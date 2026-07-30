use crate::application::data::delete::{ProgressEvent, ProgressSink, ProgressState};

pub const ACQUIRE_SCRIPT: &str = include_str!("../../../../../delete/scripts/redis/acquire.lua");
pub const RENEW_SCRIPT: &str = include_str!("../../../../../delete/scripts/redis/renew.lua");
pub const RELEASE_SCRIPT: &str = include_str!("../../../../../delete/scripts/redis/release.lua");
pub const PROGRESS_SCRIPT: &str = include_str!("../../../../../delete/scripts/redis/progress.lua");

pub trait RedisScriptExecutor {
    fn eval(&mut self, script: &str, key: &str, arguments: &[String]) -> Result<String, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedisDeleteKey {
    pub tenant_id: u64,
    pub panel_id: u64,
}

#[derive(Debug)]
pub struct RedisBatchDeleteAdapter<E> {
    executor: E,
    tenant_id: u64,
}

impl<E> RedisBatchDeleteAdapter<E> {
    pub const fn new(executor: E, tenant_id: u64) -> Self {
        Self {
            executor,
            tenant_id,
        }
    }

    pub fn into_inner(self) -> E {
        self.executor
    }
}

impl<E: RedisScriptExecutor> RedisBatchDeleteAdapter<E> {
    pub fn acquire(
        &mut self,
        key: &RedisDeleteKey,
        owner_token: &str,
        operation: &str,
        now_millis: u64,
        ttl_millis: u64,
    ) -> Result<(), String> {
        validate_claim(key, owner_token, operation, ttl_millis)?;
        let result = self.executor.eval(
            ACQUIRE_SCRIPT,
            &lease_key(key),
            &[
                owner_token.into(),
                operation.into(),
                now_millis.to_string(),
                now_millis.saturating_add(ttl_millis).to_string(),
            ],
        )?;
        map_claim_result(&result, "ACQUIRED")
    }

    pub fn renew(
        &mut self,
        key: &RedisDeleteKey,
        owner_token: &str,
        now_millis: u64,
        ttl_millis: u64,
    ) -> Result<(), String> {
        validate_claim(key, owner_token, "delete", ttl_millis)?;
        let result = self.executor.eval(
            RENEW_SCRIPT,
            &lease_key(key),
            &[
                owner_token.into(),
                now_millis.to_string(),
                now_millis.saturating_add(ttl_millis).to_string(),
            ],
        )?;
        map_claim_result(&result, "RENEWED")
    }

    pub fn release(&mut self, key: &RedisDeleteKey, owner_token: &str) -> Result<(), String> {
        validate_claim(key, owner_token, "delete", 1)?;
        let result = self
            .executor
            .eval(RELEASE_SCRIPT, &lease_key(key), &[owner_token.into()])?;
        map_claim_result(&result, "RELEASED")
    }
}

impl<E: RedisScriptExecutor> ProgressSink for RedisBatchDeleteAdapter<E> {
    fn publish(&mut self, event: &ProgressEvent, event_hash: &str) -> Result<String, String> {
        if self.tenant_id == 0
            || event.batch_id.trim().is_empty()
            || event.sequence == 0
            || event_hash.len() != 64
            || !event_hash.bytes().all(|value| value.is_ascii_hexdigit())
        {
            return Err("invalid progress event".into());
        }
        self.executor.eval(
            PROGRESS_SCRIPT,
            &format!(
                "zboss:batch-delete:progress:tenant:{}:batch:{}",
                self.tenant_id, event.batch_id
            ),
            &[
                event.sequence.to_string(),
                progress_state(event.state).into(),
                event_hash.into(),
                event.requested.to_string(),
                event.deleted.to_string(),
                event.skipped.to_string(),
            ],
        )
    }
}

fn validate_claim(
    key: &RedisDeleteKey,
    owner_token: &str,
    operation: &str,
    ttl_millis: u64,
) -> Result<(), String> {
    if key.tenant_id == 0
        || key.panel_id == 0
        || owner_token.trim().is_empty()
        || owner_token.len() > 128
        || !matches!(operation, "delete" | "update")
        || ttl_millis == 0
    {
        return Err("invalid Redis mutation claim".into());
    }
    Ok(())
}

fn lease_key(key: &RedisDeleteKey) -> String {
    format!(
        "zboss:batch-delete:lease:tenant:{}:panel:{}",
        key.tenant_id, key.panel_id
    )
}

fn map_claim_result(actual: &str, expected: &str) -> Result<(), String> {
    match actual {
        value if value == expected => Ok(()),
        "BUSY" => Err("mutation gate busy".into()),
        "OWNER_MISSING" => Err("mutation owner missing".into()),
        "OWNER_CONFLICT" => Err("mutation owner conflict".into()),
        _ => Err("Redis mutation gate backend error".into()),
    }
}

fn progress_state(state: ProgressState) -> &'static str {
    match state {
        ProgressState::Running => "RUNNING",
        ProgressState::MainCommitted => "MAIN_COMMITTED",
        ProgressState::CompensationRetrying => "COMPENSATION_RETRYING",
        ProgressState::Success => "SUCCESS",
        ProgressState::Failed => "FAILED",
        ProgressState::CompensationFailed => "COMPENSATION_FAILED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
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
                .push((script.into(), key.into(), arguments.to_vec()));
            Ok(if self.responses.is_empty() {
                "STORED".into()
            } else {
                self.responses.remove(0)
            })
        }
    }

    fn key() -> RedisDeleteKey {
        RedisDeleteKey {
            tenant_id: 7,
            panel_id: 9,
        }
    }

    #[test]
    fn owner_token_is_used_for_acquire_renew_and_release() {
        let executor = RecordingExecutor {
            responses: vec!["ACQUIRED".into(), "RENEWED".into(), "RELEASED".into()],
            ..RecordingExecutor::default()
        };
        let mut adapter = RedisBatchDeleteAdapter::new(executor, 7);
        adapter.acquire(&key(), "owner", "delete", 100, 50).unwrap();
        adapter.renew(&key(), "owner", 120, 50).unwrap();
        adapter.release(&key(), "owner").unwrap();
        let executor = adapter.into_inner();
        assert_eq!(executor.calls.len(), 3);
        assert!(executor.calls[0].1.contains("tenant:7:panel:9"));
        assert_eq!(executor.calls[0].2[0], "owner");
    }

    #[test]
    fn progress_sink_uses_atomic_script_and_exact_terminal_state() {
        let mut adapter = RedisBatchDeleteAdapter::new(RecordingExecutor::default(), 7);
        let result = adapter
            .publish(
                &ProgressEvent {
                    batch_id: "batch".into(),
                    sequence: 3,
                    state: ProgressState::CompensationFailed,
                    requested: 3,
                    deleted: 3,
                    skipped: 0,
                },
                &"a".repeat(64),
            )
            .unwrap();
        assert_eq!(result, "STORED");
        let executor = adapter.into_inner();
        assert_eq!(executor.calls[0].2[1], "COMPENSATION_FAILED");
        assert!(executor.calls[0].0.contains("TERMINAL"));
    }

    #[test]
    fn invalid_context_is_rejected_before_redis_call() {
        let mut adapter = RedisBatchDeleteAdapter::new(RecordingExecutor::default(), 7);
        assert!(adapter.acquire(&key(), "", "delete", 100, 50).is_err());
        assert!(adapter.into_inner().calls.is_empty());
    }
}
