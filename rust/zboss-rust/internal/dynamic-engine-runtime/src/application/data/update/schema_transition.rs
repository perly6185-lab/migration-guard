use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TransitionKey {
    pub tenant_id: u64,
    pub panel_id: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColumnType {
    BigInt,
    Varchar { length: u16 },
    Decimal { precision: u8, scale: u8 },
    DateTime,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SchemaChange {
    CreateTable {
        table: String,
    },
    AddColumn {
        table: String,
        column: String,
        column_type: ColumnType,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionStatus {
    Started,
    Failed { message: String },
    Succeeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionRecord {
    pub request_hash: String,
    pub attempt: u32,
    pub status: TransitionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionOutcome {
    Applied { attempt: u32 },
    Resumed { attempt: u32 },
    Replayed { attempt: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionError {
    InvalidRequest(&'static str),
    LeaseBusy,
    IdempotencyConflict {
        release_error: Option<String>,
    },
    Storage {
        operation: &'static str,
        message: String,
        release_error: Option<String>,
    },
    Execution {
        message: String,
        recovery_errors: Vec<String>,
    },
    ReleaseAfterSuccess(String),
}

pub trait SchemaLeasePort {
    fn acquire(&mut self, key: &TransitionKey, owner_token: &str) -> Result<bool, String>;
    fn release(&mut self, key: &TransitionKey, owner_token: &str) -> Result<(), String>;
}

pub trait SchemaLedgerPort {
    fn load(&mut self, key: &TransitionKey) -> Result<Option<TransitionRecord>, String>;
    fn record_started(
        &mut self,
        key: &TransitionKey,
        request_hash: &str,
        attempt: u32,
    ) -> Result<(), String>;
    fn record_succeeded(&mut self, key: &TransitionKey, attempt: u32) -> Result<(), String>;
    fn record_failed(
        &mut self,
        key: &TransitionKey,
        attempt: u32,
        message: &str,
    ) -> Result<(), String>;
}

pub trait SchemaExecutorPort {
    /// Implementations must execute the structured operation idempotently.
    fn execute(&mut self, key: &TransitionKey, change: &SchemaChange) -> Result<(), String>;
}

pub fn ensure_schema<L, G, E>(
    key: &TransitionKey,
    request_hash: &str,
    owner_token: &str,
    change: &SchemaChange,
    lease: &mut L,
    ledger: &mut G,
    executor: &mut E,
) -> Result<TransitionOutcome, TransitionError>
where
    L: SchemaLeasePort,
    G: SchemaLedgerPort,
    E: SchemaExecutorPort,
{
    validate_request(key, request_hash, owner_token, change)?;
    if !lease
        .acquire(key, owner_token)
        .map_err(|message| TransitionError::Storage {
            operation: "lease-acquire",
            message,
            release_error: None,
        })?
    {
        return Err(TransitionError::LeaseBusy);
    }

    let previous = match ledger.load(key) {
        Ok(value) => value,
        Err(message) => {
            return Err(storage_error_with_release(
                "ledger-load",
                message,
                key,
                owner_token,
                lease,
            ));
        }
    };
    if let Some(record) = &previous {
        if record.request_hash != request_hash {
            return Err(TransitionError::IdempotencyConflict {
                release_error: lease.release(key, owner_token).err(),
            });
        }
        if record.status == TransitionStatus::Succeeded {
            lease
                .release(key, owner_token)
                .map_err(TransitionError::ReleaseAfterSuccess)?;
            return Ok(TransitionOutcome::Replayed {
                attempt: record.attempt,
            });
        }
    }

    let attempt = previous
        .as_ref()
        .map_or(1, |record| record.attempt.saturating_add(1));
    if let Err(message) = ledger.record_started(key, request_hash, attempt) {
        return Err(storage_error_with_release(
            "ledger-start",
            message,
            key,
            owner_token,
            lease,
        ));
    }

    if let Err(message) = executor.execute(key, change) {
        let mut recovery_errors = Vec::new();
        if let Err(error) = ledger.record_failed(key, attempt, &message) {
            recovery_errors.push(format!("ledger-failed: {error}"));
        }
        if let Err(error) = lease.release(key, owner_token) {
            recovery_errors.push(format!("lease-release: {error}"));
        }
        return Err(TransitionError::Execution {
            message,
            recovery_errors,
        });
    }

    if let Err(message) = ledger.record_succeeded(key, attempt) {
        let mut recovery_errors = vec![format!("ledger-succeeded: {message}")];
        if let Err(error) = lease.release(key, owner_token) {
            recovery_errors.push(format!("lease-release: {error}"));
        }
        return Err(TransitionError::Execution {
            message: "schema operation completed but durable success was not recorded".to_owned(),
            recovery_errors,
        });
    }
    lease
        .release(key, owner_token)
        .map_err(TransitionError::ReleaseAfterSuccess)?;

    if previous.is_some() {
        Ok(TransitionOutcome::Resumed { attempt })
    } else {
        Ok(TransitionOutcome::Applied { attempt })
    }
}

fn storage_error_with_release<L: SchemaLeasePort>(
    operation: &'static str,
    message: String,
    key: &TransitionKey,
    owner_token: &str,
    lease: &mut L,
) -> TransitionError {
    TransitionError::Storage {
        operation,
        message,
        release_error: lease.release(key, owner_token).err(),
    }
}

fn validate_request(
    key: &TransitionKey,
    request_hash: &str,
    owner_token: &str,
    change: &SchemaChange,
) -> Result<(), TransitionError> {
    if key.tenant_id == 0 || key.panel_id == 0 {
        return Err(TransitionError::InvalidRequest(
            "tenant and panel must be non-zero",
        ));
    }
    if !valid_identifier(&key.operation_id) {
        return Err(TransitionError::InvalidRequest(
            "operation id must be a safe identifier",
        ));
    }
    if request_hash.len() != 64 || !request_hash.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(TransitionError::InvalidRequest(
            "request hash must be SHA-256 hex",
        ));
    }
    if owner_token.is_empty() || owner_token.len() > 128 {
        return Err(TransitionError::InvalidRequest(
            "owner token must be present",
        ));
    }
    match change {
        SchemaChange::CreateTable { table } => validate_identifier(table)?,
        SchemaChange::AddColumn {
            table,
            column,
            column_type,
        } => {
            validate_identifier(table)?;
            validate_identifier(column)?;
            if let ColumnType::Varchar { length } = column_type
                && *length == 0
            {
                return Err(TransitionError::InvalidRequest(
                    "varchar length must be positive",
                ));
            }
            if let ColumnType::Decimal { precision, scale } = column_type
                && (*precision == 0 || *scale > *precision)
            {
                return Err(TransitionError::InvalidRequest(
                    "decimal precision and scale are invalid",
                ));
            }
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), TransitionError> {
    if valid_identifier(value) {
        Ok(())
    } else {
        Err(TransitionError::InvalidRequest(
            "schema identifiers must be safe",
        ))
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 64
        && (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[derive(Debug, Clone, Default)]
pub struct MemoryTrace(Rc<RefCell<Vec<String>>>);

impl MemoryTrace {
    pub fn entries(&self) -> Vec<String> {
        self.0.borrow().clone()
    }

    fn push(&self, value: impl Into<String>) {
        self.0.borrow_mut().push(value.into());
    }
}

#[derive(Debug, Default)]
pub struct MemoryLease {
    owners: BTreeMap<TransitionKey, String>,
    pub trace: MemoryTrace,
    pub fail_release: bool,
}

impl MemoryLease {
    pub fn with_trace(trace: MemoryTrace) -> Self {
        Self {
            trace,
            ..Self::default()
        }
    }
}

impl SchemaLeasePort for MemoryLease {
    fn acquire(&mut self, key: &TransitionKey, owner_token: &str) -> Result<bool, String> {
        self.trace.push("lease.acquire");
        match self.owners.get(key) {
            Some(owner) if owner != owner_token => Ok(false),
            _ => {
                self.owners.insert(key.clone(), owner_token.to_owned());
                Ok(true)
            }
        }
    }

    fn release(&mut self, key: &TransitionKey, owner_token: &str) -> Result<(), String> {
        self.trace.push("lease.release");
        if self.fail_release {
            return Err("injected release failure".to_owned());
        }
        match self.owners.get(key) {
            Some(owner) if owner == owner_token => {
                self.owners.remove(key);
                Ok(())
            }
            _ => Err("owner token mismatch".to_owned()),
        }
    }
}

#[derive(Debug, Default)]
pub struct MemoryLedger {
    pub records: BTreeMap<TransitionKey, TransitionRecord>,
    pub trace: MemoryTrace,
}

impl MemoryLedger {
    pub fn with_trace(trace: MemoryTrace) -> Self {
        Self {
            trace,
            ..Self::default()
        }
    }
}

impl SchemaLedgerPort for MemoryLedger {
    fn load(&mut self, key: &TransitionKey) -> Result<Option<TransitionRecord>, String> {
        self.trace.push("ledger.load");
        Ok(self.records.get(key).cloned())
    }

    fn record_started(
        &mut self,
        key: &TransitionKey,
        request_hash: &str,
        attempt: u32,
    ) -> Result<(), String> {
        self.trace.push(format!("ledger.started:{attempt}"));
        self.records.insert(
            key.clone(),
            TransitionRecord {
                request_hash: request_hash.to_owned(),
                attempt,
                status: TransitionStatus::Started,
            },
        );
        Ok(())
    }

    fn record_succeeded(&mut self, key: &TransitionKey, attempt: u32) -> Result<(), String> {
        self.trace.push(format!("ledger.succeeded:{attempt}"));
        let record = self
            .records
            .get_mut(key)
            .ok_or_else(|| "transition record missing".to_owned())?;
        if record.attempt != attempt {
            return Err("transition attempt mismatch".to_owned());
        }
        record.status = TransitionStatus::Succeeded;
        Ok(())
    }

    fn record_failed(
        &mut self,
        key: &TransitionKey,
        attempt: u32,
        message: &str,
    ) -> Result<(), String> {
        self.trace.push(format!("ledger.failed:{attempt}"));
        let record = self
            .records
            .get_mut(key)
            .ok_or_else(|| "transition record missing".to_owned())?;
        if record.attempt != attempt {
            return Err("transition attempt mismatch".to_owned());
        }
        record.status = TransitionStatus::Failed {
            message: message.to_owned(),
        };
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct MemorySchemaExecutor {
    applied: BTreeSet<(TransitionKey, SchemaChange)>,
    pub trace: MemoryTrace,
    pub fail_next: Option<String>,
}

impl MemorySchemaExecutor {
    pub fn with_trace(trace: MemoryTrace) -> Self {
        Self {
            trace,
            ..Self::default()
        }
    }
}

impl SchemaExecutorPort for MemorySchemaExecutor {
    fn execute(&mut self, key: &TransitionKey, change: &SchemaChange) -> Result<(), String> {
        self.trace.push("ddl.execute");
        if let Some(message) = self.fail_next.take() {
            return Err(message);
        }
        self.applied.insert((key.clone(), change.clone()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn key() -> TransitionKey {
        TransitionKey {
            tenant_id: 7,
            panel_id: 9,
            operation_id: "add_amount".to_owned(),
        }
    }

    fn change() -> SchemaChange {
        SchemaChange::AddColumn {
            table: "ledger_9".to_owned(),
            column: "amount".to_owned(),
            column_type: ColumnType::Decimal {
                precision: 18,
                scale: 2,
            },
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
    fn applies_structured_ddl_and_records_success_before_release() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        let outcome = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-1",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        assert_eq!(outcome, TransitionOutcome::Applied { attempt: 1 });
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
    fn replays_durable_success_without_executing_ddl_again() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-1",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        let outcome = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-2",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        assert_eq!(outcome, TransitionOutcome::Replayed { attempt: 1 });
        assert_eq!(
            trace
                .entries()
                .iter()
                .filter(|entry| entry.as_str() == "ddl.execute")
                .count(),
            1
        );
    }

    #[test]
    fn rejects_request_hash_conflict_before_ddl() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        ledger.records.insert(
            key(),
            TransitionRecord {
                request_hash: REQUEST_HASH.to_owned(),
                attempt: 1,
                status: TransitionStatus::Succeeded,
            },
        );
        let error = ensure_schema(
            &key(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "owner-2",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert_eq!(
            error,
            TransitionError::IdempotencyConflict {
                release_error: None
            }
        );
        assert!(!trace.entries().contains(&"ddl.execute".to_owned()));
    }

    #[test]
    fn records_ddl_failure_then_resumes_idempotently() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        executor.fail_next = Some("injected DDL failure".to_owned());
        let first = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-1",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert_eq!(
            first,
            TransitionError::Execution {
                message: "injected DDL failure".to_owned(),
                recovery_errors: vec![]
            }
        );
        assert!(matches!(
            ledger.records.get(&key()).map(|record| &record.status),
            Some(TransitionStatus::Failed { .. })
        ));
        let resumed = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-2",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        assert_eq!(resumed, TransitionOutcome::Resumed { attempt: 2 });
        assert!(trace.entries().contains(&"ledger.failed:1".to_owned()));
    }

    #[test]
    fn resumes_started_record_after_expired_owner_is_replaced() {
        let (mut lease, mut ledger, mut executor, _) = adapters();
        ledger.records.insert(
            key(),
            TransitionRecord {
                request_hash: REQUEST_HASH.to_owned(),
                attempt: 1,
                status: TransitionStatus::Started,
            },
        );
        let outcome = ensure_schema(
            &key(),
            REQUEST_HASH,
            "replacement-owner",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap();
        assert_eq!(outcome, TransitionOutcome::Resumed { attempt: 2 });
    }

    #[test]
    fn rejects_unsafe_identifier_before_any_port_call() {
        let (mut lease, mut ledger, mut executor, trace) = adapters();
        let error = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-1",
            &SchemaChange::CreateTable {
                table: "ledger; DROP TABLE users".to_owned(),
            },
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert_eq!(
            error,
            TransitionError::InvalidRequest("schema identifiers must be safe")
        );
        assert!(trace.entries().is_empty());
    }

    #[test]
    fn reports_release_failure_after_durable_success() {
        let (mut lease, mut ledger, mut executor, _) = adapters();
        lease.fail_release = true;
        let error = ensure_schema(
            &key(),
            REQUEST_HASH,
            "owner-1",
            &change(),
            &mut lease,
            &mut ledger,
            &mut executor,
        )
        .unwrap_err();
        assert_eq!(
            error,
            TransitionError::ReleaseAfterSuccess("injected release failure".to_owned())
        );
        assert_eq!(
            ledger.records.get(&key()).map(|record| &record.status),
            Some(&TransitionStatus::Succeeded)
        );
    }
}
