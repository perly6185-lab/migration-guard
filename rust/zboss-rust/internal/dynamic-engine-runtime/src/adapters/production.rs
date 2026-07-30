use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    sync::Arc,
};

use serde::Deserialize;

use crate::{
    adapters::{
        mysql::MysqlPageQueryAdapter,
        redis::RedisLeaseAdapter,
        sqlx_mysql::{
            HorizontalTableSchema, MysqlHorizontalListAdapter, SqlxMysqlHorizontalQueryExecutor,
            SqlxMysqlStatementExecutor,
        },
        tokio_redis::TokioRedisLeaseExecutor,
    },
    domain::{
        context::RequestContext,
        model::{HorizontalQuery, HorizontalSlice, PageMetadata, PageSlice, Value, ViewMetadata},
        query::QueryPlan,
    },
    http::error::ApiError,
    ports::{
        child_form::ChildFormPort,
        evidence::EvidencePort,
        field_catalog::{FieldCatalogEntry, FieldCatalogPort},
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

type ScopeKey = (u64, String, String);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionCatalog {
    scopes: Vec<CatalogScope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogScope {
    tenant_id: u64,
    datasource: String,
    snapshot_id: String,
    allowed_user_ids: Vec<u64>,
    pages: Vec<CatalogPage>,
    views: Vec<ViewMetadata>,
    #[serde(default)]
    fields: Vec<FieldCatalogEntry>,
    #[serde(default)]
    horizontals: Vec<CatalogHorizontal>,
    #[serde(default)]
    child_form_headers: BTreeMap<u64, BTreeMap<String, Value>>,
    #[serde(default)]
    owned_temporary_tables: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogPage {
    request_ids: Vec<u64>,
    metadata: PageMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogHorizontal {
    horizontal_id: u64,
    table: String,
    fields: BTreeMap<String, String>,
    archived_field: Option<String>,
}

#[derive(Debug)]
struct RuntimeScope {
    allowed_user_ids: BTreeSet<u64>,
    pages: BTreeMap<u64, PageMetadata>,
    views: BTreeMap<(u64, u64), ViewMetadata>,
    fields: BTreeMap<u64, FieldCatalogEntry>,
    child_form_headers: BTreeMap<u64, BTreeMap<String, Value>>,
    owned_temporary_tables: BTreeSet<String>,
    horizontal: MysqlHorizontalListAdapter<SqlxMysqlHorizontalQueryExecutor>,
}

#[derive(Debug)]
pub struct ProductionAdapters {
    scopes: BTreeMap<ScopeKey, RuntimeScope>,
    page_query: MysqlPageQueryAdapter<SqlxMysqlStatementExecutor>,
    _lease: RedisLeaseAdapter<TokioRedisLeaseExecutor>,
}

impl ProductionAdapters {
    pub fn from_env() -> Result<Arc<Self>, String> {
        let catalog_file = required_env("ZBOSS_PAGE_CATALOG_FILE")?;
        let mysql_url = required_env("ZBOSS_PAGE_MYSQL_URL")?;
        let redis_url = required_env("ZBOSS_PAGE_REDIS_URL")?;
        let maximum_connections = std::env::var("ZBOSS_PAGE_MYSQL_MAX_CONNECTIONS")
            .unwrap_or_else(|_| "8".to_owned())
            .parse::<u32>()
            .map_err(|error| format!("invalid ZBOSS_PAGE_MYSQL_MAX_CONNECTIONS: {error}"))?;
        let bytes = fs::read(&catalog_file)
            .map_err(|error| format!("read ZBOSS_PAGE_CATALOG_FILE: {error}"))?;
        let catalog: ProductionCatalog = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse ZBOSS_PAGE_CATALOG_FILE: {error}"))?;
        let statement_executor =
            SqlxMysqlStatementExecutor::connect(&mysql_url, maximum_connections)?;
        // Preserve the established Redis namespace during the runtime rename
        // so mixed-version deployments still coordinate on the same leases.
        let lease_executor = TokioRedisLeaseExecutor::connect(&redis_url, "zboss-page")?;
        Self::build(
            catalog,
            statement_executor,
            RedisLeaseAdapter::new(lease_executor),
        )
        .map(Arc::new)
    }

    fn build(
        catalog: ProductionCatalog,
        statement_executor: SqlxMysqlStatementExecutor,
        lease: RedisLeaseAdapter<TokioRedisLeaseExecutor>,
    ) -> Result<Self, String> {
        if catalog.scopes.is_empty() {
            return Err("production catalog must contain at least one scope".to_owned());
        }
        let mut scopes = BTreeMap::new();
        for scope in catalog.scopes {
            let key = scope_key_values(scope.tenant_id, &scope.datasource, &scope.snapshot_id)?;
            if scope.allowed_user_ids.is_empty() {
                return Err(format!(
                    "scope tenant={} must declare allowedUserIds",
                    scope.tenant_id
                ));
            }
            let mut pages = BTreeMap::new();
            for page in scope.pages {
                if page.request_ids.is_empty() {
                    return Err("catalog page must declare requestIds".to_owned());
                }
                for request_id in page.request_ids {
                    if pages.insert(request_id, page.metadata.clone()).is_some() {
                        return Err(format!("duplicate page requestId: {request_id}"));
                    }
                }
            }
            let mut views = BTreeMap::new();
            for view in scope.views {
                let key = (view.use_page_id, view.view_id);
                if views.insert(key, view).is_some() {
                    return Err(format!(
                        "duplicate view binding: usePageId={} viewId={}",
                        key.0, key.1
                    ));
                }
            }
            let fields = compile_field_catalog(scope.fields, &pages, &views)?;
            let mut horizontal_catalog = BTreeMap::new();
            for horizontal in scope.horizontals {
                let id = horizontal.horizontal_id;
                let schema = HorizontalTableSchema::new(
                    horizontal.table,
                    horizontal.fields,
                    horizontal.archived_field,
                )?;
                if horizontal_catalog.insert(id, schema).is_some() {
                    return Err(format!("duplicate horizontalId: {id}"));
                }
            }
            let runtime_scope = RuntimeScope {
                allowed_user_ids: scope.allowed_user_ids.into_iter().collect(),
                pages,
                views,
                fields,
                child_form_headers: scope.child_form_headers,
                owned_temporary_tables: scope.owned_temporary_tables.into_iter().collect(),
                horizontal: MysqlHorizontalListAdapter::new(SqlxMysqlHorizontalQueryExecutor::new(
                    statement_executor.clone(),
                    horizontal_catalog,
                )),
            };
            if scopes.insert(key, runtime_scope).is_some() {
                return Err("duplicate production scope".to_owned());
            }
        }
        Ok(Self {
            scopes,
            page_query: MysqlPageQueryAdapter::new(statement_executor),
            _lease: lease,
        })
    }

    fn scope(&self, context: &RequestContext) -> Result<&RuntimeScope, ApiError> {
        context.validate().map_err(ApiError::context)?;
        self.scopes
            .get(&scope_key(context))
            .ok_or_else(|| ApiError::context("request scope is not configured"))
    }
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required for production profile"))
}

fn scope_key(context: &RequestContext) -> ScopeKey {
    (
        context.tenant_id,
        context.datasource.clone(),
        context.snapshot_id.clone(),
    )
}

fn scope_key_values(
    tenant_id: u64,
    datasource: &str,
    snapshot_id: &str,
) -> Result<ScopeKey, String> {
    if tenant_id == 0 || datasource.trim().is_empty() || snapshot_id.trim().is_empty() {
        return Err("catalog scope identity must be non-empty".to_owned());
    }
    Ok((tenant_id, datasource.to_owned(), snapshot_id.to_owned()))
}

fn compile_field_catalog(
    fields: Vec<FieldCatalogEntry>,
    pages: &BTreeMap<u64, PageMetadata>,
    views: &BTreeMap<(u64, u64), ViewMetadata>,
) -> Result<BTreeMap<u64, FieldCatalogEntry>, String> {
    let mut compiled = BTreeMap::new();
    let mut logical_keys = BTreeSet::new();
    let mut physical_keys = BTreeSet::new();
    let mut panel_response_keys = BTreeMap::<u64, String>::new();
    let mut response_key_owners = BTreeMap::<String, u64>::new();
    for field in fields {
        if field.id == 0 || field.panel_id == 0 || field.use_page_id == 0 {
            return Err("field catalog identities must be positive".to_owned());
        }
        if field.name.trim().is_empty() {
            return Err(format!("field {} must declare a non-empty name", field.id));
        }
        for (label, value) in [
            ("field", field.field.as_str()),
            ("tableScriptField", field.table_script_field.as_str()),
            ("fieldTypeValue", field.field_type_value.as_str()),
            ("fieldTagInnerKey", field.field_tag_inner_key.as_str()),
        ] {
            if !safe_catalog_token(value) {
                return Err(format!(
                    "field {} has an invalid {label} catalog token",
                    field.id
                ));
            }
        }
        if let Some(response_key) = field.panel_resp_key.as_deref() {
            if !safe_catalog_token(response_key) {
                return Err(format!(
                    "field {} has an invalid panelRespKey catalog token",
                    field.id
                ));
            }
            if let Some(existing) = panel_response_keys.get(&field.panel_id)
                && existing != response_key
            {
                return Err(format!(
                    "panelId={} has inconsistent response key (panelRespKey) bindings",
                    field.panel_id
                ));
            }
            if let Some(owner) = response_key_owners.get(response_key)
                && owner != &field.panel_id
            {
                return Err(format!(
                    "panelRespKey={response_key} is assigned to multiple panels"
                ));
            }
            panel_response_keys.insert(field.panel_id, response_key.to_owned());
            response_key_owners.insert(response_key.to_owned(), field.panel_id);
        }
        let bound_to_page = pages
            .get(&field.use_page_id)
            .is_some_and(|metadata| metadata.panel_id == field.panel_id);
        let bound_to_view = views
            .values()
            .any(|view| view.use_page_id == field.use_page_id && view.panel_id == field.panel_id);
        if !bound_to_page && !bound_to_view {
            return Err(format!(
                "field {} is not bound to its usePageId={} panelId={}",
                field.id, field.use_page_id, field.panel_id
            ));
        }
        if !logical_keys.insert((field.panel_id, field.field.clone())) {
            return Err(format!(
                "duplicate logical field binding: panelId={} field={}",
                field.panel_id, field.field
            ));
        }
        if !physical_keys.insert((field.panel_id, field.table_script_field.clone())) {
            return Err(format!(
                "duplicate physical field binding: panelId={} tableScriptField={}",
                field.panel_id, field.table_script_field
            ));
        }
        let field_id = field.id;
        if compiled.insert(field_id, field).is_some() {
            return Err(format!("duplicate field id: {field_id}"));
        }
    }
    Ok(compiled)
}

fn safe_catalog_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl PermissionPort for ProductionAdapters {
    fn ensure_page_access(&self, context: &RequestContext, _page_id: u64) -> Result<(), ApiError> {
        let scope = self.scope(context)?;
        if scope.allowed_user_ids.contains(&context.user_id) {
            Ok(())
        } else {
            Err(ApiError::context(
                "user is not allowed in the request scope",
            ))
        }
    }
}

impl MetadataPort for ProductionAdapters {
    fn load_page(&self, context: &RequestContext, page_id: u64) -> Result<PageMetadata, ApiError> {
        self.scope(context)?
            .pages
            .get(&page_id)
            .cloned()
            .ok_or_else(|| ApiError::query("page metadata not found in production catalog", false))
    }

    fn ensure_table_owned(&self, context: &RequestContext, table: &str) -> Result<(), ApiError> {
        if self.scope(context)?.owned_temporary_tables.contains(table) {
            Ok(())
        } else {
            Err(ApiError::context(
                "temporary table is not owned by the request scope",
            ))
        }
    }
}

impl ViewMetadataPort for ProductionAdapters {
    fn load_view(
        &self,
        context: &RequestContext,
        use_page_id: u64,
        view_id: u64,
    ) -> Result<ViewMetadata, ApiError> {
        self.scope(context)?
            .views
            .get(&(use_page_id, view_id))
            .cloned()
            .ok_or_else(|| ApiError::query("view metadata not found in production catalog", false))
    }
}

impl ChildFormPort for ProductionAdapters {
    fn header_conditions(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<BTreeMap<String, Value>, ApiError> {
        self.scope(context)?
            .child_form_headers
            .get(&field_id)
            .cloned()
            .ok_or_else(|| ApiError::query("child-form header binding is not configured", false))
    }
}

impl PageQueryPort for ProductionAdapters {
    fn query(&self, context: &RequestContext, plan: &QueryPlan) -> Result<PageSlice, ApiError> {
        self.scope(context)?;
        self.page_query.query(context, plan)
    }
}

impl HorizontalListPort for ProductionAdapters {
    fn list_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> Result<HorizontalSlice, ApiError> {
        self.scope(context)?
            .horizontal
            .list_horizontal(context, query)
    }
}

impl InitPort for ProductionAdapters {
    fn init_atomic(
        &self,
        context: &RequestContext,
        _command: &InitCommand,
    ) -> Result<InitCommit, ApiError> {
        let scope = self.scope(context)?;
        if !scope.allowed_user_ids.contains(&context.user_id) {
            return Err(ApiError::context(
                "user is not allowed in the request scope",
            ));
        }
        Err(ApiError::mutation(
            "init mutation is not enabled: configure an allowlisted field catalog, transactional insert/idempotency/undo tables, and a durable cascade outbox",
            false,
        ))
    }
}

impl FieldSchemaPort for ProductionAdapters {
    fn apply_field_transition(
        &self,
        context: &RequestContext,
        _command: &FieldSchemaCommand,
    ) -> Result<FieldSchemaCommit, ApiError> {
        let scope = self.scope(context)?;
        if !scope.allowed_user_ids.contains(&context.user_id) {
            return Err(ApiError::context(
                "user is not allowed in the request scope",
            ));
        }
        Err(ApiError::mutation(
            "field schema mutation is not enabled: configure scoped existing-field lookup for edit, a metadata-derived DDL allowlist for add, schema transition ledger/lease, orphan-column repair, metadata transaction, cache invalidation and durable post-commit jobs",
            false,
        ))
    }
}

impl FieldCatalogPort for ProductionAdapters {
    fn list_fields(
        &self,
        context: &RequestContext,
        use_page_id: u64,
    ) -> Result<Vec<FieldCatalogEntry>, ApiError> {
        let scope = self.scope(context)?;
        if !scope.allowed_user_ids.contains(&context.user_id) {
            return Err(ApiError::context(
                "user is not allowed in the request scope",
            ));
        }
        Ok(scope
            .fields
            .values()
            .filter(|field| field.use_page_id == use_page_id)
            .cloned()
            .collect())
    }

    fn get_field(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError> {
        let scope = self.scope(context)?;
        if !scope.allowed_user_ids.contains(&context.user_id) {
            return Err(ApiError::context(
                "user is not allowed in the request scope",
            ));
        }
        Ok(scope.fields.get(&field_id).cloned())
    }
}

impl FieldDeletePort for ProductionAdapters {
    fn delete_field(
        &self,
        context: &RequestContext,
        _command: &FieldDeleteCommand,
    ) -> Result<FieldDeleteCommit, ApiError> {
        let scope = self.scope(context)?;
        if !scope.allowed_user_ids.contains(&context.user_id) {
            return Err(ApiError::context(
                "user is not allowed in the request scope",
            ));
        }
        Err(ApiError::mutation(
            "field delete is not enabled: configure scoped field lookup, reference verification, transactional metadata/config cleanup, undo snapshots, cache invalidation and durable post-commit jobs; physical DROP COLUMN must remain disabled",
            false,
        ))
    }
}

impl PagePreferencePort for ProductionAdapters {
    fn save_page_size(
        &self,
        _context: &RequestContext,
        _page_id: u64,
        _page_size: u32,
    ) -> Result<(), ApiError> {
        Err(ApiError::query(
            "page-size persistence is not configured; send skipSavePageSize=true",
            false,
        ))
    }
}

impl LeaseLockPort for ProductionAdapters {
    fn acquire(
        &self,
        _context: &RequestContext,
        _key: &str,
        _owner_token: &str,
        _priority: LeasePriority,
        _ttl_millis: u64,
    ) -> Result<Option<Lease>, ApiError> {
        Err(ApiError::refresh(
            "page refresh is not enabled in the production catalog",
            false,
        ))
    }

    fn release(&self, _context: &RequestContext, _lease: &Lease) -> Result<bool, ApiError> {
        Err(ApiError::refresh(
            "page refresh is not enabled in the production catalog",
            false,
        ))
    }
}

impl RefreshPort for ProductionAdapters {
    fn sync(
        &self,
        _context: &RequestContext,
        _target: &RefreshTarget,
        _lease: &Lease,
    ) -> Result<(), ApiError> {
        Err(ApiError::refresh("page refresh is not configured", false))
    }

    fn update_timestamp(
        &self,
        _context: &RequestContext,
        _target: &RefreshTarget,
        _lease: &Lease,
    ) -> Result<(), ApiError> {
        Err(ApiError::refresh("page refresh is not configured", false))
    }

    fn clear_undo(
        &self,
        _context: &RequestContext,
        _target: &RefreshTarget,
        _lease: &Lease,
    ) -> Result<(), ApiError> {
        Err(ApiError::refresh("page refresh is not configured", false))
    }

    fn reconcile(
        &self,
        _context: &RequestContext,
        _target: &RefreshTarget,
        _lease: &Lease,
    ) -> Result<(), ApiError> {
        Err(ApiError::refresh("page refresh is not configured", false))
    }
}

impl EvidencePort for ProductionAdapters {
    fn append(&self, _context: &RequestContext, _kind: &str) -> Result<(), ApiError> {
        Err(ApiError::refresh(
            "refresh evidence sink is not configured",
            false,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::field_catalog::FieldDeleteBehavior;

    const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;
    const PANEL_ID: u64 = 2_059_838_046_666_665_986;

    fn pages() -> BTreeMap<u64, PageMetadata> {
        BTreeMap::from([(
            USE_PAGE_ID,
            PageMetadata {
                version: 1,
                page_id: 7,
                panel_id: PANEL_ID,
                table: "ledger".to_owned(),
                business_key: vec!["id".to_owned()],
                fields: vec![],
            },
        )])
    }

    fn field(id: u64, logical: &str, physical: &str) -> FieldCatalogEntry {
        FieldCatalogEntry {
            id,
            panel_id: PANEL_ID,
            use_page_id: USE_PAGE_ID,
            name: format!("字段{id}"),
            field: logical.to_owned(),
            table_script_field: physical.to_owned(),
            field_type_value: "text".to_owned(),
            field_tag_inner_key: "text".to_owned(),
            panel_resp_key: Some("data".to_owned()),
            delete_behavior: FieldDeleteBehavior::Remove,
            additional_values: BTreeMap::from([(
                "fieldTagCss".to_owned(),
                serde_json::json!("#606266"),
            )]),
        }
    }

    #[test]
    fn production_field_catalog_accepts_reviewed_detail_projection() {
        let catalog = compile_field_catalog(
            vec![
                field(2, "custField2", "cust_field_2"),
                field(1, "custField1", "cust_field_1"),
            ],
            &pages(),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(catalog.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(catalog[&1].panel_resp_key.as_deref(), Some("data"));
        assert_eq!(catalog[&1].additional_values["fieldTagCss"], "#606266");
    }

    #[test]
    fn production_field_catalog_rejects_duplicates_unbound_and_unsafe_tokens() {
        let duplicate_id = compile_field_catalog(
            vec![
                field(1, "custField1", "cust_field_1"),
                field(1, "custField2", "cust_field_2"),
            ],
            &pages(),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(duplicate_id.contains("duplicate field id"));

        let duplicate_physical = compile_field_catalog(
            vec![
                field(1, "custField1", "cust_field_1"),
                field(2, "custField2", "cust_field_1"),
            ],
            &pages(),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(duplicate_physical.contains("duplicate physical field"));

        let mut unbound = field(1, "custField1", "cust_field_1");
        unbound.use_page_id += 1;
        let unbound_error =
            compile_field_catalog(vec![unbound], &pages(), &BTreeMap::new()).unwrap_err();
        assert!(unbound_error.contains("is not bound"));

        let unsafe_token = compile_field_catalog(
            vec![field(1, "custField1;DROP", "cust_field_1")],
            &pages(),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(unsafe_token.contains("invalid field"));

        let mut inconsistent_response_key = field(2, "custField2", "cust_field_2");
        inconsistent_response_key.panel_resp_key = Some("otherData".to_owned());
        let inconsistent_key_error = compile_field_catalog(
            vec![
                field(1, "custField1", "cust_field_1"),
                inconsistent_response_key,
            ],
            &pages(),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(inconsistent_key_error.contains("inconsistent response key"));
    }

    #[test]
    fn production_catalog_example_contains_a_valid_field_binding() {
        let catalog: ProductionCatalog =
            serde_json::from_str(include_str!("../../config/production-catalog.example.json"))
                .unwrap();
        let scope = catalog.scopes.into_iter().next().unwrap();
        let mut page_bindings = BTreeMap::new();
        for page in scope.pages {
            for request_id in page.request_ids {
                page_bindings.insert(request_id, page.metadata.clone());
            }
        }
        let view_bindings = scope
            .views
            .into_iter()
            .map(|view| ((view.use_page_id, view.view_id), view))
            .collect();

        let fields = compile_field_catalog(scope.fields, &page_bindings, &view_bindings).unwrap();
        assert_eq!(fields.len(), 1);
    }
}
