use crate::application::data::update::coordination::{CoordinationKey, LeaseError, LeaseMode};

pub const ACQUIRE_SCRIPT: &str = include_str!("../../../../../update/scripts/redis/acquire.lua");
pub const RENEW_SCRIPT: &str = include_str!("../../../../../update/scripts/redis/renew.lua");
pub const RELEASE_SCRIPT: &str = include_str!("../../../../../update/scripts/redis/release.lua");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisAdapterConfig {
    pub url_env: String,
}

impl Default for RedisAdapterConfig {
    fn default() -> Self {
        Self {
            url_env: "ZBOSS_BATCH_REDIS_URL".to_owned(),
        }
    }
}

impl RedisAdapterConfig {
    pub fn is_configured(&self) -> bool {
        std::env::var(&self.url_env).is_ok_and(|value| !value.trim().is_empty())
    }
}

pub trait RedisScriptExecutor {
    fn eval(&mut self, script: &str, key: &str, arguments: &[String]) -> Result<String, String>;
}

#[derive(Debug)]
pub struct RedisBatchRefreshLeaseAdapter<E> {
    executor: E,
}

impl<E> RedisBatchRefreshLeaseAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }

    pub fn into_inner(self) -> E {
        self.executor
    }
}

impl<E: RedisScriptExecutor> RedisBatchRefreshLeaseAdapter<E> {
    pub fn acquire(
        &mut self,
        key: &CoordinationKey,
        owner_token: &str,
        mode: LeaseMode,
        now_millis: u64,
        ttl_millis: u64,
    ) -> Result<(), LeaseError> {
        validate(owner_token, ttl_millis)?;
        let response = self
            .executor
            .eval(
                ACQUIRE_SCRIPT,
                &redis_key(key),
                &[
                    mode_name(mode).to_owned(),
                    owner_token.to_owned(),
                    now_millis.to_string(),
                    now_millis.saturating_add(ttl_millis).to_string(),
                ],
            )
            .map_err(|_| LeaseError::Backend)?;
        match response.as_str() {
            "ACQUIRED" => Ok(()),
            "BUSY" => Err(LeaseError::Busy),
            "OWNER_CONFLICT" => Err(LeaseError::OwnerConflict),
            _ => Err(LeaseError::Backend),
        }
    }

    pub fn renew(
        &mut self,
        key: &CoordinationKey,
        owner_token: &str,
        mode: LeaseMode,
        now_millis: u64,
        ttl_millis: u64,
    ) -> Result<(), LeaseError> {
        validate(owner_token, ttl_millis)?;
        let response = self
            .executor
            .eval(
                RENEW_SCRIPT,
                &redis_key(key),
                &[
                    mode_name(mode).to_owned(),
                    owner_token.to_owned(),
                    now_millis.to_string(),
                    now_millis.saturating_add(ttl_millis).to_string(),
                ],
            )
            .map_err(|_| LeaseError::Backend)?;
        match response.as_str() {
            "RENEWED" => Ok(()),
            "OWNER_MISSING" => Err(LeaseError::OwnerMissing),
            _ => Err(LeaseError::Backend),
        }
    }

    pub fn release(
        &mut self,
        key: &CoordinationKey,
        owner_token: &str,
        mode: LeaseMode,
    ) -> Result<(), LeaseError> {
        validate(owner_token, 1)?;
        let response = self
            .executor
            .eval(
                RELEASE_SCRIPT,
                &redis_key(key),
                &[mode_name(mode).to_owned(), owner_token.to_owned()],
            )
            .map_err(|_| LeaseError::Backend)?;
        match response.as_str() {
            "RELEASED" => Ok(()),
            "OWNER_MISSING" => Err(LeaseError::OwnerMissing),
            _ => Err(LeaseError::Backend),
        }
    }
}

fn redis_key(key: &CoordinationKey) -> String {
    format!(
        "zboss:batch-lease:tenant:{}:panel:{}",
        key.tenant_id, key.panel_id
    )
}

fn mode_name(mode: LeaseMode) -> &'static str {
    match mode {
        LeaseMode::BatchShared => "batch",
        LeaseMode::RefreshExclusive => "refresh",
    }
}

fn validate(owner_token: &str, ttl_millis: u64) -> Result<(), LeaseError> {
    if owner_token.trim().is_empty() || owner_token.len() > 128 || ttl_millis == 0 {
        return Err(LeaseError::InvalidClaim);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Default)]
    struct RecordingExecutor {
        calls: Vec<(String, String, Vec<String>)>,
        responses: Vec<String>,
    }

    impl RedisScriptExecutor for RecordingExecutor {
        fn eval(
            &mut self,
            script: &str,
            key: &str,
            arguments: &[String],
        ) -> Result<String, String> {
            self.calls
                .push((script.to_owned(), key.to_owned(), arguments.to_vec()));
            Ok(if self.responses.is_empty() {
                "ACQUIRED".to_owned()
            } else {
                self.responses.remove(0)
            })
        }
    }

    fn key() -> CoordinationKey {
        CoordinationKey {
            tenant_id: 7,
            panel_id: 9,
        }
    }

    #[test]
    fn redis_adapter_uses_atomic_scripts_and_exact_owner_tokens() {
        let executor = RecordingExecutor {
            responses: vec![
                "ACQUIRED".to_owned(),
                "RENEWED".to_owned(),
                "RELEASED".to_owned(),
            ],
            ..RecordingExecutor::default()
        };
        let mut adapter = RedisBatchRefreshLeaseAdapter::new(executor);
        adapter
            .acquire(&key(), "owner-1", LeaseMode::BatchShared, 100, 50)
            .unwrap();
        adapter
            .renew(&key(), "owner-1", LeaseMode::BatchShared, 120, 50)
            .unwrap();
        adapter
            .release(&key(), "owner-1", LeaseMode::BatchShared)
            .unwrap();
        let executor = adapter.into_inner();
        assert_eq!(executor.calls.len(), 3);
        assert!(executor.calls[0].1.contains("tenant:7:panel:9"));
        assert_eq!(executor.calls[0].2[1], "owner-1");
    }

    #[test]
    fn redis_adapter_maps_busy_and_rejects_empty_owner() {
        let executor = RecordingExecutor {
            responses: vec!["BUSY".to_owned()],
            ..RecordingExecutor::default()
        };
        let mut adapter = RedisBatchRefreshLeaseAdapter::new(executor);
        assert_eq!(
            adapter.acquire(&key(), "refresh", LeaseMode::RefreshExclusive, 100, 50),
            Err(LeaseError::Busy)
        );
        assert_eq!(
            adapter.acquire(&key(), "", LeaseMode::BatchShared, 100, 50),
            Err(LeaseError::InvalidClaim)
        );
        assert_eq!(adapter.into_inner().calls.len(), 1);
    }
}
