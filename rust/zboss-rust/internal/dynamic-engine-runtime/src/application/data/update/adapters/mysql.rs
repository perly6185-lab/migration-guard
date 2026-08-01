use crate::application::data::update::execution::{
    BatchPersistencePort, CommitDisposition, ExecutionContext, RowCommand, TerminalStatus,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlAdapterConfig {
    pub url_env: String,
}

impl Default for MysqlAdapterConfig {
    fn default() -> Self {
        Self {
            url_env: "ZBOSS_BATCH_UPDATE_MYSQL_URL".to_owned(),
        }
    }
}

impl MysqlAdapterConfig {
    pub fn is_configured(&self) -> bool {
        std::env::var(&self.url_env).is_ok_and(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlRowTransaction {
    pub context: ExecutionContext,
    pub batch_id: String,
    pub row: RowCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlTerminalIntent {
    pub context: ExecutionContext,
    pub batch_id: String,
    pub status: TerminalStatus,
    pub dedupe_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlCommitResult {
    pub disposition: CommitDisposition,
    pub primary_key: String,
}

/// Production implementations must use one database transaction for the row
/// mutation, idempotent commit marker, undo intent and downstream outbox.
pub trait MysqlBatchExecutor {
    fn commit_row_atomically(
        &mut self,
        request: &MysqlRowTransaction,
    ) -> Result<MysqlCommitResult, String>;

    fn persist_terminal_idempotently(
        &mut self,
        request: &MysqlTerminalIntent,
    ) -> Result<(), String>;
}

#[derive(Debug)]
pub struct MysqlBatchAdapter<E> {
    executor: E,
}

impl<E> MysqlBatchAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }

    pub fn into_inner(self) -> E {
        self.executor
    }
}

impl<E: MysqlBatchExecutor> BatchPersistencePort for MysqlBatchAdapter<E> {
    fn commit_row(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        row: &RowCommand,
    ) -> Result<(CommitDisposition, String), String> {
        validate_request(context, batch_id)?;
        let result = self.executor.commit_row_atomically(&MysqlRowTransaction {
            context: context.clone(),
            batch_id: batch_id.to_owned(),
            row: row.clone(),
        })?;
        if result.primary_key.trim().is_empty() {
            return Err("MySQL returned an empty primary key".to_owned());
        }
        Ok((result.disposition, result.primary_key))
    }

    fn persist_terminal(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        status: TerminalStatus,
    ) -> Result<(), String> {
        validate_request(context, batch_id)?;
        self.executor
            .persist_terminal_idempotently(&MysqlTerminalIntent {
                context: context.clone(),
                batch_id: batch_id.to_owned(),
                status,
                dedupe_key: format!("{batch_id}:terminal"),
            })
    }
}

fn validate_request(context: &ExecutionContext, batch_id: &str) -> Result<(), String> {
    if context.tenant_id == 0 || context.panel_id == 0 {
        return Err("MySQL adapter requires tenant and panel context".to_owned());
    }
    if context.datasource.trim().is_empty() {
        return Err("MySQL adapter requires datasource context".to_owned());
    }
    if batch_id.trim().is_empty() || batch_id.len() > 128 {
        return Err("invalid batch id".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::application::data::update::execution::{
        BatchCommand, ProgressJournal, RowCommand, TerminalStatus, execute_batch,
    };

    #[derive(Debug, Default)]
    struct RecordingExecutor {
        rows: Vec<MysqlRowTransaction>,
        terminals: Vec<MysqlTerminalIntent>,
    }

    impl MysqlBatchExecutor for RecordingExecutor {
        fn commit_row_atomically(
            &mut self,
            request: &MysqlRowTransaction,
        ) -> Result<MysqlCommitResult, String> {
            self.rows.push(request.clone());
            Ok(MysqlCommitResult {
                disposition: CommitDisposition::Applied,
                primary_key: request
                    .row
                    .primary_key
                    .clone()
                    .unwrap_or_else(|| format!("{}-{}", request.batch_id, request.row.index)),
            })
        }

        fn persist_terminal_idempotently(
            &mut self,
            request: &MysqlTerminalIntent,
        ) -> Result<(), String> {
            self.terminals.push(request.clone());
            Ok(())
        }
    }

    fn context() -> ExecutionContext {
        ExecutionContext {
            tenant_id: 1,
            panel_id: 2,
            datasource: "primary".to_owned(),
            actor_id: 3,
            trace_id: "trace".to_owned(),
        }
    }

    #[test]
    fn mysql_adapter_is_on_the_batch_execution_path() {
        let command = BatchCommand {
            context: context(),
            batch_id: "batch-1".to_owned(),
            rows: vec![RowCommand {
                index: 0,
                primary_key: None,
                values: BTreeMap::from([("name".to_owned(), "value".to_owned())]),
                horizontal_values: BTreeMap::new(),
            }],
            header_row_count: 0,
            validation_failures: BTreeMap::new(),
            dependency_failure: None,
        };
        let mut adapter = MysqlBatchAdapter::new(RecordingExecutor::default());
        let mut progress = ProgressJournal::default();
        let result = execute_batch(&command, &mut adapter, &mut progress).unwrap();
        assert_eq!(result.status, TerminalStatus::Success);
        let executor = adapter.into_inner();
        assert_eq!(executor.rows.len(), 1);
        assert_eq!(executor.terminals.len(), 1);
        assert_eq!(executor.terminals[0].dedupe_key, "batch-1:terminal");
    }

    #[test]
    fn mysql_adapter_rejects_context_before_executor_calls() {
        let mut adapter = MysqlBatchAdapter::new(RecordingExecutor::default());
        let error = BatchPersistencePort::commit_row(
            &mut adapter,
            &ExecutionContext {
                tenant_id: 0,
                ..context()
            },
            "batch-1",
            &RowCommand {
                index: 0,
                primary_key: None,
                values: BTreeMap::new(),
                horizontal_values: BTreeMap::new(),
            },
        )
        .unwrap_err();
        assert!(error.contains("tenant"));
        assert!(adapter.into_inner().rows.is_empty());
    }
}
