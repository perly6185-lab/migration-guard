use std::time::Duration;

use crate::{
    adapters::redis::{RedisLeaseClaim, RedisLeaseExecutor},
    domain::context::RequestContext,
    http::error::ApiError,
    ports::{
        horizontal::HorizontalRefreshCoordinator,
        lease::{Lease, LeasePriority},
    },
};

const ACQUIRE_SCRIPT: &str = r#"
local current = redis.call('HMGET', KEYS[1], 'owner', 'fence', 'priority')
if current[1] then
  if ARGV[2] ~= 'manual' or current[3] ~= 'automatic' then
    return {}
  end
end
local fence = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'fence', fence, 'priority', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
local time = redis.call('TIME')
local now_ms = (time[1] * 1000) + math.floor(time[2] / 1000)
return { tostring(fence), tostring(now_ms + tonumber(ARGV[3])) }
"#;

const RELEASE_SCRIPT: &str = r#"
local current = redis.call('HMGET', KEYS[1], 'owner', 'fence')
if current[1] == ARGV[1] and current[2] == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0
"#;

#[derive(Debug, Clone)]
pub struct TokioRedisLeaseExecutor {
    client: redis::Client,
    namespace: String,
}

impl TokioRedisLeaseExecutor {
    pub fn connect(redis_url: &str, namespace: impl Into<String>) -> Result<Self, String> {
        if !redis_url.starts_with("redis://") && !redis_url.starts_with("rediss://") {
            return Err("ZBOSS_PAGE_REDIS_URL must use redis:// or rediss://".to_owned());
        }
        let namespace = namespace.into();
        if namespace.trim().is_empty() || namespace.contains(char::is_whitespace) {
            return Err("Redis namespace must be non-empty and contain no whitespace".to_owned());
        }
        let client =
            redis::Client::open(redis_url).map_err(|error| format!("configure Redis: {error}"))?;
        Ok(Self { client, namespace })
    }

    fn run<T, F, Fut>(&self, operation: F) -> Result<T, ApiError>
    where
        F: FnOnce(redis::aio::MultiplexedConnection) -> Fut,
        Fut: std::future::Future<Output = Result<T, redis::RedisError>>,
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| ApiError::refresh(format!("create Redis runtime: {error}"), true))?;
        let connection = runtime
            .block_on(self.client.get_multiplexed_async_connection())
            .map_err(redis_error)?;
        runtime.block_on(operation(connection)).map_err(redis_error)
    }

    fn lease_key(&self, context: &RequestContext, key: &str) -> String {
        format!(
            "{}:lease:{}:{}:{}",
            self.namespace, context.tenant_id, context.datasource, key
        )
    }

    fn fence_key(&self, context: &RequestContext) -> String {
        format!(
            "{}:fence:{}:{}",
            self.namespace, context.tenant_id, context.datasource
        )
    }
}

impl RedisLeaseExecutor for TokioRedisLeaseExecutor {
    fn acquire_atomic(
        &self,
        context: &RequestContext,
        claim: &RedisLeaseClaim,
    ) -> Result<Option<Lease>, ApiError> {
        let lease_key = self.lease_key(context, &claim.key);
        let fence_key = self.fence_key(context);
        let owner = claim.owner_token.clone();
        let priority = priority_name(claim.priority).to_owned();
        let ttl = claim.ttl_millis;
        let values: Vec<String> = self.run(move |mut connection| async move {
            redis::Script::new(ACQUIRE_SCRIPT)
                .key(lease_key)
                .key(fence_key)
                .arg(owner)
                .arg(priority)
                .arg(ttl)
                .invoke_async(&mut connection)
                .await
        })?;
        if values.is_empty() {
            return Ok(None);
        }
        if values.len() != 2 {
            return Err(ApiError::refresh(
                "Redis lease script returned an invalid response",
                false,
            ));
        }
        let fencing_token = values[0]
            .parse()
            .map_err(|_| ApiError::refresh("invalid Redis fencing token", false))?;
        let expires_at_millis = values[1]
            .parse()
            .map_err(|_| ApiError::refresh("invalid Redis lease expiry", false))?;
        Ok(Some(Lease {
            key: claim.key.clone(),
            owner_token: claim.owner_token.clone(),
            fencing_token,
            expires_at_millis,
            priority: claim.priority,
        }))
    }

    fn release_if_owner_and_fence(
        &self,
        context: &RequestContext,
        lease: &Lease,
    ) -> Result<bool, ApiError> {
        let lease_key = self.lease_key(context, &lease.key);
        let owner = lease.owner_token.clone();
        let fence = lease.fencing_token;
        let deleted: i64 = self.run(move |mut connection| async move {
            redis::Script::new(RELEASE_SCRIPT)
                .key(lease_key)
                .arg(owner)
                .arg(fence)
                .invoke_async(&mut connection)
                .await
        })?;
        Ok(deleted == 1)
    }
}

fn priority_name(priority: LeasePriority) -> &'static str {
    match priority {
        LeasePriority::Automatic => "automatic",
        LeasePriority::Manual => "manual",
    }
}

fn redis_error(error: redis::RedisError) -> ApiError {
    ApiError::refresh(format!("Redis execution failed: {error}"), true)
}

#[derive(Debug, Clone)]
pub struct RedisHorizontalRefreshCoordinator {
    client: redis::Client,
    stream: String,
    timeout: Duration,
}

impl RedisHorizontalRefreshCoordinator {
    pub fn connect(
        redis_url: &str,
        stream: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, String> {
        if timeout.is_zero() {
            return Err("horizontal refresh timeout must be greater than zero".to_owned());
        }
        let stream = stream.into();
        if stream.trim().is_empty() {
            return Err("horizontal refresh stream is empty".to_owned());
        }
        let client =
            redis::Client::open(redis_url).map_err(|error| format!("configure Redis: {error}"))?;
        Ok(Self {
            client,
            stream,
            timeout,
        })
    }
}

impl HorizontalRefreshCoordinator for RedisHorizontalRefreshCoordinator {
    fn refresh_horizontal(
        &self,
        context: &RequestContext,
        horizontal_id: u64,
    ) -> Result<(), ApiError> {
        context.validate().map_err(ApiError::context)?;
        let reply_key = format!(
            "zboss:horizontal:refresh:reply:{}:{}:{}",
            context.tenant_id, context.request_id, horizontal_id
        );
        let stream = self.stream.clone();
        let request_id = context.request_id.clone();
        let trace_id = context.trace_id.clone();
        let tenant_id = context.tenant_id;
        let timeout = self.timeout.as_secs_f64();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| ApiError::refresh(format!("create Redis runtime: {error}"), true))?;
        let mut connection = runtime
            .block_on(self.client.get_multiplexed_async_connection())
            .map_err(redis_error)?;
        runtime
            .block_on(async {
                redis::cmd("XADD")
                    .arg(&stream)
                    .arg("*")
                    .arg("tenantId")
                    .arg(tenant_id)
                    .arg("horizontalId")
                    .arg(horizontal_id)
                    .arg("requestId")
                    .arg(request_id)
                    .arg("traceId")
                    .arg(trace_id)
                    .arg("replyKey")
                    .arg(&reply_key)
                    .query_async::<String>(&mut connection)
                    .await
            })
            .map_err(redis_error)?;
        let reply = runtime
            .block_on(async {
                redis::cmd("BRPOP")
                    .arg(&reply_key)
                    .arg(timeout)
                    .query_async::<Option<(String, String)>>(&mut connection)
                    .await
            })
            .map_err(redis_error)?;
        match reply {
            Some((_, value)) if value == "OK" => Ok(()),
            Some((_, value)) => Err(ApiError::refresh(
                format!("horizontal refresh worker failed: {value}"),
                false,
            )),
            None => Err(ApiError::refresh(
                "horizontal refresh worker timed out",
                true,
            )),
        }
    }
}
