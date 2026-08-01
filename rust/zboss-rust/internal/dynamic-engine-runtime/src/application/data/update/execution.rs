use std::collections::{BTreeMap, BTreeSet};

use crate::application::data::update::batch::{BatchRow, PlanError, plan_batch};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExecutionContext {
    pub tenant_id: u64,
    pub panel_id: u64,
    pub datasource: String,
    pub actor_id: u64,
    pub trace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowCommand {
    pub index: usize,
    pub primary_key: Option<String>,
    pub values: BTreeMap<String, String>,
    pub horizontal_values: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchCommand {
    pub context: ExecutionContext,
    pub batch_id: String,
    pub rows: Vec<RowCommand>,
    pub header_row_count: usize,
    pub validation_failures: BTreeMap<usize, String>,
    pub dependency_failure: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailurePhase {
    Validation,
    Dependency,
    Transaction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowFailure {
    pub index: usize,
    pub phase: FailurePhase,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStatus {
    Success,
    PartialFailed,
    Failed,
}

impl TerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "SUCCESS",
            Self::PartialFailed => "PARTIAL_FAILED",
            Self::Failed => "FAILED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProgressStage {
    Accepted,
    Validating,
    Writing,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressEvent {
    pub event_id: String,
    pub sequence: u32,
    pub stage: ProgressStage,
    pub committed: usize,
    pub failed: usize,
    pub total: usize,
    pub terminal: Option<TerminalStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressError {
    EventConflict,
    InvalidTransition,
}

#[derive(Debug, Default)]
pub struct ProgressJournal {
    events: BTreeMap<(String, u32), ProgressEvent>,
}

impl ProgressJournal {
    pub fn record(&mut self, batch_id: &str, event: ProgressEvent) -> Result<(), ProgressError> {
        validate_progress_event(&event)?;
        let key = (batch_id.to_owned(), event.sequence);
        if let Some(existing) = self.events.get(&key) {
            return if existing == &event {
                Ok(())
            } else {
                Err(ProgressError::EventConflict)
            };
        }
        if event.sequence > 0 {
            let previous = self
                .events
                .get(&(batch_id.to_owned(), event.sequence - 1))
                .ok_or(ProgressError::InvalidTransition)?;
            if event.stage < previous.stage
                || event.committed < previous.committed
                || event.failed < previous.failed
            {
                return Err(ProgressError::InvalidTransition);
            }
        }
        self.events.insert(key, event);
        Ok(())
    }

    pub fn events(&self, batch_id: &str) -> Vec<ProgressEvent> {
        self.events
            .iter()
            .filter(|((stored_batch_id, _), _)| stored_batch_id == batch_id)
            .map(|(_, event)| event.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxState {
    Pending,
    Delivered,
    PermanentlyFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRecord {
    pub dedupe_key: String,
    pub kind: String,
    pub row_index: Option<usize>,
    pub state: OutboxState,
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoIntent {
    pub row_index: usize,
    pub primary_key: String,
    pub before_values: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRow {
    pub context: ExecutionContext,
    pub primary_key: String,
    pub values: BTreeMap<String, String>,
    pub horizontal_values: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitDisposition {
    Applied,
    Replayed,
}

#[derive(Debug, Default)]
pub struct MemoryBatchStore {
    rows: BTreeMap<(u64, u64, String), StoredRow>,
    committed: BTreeMap<(u64, String, usize), String>,
    undo_intents: BTreeMap<(u64, String, usize), UndoIntent>,
    outbox: BTreeMap<(u64, String), OutboxRecord>,
    transaction_failures: BTreeMap<usize, String>,
}

impl MemoryBatchStore {
    pub fn fail_transaction(&mut self, row_index: usize, message: &str) {
        self.transaction_failures
            .insert(row_index, message.to_owned());
    }

    pub fn seed_row(&mut self, row: StoredRow) {
        self.rows.insert(
            (
                row.context.tenant_id,
                row.context.panel_id,
                row.primary_key.clone(),
            ),
            row,
        );
    }

    pub fn row(&self, context: &ExecutionContext, primary_key: &str) -> Option<&StoredRow> {
        self.rows
            .get(&(context.tenant_id, context.panel_id, primary_key.to_owned()))
    }

    pub fn undo_intents(&self, tenant_id: u64, batch_id: &str) -> Vec<UndoIntent> {
        self.undo_intents
            .iter()
            .filter(|((tenant, batch, _), _)| *tenant == tenant_id && batch == batch_id)
            .map(|(_, intent)| intent.clone())
            .collect()
    }

    pub fn outbox(&self, tenant_id: u64, batch_id: &str) -> Vec<OutboxRecord> {
        let prefix = format!("{batch_id}:");
        self.outbox
            .iter()
            .filter(|((tenant, dedupe), _)| *tenant == tenant_id && dedupe.starts_with(&prefix))
            .map(|(_, record)| record.clone())
            .collect()
    }

    pub fn deliver(
        &mut self,
        tenant_id: u64,
        dedupe_key: &str,
        failure: Option<&str>,
        permanent: bool,
    ) -> Result<(), &'static str> {
        let record = self
            .outbox
            .get_mut(&(tenant_id, dedupe_key.to_owned()))
            .ok_or("outbox record missing")?;
        record.attempts = record.attempts.saturating_add(1);
        if let Some(message) = failure {
            record.state = if permanent {
                OutboxState::PermanentlyFailed
            } else {
                OutboxState::Pending
            };
            record.last_error = Some(message.to_owned());
            return Err("outbox delivery failed");
        }
        record.state = OutboxState::Delivered;
        record.last_error = None;
        Ok(())
    }
}

pub trait BatchPersistencePort {
    fn commit_row(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        row: &RowCommand,
    ) -> Result<(CommitDisposition, String), String>;

    fn persist_terminal(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        status: TerminalStatus,
    ) -> Result<(), String>;
}

impl BatchPersistencePort for MemoryBatchStore {
    fn commit_row(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        row: &RowCommand,
    ) -> Result<(CommitDisposition, String), String> {
        let commit_key = (context.tenant_id, batch_id.to_owned(), row.index);
        if let Some(primary_key) = self.committed.get(&commit_key) {
            return Ok((CommitDisposition::Replayed, primary_key.clone()));
        }
        if let Some(message) = self.transaction_failures.get(&row.index) {
            return Err(message.clone());
        }
        let primary_key = row
            .primary_key
            .clone()
            .unwrap_or_else(|| format!("{batch_id}-{}", row.index));
        let row_key = (context.tenant_id, context.panel_id, primary_key.clone());
        let before_values = self.rows.get(&row_key).map(|stored| stored.values.clone());

        // This block models one database transaction: row mutation, commit marker,
        // undo intent and downstream outbox intent become visible together.
        self.rows.insert(
            row_key,
            StoredRow {
                context: context.clone(),
                primary_key: primary_key.clone(),
                values: row.values.clone(),
                horizontal_values: row.horizontal_values.clone(),
            },
        );
        self.committed.insert(commit_key, primary_key.clone());
        self.undo_intents.insert(
            (context.tenant_id, batch_id.to_owned(), row.index),
            UndoIntent {
                row_index: row.index,
                primary_key: primary_key.clone(),
                before_values,
            },
        );
        for kind in ["undo", "downstream"] {
            let dedupe_key = format!("{batch_id}:{kind}:{}", row.index);
            self.outbox.insert(
                (context.tenant_id, dedupe_key.clone()),
                OutboxRecord {
                    dedupe_key,
                    kind: kind.to_owned(),
                    row_index: Some(row.index),
                    state: OutboxState::Pending,
                    attempts: 0,
                    last_error: None,
                },
            );
        }
        Ok((CommitDisposition::Applied, primary_key))
    }

    fn persist_terminal(
        &mut self,
        context: &ExecutionContext,
        batch_id: &str,
        status: TerminalStatus,
    ) -> Result<(), String> {
        let dedupe_key = format!("{batch_id}:terminal");
        self.outbox
            .entry((context.tenant_id, dedupe_key.clone()))
            .or_insert(OutboxRecord {
                dedupe_key,
                kind: format!("terminal:{}", status.as_str()),
                row_index: None,
                state: OutboxState::Pending,
                attempts: 0,
                last_error: None,
            });
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchExecutionResult {
    pub status: TerminalStatus,
    pub committed: Vec<usize>,
    pub replayed: Vec<usize>,
    pub failures: Vec<RowFailure>,
    pub terminal_event: Option<ProgressEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecuteError {
    Plan(PlanError),
    Progress(ProgressError),
    Persistence {
        operation: &'static str,
        message: String,
    },
    InvalidContext(&'static str),
}

pub fn execute_batch<S>(
    command: &BatchCommand,
    store: &mut S,
    progress: &mut ProgressJournal,
) -> Result<BatchExecutionResult, ExecuteError>
where
    S: BatchPersistencePort,
{
    validate_context(&command.context)?;
    let batch_rows = command
        .rows
        .iter()
        .map(|row| BatchRow {
            index: row.index,
            primary_key: row.primary_key.clone(),
        })
        .collect::<Vec<_>>();
    let validation_positions = command
        .rows
        .iter()
        .enumerate()
        .filter(|(_, row)| command.validation_failures.contains_key(&row.index))
        .map(|(position, _)| position)
        .collect::<Vec<_>>();
    let plan = plan_batch(
        &batch_rows,
        command.header_row_count,
        &validation_positions,
        crate::application::data::update::batch::DEFAULT_ROW_LIMIT,
    )
    .map_err(ExecuteError::Plan)?;
    let total = plan.requested.len();
    let mut failures = command
        .validation_failures
        .iter()
        .filter(|(index, _)| plan.requested.contains(index))
        .map(|(index, message)| RowFailure {
            index: *index,
            phase: FailurePhase::Validation,
            message: message.clone(),
        })
        .collect::<Vec<_>>();
    failures.sort_by_key(|failure| failure.index);
    if total > 0 && plan.valid.is_empty() && failures.len() == total {
        return Ok(BatchExecutionResult {
            status: TerminalStatus::Success,
            committed: Vec::new(),
            replayed: Vec::new(),
            failures,
            terminal_event: None,
        });
    }
    progress
        .record(
            &command.batch_id,
            progress_event(
                &command.batch_id,
                0,
                ProgressStage::Accepted,
                0,
                0,
                total,
                None,
            ),
        )
        .map_err(ExecuteError::Progress)?;
    progress
        .record(
            &command.batch_id,
            progress_event(
                &command.batch_id,
                1,
                ProgressStage::Validating,
                0,
                failures.len(),
                total,
                None,
            ),
        )
        .map_err(ExecuteError::Progress)?;

    let mut committed = Vec::new();
    let mut replayed = Vec::new();
    if let Some(message) = &command.dependency_failure {
        failures.extend(plan.valid.iter().map(|index| RowFailure {
            index: *index,
            phase: FailurePhase::Dependency,
            message: message.clone(),
        }));
    } else {
        for index in &plan.valid {
            let row = command
                .rows
                .iter()
                .find(|row| row.index == *index)
                .expect("planned row must exist");
            match store.commit_row(&command.context, &command.batch_id, row) {
                Ok((disposition, _)) => {
                    committed.push(*index);
                    if disposition == CommitDisposition::Replayed {
                        replayed.push(*index);
                    }
                }
                Err(message) => failures.push(RowFailure {
                    index: *index,
                    phase: FailurePhase::Transaction,
                    message,
                }),
            }
        }
    }
    failures.sort_by_key(|failure| failure.index);
    progress
        .record(
            &command.batch_id,
            progress_event(
                &command.batch_id,
                2,
                ProgressStage::Writing,
                committed.len(),
                failures.len(),
                total,
                None,
            ),
        )
        .map_err(ExecuteError::Progress)?;

    let status = terminal_status(committed.len(), &failures);
    let terminal_event = progress_event(
        &command.batch_id,
        3,
        ProgressStage::Terminal,
        committed.len(),
        failures.len(),
        total,
        Some(status),
    );
    progress
        .record(&command.batch_id, terminal_event.clone())
        .map_err(ExecuteError::Progress)?;
    store
        .persist_terminal(&command.context, &command.batch_id, status)
        .map_err(|message| ExecuteError::Persistence {
            operation: "terminal-outbox",
            message,
        })?;
    Ok(BatchExecutionResult {
        status,
        committed,
        replayed,
        failures,
        terminal_event: Some(terminal_event),
    })
}

fn progress_event(
    batch_id: &str,
    sequence: u32,
    stage: ProgressStage,
    committed: usize,
    failed: usize,
    total: usize,
    terminal: Option<TerminalStatus>,
) -> ProgressEvent {
    ProgressEvent {
        event_id: format!("{batch_id}:{sequence}"),
        sequence,
        stage,
        committed,
        failed,
        total,
        terminal,
    }
}

fn terminal_status(committed: usize, failures: &[RowFailure]) -> TerminalStatus {
    let execution_failures = failures
        .iter()
        .filter(|failure| failure.phase != FailurePhase::Validation)
        .count();
    match (committed, execution_failures) {
        (_, 0) => TerminalStatus::Success,
        (0, _) => TerminalStatus::Failed,
        _ => TerminalStatus::PartialFailed,
    }
}

pub fn all_rows_rejected_by_validation(command: &BatchCommand) -> bool {
    !command.rows.is_empty()
        && command
            .rows
            .iter()
            .all(|row| command.validation_failures.contains_key(&row.index))
}

fn validate_context(context: &ExecutionContext) -> Result<(), ExecuteError> {
    if context.tenant_id == 0 {
        return Err(ExecuteError::InvalidContext("tenant"));
    }
    if context.panel_id == 0 {
        return Err(ExecuteError::InvalidContext("panel"));
    }
    if context.datasource.trim().is_empty() {
        return Err(ExecuteError::InvalidContext("datasource"));
    }
    if context.actor_id == 0 {
        return Err(ExecuteError::InvalidContext("actor"));
    }
    if context.trace_id.trim().is_empty() {
        return Err(ExecuteError::InvalidContext("trace"));
    }
    Ok(())
}

fn validate_progress_event(event: &ProgressEvent) -> Result<(), ProgressError> {
    if event.committed + event.failed > event.total {
        return Err(ProgressError::InvalidTransition);
    }
    if event.stage == ProgressStage::Terminal {
        if event.committed + event.failed != event.total || event.terminal.is_none() {
            return Err(ProgressError::InvalidTransition);
        }
    } else if event.terminal.is_some() {
        return Err(ProgressError::InvalidTransition);
    }
    Ok(())
}

pub fn committed_and_undo_match(
    store: &MemoryBatchStore,
    tenant_id: u64,
    batch_id: &str,
    committed: &[usize],
) -> bool {
    let committed = committed.iter().copied().collect::<BTreeSet<_>>();
    let undo = store
        .undo_intents(tenant_id, batch_id)
        .iter()
        .map(|intent| intent.row_index)
        .collect::<BTreeSet<_>>();
    committed == undo
}
