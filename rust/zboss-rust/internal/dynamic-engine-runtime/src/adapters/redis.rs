use crate::{
    domain::context::RequestContext,
    http::error::ApiError,
    ports::lease::{Lease, LeaseLockPort, LeasePriority},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisAdapterConfig {
    pub url_env: String,
}

impl Default for RedisAdapterConfig {
    fn default() -> Self {
        Self {
            url_env: "ZBOSS_PAGE_REDIS_URL".to_owned(),
        }
    }
}

impl RedisAdapterConfig {
    pub fn is_configured(&self) -> bool {
        std::env::var(&self.url_env).is_ok_and(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisLeaseClaim {
    pub key: String,
    pub owner_token: String,
    pub priority: LeasePriority,
    pub ttl_millis: u64,
}

pub trait RedisLeaseExecutor: Send + Sync {
    fn acquire_atomic(
        &self,
        context: &RequestContext,
        claim: &RedisLeaseClaim,
    ) -> Result<Option<Lease>, ApiError>;

    fn release_if_owner_and_fence(
        &self,
        context: &RequestContext,
        lease: &Lease,
    ) -> Result<bool, ApiError>;
}

#[derive(Debug)]
pub struct RedisLeaseAdapter<E> {
    executor: E,
}

impl<E> RedisLeaseAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }
}

impl<E: RedisLeaseExecutor> LeaseLockPort for RedisLeaseAdapter<E> {
    fn acquire(
        &self,
        context: &RequestContext,
        key: &str,
        owner_token: &str,
        priority: LeasePriority,
        ttl_millis: u64,
    ) -> Result<Option<Lease>, ApiError> {
        context.validate().map_err(ApiError::context)?;
        if !key.starts_with(&format!("tenant:{}:", context.tenant_id)) {
            return Err(ApiError::context("lease key tenant mismatch"));
        }
        if owner_token.trim().is_empty() || ttl_millis == 0 {
            return Err(ApiError::refresh("invalid Redis lease claim", false));
        }
        let claim = RedisLeaseClaim {
            key: key.to_owned(),
            owner_token: owner_token.to_owned(),
            priority,
            ttl_millis,
        };
        let lease = self.executor.acquire_atomic(context, &claim)?;
        if let Some(lease) = &lease
            && (lease.key != claim.key
                || lease.owner_token != claim.owner_token
                || lease.priority != claim.priority
                || lease.fencing_token == 0)
        {
            return Err(ApiError::refresh(
                "Redis lease response does not match atomic claim",
                false,
            ));
        }
        Ok(lease)
    }

    fn release(&self, context: &RequestContext, lease: &Lease) -> Result<bool, ApiError> {
        context.validate().map_err(ApiError::context)?;
        if !lease
            .key
            .starts_with(&format!("tenant:{}:", context.tenant_id))
        {
            return Err(ApiError::context("lease key tenant mismatch"));
        }
        if lease.fencing_token == 0 {
            return Err(ApiError::refresh(
                "invalid Redis lease fencing token",
                false,
            ));
        }
        self.executor.release_if_owner_and_fence(context, lease)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug, Default)]
    struct RecordingExecutor {
        claims: Mutex<Vec<RedisLeaseClaim>>,
        releases: Mutex<Vec<Lease>>,
    }

    impl RedisLeaseExecutor for RecordingExecutor {
        fn acquire_atomic(
            &self,
            _context: &RequestContext,
            claim: &RedisLeaseClaim,
        ) -> Result<Option<Lease>, ApiError> {
            self.claims.lock().unwrap().push(claim.clone());
            Ok(Some(Lease {
                key: claim.key.clone(),
                owner_token: claim.owner_token.clone(),
                fencing_token: 7,
                expires_at_millis: 100,
                priority: claim.priority,
            }))
        }

        fn release_if_owner_and_fence(
            &self,
            _context: &RequestContext,
            lease: &Lease,
        ) -> Result<bool, ApiError> {
            self.releases.lock().unwrap().push(lease.clone());
            Ok(true)
        }
    }

    fn context(tenant_id: u64) -> RequestContext {
        RequestContext {
            tenant_id,
            user_id: 2,
            device_id: "device".to_owned(),
            request_id: "request".to_owned(),
            trace_id: "trace".to_owned(),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    #[test]
    fn adapter_requires_atomic_claim_and_exact_owner_fence_release() {
        let adapter = RedisLeaseAdapter::new(RecordingExecutor::default());
        let lease = adapter
            .acquire(
                &context(1),
                "tenant:1:page:7:panel:8:column:9",
                "owner",
                LeasePriority::Manual,
                50,
            )
            .unwrap()
            .unwrap();

        assert_eq!(lease.fencing_token, 7);
        assert_eq!(adapter.executor.claims.lock().unwrap().len(), 1);
        assert!(adapter.release(&context(1), &lease).unwrap());
        assert_eq!(adapter.executor.releases.lock().unwrap()[0], lease);
        assert!(adapter.release(&context(2), &lease).is_err());
    }

    #[test]
    fn adapter_rejects_cross_tenant_keys_before_redis() {
        let adapter = RedisLeaseAdapter::new(RecordingExecutor::default());
        assert!(
            adapter
                .acquire(
                    &context(1),
                    "tenant:2:page:7:panel:8:column:9",
                    "owner",
                    LeasePriority::Automatic,
                    50,
                )
                .is_err()
        );
        assert!(adapter.executor.claims.lock().unwrap().is_empty());
    }
}
