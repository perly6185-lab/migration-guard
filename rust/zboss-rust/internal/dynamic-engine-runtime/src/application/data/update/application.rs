use crate::application::data::update::{
    batch::{BatchPlan, BatchRow, PlanError, plan_batch},
    schema_transition::{
        SchemaChange, SchemaExecutorPort, SchemaLeasePort, SchemaLedgerPort, TransitionError,
        TransitionKey, TransitionOutcome, ensure_schema,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaRequirement {
    pub key: TransitionKey,
    pub request_hash: String,
    pub owner_token: String,
    pub change: SchemaChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchExecutionPlan {
    pub schema: Option<TransitionOutcome>,
    pub rows: BatchPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchExecutionError {
    Batch(PlanError),
    Schema(TransitionError),
}

#[derive(Debug, Clone, Copy)]
pub struct BatchPreparation<'a> {
    pub post_rows: &'a [BatchRow],
    pub header_row_count: usize,
    pub failed_indexes: &'a [usize],
    pub limit: usize,
    pub schema: Option<&'a SchemaRequirement>,
}

/// Validates and partitions every requested row before the first schema or row
/// side effect. If a schema transition is required, the returned row plan is
/// released to the caller only after the transition is durably successful.
pub fn prepare_batch_execution<L, G, E>(
    request: BatchPreparation<'_>,
    lease: &mut L,
    ledger: &mut G,
    executor: &mut E,
) -> Result<BatchExecutionPlan, BatchExecutionError>
where
    L: SchemaLeasePort,
    G: SchemaLedgerPort,
    E: SchemaExecutorPort,
{
    let rows = plan_batch(
        request.post_rows,
        request.header_row_count,
        request.failed_indexes,
        request.limit,
    )
    .map_err(BatchExecutionError::Batch)?;
    let schema = request
        .schema
        .map(|requirement| {
            ensure_schema(
                &requirement.key,
                &requirement.request_hash,
                &requirement.owner_token,
                &requirement.change,
                lease,
                ledger,
                executor,
            )
            .map_err(BatchExecutionError::Schema)
        })
        .transpose()?;
    Ok(BatchExecutionPlan { schema, rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::data::update::schema_transition::{
        ColumnType, MemoryLease, MemoryLedger, MemorySchemaExecutor, MemoryTrace,
    };

    const REQUEST_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn requirement() -> SchemaRequirement {
        SchemaRequirement {
            key: TransitionKey {
                tenant_id: 1,
                panel_id: 2,
                operation_id: "add_status".to_owned(),
            },
            request_hash: REQUEST_HASH.to_owned(),
            owner_token: "owner-1".to_owned(),
            change: SchemaChange::AddColumn {
                table: "ledger_2".to_owned(),
                column: "status".to_owned(),
                column_type: ColumnType::Varchar { length: 32 },
            },
        }
    }

    fn row() -> BatchRow {
        BatchRow {
            index: 0,
            primary_key: Some("10".to_owned()),
        }
    }

    fn adapters() -> (MemoryLease, MemoryLedger, MemorySchemaExecutor, MemoryTrace) {
        let trace = MemoryTrace::default();
        (
            MemoryLease::with_trace(trace.clone()),
            MemoryLedger::with_trace(trace.clone()),
            MemorySchemaExecutor::with_trace(trace.clone()),
            trace,
        )
    }

    #[test]
    fn rejects_batch_constraints_before_schema_effects() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        let error = prepare_batch_execution(
            BatchPreparation {
                post_rows: &[row()],
                header_row_count: 1,
                failed_indexes: &[],
                limit: 1,
                schema: Some(&requirement()),
            },
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert_eq!(
            error,
            BatchExecutionError::Batch(PlanError::HeaderRowsUnsupported { count: 1 })
        );
        assert!(trace.entries().is_empty());
    }

    #[test]
    fn releases_row_plan_only_after_durable_schema_success() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        let plan = prepare_batch_execution(
            BatchPreparation {
                post_rows: &[row()],
                header_row_count: 0,
                failed_indexes: &[],
                limit: 1,
                schema: Some(&requirement()),
            },
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        assert_eq!(plan.schema, Some(TransitionOutcome::Applied { attempt: 1 }));
        assert_eq!(plan.rows.valid, [0]);
        assert_eq!(
            trace.entries(),
            [
                "lease.acquire",
                "ledger.load",
                "ledger.started:1",
                "ddl.execute",
                "ledger.succeeded:1",
                "lease.release"
            ]
        );
    }

    #[test]
    fn ddl_failure_prevents_row_execution_plan() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        executor.fail_next = Some("DDL unavailable".to_owned());
        let error = prepare_batch_execution(
            BatchPreparation {
                post_rows: &[row()],
                header_row_count: 0,
                failed_indexes: &[],
                limit: 1,
                schema: Some(&requirement()),
            },
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            BatchExecutionError::Schema(TransitionError::Execution { .. })
        ));
        assert_eq!(
            trace.entries().last().map(String::as_str),
            Some("lease.release")
        );
    }
}
