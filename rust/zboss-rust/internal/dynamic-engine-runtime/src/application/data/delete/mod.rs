//! Offline executable contract for the zboss batch-delete migration.
//!
//! The reference Java source remains read-only. This model makes the transaction,
//! replay, progress and after-commit compensation boundaries explicit so they can
//! be exercised before a production MySQL/Redis adapter is introduced.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub mod adapters;
pub mod runtime;

pub const MIGRATION_PROJECT_ID: &str = "zboss-batch-delete";
pub const HTTP_PATH: &str = "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchDelete";
pub const MAX_ROWS: usize = 10_000;
pub const COMPENSATION_STEPS: [&str; 9] = [
    "child-form-cascade",
    "same-panel-derived-cascade",
    "select-ref-cascade",
    "color-shadow-sync",
    "sync-relation-cleanup",
    "audit-and-snapshot-link",
    "bill-cleanup",
    "page-ref-refresh",
    "page-query-cache-invalidate",
];

/// Production persistence boundary. Implementations must keep the idempotency
/// decision, snapshots, soft delete, undo anchors and compensation outbox in
/// one MySQL transaction.
pub trait BatchDeleteStore {
    type Command;
    type Outcome;

    fn commit_delete(&mut self, command: &Self::Command) -> Result<Self::Outcome, String>;
    fn find_replay(
        &mut self,
        tenant_id: u64,
        idempotency_key: &str,
    ) -> Result<Option<Self::Outcome>, String>;
}

/// Durable ordered compensation boundary. Claim, complete and fail transitions
/// must be owner-token checked and idempotent.
pub trait CompensationOutbox {
    type Claim;

    fn claim_next(
        &mut self,
        batch_id: &str,
        owner_token: &str,
    ) -> Result<Option<Self::Claim>, String>;
    fn complete_step(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
    ) -> Result<(), String>;
    fn fail_step(
        &mut self,
        batch_id: &str,
        step_index: usize,
        owner_token: &str,
        error: &str,
    ) -> Result<(), String>;
}

/// Progress transport boundary. The sink must reject out-of-order events and
/// guarantee one logical terminal state per batch.
pub trait ProgressSink {
    fn publish(&mut self, event: &ProgressEvent, event_hash: &str) -> Result<String, String>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub tenant_id: u64,
    pub user_id: u64,
    pub request_id: String,
    pub idempotency_key: String,
    pub inter_id: u64,
    pub http_id: u64,
    pub use_page_id: u64,
    pub panel_id: u64,
    pub row_ids: Vec<u64>,
    pub operation_kind: String,
    pub operation_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: u64,
    pub active: bool,
    pub referenced: bool,
    pub version: u64,
}

impl Row {
    pub fn active(id: u64) -> Self {
        Self {
            id,
            active: true,
            referenced: false,
            version: 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProgressState {
    Running,
    MainCommitted,
    CompensationRetrying,
    Success,
    Failed,
    CompensationFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub batch_id: String,
    pub sequence: u64,
    pub state: ProgressState,
    pub requested: usize,
    pub deleted: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub row_id: u64,
    pub active: bool,
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoAnchor {
    pub request_id: String,
    pub row_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StepState {
    Pending,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompensationStep {
    pub name: String,
    pub state: StepState,
    pub attempts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompensationTask {
    pub request_id: String,
    pub batch_id: String,
    pub row_ids: Vec<u64>,
    pub steps: Vec<CompensationStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResponse {
    pub http_status: u16,
    pub code: String,
    pub request_id: String,
    pub batch_id: String,
    pub deleted_row_ids: Vec<u64>,
    pub skipped_row_ids: Vec<u64>,
    pub replayed: bool,
    pub main_committed: bool,
    pub progress_state: ProgressState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeleteErrorCode {
    EmptyBatch,
    RowLimitExceeded,
    InvalidOperationKind,
    MissingActiveRow,
    IdempotencyConflict,
    ConcurrentMutation,
    SnapshotWriteFailed,
    SoftDeleteFailed,
    UndoWriteFailed,
    OutboxWriteFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteError {
    pub code: DeleteErrorCode,
    pub message: String,
}

impl DeleteError {
    fn new(code: DeleteErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fault {
    #[default]
    None,
    Snapshot,
    SoftDelete,
    Undo,
    Outbox,
    CompensationStep(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReplayDecision {
    request_hash: String,
    response: DeleteResponse,
}

#[derive(Clone, Debug, Default)]
pub struct MemoryStore {
    pub rows: BTreeMap<u64, Row>,
    pub snapshots: Vec<Snapshot>,
    pub undo_anchors: Vec<UndoAnchor>,
    pub compensation_tasks: Vec<CompensationTask>,
    pub progress: Vec<ProgressEvent>,
    replay: BTreeMap<String, ReplayDecision>,
    panel_owners: BTreeMap<(u64, u64), String>,
    next_sequence: u64,
}

impl MemoryStore {
    pub fn seed_rows(&mut self, rows: impl IntoIterator<Item = Row>) {
        self.rows.extend(rows.into_iter().map(|row| (row.id, row)));
    }

    pub fn acquire_panel_for_test(
        &mut self,
        tenant_id: u64,
        panel_id: u64,
        owner: impl Into<String>,
    ) -> bool {
        self.panel_owners
            .insert((tenant_id, panel_id), owner.into())
            .is_none()
    }

    pub fn release_panel_for_test(&mut self, tenant_id: u64, panel_id: u64) {
        self.panel_owners.remove(&(tenant_id, panel_id));
    }

    pub fn execute(
        &mut self,
        request: &DeleteRequest,
        fault: Fault,
    ) -> Result<DeleteResponse, DeleteError> {
        let row_ids = normalize_and_validate(request)?;
        let request_hash = request_hash(request, &row_ids);
        let replay_key = format!("{}:{}", request.tenant_id, request.idempotency_key);
        if let Some(decision) = self.replay.get(&replay_key) {
            if decision.request_hash != request_hash {
                return Err(DeleteError::new(
                    DeleteErrorCode::IdempotencyConflict,
                    "idempotency key was already used by a different request",
                ));
            }
            let mut response = decision.response.clone();
            response.replayed = true;
            return Ok(response);
        }

        let lock_key = (request.tenant_id, request.panel_id);
        let owner = format!("delete:{}", request.request_id);
        if self.panel_owners.contains_key(&lock_key) {
            return Err(DeleteError::new(
                DeleteErrorCode::ConcurrentMutation,
                "tenant-panel mutation gate is already owned",
            ));
        }
        self.panel_owners.insert(lock_key, owner);

        let batch_id = format!("bd-{}", request.request_id);
        self.push_progress(&batch_id, ProgressState::Running, row_ids.len(), 0, 0);
        let result = self.execute_locked(
            request,
            &row_ids,
            &request_hash,
            &replay_key,
            &batch_id,
            fault,
        );
        self.panel_owners.remove(&lock_key);
        result
    }

    fn execute_locked(
        &mut self,
        request: &DeleteRequest,
        row_ids: &[u64],
        request_hash: &str,
        replay_key: &str,
        batch_id: &str,
        fault: Fault,
    ) -> Result<DeleteResponse, DeleteError> {
        let missing = row_ids
            .iter()
            .filter(|id| !self.rows.get(id).is_some_and(|row| row.active))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return self.fail(
                batch_id,
                row_ids.len(),
                DeleteErrorCode::MissingActiveRow,
                format!("requested rows are not active: {missing:?}"),
            );
        }

        let skipped = row_ids
            .iter()
            .filter(|id| self.rows.get(id).is_some_and(|row| row.referenced))
            .copied()
            .collect::<Vec<_>>();
        let skipped_set = skipped.iter().copied().collect::<BTreeSet<_>>();
        let deletable = row_ids
            .iter()
            .filter(|id| !skipped_set.contains(id))
            .copied()
            .collect::<Vec<_>>();

        if deletable.is_empty() {
            let response = DeleteResponse {
                http_status: 200,
                code: "OK".into(),
                request_id: request.request_id.clone(),
                batch_id: batch_id.into(),
                deleted_row_ids: Vec::new(),
                skipped_row_ids: skipped,
                replayed: false,
                main_committed: true,
                progress_state: ProgressState::Success,
            };
            self.push_progress(
                batch_id,
                ProgressState::MainCommitted,
                row_ids.len(),
                0,
                response.skipped_row_ids.len(),
            );
            self.push_progress(
                batch_id,
                ProgressState::Success,
                row_ids.len(),
                0,
                response.skipped_row_ids.len(),
            );
            self.replay.insert(
                replay_key.into(),
                ReplayDecision {
                    request_hash: request_hash.into(),
                    response: response.clone(),
                },
            );
            return Ok(response);
        }

        let mut staged = self.clone();
        for row_id in &deletable {
            let row = staged.rows.get(row_id).expect("validated active row");
            staged.snapshots.push(Snapshot {
                row_id: *row_id,
                active: row.active,
                version: row.version,
            });
        }
        if fault == Fault::Snapshot {
            return self.fail(
                batch_id,
                row_ids.len(),
                DeleteErrorCode::SnapshotWriteFailed,
                "injected snapshot write failure",
            );
        }

        for row_id in &deletable {
            let row = staged.rows.get_mut(row_id).expect("validated active row");
            row.active = false;
            row.version += 1;
        }
        if fault == Fault::SoftDelete {
            return self.fail(
                batch_id,
                row_ids.len(),
                DeleteErrorCode::SoftDeleteFailed,
                "injected soft-delete failure",
            );
        }

        staged
            .undo_anchors
            .extend(deletable.iter().map(|row_id| UndoAnchor {
                request_id: request.request_id.clone(),
                row_id: *row_id,
            }));
        if fault == Fault::Undo {
            return self.fail(
                batch_id,
                row_ids.len(),
                DeleteErrorCode::UndoWriteFailed,
                "injected undo-anchor failure",
            );
        }

        staged.compensation_tasks.push(CompensationTask {
            request_id: request.request_id.clone(),
            batch_id: batch_id.into(),
            row_ids: deletable.clone(),
            steps: COMPENSATION_STEPS
                .iter()
                .map(|name| CompensationStep {
                    name: (*name).into(),
                    state: StepState::Pending,
                    attempts: 0,
                })
                .collect(),
        });
        if fault == Fault::Outbox {
            return self.fail(
                batch_id,
                row_ids.len(),
                DeleteErrorCode::OutboxWriteFailed,
                "injected compensation-outbox failure",
            );
        }

        let mut response = DeleteResponse {
            http_status: 200,
            code: "OK".into(),
            request_id: request.request_id.clone(),
            batch_id: batch_id.into(),
            deleted_row_ids: deletable,
            skipped_row_ids: skipped,
            replayed: false,
            main_committed: true,
            progress_state: ProgressState::MainCommitted,
        };
        staged.push_progress(
            batch_id,
            ProgressState::MainCommitted,
            row_ids.len(),
            response.deleted_row_ids.len(),
            response.skipped_row_ids.len(),
        );
        staged.replay.insert(
            replay_key.into(),
            ReplayDecision {
                request_hash: request_hash.into(),
                response: response.clone(),
            },
        );
        *self = staged;

        let compensation_fault = match fault {
            Fault::CompensationStep(index) => Some(index),
            _ => None,
        };
        self.run_compensation(batch_id, compensation_fault);
        response.progress_state = self
            .progress
            .last()
            .map(|event| event.state)
            .unwrap_or(ProgressState::Failed);
        if let Some(decision) = self.replay.get_mut(replay_key) {
            decision.response = response.clone();
        }
        Ok(response)
    }

    pub fn retry_compensation(&mut self, batch_id: &str) -> Option<ProgressState> {
        let task = self
            .compensation_tasks
            .iter_mut()
            .find(|task| task.batch_id == batch_id)?;
        for step in &mut task.steps {
            if step.state == StepState::Failed {
                step.state = StepState::Pending;
            }
        }
        self.run_compensation(batch_id, None);
        self.progress.last().map(|event| event.state)
    }

    pub fn mark_compensation_exhausted(&mut self, batch_id: &str) -> Option<ProgressState> {
        let task = self
            .compensation_tasks
            .iter()
            .find(|task| task.batch_id == batch_id)?;
        if !task
            .steps
            .iter()
            .any(|step| step.state == StepState::Failed)
        {
            return None;
        }
        if self.progress.last().is_some_and(|event| {
            event.batch_id == batch_id && event.state == ProgressState::CompensationFailed
        }) {
            return Some(ProgressState::CompensationFailed);
        }
        let requested = task.row_ids.len();
        self.push_progress(
            batch_id,
            ProgressState::CompensationFailed,
            requested,
            requested,
            0,
        );
        self.update_replay_progress(batch_id, ProgressState::CompensationFailed);
        Some(ProgressState::CompensationFailed)
    }

    fn run_compensation(&mut self, batch_id: &str, fault_index: Option<usize>) {
        let Some(task_index) = self
            .compensation_tasks
            .iter()
            .position(|task| task.batch_id == batch_id)
        else {
            return;
        };
        let requested = self.compensation_tasks[task_index].row_ids.len();
        for index in 0..self.compensation_tasks[task_index].steps.len() {
            let step = &mut self.compensation_tasks[task_index].steps[index];
            if step.state == StepState::Completed {
                continue;
            }
            step.attempts += 1;
            if fault_index == Some(index) {
                step.state = StepState::Failed;
                self.push_progress(
                    batch_id,
                    ProgressState::CompensationRetrying,
                    requested,
                    requested,
                    0,
                );
                self.update_replay_progress(batch_id, ProgressState::CompensationRetrying);
                return;
            }
            step.state = StepState::Completed;
        }
        self.push_progress(batch_id, ProgressState::Success, requested, requested, 0);
        self.update_replay_progress(batch_id, ProgressState::Success);
    }

    fn update_replay_progress(&mut self, batch_id: &str, state: ProgressState) {
        for decision in self.replay.values_mut() {
            if decision.response.batch_id == batch_id {
                decision.response.progress_state = state;
            }
        }
    }

    fn fail<T>(
        &mut self,
        batch_id: &str,
        requested: usize,
        code: DeleteErrorCode,
        message: impl Into<String>,
    ) -> Result<T, DeleteError> {
        self.push_progress(batch_id, ProgressState::Failed, requested, 0, 0);
        Err(DeleteError::new(code, message))
    }

    fn push_progress(
        &mut self,
        batch_id: &str,
        state: ProgressState,
        requested: usize,
        deleted: usize,
        skipped: usize,
    ) {
        self.next_sequence += 1;
        self.progress.push(ProgressEvent {
            batch_id: batch_id.into(),
            sequence: self.next_sequence,
            state,
            requested,
            deleted,
            skipped,
        });
    }
}

pub fn request_hash(request: &DeleteRequest, normalized_row_ids: &[u64]) -> String {
    let stable = serde_json::json!({
        "tenantId": request.tenant_id,
        "userId": request.user_id,
        "interId": request.inter_id,
        "httpId": request.http_id,
        "usePageId": request.use_page_id,
        "panelId": request.panel_id,
        "rowIds": normalized_row_ids,
        "operationKind": request.operation_kind,
        "operationLabel": request.operation_label,
    });
    format!("{:x}", Sha256::digest(stable.to_string().as_bytes()))
}

fn normalize_and_validate(request: &DeleteRequest) -> Result<Vec<u64>, DeleteError> {
    if request.operation_kind != "ROW_DELETE" {
        return Err(DeleteError::new(
            DeleteErrorCode::InvalidOperationKind,
            "operationKind must be ROW_DELETE",
        ));
    }
    let mut seen = BTreeSet::new();
    let row_ids = request
        .row_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect::<Vec<_>>();
    if row_ids.is_empty() {
        return Err(DeleteError::new(
            DeleteErrorCode::EmptyBatch,
            "batchPostValueList must contain at least one id",
        ));
    }
    if row_ids.len() > MAX_ROWS {
        return Err(DeleteError::new(
            DeleteErrorCode::RowLimitExceeded,
            format!("batch delete accepts at most {MAX_ROWS} distinct rows"),
        ));
    }
    Ok(row_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDS: [u64; 3] = [
        2_082_397_610_825_953_281,
        2_082_397_610_809_176_066,
        2_082_397_610_804_981_762,
    ];

    fn request() -> DeleteRequest {
        DeleteRequest {
            tenant_id: 2_059_823_220_968_001_539,
            user_id: 1,
            request_id: "real-ledger-delete-001".into(),
            idempotency_key: "real-ledger-delete-001".into(),
            inter_id: 2_082_276_810_223_452_163,
            http_id: 2_082_276_811_863_425_027,
            use_page_id: 2_082_276_811_842_453_506,
            panel_id: 2_082_276_811_427_217_409,
            row_ids: IDS.to_vec(),
            operation_kind: "ROW_DELETE".into(),
            operation_label: "3 行".into(),
        }
    }

    fn store() -> MemoryStore {
        let mut store = MemoryStore::default();
        store.seed_rows(IDS.into_iter().map(Row::active));
        store
    }

    #[test]
    fn success_commits_rows_snapshots_undo_outbox_and_terminal_progress() {
        let mut store = store();
        let response = store.execute(&request(), Fault::None).unwrap();
        assert_eq!(response.deleted_row_ids, IDS);
        assert_eq!(response.progress_state, ProgressState::Success);
        assert!(IDS.iter().all(|id| !store.rows[id].active));
        assert_eq!(store.snapshots.len(), 3);
        assert_eq!(store.undo_anchors.len(), 3);
        assert_eq!(store.compensation_tasks.len(), 1);
        assert!(
            store.compensation_tasks[0]
                .steps
                .iter()
                .all(|step| step.state == StepState::Completed)
        );
        assert_eq!(
            store
                .progress
                .iter()
                .map(|event| event.state)
                .collect::<Vec<_>>(),
            [
                ProgressState::Running,
                ProgressState::MainCommitted,
                ProgressState::Success
            ]
        );
    }

    #[test]
    fn referenced_rows_are_skipped_while_other_rows_commit() {
        let mut store = store();
        store.rows.get_mut(&IDS[1]).unwrap().referenced = true;
        let response = store.execute(&request(), Fault::None).unwrap();
        assert_eq!(response.deleted_row_ids, [IDS[0], IDS[2]]);
        assert_eq!(response.skipped_row_ids, [IDS[1]]);
        assert!(store.rows[&IDS[1]].active);
        assert_eq!(store.snapshots.len(), 2);
        assert_eq!(store.undo_anchors.len(), 2);
    }

    #[test]
    fn all_referenced_rows_return_success_without_write_side_effects() {
        let mut store = store();
        for row in store.rows.values_mut() {
            row.referenced = true;
        }
        let response = store.execute(&request(), Fault::None).unwrap();
        assert!(response.deleted_row_ids.is_empty());
        assert_eq!(response.skipped_row_ids, IDS);
        assert!(store.snapshots.is_empty());
        assert!(store.undo_anchors.is_empty());
        assert!(store.compensation_tasks.is_empty());
    }

    #[test]
    fn missing_active_row_rejects_the_whole_batch() {
        let mut store = store();
        store.rows.get_mut(&IDS[2]).unwrap().active = false;
        let error = store.execute(&request(), Fault::None).unwrap_err();
        assert_eq!(error.code, DeleteErrorCode::MissingActiveRow);
        assert!(store.rows[&IDS[0]].active);
        assert!(store.snapshots.is_empty());
    }

    #[test]
    fn every_main_transaction_fault_rolls_back_rows_snapshots_undo_and_outbox() {
        for fault in [
            Fault::Snapshot,
            Fault::SoftDelete,
            Fault::Undo,
            Fault::Outbox,
        ] {
            let mut store = store();
            assert!(store.execute(&request(), fault).is_err());
            assert!(IDS.iter().all(|id| store.rows[id].active));
            assert!(store.snapshots.is_empty());
            assert!(store.undo_anchors.is_empty());
            assert!(store.compensation_tasks.is_empty());
            assert_eq!(store.progress.last().unwrap().state, ProgressState::Failed);
        }
    }

    #[test]
    fn identical_replay_returns_stored_decision_without_repeating_effects() {
        let mut store = store();
        store.execute(&request(), Fault::None).unwrap();
        let counts = (
            store.snapshots.len(),
            store.undo_anchors.len(),
            store.compensation_tasks.len(),
            store.progress.len(),
        );
        let replay = store.execute(&request(), Fault::None).unwrap();
        assert!(replay.replayed);
        assert_eq!(
            counts,
            (
                store.snapshots.len(),
                store.undo_anchors.len(),
                store.compensation_tasks.len(),
                store.progress.len()
            )
        );
    }

    #[test]
    fn idempotency_hash_conflict_is_rejected_before_effects() {
        let mut store = store();
        store.execute(&request(), Fault::None).unwrap();
        let mut conflict = request();
        conflict.row_ids = vec![IDS[0]];
        let error = store.execute(&conflict, Fault::None).unwrap_err();
        assert_eq!(error.code, DeleteErrorCode::IdempotencyConflict);
    }

    #[test]
    fn failed_compensation_is_durable_observable_and_resumable_in_order() {
        let mut store = store();
        let response = store
            .execute(&request(), Fault::CompensationStep(5))
            .unwrap();
        assert_eq!(response.progress_state, ProgressState::CompensationRetrying);
        assert!(IDS.iter().all(|id| !store.rows[id].active));
        let task = &store.compensation_tasks[0];
        assert!(
            task.steps[..5]
                .iter()
                .all(|step| step.state == StepState::Completed)
        );
        assert_eq!(task.steps[5].state, StepState::Failed);
        assert!(
            task.steps[6..]
                .iter()
                .all(|step| step.state == StepState::Pending)
        );
        assert_eq!(
            store.retry_compensation(&response.batch_id),
            Some(ProgressState::Success)
        );
        assert_eq!(store.compensation_tasks[0].steps[5].attempts, 2);
    }

    #[test]
    fn exhausted_compensation_emits_one_permanent_terminal() {
        let mut store = store();
        let response = store
            .execute(&request(), Fault::CompensationStep(5))
            .unwrap();
        assert_eq!(
            store.mark_compensation_exhausted(&response.batch_id),
            Some(ProgressState::CompensationFailed)
        );
        let event_count = store.progress.len();
        assert_eq!(
            store.mark_compensation_exhausted(&response.batch_id),
            Some(ProgressState::CompensationFailed)
        );
        assert_eq!(store.progress.len(), event_count);
    }

    #[test]
    fn same_panel_delete_and_update_are_serialized_by_the_mutation_gate() {
        let mut store = store();
        let request = request();
        assert!(store.acquire_panel_for_test(
            request.tenant_id,
            request.panel_id,
            "concurrent-update"
        ));
        let error = store.execute(&request, Fault::None).unwrap_err();
        assert_eq!(error.code, DeleteErrorCode::ConcurrentMutation);
        assert!(IDS.iter().all(|id| store.rows[id].active));
        store.release_panel_for_test(request.tenant_id, request.panel_id);
        assert!(store.execute(&request, Fault::None).is_ok());
    }

    #[test]
    fn duplicate_ids_are_normalized_in_first_occurrence_order() {
        let mut store = store();
        let mut request = request();
        request.row_ids = vec![IDS[1], IDS[0], IDS[1], IDS[2], IDS[0]];
        let response = store.execute(&request, Fault::None).unwrap();
        assert_eq!(response.deleted_row_ids, [IDS[1], IDS[0], IDS[2]]);
        assert_eq!(store.snapshots.len(), 3);
    }

    #[test]
    fn invalid_operation_and_row_limit_fail_before_progress() {
        let mut store = store();
        let mut invalid = request();
        invalid.operation_kind = "PASTE".into();
        assert_eq!(
            store.execute(&invalid, Fault::None).unwrap_err().code,
            DeleteErrorCode::InvalidOperationKind
        );
        let mut too_large = request();
        too_large.row_ids = (1..=(MAX_ROWS as u64 + 1)).collect();
        assert_eq!(
            store.execute(&too_large, Fault::None).unwrap_err().code,
            DeleteErrorCode::RowLimitExceeded
        );
        assert!(store.progress.is_empty());
    }
}
