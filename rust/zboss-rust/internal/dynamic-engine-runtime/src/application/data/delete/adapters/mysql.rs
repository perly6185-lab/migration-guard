use crate::application::data::delete::{BatchDeleteStore, COMPENSATION_STEPS, CompensationOutbox};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MysqlDeleteAdapterConfig {
    pub url_env: String,
}

impl Default for MysqlDeleteAdapterConfig {
    fn default() -> Self {
        Self {
            url_env: "ZBOSS_BATCH_DELETE_MYSQL_URL".into(),
        }
    }
}

impl MysqlDeleteAdapterConfig {
    pub fn is_configured(&self) -> bool {
        std::env::var(&self.url_env).is_ok_and(|value| !value.trim().is_empty())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MysqlDeleteContext {
    pub tenant_id: u64,
    pub panel_id: u64,
    pub use_page_id: u64,
    pub actor_id: u64,
    pub datasource: String,
    pub trace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MysqlDeleteCommand {
    pub context: MysqlDeleteContext,
    pub request_id: String,
    pub batch_id: String,
    pub idempotency_key: String,
    pub request_hash: String,
    pub table_name: String,
    pub primary_key: String,
    pub row_ids: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MysqlDeleteOutcome {
    pub batch_id: String,
    pub request_hash: String,
    pub deleted_row_ids: Vec<u64>,
    pub skipped_row_ids: Vec<u64>,
    pub replayed: bool,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MysqlCompensationClaim {
    pub batch_id: String,
    pub step_index: usize,
    pub step_name: String,
    pub owner_token: String,
    pub attempts: u32,
}

pub trait MysqlDeleteExecutor {
    fn commit_delete_transaction(
        &mut self,
        command: &MysqlDeleteCommand,
    ) -> Result<MysqlDeleteOutcome, String>;

    fn load_replay(
        &mut self,
        tenant_id: u64,
        idempotency_key: &str,
    ) -> Result<Option<MysqlDeleteOutcome>, String>;

    fn claim_compensation(
        &mut self,
        batch_id: &str,
        owner_token: &str,
    ) -> Result<Option<MysqlCompensationClaim>, String>;

    fn complete_compensation(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
    ) -> Result<(), String>;

    fn fail_compensation(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
        error: &str,
    ) -> Result<(), String>;
}

#[derive(Debug)]
pub struct MysqlBatchDeleteAdapter<E> {
    executor: E,
}

impl<E> MysqlBatchDeleteAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }

    pub fn into_inner(self) -> E {
        self.executor
    }
}

impl<E: MysqlDeleteExecutor> BatchDeleteStore for MysqlBatchDeleteAdapter<E> {
    type Command = MysqlDeleteCommand;
    type Outcome = MysqlDeleteOutcome;

    fn commit_delete(&mut self, command: &Self::Command) -> Result<Self::Outcome, String> {
        validate_command(command)?;
        let result = self.executor.commit_delete_transaction(command)?;
        validate_outcome(command, &result)?;
        Ok(result)
    }

    fn find_replay(
        &mut self,
        tenant_id: u64,
        idempotency_key: &str,
    ) -> Result<Option<Self::Outcome>, String> {
        if tenant_id == 0 || idempotency_key.trim().is_empty() || idempotency_key.len() > 128 {
            return Err("invalid MySQL replay lookup".into());
        }
        self.executor.load_replay(tenant_id, idempotency_key)
    }
}

impl<E: MysqlDeleteExecutor> CompensationOutbox for MysqlBatchDeleteAdapter<E> {
    type Claim = MysqlCompensationClaim;

    fn claim_next(
        &mut self,
        batch_id: &str,
        owner_token: &str,
    ) -> Result<Option<Self::Claim>, String> {
        validate_owner(batch_id, owner_token)?;
        let claim = self.executor.claim_compensation(batch_id, owner_token)?;
        if let Some(value) = &claim
            && (value.step_index >= COMPENSATION_STEPS.len()
                || value.step_name != COMPENSATION_STEPS[value.step_index]
                || value.owner_token != owner_token)
        {
            return Err("MySQL returned an invalid compensation claim".into());
        }
        Ok(claim)
    }

    fn complete_step(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
    ) -> Result<(), String> {
        validate_step(batch_id, step_index, owner_token)?;
        self.executor
            .complete_compensation(batch_id, step_index, owner_token)
    }

    fn fail_step(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
        error: &str,
    ) -> Result<(), String> {
        validate_step(batch_id, step_index, owner_token)?;
        if error.trim().is_empty() || error.len() > 1_024 {
            return Err("invalid compensation error".into());
        }
        self.executor
            .fail_compensation(batch_id, step_index, owner_token, error)
    }
}

fn validate_command(command: &MysqlDeleteCommand) -> Result<(), String> {
    if command.context.tenant_id == 0
        || command.context.panel_id == 0
        || command.context.use_page_id == 0
        || command.context.actor_id == 0
    {
        return Err("MySQL delete adapter requires explicit tenant, panel, page and actor".into());
    }
    if command.context.datasource.trim().is_empty() || command.context.trace_id.trim().is_empty() {
        return Err("MySQL delete adapter requires datasource and trace context".into());
    }
    for value in [
        &command.request_id,
        &command.batch_id,
        &command.idempotency_key,
    ] {
        if value.trim().is_empty() || value.len() > 128 {
            return Err("invalid MySQL delete identity".into());
        }
    }
    if command.request_hash.len() != 64
        || !command
            .request_hash
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("request hash must be 64 hexadecimal characters".into());
    }
    if !is_safe_dynamic_table(&command.table_name) || !is_safe_identifier(&command.primary_key) {
        return Err("unsafe dynamic SQL identifier".into());
    }
    if command.row_ids.is_empty() || command.row_ids.len() > 10_000 {
        return Err("row ids must contain 1..10000 entries".into());
    }
    if command.row_ids.contains(&0) {
        return Err("row ids must be positive".into());
    }
    Ok(())
}

fn validate_outcome(
    command: &MysqlDeleteCommand,
    outcome: &MysqlDeleteOutcome,
) -> Result<(), String> {
    if outcome.batch_id != command.batch_id || outcome.request_hash != command.request_hash {
        return Err("MySQL delete outcome identity mismatch".into());
    }
    let requested = command
        .row_ids
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let classified = outcome
        .deleted_row_ids
        .iter()
        .chain(outcome.skipped_row_ids.iter())
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if requested != classified {
        return Err("MySQL delete outcome did not classify every requested row".into());
    }
    Ok(())
}

fn validate_owner(batch_id: &str, owner_token: &str) -> Result<(), String> {
    if batch_id.trim().is_empty()
        || batch_id.len() > 128
        || owner_token.trim().is_empty()
        || owner_token.len() > 128
    {
        return Err("invalid compensation owner claim".into());
    }
    Ok(())
}

fn validate_step(batch_id: &str, step_index: usize, owner_token: &str) -> Result<(), String> {
    validate_owner(batch_id, owner_token)?;
    if step_index >= COMPENSATION_STEPS.len() {
        return Err("invalid compensation step index".into());
    }
    Ok(())
}

pub fn is_safe_dynamic_table(value: &str) -> bool {
    value.strip_prefix("cust_table").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingExecutor {
        commits: Vec<MysqlDeleteCommand>,
        claims: Vec<(String, String)>,
    }

    impl MysqlDeleteExecutor for RecordingExecutor {
        fn commit_delete_transaction(
            &mut self,
            command: &MysqlDeleteCommand,
        ) -> Result<MysqlDeleteOutcome, String> {
            self.commits.push(command.clone());
            Ok(MysqlDeleteOutcome {
                batch_id: command.batch_id.clone(),
                request_hash: command.request_hash.clone(),
                deleted_row_ids: command.row_ids.clone(),
                skipped_row_ids: vec![],
                replayed: false,
                state: "MAIN_COMMITTED".into(),
            })
        }

        fn load_replay(
            &mut self,
            _tenant_id: u64,
            _idempotency_key: &str,
        ) -> Result<Option<MysqlDeleteOutcome>, String> {
            Ok(None)
        }

        fn claim_compensation(
            &mut self,
            batch_id: &str,
            owner_token: &str,
        ) -> Result<Option<MysqlCompensationClaim>, String> {
            self.claims
                .push((batch_id.to_owned(), owner_token.to_owned()));
            Ok(Some(MysqlCompensationClaim {
                batch_id: batch_id.into(),
                step_index: 0,
                step_name: COMPENSATION_STEPS[0].into(),
                owner_token: owner_token.into(),
                attempts: 1,
            }))
        }

        fn complete_compensation(
            &mut self,
            _batch_id: &str,
            _step_index: usize,
            _owner_token: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        fn fail_compensation(
            &mut self,
            _batch_id: &str,
            _step_index: usize,
            _owner_token: &str,
            _error: &str,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    fn command() -> MysqlDeleteCommand {
        MysqlDeleteCommand {
            context: MysqlDeleteContext {
                tenant_id: 1,
                panel_id: 2,
                use_page_id: 3,
                actor_id: 4,
                datasource: "primary".into(),
                trace_id: "trace".into(),
            },
            request_id: "request".into(),
            batch_id: "batch".into(),
            idempotency_key: "key".into(),
            request_hash: "a".repeat(64),
            table_name: "cust_table7119".into(),
            primary_key: "id".into(),
            row_ids: vec![10, 11],
        }
    }

    #[test]
    fn adapter_validates_and_traverses_atomic_executor() {
        let mut adapter = MysqlBatchDeleteAdapter::new(RecordingExecutor::default());
        let result = adapter.commit_delete(&command()).unwrap();
        assert_eq!(result.deleted_row_ids, [10, 11]);
        let claim = adapter.claim_next("batch", "worker-1").unwrap().unwrap();
        assert_eq!(claim.step_name, COMPENSATION_STEPS[0]);
        assert_eq!(adapter.into_inner().commits.len(), 1);
    }

    #[test]
    fn adapter_rejects_dynamic_identifier_injection_before_executor() {
        let mut invalid = command();
        invalid.table_name = "cust_table7119; DROP TABLE users".into();
        let mut adapter = MysqlBatchDeleteAdapter::new(RecordingExecutor::default());
        assert!(
            adapter
                .commit_delete(&invalid)
                .unwrap_err()
                .contains("unsafe")
        );
        assert!(adapter.into_inner().commits.is_empty());
    }

    #[test]
    fn adapter_rejects_unclassified_executor_result() {
        struct BadExecutor;
        impl MysqlDeleteExecutor for BadExecutor {
            fn commit_delete_transaction(
                &mut self,
                command: &MysqlDeleteCommand,
            ) -> Result<MysqlDeleteOutcome, String> {
                Ok(MysqlDeleteOutcome {
                    batch_id: command.batch_id.clone(),
                    request_hash: command.request_hash.clone(),
                    deleted_row_ids: vec![command.row_ids[0]],
                    skipped_row_ids: vec![],
                    replayed: false,
                    state: "MAIN_COMMITTED".into(),
                })
            }
            fn load_replay(
                &mut self,
                _: u64,
                _: &str,
            ) -> Result<Option<MysqlDeleteOutcome>, String> {
                Ok(None)
            }
            fn claim_compensation(
                &mut self,
                _: &str,
                _: &str,
            ) -> Result<Option<MysqlCompensationClaim>, String> {
                Ok(None)
            }
            fn complete_compensation(&mut self, _: &str, _: usize, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn fail_compensation(
                &mut self,
                _: &str,
                _: usize,
                _: &str,
                _: &str,
            ) -> Result<(), String> {
                Ok(())
            }
        }
        assert!(
            MysqlBatchDeleteAdapter::new(BadExecutor)
                .commit_delete(&command())
                .unwrap_err()
                .contains("classify")
        );
    }
}
