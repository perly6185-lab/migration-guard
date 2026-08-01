use std::collections::{BTreeMap, BTreeSet};

use crate::application::data::update::{
    batch::{DEFAULT_ROW_LIMIT, PlanError},
    coordination::{
        ChunkDecision, ChunkError, ChunkKey, CoordinationKey, LeaseError, LeaseMode,
        MemoryBatchRefreshLease, MemoryChunkLedger,
    },
    entrypoint::{Entrypoint, HTTP_PATH, RPC_METHOD, WEB_RPC_METHOD, invoke},
    execution::{
        BatchCommand, ExecuteError, ExecutionContext, FailurePhase, MemoryBatchStore, OutboxState,
        ProgressJournal, ProgressStage, RowCommand, StoredRow, TerminalStatus,
        committed_and_undo_match, execute_batch,
    },
    scenario_contract::SCENARIOS,
    schema_transition::{
        ColumnType, MemoryLease, MemoryLedger, MemorySchemaExecutor, MemoryTrace, SchemaChange,
        TransitionError, TransitionKey, TransitionOutcome, TransitionStatus, ensure_schema,
    },
};

const REQUEST_HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn context(tenant_id: u64, panel_id: u64) -> ExecutionContext {
    ExecutionContext {
        tenant_id,
        panel_id,
        datasource: format!("tenant_{tenant_id}"),
        actor_id: 99,
        trace_id: format!("trace-{tenant_id}-{panel_id}"),
    }
}

fn row(index: usize, primary_key: Option<&str>) -> RowCommand {
    RowCommand {
        index,
        primary_key: primary_key.map(str::to_owned),
        values: BTreeMap::from([("name".to_owned(), format!("row-{index}"))]),
        horizontal_values: BTreeMap::new(),
    }
}

fn command(batch_id: &str, rows: Vec<RowCommand>) -> BatchCommand {
    BatchCommand {
        context: context(1, 10),
        batch_id: batch_id.to_owned(),
        rows,
        header_row_count: 0,
        validation_failures: BTreeMap::new(),
        dependency_failure: None,
    }
}

fn run(
    command: &BatchCommand,
) -> (
    MemoryBatchStore,
    ProgressJournal,
    crate::application::data::update::execution::BatchExecutionResult,
) {
    let mut store = MemoryBatchStore::default();
    let mut progress = ProgressJournal::default();
    let result = execute_batch(command, &mut store, &mut progress).unwrap();
    (store, progress, result)
}

#[test]
fn matrix_has_exactly_the_19_runtime_contract_scenarios() {
    let ids = SCENARIOS
        .iter()
        .map(|scenario| scenario.id)
        .collect::<BTreeSet<_>>();
    assert_eq!(ids.len(), 19);
    assert_eq!(ids.first(), Some(&"batch-partial-failure"));
    assert_eq!(ids.last(), Some(&"web-rpc-entrypoint-parity"));
    let decisions = SCENARIOS
        .iter()
        .flat_map(|scenario| scenario.decisions.iter().copied())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        decisions,
        BTreeSet::from([
            "BUP-DEC-BATCH-REFRESH-LEASE",
            "BUP-DEC-CHUNK-IDEMPOTENCY",
            "BUP-DEC-PARTIAL-COMMIT",
            "BUP-DEC-PROGRESS-TERMINAL",
            "BUP-DEC-ROW-LIMIT",
            "BUP-DEC-SCHEMA-TRANSITION",
            "BUP-DEC-UNDO-DURABILITY",
        ])
    );
}

#[test]
fn batch_partial_failure() {
    let mut request = command(
        "partial",
        vec![row(0, Some("10")), row(1, None), row(2, Some("12"))],
    );
    request
        .validation_failures
        .insert(1, "invalid reference".to_owned());
    let (store, _, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Success);
    assert_eq!(result.committed, [0, 2]);
    assert_eq!(
        result
            .failures
            .iter()
            .map(|failure| failure.index)
            .collect::<Vec<_>>(),
        [1]
    );
    assert!(committed_and_undo_match(&store, 1, "partial", &[0, 2]));
}

#[test]
fn batch_row_limit_rejected() {
    let mut request = command(
        "limit",
        (0..=DEFAULT_ROW_LIMIT)
            .map(|index| row(index, None))
            .collect(),
    );
    let mut store = MemoryBatchStore::default();
    let mut progress = ProgressJournal::default();
    assert_eq!(
        execute_batch(&request, &mut store, &mut progress),
        Err(ExecuteError::Plan(PlanError::RowLimitExceeded {
            limit: DEFAULT_ROW_LIMIT
        }))
    );
    assert!(progress.events("limit").is_empty());
    assert!(store.outbox(1, "limit").is_empty());

    request.rows.truncate(1);
    request.header_row_count = 1;
    assert_eq!(
        execute_batch(&request, &mut store, &mut progress),
        Err(ExecuteError::Plan(PlanError::HeaderRowsUnsupported {
            count: 1
        }))
    );
    assert!(progress.events("limit").is_empty());
}

#[test]
fn batch_update_success() {
    let request = command("update-success", vec![row(0, Some("10")), row(1, None)]);
    let (store, _, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Success);
    assert_eq!(result.committed, [0, 1]);
    assert_eq!(store.undo_intents(1, "update-success").len(), 2);
    assert_eq!(
        store
            .outbox(1, "update-success")
            .iter()
            .filter(|record| record.kind == "undo")
            .count(),
        2
    );
}

#[test]
fn branch_coverage() {
    let success = run(&command("branch-success", vec![row(0, None)])).2;
    assert_eq!(success.status, TerminalStatus::Success);

    let mut partial_request = command("branch-partial", vec![row(0, None), row(1, None)]);
    partial_request
        .validation_failures
        .insert(1, "invalid".to_owned());
    let partial = run(&partial_request).2;
    assert_eq!(partial.status, TerminalStatus::Success);

    let mut failed_request = command("branch-failed", vec![row(0, None)]);
    failed_request.dependency_failure = Some("metadata unavailable".to_owned());
    let failed = run(&failed_request).2;
    assert_eq!(failed.status, TerminalStatus::Failed);
}

#[test]
fn chunked_paste_progress() {
    let mut ledger = MemoryChunkLedger::default();
    let first = ledger
        .decide(
            ChunkKey {
                tenant_id: 1,
                client_session_id: "paste-1".to_owned(),
                chunk_no: 0,
            },
            REQUEST_HASH_A,
            false,
            "SUCCESS",
            2,
            0,
        )
        .unwrap();
    assert!(matches!(first, ChunkDecision::Stored(_)));
    let final_key = ChunkKey {
        tenant_id: 1,
        client_session_id: "paste-1".to_owned(),
        chunk_no: 1,
    };
    let final_result = ledger
        .decide(
            final_key.clone(),
            REQUEST_HASH_B,
            true,
            "PARTIAL_FAILED",
            1,
            1,
        )
        .unwrap();
    assert!(matches!(final_result, ChunkDecision::Stored(_)));
    assert!(matches!(
        ledger
            .decide(
                final_key.clone(),
                REQUEST_HASH_B,
                true,
                "PARTIAL_FAILED",
                1,
                1
            )
            .unwrap(),
        ChunkDecision::Replayed(_)
    ));
    assert_eq!(
        ledger.decide(final_key, REQUEST_HASH_A, true, "SUCCESS", 2, 0),
        Err(ChunkError::HashConflict)
    );
    assert_eq!(
        ledger.decide(
            ChunkKey {
                tenant_id: 1,
                client_session_id: "paste-1".to_owned(),
                chunk_no: 2,
            },
            REQUEST_HASH_A,
            false,
            "SUCCESS",
            1,
            0,
        ),
        Err(ChunkError::SessionClosed)
    );
}

#[test]
fn concurrent_write() {
    let key = CoordinationKey {
        tenant_id: 1,
        panel_id: 10,
    };
    let mut lease = MemoryBatchRefreshLease::default();
    lease
        .acquire(key.clone(), "batch-a", LeaseMode::BatchShared, 100, 20)
        .unwrap();
    lease
        .acquire(key.clone(), "batch-b", LeaseMode::BatchShared, 100, 20)
        .unwrap();
    assert_eq!(
        lease.acquire(
            key.clone(),
            "refresh-a",
            LeaseMode::RefreshExclusive,
            100,
            20
        ),
        Err(LeaseError::Busy)
    );
    lease.renew(&key, "batch-a", 110, 20).unwrap();
    lease.release(&key, "batch-b").unwrap();
    assert_eq!(
        lease.release(&key, "wrong-owner"),
        Err(LeaseError::OwnerMissing)
    );
    lease.release(&key, "batch-a").unwrap();
    lease
        .acquire(
            key.clone(),
            "refresh-a",
            LeaseMode::RefreshExclusive,
            121,
            20,
        )
        .unwrap();
    assert_eq!(
        lease.acquire(key, "batch-c", LeaseMode::BatchShared, 121, 20),
        Err(LeaseError::Busy)
    );
}

#[test]
fn context_isolation() {
    let mut store = MemoryBatchStore::default();
    let mut progress = ProgressJournal::default();
    let first = command("tenant-1", vec![row(0, Some("shared-key"))]);
    execute_batch(&first, &mut store, &mut progress).unwrap();

    let mut second = command("tenant-2", vec![row(0, Some("shared-key"))]);
    second.context = context(2, 10);
    execute_batch(&second, &mut store, &mut progress).unwrap();
    assert_eq!(
        store
            .row(&first.context, "shared-key")
            .unwrap()
            .context
            .tenant_id,
        1
    );
    assert_eq!(
        store
            .row(&second.context, "shared-key")
            .unwrap()
            .context
            .tenant_id,
        2
    );
}

#[test]
fn dependency_failure() {
    let mut request = command("dependency", vec![row(0, None), row(1, None)]);
    request.dependency_failure = Some("metadata service unavailable".to_owned());
    let (store, _, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Failed);
    assert!(result.committed.is_empty());
    assert!(
        result
            .failures
            .iter()
            .all(|failure| failure.phase == FailurePhase::Dependency)
    );
    assert!(store.undo_intents(1, "dependency").is_empty());
}

#[test]
fn entrypoint_parity() {
    let request = command("entrypoint", vec![row(0, None), row(1, Some("2"))]);
    let mut http_store = MemoryBatchStore::default();
    let mut http_progress = ProgressJournal::default();
    let http = invoke(
        Entrypoint::Http,
        &request,
        &mut http_store,
        &mut http_progress,
    )
    .unwrap()
    .0;
    let mut rpc_store = MemoryBatchStore::default();
    let mut rpc_progress = ProgressJournal::default();
    let rpc = invoke(Entrypoint::Rpc, &request, &mut rpc_store, &mut rpc_progress)
        .unwrap()
        .0;
    assert_eq!(http, rpc);
    assert!(HTTP_PATH.ends_with("/batchUpdateWithProgress"));
    assert!(RPC_METHOD.ends_with(".batchUpdateWithProgress"));
}

#[test]
fn horizontal_batch_upsert() {
    let ctx = context(1, 10);
    let mut store = MemoryBatchStore::default();
    store.seed_row(StoredRow {
        context: ctx.clone(),
        primary_key: "existing".to_owned(),
        values: BTreeMap::from([("name".to_owned(), "old".to_owned())]),
        horizontal_values: BTreeMap::new(),
    });
    let mut update = row(0, Some("existing"));
    update.horizontal_values.insert(
        "quarter".to_owned(),
        BTreeMap::from([
            ("Q1".to_owned(), "10".to_owned()),
            ("Q2".to_owned(), "20".to_owned()),
        ]),
    );
    let mut insert = row(1, None);
    insert.horizontal_values.insert(
        "quarter".to_owned(),
        BTreeMap::from([("Q1".to_owned(), "30".to_owned())]),
    );
    let request = command("horizontal", vec![update, insert]);
    let mut progress = ProgressJournal::default();
    let result = execute_batch(&request, &mut store, &mut progress).unwrap();
    assert_eq!(result.committed, [0, 1]);
    assert_eq!(
        store.row(&ctx, "existing").unwrap().horizontal_values["quarter"]["Q2"],
        "20"
    );
    assert_eq!(
        store.row(&ctx, "horizontal-1").unwrap().horizontal_values["quarter"]["Q1"],
        "30"
    );
}

#[test]
fn post_commit_effect_failure() {
    let request = command("post-commit", vec![row(0, Some("10"))]);
    let (mut store, _, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Success);
    assert!(
        store
            .deliver(
                1,
                "post-commit:downstream:0",
                Some("event broker unavailable"),
                false,
            )
            .is_err()
    );
    let outbox = store.outbox(1, "post-commit");
    let downstream = outbox
        .iter()
        .find(|record| record.dedupe_key == "post-commit:downstream:0")
        .unwrap();
    assert_eq!(downstream.state, OutboxState::Pending);
    assert_eq!(downstream.attempts, 1);
    assert_eq!(store.undo_intents(1, "post-commit").len(), 1);
}

#[test]
fn primary_success() {
    let request = command("primary", vec![row(0, None)]);
    let mut store = MemoryBatchStore::default();
    let mut progress = ProgressJournal::default();
    let (response, result) = invoke(Entrypoint::Http, &request, &mut store, &mut progress).unwrap();
    assert_eq!(response.code, 200);
    assert_eq!(response.terminal, TerminalStatus::Success);
    assert_eq!(response.committed, [0]);
    assert_eq!(
        result.terminal_event.unwrap().terminal,
        Some(TerminalStatus::Success)
    );
}

#[test]
fn progress_event_shape() {
    let request = command("progress-shape", vec![row(0, None), row(1, None)]);
    let (mut store, mut progress, first) = run(&request);
    let events = progress.events("progress-shape");
    assert_eq!(events.len(), 4);
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(
        events.iter().map(|event| event.stage).collect::<Vec<_>>(),
        [
            ProgressStage::Accepted,
            ProgressStage::Validating,
            ProgressStage::Writing,
            ProgressStage::Terminal,
        ]
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.terminal.is_some())
            .count(),
        1
    );
    assert_eq!(
        first.terminal_event.as_ref().unwrap().committed
            + first.terminal_event.as_ref().unwrap().failed,
        2
    );

    let replay = execute_batch(&request, &mut store, &mut progress).unwrap();
    assert_eq!(replay.replayed, [0, 1]);
    assert_eq!(progress.events("progress-shape"), events);
}

#[test]
fn scale_boundary() {
    let request = command(
        "scale",
        (0..DEFAULT_ROW_LIMIT)
            .map(|index| row(index, None))
            .collect(),
    );
    let (store, progress, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Success);
    assert_eq!(result.committed.len(), DEFAULT_ROW_LIMIT);
    assert_eq!(store.undo_intents(1, "scale").len(), DEFAULT_ROW_LIMIT);
    assert_eq!(progress.events("scale").len(), 4);
}

#[test]
fn schema_transition_failure() {
    let key = TransitionKey {
        tenant_id: 1,
        panel_id: 10,
        operation_id: "add_status".to_owned(),
    };
    let change = SchemaChange::AddColumn {
        table: "ledger_10".to_owned(),
        column: "status".to_owned(),
        column_type: ColumnType::Varchar { length: 32 },
    };
    let trace = MemoryTrace::default();
    let mut lease = MemoryLease::with_trace(trace.clone());
    let mut ledger = MemoryLedger::with_trace(trace);
    let mut executor = MemorySchemaExecutor::default();
    executor.fail_next = Some("DDL unavailable".to_owned());
    assert!(matches!(
        ensure_schema(
            &key,
            REQUEST_HASH_A,
            "schema-owner",
            &change,
            &mut lease,
            &mut ledger,
            &mut executor,
        ),
        Err(TransitionError::Execution { .. })
    ));
    assert!(matches!(
        ledger.records[&key].status,
        TransitionStatus::Failed { .. }
    ));
    assert_eq!(
        ensure_schema(
            &key,
            REQUEST_HASH_A,
            "schema-owner-retry",
            &change,
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap(),
        TransitionOutcome::Resumed { attempt: 2 }
    );
}

#[test]
fn transaction_failure() {
    let request = command(
        "transaction",
        vec![row(0, Some("10")), row(1, Some("11")), row(2, None)],
    );
    let mut store = MemoryBatchStore::default();
    store.fail_transaction(1, "deadlock");
    let mut progress = ProgressJournal::default();
    let result = execute_batch(&request, &mut store, &mut progress).unwrap();
    assert_eq!(result.status, TerminalStatus::PartialFailed);
    assert_eq!(result.committed, [0, 2]);
    assert_eq!(result.failures[0].phase, FailurePhase::Transaction);
    assert!(store.row(&request.context, "11").is_none());
    assert!(committed_and_undo_match(&store, 1, "transaction", &[0, 2]));
}

#[test]
fn undo_excludes_failed_rows() {
    let mut request = command(
        "undo-filter",
        vec![row(0, Some("10")), row(1, Some("11")), row(2, None)],
    );
    request
        .validation_failures
        .insert(1, "permission denied".to_owned());
    let (mut store, _, result) = run(&request);
    assert_eq!(result.committed, [0, 2]);
    let undo_indexes = store
        .undo_intents(1, "undo-filter")
        .iter()
        .map(|intent| intent.row_index)
        .collect::<Vec<_>>();
    assert_eq!(undo_indexes, [0, 2]);
    assert!(
        store
            .deliver(
                1,
                "undo-filter:undo:0",
                Some("undo materializer rejected payload"),
                true,
            )
            .is_err()
    );
    assert_eq!(
        store
            .outbox(1, "undo-filter")
            .iter()
            .find(|record| record.dedupe_key == "undo-filter:undo:0")
            .unwrap()
            .state,
        OutboxState::PermanentlyFailed
    );
}

#[test]
fn validation_failure() {
    let mut request = command("validation", vec![row(0, None), row(1, None)]);
    request
        .validation_failures
        .insert(0, "required field missing".to_owned());
    request
        .validation_failures
        .insert(1, "type mismatch".to_owned());
    let (store, progress, result) = run(&request);
    assert_eq!(result.status, TerminalStatus::Success);
    assert!(result.committed.is_empty());
    assert!(result.terminal_event.is_none());
    assert!(progress.events("validation").is_empty());
    assert_eq!(result.failures.len(), 2);
    assert!(
        result
            .failures
            .iter()
            .all(|failure| failure.phase == FailurePhase::Validation)
    );
    assert!(store.undo_intents(1, "validation").is_empty());
    assert!(store.outbox(1, "validation").is_empty());
}

#[test]
fn web_rpc_entrypoint_parity() {
    let mut request = command("web-rpc", vec![row(0, None), row(1, None)]);
    request.validation_failures.insert(1, "invalid".to_owned());
    let mut web_store = MemoryBatchStore::default();
    let mut web_progress = ProgressJournal::default();
    let web = invoke(
        Entrypoint::WebRpc,
        &request,
        &mut web_store,
        &mut web_progress,
    )
    .unwrap()
    .0;
    let mut http_store = MemoryBatchStore::default();
    let mut http_progress = ProgressJournal::default();
    let http = invoke(
        Entrypoint::Http,
        &request,
        &mut http_store,
        &mut http_progress,
    )
    .unwrap()
    .0;
    assert_eq!(web, http);
    assert!(WEB_RPC_METHOD.ends_with(".batchUpdateWithProgress"));
}
