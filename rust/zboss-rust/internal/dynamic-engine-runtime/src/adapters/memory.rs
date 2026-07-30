use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::{
    domain::{
        context::RequestContext,
        horizontal::{aggregate_pivots, group_rows, paginate_distinct_keys},
        model::{
            EvidenceEvent, HorizontalQuery, HorizontalSlice, PageLineage, PageMetadata, PageSlice,
            Row, Value, ViewMetadata,
        },
        query::{Aggregate, Direction, Operator, Predicate, QueryPlan},
    },
    http::error::ApiError,
    ports::{
        child_form::ChildFormPort,
        clock::ClockPort,
        event::EventPort,
        evidence::EvidencePort,
        field_catalog::{FieldCatalogEntry, FieldCatalogPort, FieldDeleteBehavior},
        field_delete::{FieldDeleteCommand, FieldDeleteCommit, FieldDeletePort},
        field_schema::{FieldSchemaCommand, FieldSchemaCommit, FieldSchemaPort},
        horizontal::HorizontalListPort,
        init::{InitCommand, InitCommit, InitPort},
        lease::{Lease, LeaseLockPort, LeasePriority},
        metadata::MetadataPort,
        permission::PermissionPort,
        preference::PagePreferencePort,
        query::PageQueryPort,
        refresh::{RefreshPort, RefreshTarget},
        view_metadata::ViewMetadataPort,
    },
};
use sha2::{Digest, Sha256};

type ScopeKey = (u64, String, String);
type PageKey = (ScopeKey, u64);
type TableKey = (ScopeKey, String);
type ViewKey = (ScopeKey, u64, u64);
type HorizontalKey = (ScopeKey, u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FaultPoint {
    Metadata,
    Permission,
    Query,
    Preference,
    LeaseAcquire,
    LeaseRelease,
    RefreshSync,
    RefreshTimestamp,
    RefreshUndoClear,
    RefreshReconcile,
    Event,
    InitInsert,
    InitCalculate,
    InitOutbox,
    FieldSchemaDdl,
    FieldSchemaMetadata,
    FieldSchemaOutbox,
    FieldDeleteMetadata,
    FieldDeleteOutbox,
}

#[derive(Debug, Default)]
struct MemoryInitState {
    records: BTreeMap<ScopeKey, Vec<InitCommit>>,
    idempotency: BTreeMap<(ScopeKey, String), ([u8; 32], InitCommit)>,
    outbox: BTreeMap<ScopeKey, Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryFieldTransitionPhase {
    Planned,
    DdlApplied,
    Succeeded,
}

#[derive(Debug, Clone)]
struct MemoryFieldTransition {
    fingerprint: [u8; 32],
    phase: MemoryFieldTransitionPhase,
    ddl_execution_count: u32,
    commit: Option<FieldSchemaCommit>,
}

#[derive(Debug, Clone)]
struct MemoryFieldDefinition {
    entry: FieldCatalogEntry,
}

#[derive(Debug, Default)]
struct MemoryFieldSchemaState {
    transitions: BTreeMap<(ScopeKey, String), MemoryFieldTransition>,
    fields: BTreeMap<(ScopeKey, u64), MemoryFieldDefinition>,
    records: BTreeMap<ScopeKey, Vec<FieldSchemaCommit>>,
    outbox: BTreeMap<ScopeKey, Vec<String>>,
    deletes: BTreeMap<(ScopeKey, String), ([u8; 32], FieldDeleteCommit)>,
    delete_outbox: BTreeMap<ScopeKey, Vec<String>>,
    deleted_fields: BTreeSet<(ScopeKey, u64)>,
    delete_snapshots: BTreeMap<(ScopeKey, String), FieldCatalogEntry>,
}

#[derive(Debug, Default)]
pub struct MemoryAdapters {
    now_millis: AtomicU64,
    fencing_token: AtomicU64,
    metadata: RwLock<BTreeMap<PageKey, PageMetadata>>,
    view_metadata: RwLock<BTreeMap<ViewKey, ViewMetadata>>,
    rows: RwLock<BTreeMap<TableKey, Vec<Row>>>,
    horizontal_rows: RwLock<BTreeMap<HorizontalKey, Vec<Row>>>,
    preferences: RwLock<BTreeMap<PageKey, u32>>,
    denied_pages: RwLock<BTreeSet<(u64, u64)>>,
    child_headers: RwLock<BTreeMap<(u64, u64), BTreeMap<String, Value>>>,
    leases: Mutex<BTreeMap<String, Lease>>,
    events: Mutex<Vec<EvidenceEvent>>,
    query_evidence: Mutex<Vec<MemoryQueryEvidence>>,
    faults: RwLock<BTreeSet<FaultPoint>>,
    next_init_id: AtomicU64,
    denied_init_panels: RwLock<BTreeSet<(u64, u64)>>,
    init_state: Mutex<MemoryInitState>,
    next_field_id: AtomicU64,
    denied_field_schema_panels: RwLock<BTreeSet<(u64, u64)>>,
    field_schema_state: Mutex<MemoryFieldSchemaState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryQueryEvidence {
    pub context: RequestContext,
    pub plan: QueryPlan,
    pub result: PageSlice,
}

impl MemoryAdapters {
    pub fn with_time(now_millis: u64) -> Self {
        let adapter = Self::default();
        adapter.now_millis.store(now_millis, Ordering::SeqCst);
        adapter
    }

    pub fn set_time(&self, now_millis: u64) {
        self.now_millis.store(now_millis, Ordering::SeqCst);
    }

    pub fn insert_metadata(&self, context: &RequestContext, metadata: PageMetadata) {
        self.metadata
            .write()
            .expect("metadata lock poisoned")
            .insert((scope_key(context), metadata.page_id), metadata);
    }

    pub fn insert_view_metadata(&self, context: &RequestContext, metadata: ViewMetadata) {
        self.view_metadata
            .write()
            .expect("view metadata lock poisoned")
            .insert(
                (scope_key(context), metadata.use_page_id, metadata.view_id),
                metadata,
            );
    }

    pub fn insert_horizontal_rows(
        &self,
        context: &RequestContext,
        horizontal_id: u64,
        rows: Vec<Row>,
    ) {
        self.horizontal_rows
            .write()
            .expect("horizontal rows lock poisoned")
            .insert((scope_key(context), horizontal_id), rows);
    }

    pub fn insert_rows(&self, context: &RequestContext, table: impl Into<String>, rows: Vec<Row>) {
        self.rows
            .write()
            .expect("rows lock poisoned")
            .insert((scope_key(context), table.into()), rows);
    }

    pub fn deny_page(&self, tenant_id: u64, page_id: u64) {
        self.denied_pages
            .write()
            .expect("permission lock poisoned")
            .insert((tenant_id, page_id));
    }

    pub fn insert_child_headers(
        &self,
        tenant_id: u64,
        field_id: u64,
        headers: BTreeMap<String, Value>,
    ) {
        self.child_headers
            .write()
            .expect("child header lock poisoned")
            .insert((tenant_id, field_id), headers);
    }

    pub fn deny_init_panel(&self, tenant_id: u64, panel_id: u64) {
        self.denied_init_panels
            .write()
            .expect("init permission lock poisoned")
            .insert((tenant_id, panel_id));
    }

    pub fn init_records(&self, context: &RequestContext) -> Vec<InitCommit> {
        self.init_state
            .lock()
            .expect("init state lock poisoned")
            .records
            .get(&scope_key(context))
            .cloned()
            .unwrap_or_default()
    }

    pub fn init_outbox(&self, context: &RequestContext) -> Vec<String> {
        self.init_state
            .lock()
            .expect("init state lock poisoned")
            .outbox
            .get(&scope_key(context))
            .cloned()
            .unwrap_or_default()
    }

    pub fn deny_field_schema_panel(&self, tenant_id: u64, panel_id: u64) {
        self.denied_field_schema_panels
            .write()
            .expect("field schema permission lock poisoned")
            .insert((tenant_id, panel_id));
    }

    pub fn field_schema_records(&self, context: &RequestContext) -> Vec<FieldSchemaCommit> {
        self.field_schema_state
            .lock()
            .expect("field schema state lock poisoned")
            .records
            .get(&scope_key(context))
            .cloned()
            .unwrap_or_default()
    }

    pub fn field_delete_outbox(&self, context: &RequestContext) -> Vec<String> {
        self.field_schema_state
            .lock()
            .expect("field schema state lock poisoned")
            .delete_outbox
            .get(&scope_key(context))
            .cloned()
            .unwrap_or_default()
    }

    pub fn field_delete_snapshot_count(&self, context: &RequestContext) -> usize {
        let scope = scope_key(context);
        self.field_schema_state
            .lock()
            .expect("field schema state lock poisoned")
            .delete_snapshots
            .keys()
            .filter(|(snapshot_scope, _)| snapshot_scope == &scope)
            .count()
    }

    pub fn insert_field_schema(
        &self,
        context: &RequestContext,
        panel_id: u64,
        use_page_id: u64,
        commit: FieldSchemaCommit,
    ) {
        self.insert_field_catalog_entry(
            context,
            FieldCatalogEntry {
                id: commit.field_id,
                panel_id,
                use_page_id,
                name: commit.field.clone(),
                field: commit.field,
                table_script_field: commit.table_script_field,
                field_type_value: "text".to_owned(),
                field_tag_inner_key: "text".to_owned(),
                panel_resp_key: None,
                delete_behavior: FieldDeleteBehavior::Remove,
                additional_values: BTreeMap::new(),
            },
        );
    }

    pub fn insert_field_catalog_entry(&self, context: &RequestContext, entry: FieldCatalogEntry) {
        let key = (scope_key(context), entry.id);
        let mut state = self
            .field_schema_state
            .lock()
            .expect("field schema state lock poisoned");
        state.deleted_fields.remove(&key);
        state.fields.insert(key, MemoryFieldDefinition { entry });
    }

    pub fn field_transition_phase(
        &self,
        context: &RequestContext,
        request_id: &str,
    ) -> Option<String> {
        self.field_schema_state
            .lock()
            .expect("field schema state lock poisoned")
            .transitions
            .get(&(scope_key(context), request_id.to_owned()))
            .map(|transition| match transition.phase {
                MemoryFieldTransitionPhase::Planned => "planned",
                MemoryFieldTransitionPhase::DdlApplied => "ddl-applied",
                MemoryFieldTransitionPhase::Succeeded => "succeeded",
            })
            .map(str::to_owned)
    }

    pub fn field_ddl_execution_count(&self, context: &RequestContext, request_id: &str) -> u32 {
        self.field_schema_state
            .lock()
            .expect("field schema state lock poisoned")
            .transitions
            .get(&(scope_key(context), request_id.to_owned()))
            .map_or(0, |transition| transition.ddl_execution_count)
    }

    pub fn events(&self) -> Vec<EvidenceEvent> {
        self.events.lock().expect("events lock poisoned").clone()
    }

    pub fn query_evidence(&self) -> Vec<MemoryQueryEvidence> {
        self.query_evidence
            .lock()
            .expect("query evidence lock poisoned")
            .clone()
    }

    pub fn page_size(&self, context: &RequestContext, page_id: u64) -> Option<u32> {
        self.preferences
            .read()
            .expect("preferences lock poisoned")
            .get(&(scope_key(context), page_id))
            .copied()
    }

    pub fn inject_fault(&self, point: FaultPoint) {
        self.faults
            .write()
            .expect("fault lock poisoned")
            .insert(point);
    }

    pub fn clear_faults(&self) {
        self.faults.write().expect("fault lock poisoned").clear();
    }

    fn fail_if(&self, point: FaultPoint) -> Result<(), ApiError> {
        if self
            .faults
            .read()
            .map_err(|_| ApiError::query("fault lock poisoned", true))?
            .contains(&point)
        {
            return Err(ApiError::query(format!("{point:?} fault injected"), true));
        }
        Ok(())
    }

    fn ensure_active_lease(&self, lease: &Lease) -> Result<(), ApiError> {
        let now = self.now_millis();
        let leases = self
            .leases
            .lock()
            .map_err(|_| ApiError::refresh("lease lock poisoned", true))?;
        if leases.get(&lease.key).is_some_and(|current| {
            current.owner_token == lease.owner_token
                && current.fencing_token == lease.fencing_token
                && current.expires_at_millis > now
        }) {
            Ok(())
        } else {
            Err(ApiError::refresh("stale refresh fencing token", false))
        }
    }

    fn record_event(&self, context: &RequestContext, kind: &str) -> Result<(), ApiError> {
        self.fail_if(FaultPoint::Event)?;
        if kind.trim().is_empty() {
            return Err(ApiError::query("evidence event kind is empty", false));
        }
        let mut events = self
            .events
            .lock()
            .map_err(|_| ApiError::query("event lock poisoned", true))?;
        let sequence = u64::try_from(events.len())
            .map_err(|_| ApiError::query("evidence sequence overflow", false))?
            .checked_add(1)
            .ok_or_else(|| ApiError::query("evidence sequence overflow", false))?;
        events.push(EvidenceEvent {
            trace_id: context.trace_id.clone(),
            kind: kind.to_owned(),
            sequence,
        });
        Ok(())
    }
}

impl InitPort for MemoryAdapters {
    fn init_atomic(
        &self,
        context: &RequestContext,
        command: &InitCommand,
    ) -> Result<InitCommit, ApiError> {
        context.validate().map_err(ApiError::context)?;
        if self
            .denied_init_panels
            .read()
            .map_err(|_| ApiError::mutation("init permission lock poisoned", true))?
            .contains(&(context.tenant_id, command.panel_id))
        {
            return Err(ApiError::context(
                "user is not allowed to insert into the requested panel",
            ));
        }
        let encoded = serde_json::to_vec(command)
            .map_err(|error| ApiError::mutation(format!("hash init request: {error}"), false))?;
        let fingerprint: [u8; 32] = Sha256::digest(encoded).into();
        let scope = scope_key(context);
        let idempotency_key = (scope.clone(), command.request_id.clone());
        let mut state = self
            .init_state
            .lock()
            .map_err(|_| ApiError::mutation("init state lock poisoned", true))?;
        if let Some((existing_fingerprint, existing)) = state.idempotency.get(&idempotency_key) {
            if existing_fingerprint != &fingerprint {
                return Err(ApiError::conflict(
                    "request id was already used with a different init payload",
                ));
            }
            let mut replay = existing.clone();
            replay.replayed = true;
            return Ok(replay);
        }

        self.fail_if(FaultPoint::InitInsert)?;
        let sequence = self
            .next_init_id
            .fetch_add(1, Ordering::SeqCst)
            .checked_add(1)
            .ok_or_else(|| ApiError::mutation("init identifier overflow", false))?;
        let primary_key_id = 2_100_000_000_000_000_000_u64
            .checked_add(sequence)
            .ok_or_else(|| ApiError::mutation("init identifier overflow", false))?;
        let row_num = state
            .records
            .get(&scope)
            .map_or(1_u64, |records| records.len() as u64 + 1);
        let mut row = command.post_values.clone();
        row.insert("id".to_owned(), serde_json::json!(primary_key_id));
        if row
            .get("selfBookRowNum")
            .is_none_or(serde_json::Value::is_null)
        {
            row.insert("selfBookRowNum".to_owned(), serde_json::json!(row_num));
        }

        self.fail_if(FaultPoint::InitCalculate)?;
        let outbox_event_id = format!(
            "init:{}:{}:{}",
            context.tenant_id, command.request_id, primary_key_id
        );
        self.fail_if(FaultPoint::InitOutbox)?;

        let commit = InitCommit {
            primary_key_id,
            resp_key: "data".to_owned(),
            row,
            outbox_event_id: outbox_event_id.clone(),
            replayed: false,
        };
        state
            .records
            .entry(scope.clone())
            .or_default()
            .push(commit.clone());
        state.outbox.entry(scope).or_default().push(outbox_event_id);
        state
            .idempotency
            .insert(idempotency_key, (fingerprint, commit.clone()));
        Ok(commit)
    }
}

impl FieldSchemaPort for MemoryAdapters {
    fn apply_field_transition(
        &self,
        context: &RequestContext,
        command: &FieldSchemaCommand,
    ) -> Result<FieldSchemaCommit, ApiError> {
        context.validate().map_err(ApiError::context)?;
        if self
            .denied_field_schema_panels
            .read()
            .map_err(|_| ApiError::mutation("field schema permission lock poisoned", true))?
            .contains(&(context.tenant_id, command.panel_id))
        {
            return Err(ApiError::context(
                "user is not allowed to change the requested panel schema",
            ));
        }
        let encoded = serde_json::to_vec(command).map_err(|error| {
            ApiError::mutation(format!("hash field schema request: {error}"), false)
        })?;
        let fingerprint: [u8; 32] = Sha256::digest(encoded).into();
        let scope = scope_key(context);
        let transition_key = (scope.clone(), command.request_id.clone());
        let mut state = self
            .field_schema_state
            .lock()
            .map_err(|_| ApiError::mutation("field schema state lock poisoned", true))?;
        let existing_field = command
            .field_id
            .map(|field_id| {
                state
                    .fields
                    .get(&(scope.clone(), field_id))
                    .filter(|field| {
                        field.entry.panel_id == command.panel_id
                            && field.entry.use_page_id == command.use_page_id
                    })
                    .cloned()
                    .ok_or_else(|| {
                        ApiError::conflict(
                            "field does not exist in the requested tenant, panel and page scope",
                        )
                    })
            })
            .transpose()?;

        if let Some(existing) = state.transitions.get(&transition_key) {
            if existing.fingerprint != fingerprint {
                return Err(ApiError::conflict(
                    "request id was already used with a different field schema payload",
                ));
            }
            if existing.phase == MemoryFieldTransitionPhase::Succeeded {
                let mut replay = existing.commit.clone().ok_or_else(|| {
                    ApiError::mutation("field schema success record is incomplete", false)
                })?;
                replay.replayed = true;
                return Ok(replay);
            }
        } else {
            state.transitions.insert(
                transition_key.clone(),
                MemoryFieldTransition {
                    fingerprint,
                    phase: MemoryFieldTransitionPhase::Planned,
                    ddl_execution_count: 0,
                    commit: None,
                },
            );
        }

        let needs_ddl = state
            .transitions
            .get(&transition_key)
            .is_some_and(|transition| {
                command.field_id.is_none()
                    && transition.phase == MemoryFieldTransitionPhase::Planned
            });
        if needs_ddl {
            self.fail_if(FaultPoint::FieldSchemaDdl)?;
            let transition = state
                .transitions
                .get_mut(&transition_key)
                .expect("transition inserted above");
            transition.ddl_execution_count = transition.ddl_execution_count.saturating_add(1);
            transition.phase = MemoryFieldTransitionPhase::DdlApplied;
        }

        // MySQL DDL has already committed at this point. Failures below must
        // preserve DdlApplied so a retry repairs metadata without another DDL.
        self.fail_if(FaultPoint::FieldSchemaMetadata)?;
        self.fail_if(FaultPoint::FieldSchemaOutbox)?;

        let delete_behavior = existing_field
            .as_ref()
            .map_or(FieldDeleteBehavior::Remove, |field| {
                field.entry.delete_behavior
            });
        let panel_resp_key = existing_field
            .as_ref()
            .and_then(|field| field.entry.panel_resp_key.clone());
        let commit = if let Some(existing_field) = existing_field {
            FieldSchemaCommit {
                field_id: existing_field.entry.id,
                field: existing_field.entry.field,
                table_script_field: existing_field.entry.table_script_field,
                replayed: false,
            }
        } else {
            let field_id = 2_200_000_000_000_000_000_u64
                .checked_add(
                    self.next_field_id
                        .fetch_add(1, Ordering::SeqCst)
                        .checked_add(1)
                        .ok_or_else(|| {
                            ApiError::mutation("field schema identifier overflow", false)
                        })?,
                )
                .ok_or_else(|| ApiError::mutation("field schema identifier overflow", false))?;
            let suffix = field_id % 1_000_000;
            FieldSchemaCommit {
                field_id,
                field: format!("custField{suffix}"),
                table_script_field: format!("cust_field_{suffix}"),
                replayed: false,
            }
        };
        let field_id = commit.field_id;
        state.fields.insert(
            (scope.clone(), field_id),
            MemoryFieldDefinition {
                entry: FieldCatalogEntry {
                    id: field_id,
                    panel_id: command.panel_id,
                    use_page_id: command.use_page_id,
                    name: command.name.clone(),
                    field: commit.field.clone(),
                    table_script_field: commit.table_script_field.clone(),
                    field_type_value: command.field_type_value.clone(),
                    field_tag_inner_key: command.field_tag_inner_key.clone(),
                    panel_resp_key,
                    delete_behavior,
                    additional_values: field_detail_values(&command.payload),
                },
            },
        );
        state.deleted_fields.remove(&(scope.clone(), field_id));
        state
            .records
            .entry(scope.clone())
            .or_default()
            .push(commit.clone());
        state.outbox.entry(scope).or_default().push(format!(
            "field-schema:{}:{}:{}",
            context.tenant_id, command.request_id, field_id
        ));
        let transition = state
            .transitions
            .get_mut(&transition_key)
            .expect("transition inserted above");
        transition.phase = MemoryFieldTransitionPhase::Succeeded;
        transition.commit = Some(commit.clone());
        Ok(commit)
    }
}

impl FieldCatalogPort for MemoryAdapters {
    fn list_fields(
        &self,
        context: &RequestContext,
        use_page_id: u64,
    ) -> Result<Vec<FieldCatalogEntry>, ApiError> {
        context.validate().map_err(ApiError::context)?;
        let scope = scope_key(context);
        let state = self
            .field_schema_state
            .lock()
            .map_err(|_| ApiError::query("field catalog state lock poisoned", true))?;
        Ok(state
            .fields
            .iter()
            .filter(|((field_scope, _), definition)| {
                field_scope == &scope && definition.entry.use_page_id == use_page_id
            })
            .map(|(_, definition)| definition.entry.clone())
            .collect())
    }

    fn get_field(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError> {
        context.validate().map_err(ApiError::context)?;
        let field = self
            .field_schema_state
            .lock()
            .map_err(|_| ApiError::query("field catalog state lock poisoned", true))?
            .fields
            .get(&(scope_key(context), field_id))
            .map(|definition| definition.entry.clone());
        if let Some(field) = &field
            && self
                .denied_field_schema_panels
                .read()
                .map_err(|_| ApiError::query("field detail permission lock poisoned", true))?
                .contains(&(context.tenant_id, field.panel_id))
        {
            return Err(ApiError::context(
                "user is not allowed to read the requested panel field",
            ));
        }
        Ok(field)
    }
}

impl FieldDeletePort for MemoryAdapters {
    fn delete_field(
        &self,
        context: &RequestContext,
        command: &FieldDeleteCommand,
    ) -> Result<FieldDeleteCommit, ApiError> {
        context.validate().map_err(ApiError::context)?;
        let encoded = serde_json::to_vec(command)
            .map_err(|error| ApiError::mutation(format!("hash field delete: {error}"), false))?;
        let fingerprint: [u8; 32] = Sha256::digest(encoded).into();
        let scope = scope_key(context);
        let delete_key = (scope.clone(), command.request_id.clone());

        let field = {
            let state = self
                .field_schema_state
                .lock()
                .map_err(|_| ApiError::mutation("field delete state lock poisoned", true))?;
            if let Some((existing_fingerprint, existing_commit)) = state.deletes.get(&delete_key) {
                if existing_fingerprint != &fingerprint {
                    return Err(ApiError::conflict(
                        "request id was already used with a different field delete payload",
                    ));
                }
                let mut replay = existing_commit.clone();
                replay.replayed = true;
                return Ok(replay);
            }
            state
                .fields
                .get(&(scope.clone(), command.field_id))
                .filter(|_| {
                    !state
                        .deleted_fields
                        .contains(&(scope.clone(), command.field_id))
                })
                .cloned()
        };

        if let Some(field) = &field
            && self
                .denied_field_schema_panels
                .read()
                .map_err(|_| ApiError::mutation("field delete permission lock poisoned", true))?
                .contains(&(context.tenant_id, field.entry.panel_id))
        {
            return Err(ApiError::context(
                "user is not allowed to delete the requested panel field",
            ));
        }

        let mut state = self
            .field_schema_state
            .lock()
            .map_err(|_| ApiError::mutation("field delete state lock poisoned", true))?;
        if let Some((existing_fingerprint, existing_commit)) = state.deletes.get(&delete_key) {
            if existing_fingerprint != &fingerprint {
                return Err(ApiError::conflict(
                    "request id was already used with a different field delete payload",
                ));
            }
            let mut replay = existing_commit.clone();
            replay.replayed = true;
            return Ok(replay);
        }

        let current = state
            .fields
            .get(&(scope.clone(), command.field_id))
            .filter(|_| {
                !state
                    .deleted_fields
                    .contains(&(scope.clone(), command.field_id))
            })
            .cloned();
        self.fail_if(FaultPoint::FieldDeleteMetadata)?;
        self.fail_if(FaultPoint::FieldDeleteOutbox)?;

        let commit = if let Some(current) = current {
            state
                .delete_snapshots
                .insert(delete_key.clone(), current.entry.clone());
            match current.entry.delete_behavior {
                FieldDeleteBehavior::Remove => {
                    state.fields.remove(&(scope.clone(), command.field_id));
                }
                FieldDeleteBehavior::Hide => {
                    let hidden = state
                        .fields
                        .get_mut(&(scope.clone(), command.field_id))
                        .expect("field was loaded above");
                    hidden
                        .entry
                        .additional_values
                        .insert("openList".to_owned(), serde_json::json!(1));
                    hidden
                        .entry
                        .additional_values
                        .insert("openForm".to_owned(), serde_json::json!(1));
                    hidden
                        .entry
                        .additional_values
                        .insert("openFun".to_owned(), serde_json::json!(1));
                    hidden
                        .entry
                        .additional_values
                        .insert("fieldShowTag".to_owned(), serde_json::json!(false));
                }
            }
            state
                .deleted_fields
                .insert((scope.clone(), command.field_id));
            state
                .delete_outbox
                .entry(scope.clone())
                .or_default()
                .push(format!(
                    "field-delete:{}:{}:{}",
                    context.tenant_id, command.request_id, command.field_id
                ));
            FieldDeleteCommit {
                field_id: command.field_id,
                panel_id: Some(current.entry.panel_id),
                use_page_id: Some(current.entry.use_page_id),
                deleted: true,
                replayed: false,
            }
        } else {
            FieldDeleteCommit {
                field_id: command.field_id,
                panel_id: None,
                use_page_id: None,
                deleted: false,
                replayed: false,
            }
        };
        state
            .deletes
            .insert(delete_key, (fingerprint, commit.clone()));
        Ok(commit)
    }
}

fn field_detail_values(payload: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    const REQUEST_ONLY: &[&str] = &[
        "id",
        "panelId",
        "usePageId",
        "name",
        "field",
        "tableScriptField",
        "fieldTypeValue",
        "fieldTagInnerKey",
        "pageNo",
        "pageSize",
        "pageId",
        "interId",
        "httpId",
        "headerValues",
        "postValues",
        "selectValues",
        "orderValues",
        "showArchived",
    ];
    payload
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| !REQUEST_ONLY.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn scope_key(context: &RequestContext) -> ScopeKey {
    (
        context.tenant_id,
        context.datasource.clone(),
        context.snapshot_id.clone(),
    )
}

impl ClockPort for MemoryAdapters {
    fn now_millis(&self) -> u64 {
        self.now_millis.load(Ordering::SeqCst)
    }
}

impl MetadataPort for MemoryAdapters {
    fn load_page(&self, context: &RequestContext, page_id: u64) -> Result<PageMetadata, ApiError> {
        self.fail_if(FaultPoint::Metadata)?;
        self.metadata
            .read()
            .map_err(|_| ApiError::query("metadata lock poisoned", true))?
            .get(&(scope_key(context), page_id))
            .cloned()
            .ok_or_else(|| ApiError::query("page metadata not found", false))
    }

    fn ensure_table_owned(&self, context: &RequestContext, table: &str) -> Result<(), ApiError> {
        self.fail_if(FaultPoint::Metadata)?;
        if self
            .rows
            .read()
            .map_err(|_| ApiError::query("row lock poisoned", true))?
            .contains_key(&(scope_key(context), table.to_owned()))
        {
            Ok(())
        } else {
            Err(ApiError::context(
                "table is not owned by the active request scope",
            ))
        }
    }
}

impl ViewMetadataPort for MemoryAdapters {
    fn load_view(
        &self,
        context: &RequestContext,
        use_page_id: u64,
        view_id: u64,
    ) -> Result<ViewMetadata, ApiError> {
        self.fail_if(FaultPoint::Metadata)?;
        self.view_metadata
            .read()
            .map_err(|_| ApiError::query("view metadata lock poisoned", true))?
            .get(&(scope_key(context), use_page_id, view_id))
            .cloned()
            .ok_or_else(|| ApiError::query("view metadata not found", false))
    }
}

impl HorizontalListPort for MemoryAdapters {
    fn list_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> Result<HorizontalSlice, ApiError> {
        self.fail_if(FaultPoint::Query)?;
        let mut rows = self
            .horizontal_rows
            .read()
            .map_err(|_| ApiError::query("horizontal rows lock poisoned", true))?
            .get(&(scope_key(context), query.horizontal_id))
            .cloned()
            .ok_or_else(|| ApiError::query("horizontal data not found", false))?;
        if !query.show_archived {
            rows.retain(|row| row.get("locked") != Some(&Value::Integer(1)));
        }
        rows.sort_by(|left, right| {
            for order in &query.order {
                let comparison = left
                    .get(&order.field_name)
                    .unwrap_or(&Value::Null)
                    .cmp(right.get(&order.field_name).unwrap_or(&Value::Null));
                if comparison.is_ne() {
                    return if order.ascending {
                        comparison
                    } else {
                        comparison.reverse()
                    };
                }
            }
            std::cmp::Ordering::Equal
        });
        let total = rows.len() as u64;
        let start =
            (query.page_no.saturating_sub(1) as usize).saturating_mul(query.page_size as usize);
        let rows = rows
            .into_iter()
            .skip(start)
            .take(query.page_size as usize)
            .map(|row| {
                if query.selected_fields.is_empty() {
                    row
                } else {
                    query
                        .selected_fields
                        .iter()
                        .filter_map(|field| {
                            row.get(field).cloned().map(|value| (field.clone(), value))
                        })
                        .collect()
                }
            })
            .collect();
        Ok(HorizontalSlice { rows, total })
    }
}

impl PageQueryPort for MemoryAdapters {
    fn query(&self, context: &RequestContext, plan: &QueryPlan) -> Result<PageSlice, ApiError> {
        self.fail_if(FaultPoint::Query)?;
        let source_rows = self
            .rows
            .read()
            .map_err(|_| ApiError::query("row lock poisoned", true))?
            .get(&(scope_key(context), plan.table.as_str().to_owned()))
            .cloned()
            .unwrap_or_default();
        let rendered = plan
            .render()
            .map_err(|error| ApiError::query(format!("invalid query plan: {error:?}"), false))?;
        let mut rows = source_rows
            .into_iter()
            .filter(|row| {
                plan.where_predicates
                    .iter()
                    .all(|predicate| matches_row(row, predicate))
            })
            .collect::<Vec<_>>();
        if !plan.having_predicates.is_empty() {
            let keys = plan
                .group_by
                .iter()
                .map(|column| column.as_str().to_owned())
                .collect::<Vec<_>>();
            let mut surviving_rows = Vec::new();
            for group in group_rows(&rows, &keys).into_values() {
                let mut survives = true;
                for predicate in &plan.having_predicates {
                    if !matches_group(&group, predicate)? {
                        survives = false;
                        break;
                    }
                }
                if survives {
                    surviving_rows.extend(group);
                }
            }
            rows = surviving_rows;
        }
        let stable_order = plan.stable_order();
        rows.sort_by(|left, right| {
            for order in &stable_order {
                let comparison = left
                    .get(order.column.as_str())
                    .unwrap_or(&Value::Null)
                    .cmp(right.get(order.column.as_str()).unwrap_or(&Value::Null));
                if comparison.is_ne() {
                    return match order.direction {
                        Direction::Ascending => comparison,
                        Direction::Descending => comparison.reverse(),
                    };
                }
            }
            std::cmp::Ordering::Equal
        });
        let (page_rows, total, page_keys, pivot_values) = if plan.group_by.is_empty() {
            let total = rows.len() as u64;
            let start =
                (plan.page_no.saturating_sub(1) as usize).saturating_mul(plan.page_size as usize);
            (
                rows.into_iter()
                    .skip(start)
                    .take(plan.page_size as usize)
                    .collect(),
                total,
                vec![],
                vec![],
            )
        } else {
            let keys = plan
                .group_by
                .iter()
                .map(|column| column.as_str().to_owned())
                .collect::<Vec<_>>();
            let page = paginate_distinct_keys(&rows, &keys, plan.page_no, plan.page_size);
            let pivots =
                aggregate_pivots(&page.rows, &keys, &plan.aggregates).map_err(|error| {
                    ApiError::query(format!("horizontal aggregate: {error:?}"), false)
                })?;
            (page.rows, page.total, page.page_keys, pivots)
        };
        let lineage = PageLineage::unified(&rendered.fingerprint);
        let result = PageSlice {
            total,
            rows: page_rows,
            page_keys,
            pivot_values,
            lineage,
            query_fingerprint: rendered.fingerprint,
        };
        self.query_evidence
            .lock()
            .map_err(|_| ApiError::query("query evidence lock poisoned", true))?
            .push(MemoryQueryEvidence {
                context: context.clone(),
                plan: plan.clone(),
                result: result.clone(),
            });
        Ok(result)
    }
}

fn matches_row(row: &Row, predicate: &Predicate) -> bool {
    compare_value(
        row.get(predicate.expression.column.as_str())
            .unwrap_or(&Value::Null),
        predicate.operator,
        &predicate.values,
    )
}

fn matches_group(rows: &[Row], predicate: &Predicate) -> Result<bool, ApiError> {
    let values = rows
        .iter()
        .map(|row| {
            row.get(predicate.expression.column.as_str())
                .cloned()
                .unwrap_or(Value::Null)
        })
        .collect::<Vec<_>>();
    let actual = match predicate.expression.aggregate {
        Some(Aggregate::Count) => {
            Value::Integer(values.iter().filter(|value| value != &&Value::Null).count() as i64)
        }
        Some(Aggregate::Sum) => checked_sum(&values)?,
        Some(Aggregate::Average) => {
            let numbers = integer_values(&values)?;
            if numbers.is_empty() {
                Value::Null
            } else {
                let sum = numbers.iter().try_fold(0_i64, |sum, value| {
                    sum.checked_add(*value)
                        .ok_or_else(|| ApiError::query("aggregate integer overflow", false))
                })?;
                Value::Integer(sum / numbers.len() as i64)
            }
        }
        Some(Aggregate::Minimum) => typed_extreme(&values, false)?,
        Some(Aggregate::Maximum) => typed_extreme(&values, true)?,
        None => return Ok(false),
    };
    Ok(compare_value(
        &actual,
        predicate.operator,
        &predicate.values,
    ))
}

fn integer_values(values: &[Value]) -> Result<Vec<i64>, ApiError> {
    values
        .iter()
        .filter(|value| value != &&Value::Null)
        .map(|value| match value {
            Value::Integer(value) => Ok(*value),
            _ => Err(ApiError::query(
                "numeric aggregate received a non-integer value",
                false,
            )),
        })
        .collect()
}

fn checked_sum(values: &[Value]) -> Result<Value, ApiError> {
    let numbers = integer_values(values)?;
    if numbers.is_empty() {
        return Ok(Value::Null);
    }
    numbers
        .into_iter()
        .try_fold(0_i64, |sum, value| {
            sum.checked_add(value)
                .ok_or_else(|| ApiError::query("aggregate integer overflow", false))
        })
        .map(Value::Integer)
}

fn typed_extreme(values: &[Value], maximum: bool) -> Result<Value, ApiError> {
    let mut values = values.iter().filter(|value| value != &&Value::Null);
    let Some(mut selected) = values.next().cloned() else {
        return Ok(Value::Null);
    };
    for candidate in values {
        let ordering = typed_cmp(candidate, &selected)
            .ok_or_else(|| ApiError::query("aggregate received mixed value types", false))?;
        if (maximum && ordering.is_gt()) || (!maximum && ordering.is_lt()) {
            selected = candidate.clone();
        }
    }
    Ok(selected)
}

fn compare_value(actual: &Value, operator: Operator, expected: &[Value]) -> bool {
    match operator {
        Operator::Equal => expected.first() == Some(actual),
        Operator::NotEqual => expected.first().is_some_and(|value| value != actual),
        Operator::GreaterThan => expected
            .first()
            .and_then(|value| typed_cmp(actual, value))
            .is_some_and(|ordering| ordering.is_gt()),
        Operator::GreaterThanOrEqual => expected
            .first()
            .and_then(|value| typed_cmp(actual, value))
            .is_some_and(|ordering| ordering.is_ge()),
        Operator::LessThan => expected
            .first()
            .and_then(|value| typed_cmp(actual, value))
            .is_some_and(|ordering| ordering.is_lt()),
        Operator::LessThanOrEqual => expected
            .first()
            .and_then(|value| typed_cmp(actual, value))
            .is_some_and(|ordering| ordering.is_le()),
        Operator::In => expected.contains(actual),
        Operator::IsNull => actual == &Value::Null,
        Operator::IsNotNull => actual != &Value::Null,
    }
}

fn typed_cmp(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Boolean(left), Value::Boolean(right)) => Some(left.cmp(right)),
        (Value::Integer(left), Value::Integer(right)) => Some(left.cmp(right)),
        (Value::Text(left), Value::Text(right)) => Some(left.cmp(right)),
        (Value::Null, Value::Null) => Some(std::cmp::Ordering::Equal),
        _ => None,
    }
}

impl PagePreferencePort for MemoryAdapters {
    fn save_page_size(
        &self,
        context: &RequestContext,
        page_id: u64,
        page_size: u32,
    ) -> Result<(), ApiError> {
        self.fail_if(FaultPoint::Preference)?;
        self.preferences
            .write()
            .map_err(|_| ApiError::query("preference lock poisoned", true))?
            .insert((scope_key(context), page_id), page_size);
        Ok(())
    }
}

impl PermissionPort for MemoryAdapters {
    fn ensure_page_access(&self, context: &RequestContext, page_id: u64) -> Result<(), ApiError> {
        self.fail_if(FaultPoint::Permission)?;
        if self
            .denied_pages
            .read()
            .map_err(|_| ApiError::context("permission lock poisoned"))?
            .contains(&(context.tenant_id, page_id))
        {
            return Err(ApiError::context("page access denied"));
        }
        Ok(())
    }
}

impl ChildFormPort for MemoryAdapters {
    fn header_conditions(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<BTreeMap<String, Value>, ApiError> {
        Ok(self
            .child_headers
            .read()
            .map_err(|_| ApiError::query("child form lock poisoned", true))?
            .get(&(context.tenant_id, field_id))
            .cloned()
            .unwrap_or_default())
    }
}

impl LeaseLockPort for MemoryAdapters {
    fn acquire(
        &self,
        context: &RequestContext,
        key: &str,
        owner_token: &str,
        priority: LeasePriority,
        ttl_millis: u64,
    ) -> Result<Option<Lease>, ApiError> {
        self.fail_if(FaultPoint::LeaseAcquire)?;
        if key.is_empty() || owner_token.is_empty() || ttl_millis == 0 {
            return Err(ApiError::refresh("invalid lease claim", false));
        }
        if !key.starts_with(&format!("tenant:{}:", context.tenant_id)) {
            return Err(ApiError::context("lease key tenant mismatch"));
        }
        let now = self.now_millis();
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| ApiError::refresh("lease lock poisoned", true))?;
        if let Some(current) = leases.get(key)
            && current.expires_at_millis > now
            && priority <= current.priority
        {
            return Ok(None);
        }
        let lease = Lease {
            key: key.to_owned(),
            owner_token: owner_token.to_owned(),
            fencing_token: self.fencing_token.fetch_add(1, Ordering::SeqCst) + 1,
            expires_at_millis: now.saturating_add(ttl_millis),
            priority,
        };
        leases.insert(key.to_owned(), lease.clone());
        Ok(Some(lease))
    }

    fn release(&self, _context: &RequestContext, lease: &Lease) -> Result<bool, ApiError> {
        self.fail_if(FaultPoint::LeaseRelease)?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| ApiError::refresh("lease lock poisoned", true))?;
        if leases.get(&lease.key).is_some_and(|current| {
            current.owner_token == lease.owner_token && current.fencing_token == lease.fencing_token
        }) {
            leases.remove(&lease.key);
            return Ok(true);
        }
        Ok(false)
    }
}

impl RefreshPort for MemoryAdapters {
    fn sync(
        &self,
        context: &RequestContext,
        _target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError> {
        self.ensure_active_lease(lease)?;
        self.fail_if(FaultPoint::RefreshSync)?;
        self.record_event(context, "refresh.sync")
    }

    fn update_timestamp(
        &self,
        context: &RequestContext,
        _target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError> {
        self.ensure_active_lease(lease)?;
        self.fail_if(FaultPoint::RefreshTimestamp)?;
        self.record_event(context, "refresh.timestamp")
    }

    fn clear_undo(
        &self,
        context: &RequestContext,
        _target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError> {
        self.ensure_active_lease(lease)?;
        self.fail_if(FaultPoint::RefreshUndoClear)?;
        self.record_event(context, "refresh.undo-clear")
    }

    fn reconcile(
        &self,
        context: &RequestContext,
        _target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError> {
        self.ensure_active_lease(lease)?;
        self.fail_if(FaultPoint::RefreshReconcile)?;
        self.record_event(context, "refresh.reconcile")
    }
}

impl EventPort for MemoryAdapters {
    fn publish(&self, context: &RequestContext, event: EvidenceEvent) -> Result<(), ApiError> {
        if event.trace_id != context.trace_id {
            return Err(ApiError::context("event trace mismatch"));
        }
        self.record_event(context, &event.kind)
    }
}

impl EvidencePort for MemoryAdapters {
    fn append(&self, context: &RequestContext, kind: &str) -> Result<(), ApiError> {
        self.record_event(context, kind)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::domain::query::{AggregateProjection, Expression, Identifier};

    fn context(tenant_id: u64) -> RequestContext {
        RequestContext {
            tenant_id,
            user_id: 2,
            device_id: "device".to_owned(),
            request_id: "request".to_owned(),
            trace_id: "trace".to_owned(),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    #[test]
    fn rows_and_preferences_are_tenant_isolated() {
        let adapter = MemoryAdapters::default();
        adapter.insert_rows(&context(1), "orders", vec![Row::new()]);
        adapter.insert_rows(&context(2), "orders", vec![Row::new(), Row::new()]);
        let request = QueryPlan {
            table: crate::domain::query::Identifier::parse("orders").unwrap(),
            fields: vec![crate::domain::query::Identifier::parse("id").unwrap()],
            where_predicates: vec![],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 10,
        };
        assert_eq!(adapter.query(&context(1), &request).unwrap().total, 1);
        assert_eq!(adapter.query(&context(2), &request).unwrap().total, 2);
        adapter.save_page_size(&context(1), 7, 50).unwrap();
        assert_eq!(adapter.page_size(&context(1), 7), Some(50));
        assert_eq!(adapter.page_size(&context(2), 7), None);
    }

    #[test]
    fn lease_uses_owner_and_fencing_tokens() {
        let adapter = MemoryAdapters::with_time(100);
        let first = adapter
            .acquire(
                &context(1),
                "tenant:1:page:7",
                "a",
                LeasePriority::Automatic,
                50,
            )
            .unwrap()
            .unwrap();
        assert!(
            adapter
                .acquire(
                    &context(1),
                    "tenant:1:page:7",
                    "b",
                    LeasePriority::Automatic,
                    50,
                )
                .unwrap()
                .is_none()
        );
        adapter.set_time(151);
        let second = adapter
            .acquire(
                &context(1),
                "tenant:1:page:7",
                "b",
                LeasePriority::Automatic,
                50,
            )
            .unwrap()
            .unwrap();
        assert!(second.fencing_token > first.fencing_token);
        assert!(!adapter.release(&context(1), &first).unwrap());
        assert!(adapter.release(&context(1), &second).unwrap());
    }

    #[test]
    fn manual_refresh_preempts_automatic_and_fences_the_old_owner() {
        let adapter = MemoryAdapters::with_time(100);
        let key = "tenant:1:page:7:panel:8:column:9";
        let automatic = adapter
            .acquire(&context(1), key, "automatic", LeasePriority::Automatic, 50)
            .unwrap()
            .unwrap();
        let manual = adapter
            .acquire(&context(1), key, "manual", LeasePriority::Manual, 50)
            .unwrap()
            .unwrap();

        assert!(manual.fencing_token > automatic.fencing_token);
        assert!(
            adapter
                .acquire(
                    &context(1),
                    key,
                    "automatic-2",
                    LeasePriority::Automatic,
                    50,
                )
                .unwrap()
                .is_none()
        );
        let target = RefreshTarget {
            page_id: 7,
            panel_id: 8,
            column_id: Some(9),
        };
        assert!(
            adapter
                .sync(&context(1), &target, &automatic)
                .unwrap_err()
                .message
                .contains("stale")
        );
        assert!(!adapter.release(&context(1), &automatic).unwrap());
        assert!(adapter.release(&context(1), &manual).unwrap());
    }

    #[test]
    fn same_column_is_atomic_while_different_columns_can_run() {
        let adapter = Arc::new(MemoryAdapters::with_time(100));
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let adapter = adapter.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    adapter
                        .acquire(
                            &context(1),
                            "tenant:1:page:7:panel:8:column:9",
                            &format!("owner-{index}"),
                            LeasePriority::Automatic,
                            50,
                        )
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let leases = handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(leases.len(), 1);
        assert!(
            adapter
                .acquire(
                    &context(1),
                    "tenant:1:page:7:panel:8:column:10",
                    "other-column",
                    LeasePriority::Automatic,
                    50,
                )
                .unwrap()
                .is_some()
        );
        assert!(adapter.release(&context(1), &leases[0]).unwrap());
    }

    #[test]
    fn lease_key_cannot_cross_tenant_scope() {
        let adapter = MemoryAdapters::with_time(100);
        let error = adapter
            .acquire(
                &context(1),
                "tenant:2:page:7:panel:8:column:9",
                "owner",
                LeasePriority::Manual,
                50,
            )
            .unwrap_err();
        assert_eq!(error.http_status, 403);
    }

    #[test]
    fn datasource_snapshot_and_faults_fail_closed() {
        let adapter = MemoryAdapters::default();
        let first = context(1);
        let mut second = context(1);
        second.snapshot_id = "other".to_owned();
        adapter.insert_rows(&first, "orders", vec![Row::new()]);
        let request = QueryPlan {
            table: crate::domain::query::Identifier::parse("orders").unwrap(),
            fields: vec![crate::domain::query::Identifier::parse("id").unwrap()],
            where_predicates: vec![],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 10,
        };
        assert_eq!(adapter.query(&second, &request).unwrap().total, 0);
        adapter.inject_fault(FaultPoint::Query);
        assert!(adapter.query(&first, &request).is_err());
        adapter.clear_faults();
        assert_eq!(adapter.query(&first, &request).unwrap().total, 1);
    }

    #[test]
    fn having_filters_complete_groups_before_distinct_key_pagination() {
        let adapter = MemoryAdapters::default();
        adapter.insert_rows(
            &context(1),
            "orders",
            vec![
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(60)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(50)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("b".to_owned())),
                    ("amount".to_owned(), Value::Integer(80)),
                ]),
            ],
        );
        let customer = Identifier::parse("customer").unwrap();
        let amount = Identifier::parse("amount").unwrap();
        let plan = QueryPlan {
            table: Identifier::parse("orders").unwrap(),
            fields: vec![customer.clone(), amount.clone()],
            where_predicates: vec![],
            having_predicates: vec![Predicate {
                expression: Expression {
                    column: amount.clone(),
                    aggregate: Some(Aggregate::Sum),
                },
                operator: Operator::GreaterThan,
                values: vec![Value::Integer(100)],
            }],
            group_by: vec![customer],
            order_by: vec![],
            aggregates: vec![AggregateProjection {
                output_key: "total".to_owned(),
                column: amount,
                aggregate: Aggregate::Sum,
            }],
            page_no: 1,
            page_size: 1,
        };

        let page = adapter.query(&context(1), &plan).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.page_keys.len(), 1);
        assert_eq!(page.pivot_values.len(), 1);
        assert_eq!(
            page.pivot_values[0].values["total"].value,
            Value::Integer(110)
        );
        assert_eq!(page.pivot_values[0].values["total"].sum, Some(110));
        assert!(page.lineage.is_unified());
        assert_eq!(page.lineage.total, page.query_fingerprint);
        assert!(
            page.rows
                .iter()
                .all(|row| row["customer"] == Value::Text("a".to_owned()))
        );
    }

    #[test]
    fn aggregates_follow_sql_null_and_type_rules() {
        let amount = Identifier::parse("amount").unwrap();
        let predicate = |aggregate, operator, values| Predicate {
            expression: Expression {
                column: amount.clone(),
                aggregate: Some(aggregate),
            },
            operator,
            values,
        };
        let null_rows = vec![Row::from([("amount".to_owned(), Value::Null)])];

        assert!(
            matches_group(
                &null_rows,
                &predicate(Aggregate::Count, Operator::Equal, vec![Value::Integer(0)])
            )
            .unwrap()
        );
        for aggregate in [
            Aggregate::Sum,
            Aggregate::Average,
            Aggregate::Minimum,
            Aggregate::Maximum,
        ] {
            assert!(
                matches_group(&null_rows, &predicate(aggregate, Operator::IsNull, vec![])).unwrap()
            );
        }

        let mixed_rows = vec![
            Row::from([("amount".to_owned(), Value::Integer(1))]),
            Row::from([("amount".to_owned(), Value::Text("2".to_owned()))]),
        ];
        assert!(
            matches_group(
                &mixed_rows,
                &predicate(
                    Aggregate::Sum,
                    Operator::GreaterThan,
                    vec![Value::Integer(0)]
                )
            )
            .is_err()
        );
        assert!(!compare_value(
            &Value::Integer(10),
            Operator::GreaterThan,
            &[Value::Text("2".to_owned())]
        ));
    }
}
