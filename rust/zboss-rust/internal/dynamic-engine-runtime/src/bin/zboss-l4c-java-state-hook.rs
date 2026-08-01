use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Component, Path},
    process,
};

use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{
    MySql, MySqlPool, QueryBuilder, Row,
    mysql::{MySqlPoolOptions, MySqlRow},
    types::Json,
};

const HOOK_PROTOCOL: &str = "migration-guard.batch-update-l4c-state-hook/v1";
const PROFILE_PROTOCOL: &str = "migration-guard.batch-update-l4c-java-state-profile/v1";
const SEED_PROTOCOL: &str = "migration-guard.batch-update-l4c-java-seed/v1";
const EVENT_PROTOCOL: &str = "migration-guard.batch-update-l4c-websocket-event/v1";
const PROJECT_ID: &str = "zboss-batch-update-with-progress";
const ADAPTER_ID: &str = "java-deployed-v1";

#[derive(Clone)]
struct Scope {
    scenario_id: String,
    marker: String,
    tenant_id: String,
    panel_id: String,
    table: String,
    database: String,
    max_rows: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Profile {
    schema_version: u32,
    protocol: String,
    status: String,
    project_id: String,
    target_kind: String,
    adapter: String,
    applicable_scenarios: Vec<String>,
    connections: Connections,
    semantics: Vec<SemanticBinding>,
    mysql: MysqlProfile,
    redis: RedisProfile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Connections {
    mysql_url_env: String,
    #[serde(default)]
    redis_url_env: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SemanticBinding {
    role: SemanticRole,
    storage: SemanticStorage,
    #[serde(default)]
    resource_ids: Vec<String>,
    collector: Option<String>,
    rationale: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
enum SemanticRole {
    Projection,
    Idempotency,
    Commit,
    Undo,
    Outbox,
    SchemaLedger,
    Progress,
    BatchLease,
    SchemaLease,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum SemanticStorage {
    Mysql,
    Redis,
    VolatileEvent,
    Absent,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MysqlProfile {
    resources: Vec<MysqlResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MysqlResource {
    id: String,
    role: MysqlRole,
    table: String,
    tenant_column: String,
    panel_column: Option<String>,
    marker_column: String,
    marker_match: MarkerMatch,
    marker_json_path: Option<String>,
    order_column: String,
    columns: Vec<ProfileColumn>,
    cleanup: bool,
    cleanup_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileColumn {
    name: String,
    alias: String,
    kind: ColumnKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
enum MysqlRole {
    Projection,
    Idempotency,
    Commit,
    Undo,
    Outbox,
    SchemaLedger,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MarkerMatch {
    Exact,
    Prefix,
    JsonPathExact,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ColumnKind {
    Scalar,
    Json,
    Text,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RedisProfile {
    resources: Vec<RedisResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RedisResource {
    id: String,
    role: RedisRole,
    data_type: RedisDataType,
    key_template: String,
    marker_location: MarkerLocation,
    #[serde(default)]
    fields: Vec<RedisField>,
    cleanup: RedisCleanup,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RedisField {
    name: String,
    alias: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
enum RedisRole {
    Progress,
    BatchLease,
    SchemaLease,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum RedisDataType {
    Hash,
    String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MarkerLocation {
    Key,
    HashField,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RedisCleanup {
    ExactKey,
    MatchingHashFields,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MysqlState {
    fixture_rows: u64,
    idempotency_rows: u64,
    undo_rows: u64,
    outbox_rows: u64,
    commit_rows: u64,
    schema_ledger_rows: u64,
    projection: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedisState {
    progress_keys: u64,
    lease_fields: u64,
    progress: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupCounters {
    fixture_rows: u64,
    undo_rows: u64,
    outbox_rows: u64,
    commit_rows: u64,
    redis_keys: u64,
    lease_keys: u64,
    schema_artifacts: u64,
    fault_artifacts: u64,
}

struct ResourceSnapshot {
    count: u64,
    rows: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeedProfile {
    schema_version: u32,
    protocol: String,
    status: String,
    project_id: String,
    target_kind: String,
    scenario_id: String,
    state_profile_sha256: String,
    resources: Vec<SeedResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeedResource {
    resource_id: String,
    rows: Vec<SeedRow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeedRow {
    marker_suffix: String,
    values: BTreeMap<String, Value>,
}

struct SeedOutcome {
    inserted: u64,
    bindings: BTreeMap<String, BTreeMap<String, String>>,
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(document) => println!("{document}"),
        Err(error) => {
            eprintln!("L4-C Java state hook blocked: {error}");
            process::exit(1);
        }
    }
}

async fn run() -> Result<Value, String> {
    require_env_value("MG_L4C_HOOK_PROTOCOL", HOOK_PROTOCOL)?;
    let operation = env::args()
        .nth(1)
        .ok_or_else(|| "state hook operation is required".to_owned())?;
    let scope = load_scope()?;
    let (profile, profile_hash) = load_profile()?;
    validate_profile(&profile)?;
    validate_profile_scope(&profile, &scope)?;

    if operation == "validate-profile" {
        return Ok(hook_document(
            &scope,
            json!({
                "rowCount": 0,
                "diagnostic": {
                    "adapter": ADAPTER_ID,
                    "profileHash": profile_hash,
                    "mysqlResources": profile.mysql.resources.len(),
                    "redisResources": profile.redis.resources.len(),
                }
            }),
            &profile_hash,
        ));
    }

    let mysql_url = normalize_mysql_url(&required_env(&profile.connections.mysql_url_env)?)?;
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&mysql_url)
        .await
        .map_err(|error| format!("connect scoped Java MySQL: {error}"))?;
    verify_database_scope(&pool, &scope).await?;
    let mut redis = if let Some(redis_env) = &profile.connections.redis_url_env {
        let redis_url = required_env(redis_env)?;
        if !redis_url.starts_with("redis://") {
            return Err("Java Redis URL must use redis://".to_owned());
        }
        let client = redis::Client::open(redis_url)
            .map_err(|error| format!("configure scoped Java Redis: {error}"))?;
        Some(
            client
                .get_multiplexed_async_connection()
                .await
                .map_err(|error| format!("connect scoped Java Redis: {error}"))?,
        )
    } else {
        None
    };

    let payload = match operation.as_str() {
        "doctor" => doctor(&pool, redis.as_mut(), &scope, &profile, &profile_hash).await?,
        "seed" => seed(&pool, redis.as_mut(), &scope, &profile, &profile_hash).await?,
        "snapshot" => snapshot(&pool, redis.as_mut(), &scope, &profile).await?,
        "collect" => collect(&pool, redis.as_mut(), &scope, &profile).await?,
        "cleanup" => cleanup(&pool, redis.as_mut(), &scope, &profile).await?,
        "verify-cleanup" | "verifyCleanup" => {
            verify_cleanup(&pool, redis.as_mut(), &scope, &profile).await?
        }
        "inject-fault" | "injectFault" => {
            return Err("fault scenarios require the separate fault controller".to_owned());
        }
        _ => {
            return Err(format!(
                "unsupported Java state hook operation: {operation}"
            ));
        }
    };
    Ok(hook_document(&scope, payload, &profile_hash))
}

fn hook_document(scope: &Scope, payload: Value, profile_hash: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "protocol": HOOK_PROTOCOL,
        "status": "passed",
        "marker": scope.marker,
        "rowCount": payload["rowCount"],
        "profileHash": profile_hash,
        "seedHash": payload.get("seedHash"),
        "bindings": payload.get("bindings"),
        "snapshot": payload.get("snapshot"),
        "observation": payload.get("observation"),
        "cleanup": payload.get("cleanup"),
        "diagnostic": payload.get("diagnostic"),
    })
}

fn load_scope() -> Result<Scope, String> {
    require_env_value("MG_L4C_TARGET_KIND", "source")?;
    let scenario_id = required_env("MG_L4C_SCENARIO_ID")?;
    validate_token("scenario ID", &scenario_id, 128)?;
    let marker = required_env("MG_L4C_MARKER")?;
    validate_token("marker", &marker, 128)?;
    let tenant_id = required_env("MG_L4C_TENANT_ID")?;
    validate_token("tenant ID", &tenant_id, 64)?;
    let panel_id = required_env("MG_L4C_PANEL_ID")?;
    validate_token("panel ID", &panel_id, 64)?;
    let table = required_env("MG_L4C_TABLE")?;
    if !is_safe_dynamic_table(&table) {
        return Err("MG_L4C_TABLE must match cust_table<digits>".to_owned());
    }
    let database = required_env("MG_L4C_DATABASE")?;
    if !is_safe_database(&database) {
        return Err("MG_L4C_DATABASE is not an approved disposable database".to_owned());
    }
    let max_rows = parse_u64("MG_L4C_MAX_ROWS")?;
    if !(1..=100).contains(&max_rows) {
        return Err("MG_L4C_MAX_ROWS must be between 1 and 100".to_owned());
    }
    Ok(Scope {
        scenario_id,
        marker,
        tenant_id,
        panel_id,
        table,
        database,
        max_rows,
    })
}

fn load_profile() -> Result<(Profile, String), String> {
    let profile_path = required_env("MG_L4C_JAVA_STATE_PROFILE")?;
    let path = Path::new(&profile_path);
    if path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("MG_L4C_JAVA_STATE_PROFILE must be a nested JSON path".to_owned());
    }
    let content = fs::read(path).map_err(|error| format!("read Java state profile: {error}"))?;
    if content.len() > 1024 * 1024 {
        return Err("Java state profile exceeds 1 MiB".to_owned());
    }
    let hash = canonical_file_hash(&content);
    let profile = serde_json::from_slice(&content)
        .map_err(|error| format!("decode Java state profile: {error}"))?;
    Ok((profile, hash))
}

fn load_seed_profile(
    profile: &Profile,
    profile_hash: &str,
    scope: &Scope,
) -> Result<(SeedProfile, String), String> {
    let seed_path = required_env("MG_L4C_SEED_PROFILE")?;
    let path = Path::new(&seed_path);
    if path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("MG_L4C_SEED_PROFILE must be a nested JSON path".to_owned());
    }
    let content = fs::read(path).map_err(|error| format!("read Java seed profile: {error}"))?;
    if content.len() > 1024 * 1024 {
        return Err("Java seed profile exceeds 1 MiB".to_owned());
    }
    let hash = canonical_file_hash(&content);
    let expected_hash = required_env("MG_L4C_SEED_PROFILE_SHA256")?;
    if hash != expected_hash {
        return Err("Java seed profile hash does not match binding".to_owned());
    }
    let seed: SeedProfile = serde_json::from_slice(&content)
        .map_err(|error| format!("decode Java seed profile: {error}"))?;
    validate_seed_profile(&seed, profile, profile_hash, scope)?;
    Ok((seed, hash))
}

fn validate_seed_profile(
    seed: &SeedProfile,
    profile: &Profile,
    profile_hash: &str,
    scope: &Scope,
) -> Result<(), String> {
    if seed.schema_version != 1
        || seed.protocol != SEED_PROTOCOL
        || seed.status != "approved"
        || seed.project_id != PROJECT_ID
        || seed.target_kind != "source"
        || seed.scenario_id != scope.scenario_id
        || seed.state_profile_sha256 != profile_hash
    {
        return Err("Java seed profile identity or binding is invalid".to_owned());
    }
    let resources = profile
        .mysql
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect::<BTreeMap<_, _>>();
    let mut ids = BTreeSet::new();
    let mut total_rows = 0u64;
    for seed_resource in &seed.resources {
        let resource = resources
            .get(seed_resource.resource_id.as_str())
            .ok_or_else(|| format!("unknown Java seed resource: {}", seed_resource.resource_id))?;
        if !ids.insert(seed_resource.resource_id.as_str())
            || resource.role != MysqlRole::Projection
            || seed_resource.rows.is_empty()
        {
            return Err(format!(
                "Java seed resource is not an approved projection: {}",
                seed_resource.resource_id
            ));
        }
        total_rows = total_rows.saturating_add(seed_resource.rows.len() as u64);
        let required_aliases = resource
            .columns
            .iter()
            .filter(|column| !is_scope_column(resource, &column.name))
            .map(|column| column.alias.as_str())
            .collect::<BTreeSet<_>>();
        for row in &seed_resource.rows {
            validate_token("seed marker suffix", &row.marker_suffix, 64)?;
            if matches!(resource.marker_match, MarkerMatch::JsonPathExact) {
                return Err("JSON-path marker resources cannot be seeded".to_owned());
            }
            if matches!(resource.marker_match, MarkerMatch::Exact) && row.marker_suffix != "exact" {
                return Err("exact-marker seed row must use markerSuffix=exact".to_owned());
            }
            let actual_aliases = row
                .values
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            if actual_aliases != required_aliases {
                return Err(format!(
                    "Java seed aliases do not match reviewed resource: {}",
                    resource.id
                ));
            }
            for value in row.values.values() {
                let encoded = serde_json::to_vec(value)
                    .map_err(|error| format!("encode Java seed value: {error}"))?;
                if encoded.len() > 64 * 1024 {
                    return Err("Java seed value exceeds 64 KiB".to_owned());
                }
            }
        }
    }
    if total_rows == 0 || total_rows > scope.max_rows {
        return Err("Java seed row count is outside the approved scope".to_owned());
    }
    Ok(())
}

fn canonical_file_hash(content: &[u8]) -> String {
    let mut canonical = Vec::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        if content[index] == b'\r' && content.get(index + 1) == Some(&b'\n') {
            canonical.push(b'\n');
            index += 2;
        } else {
            canonical.push(content[index]);
            index += 1;
        }
    }
    format!("{:x}", Sha256::digest(canonical))
}

async fn apply_seed(
    pool: &MySqlPool,
    scope: &Scope,
    profile: &Profile,
    seed: &SeedProfile,
) -> Result<SeedOutcome, String> {
    let resources = profile
        .mysql
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect::<BTreeMap<_, _>>();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin Java seed transaction: {error}"))?;
    let mut inserted = 0u64;
    let mut bindings = BTreeMap::new();
    for seed_resource in &seed.resources {
        let resource = resources
            .get(seed_resource.resource_id.as_str())
            .ok_or_else(|| format!("unknown Java seed resource: {}", seed_resource.resource_id))?;
        for row in &seed_resource.rows {
            let (columns, values) = seed_insert_values(resource, row, scope)?;
            let mut query = QueryBuilder::<MySql>::new("INSERT INTO ");
            query.push(quote_identifier(&resource.table)).push(" (");
            {
                let mut separated = query.separated(", ");
                for column in &columns {
                    separated.push(quote_identifier(column));
                }
            }
            query.push(") VALUES (");
            {
                let mut separated = query.separated(", ");
                for value in values {
                    separated.push_bind(value);
                }
            }
            query.push(")");
            let result = query
                .build()
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("seed Java resource {}: {error}", resource.id))?;
            let marker = seed_marker(resource, row, scope);
            if bindings
                .insert(
                    row.marker_suffix.clone(),
                    BTreeMap::from([
                        (
                            "generatedId".to_owned(),
                            result.last_insert_id().to_string(),
                        ),
                        ("marker".to_owned(), marker),
                    ]),
                )
                .is_some()
            {
                return Err(format!(
                    "duplicate Java seed marker suffix: {}",
                    row.marker_suffix
                ));
            }
            inserted += 1;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit Java seed transaction: {error}"))?;
    Ok(SeedOutcome { inserted, bindings })
}

fn seed_insert_values(
    resource: &MysqlResource,
    row: &SeedRow,
    scope: &Scope,
) -> Result<(Vec<String>, Vec<Option<String>>), String> {
    let marker = seed_marker(resource, row, scope);
    let mut columns = Vec::new();
    let mut values = Vec::new();
    push_seed_value(
        &mut columns,
        &mut values,
        &resource.tenant_column,
        Some(scope.tenant_id.clone()),
    )?;
    if let Some(panel) = &resource.panel_column {
        push_seed_value(
            &mut columns,
            &mut values,
            panel,
            Some(scope.panel_id.clone()),
        )?;
    }
    push_seed_value(
        &mut columns,
        &mut values,
        &resource.marker_column,
        Some(marker),
    )?;
    for column in &resource.columns {
        if is_scope_column(resource, &column.name) {
            continue;
        }
        let value = row
            .values
            .get(&column.alias)
            .ok_or_else(|| format!("missing Java seed alias: {}", column.alias))?;
        let encoded = match column.kind {
            ColumnKind::Json => Some(
                serde_json::to_string(value)
                    .map_err(|error| format!("encode Java JSON seed: {error}"))?,
            ),
            ColumnKind::Scalar | ColumnKind::Text => match value {
                Value::Null => None,
                Value::String(item) => Some(item.clone()),
                Value::Bool(item) => Some(item.to_string()),
                Value::Number(item) => Some(item.to_string()),
                _ => {
                    return Err(format!(
                        "non-JSON seed alias must be scalar: {}",
                        column.alias
                    ));
                }
            },
        };
        push_seed_value(&mut columns, &mut values, &column.name, encoded)?;
    }
    if !columns
        .iter()
        .any(|column| column == &resource.order_column)
    {
        return Err(format!(
            "Java seed does not bind order column: {}",
            resource.order_column
        ));
    }
    Ok((columns, values))
}

fn seed_marker(resource: &MysqlResource, row: &SeedRow, scope: &Scope) -> String {
    match resource.marker_match {
        MarkerMatch::Exact | MarkerMatch::JsonPathExact => scope.marker.clone(),
        MarkerMatch::Prefix => format!("{}-{}", scope.marker, row.marker_suffix),
    }
}

fn push_seed_value(
    columns: &mut Vec<String>,
    values: &mut Vec<Option<String>>,
    column: &str,
    value: Option<String>,
) -> Result<(), String> {
    if columns.iter().any(|existing| existing == column) {
        return Err(format!("duplicate Java seed column: {column}"));
    }
    columns.push(column.to_owned());
    values.push(value);
    Ok(())
}

fn is_scope_column(resource: &MysqlResource, column: &str) -> bool {
    column == resource.tenant_column
        || column == resource.marker_column
        || resource.panel_column.as_deref() == Some(column)
}

fn validate_profile(profile: &Profile) -> Result<(), String> {
    if profile.schema_version != 1
        || profile.protocol != PROFILE_PROTOCOL
        || profile.status != "approved"
        || profile.project_id != PROJECT_ID
        || profile.target_kind != "source"
        || profile.adapter != ADAPTER_ID
        || profile.connections.mysql_url_env != "MG_JAVA_DATABASE_URL"
        || profile
            .connections
            .redis_url_env
            .as_deref()
            .is_some_and(|value| value != "MG_JAVA_REDIS_URL")
    {
        return Err("Java state profile identity or approval is invalid".to_owned());
    }
    let applicable_scenarios = profile
        .applicable_scenarios
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if profile.applicable_scenarios.is_empty()
        || profile.applicable_scenarios.len() > 19
        || applicable_scenarios.len() != profile.applicable_scenarios.len()
        || profile
            .applicable_scenarios
            .iter()
            .any(|scenario| !is_profile_id(scenario))
    {
        return Err("Java state profile applicable scenarios are invalid".to_owned());
    }
    let mut ids = BTreeSet::new();
    for resource in &profile.mysql.resources {
        if !ids.insert(resource.id.as_str())
            || !is_profile_id(&resource.id)
            || !resource.cleanup
            || resource.columns.is_empty()
            || !is_identifier(&resource.table)
            || !is_identifier(&resource.tenant_column)
            || !is_identifier(&resource.marker_column)
            || !is_identifier(&resource.order_column)
            || resource
                .panel_column
                .as_deref()
                .is_some_and(|value| !is_identifier(value))
            || match resource.marker_match {
                MarkerMatch::JsonPathExact => !resource
                    .marker_json_path
                    .as_deref()
                    .is_some_and(valid_json_path),
                MarkerMatch::Exact | MarkerMatch::Prefix => resource.marker_json_path.is_some(),
            }
        {
            return Err(format!("unsafe Java MySQL resource: {}", resource.id));
        }
        if matches!(
            resource.role,
            MysqlRole::Idempotency | MysqlRole::SchemaLedger
        ) && resource.panel_column.is_none()
        {
            return Err(format!(
                "panel scope is missing for resource: {}",
                resource.id
            ));
        }
        let mut aliases = BTreeSet::new();
        for column in &resource.columns {
            if !is_identifier(&column.name)
                || !is_alias(&column.alias)
                || !aliases.insert(column.alias.as_str())
            {
                return Err(format!("unsafe Java MySQL column: {}", resource.id));
            }
        }
    }

    ids.clear();
    for resource in &profile.redis.resources {
        let field_aliases = resource
            .fields
            .iter()
            .map(|field| field.alias.as_str())
            .collect::<BTreeSet<_>>();
        if !ids.insert(resource.id.as_str())
            || !is_profile_id(&resource.id)
            || !valid_key_template(&resource.key_template)
            || resource
                .fields
                .iter()
                .any(|field| !is_identifier(&field.name) || !is_identifier(&field.alias))
            || field_aliases.len() != resource.fields.len()
        {
            return Err(format!("unsafe Java Redis resource: {}", resource.id));
        }
        match (
            resource.marker_location,
            resource.cleanup,
            resource.data_type,
        ) {
            (MarkerLocation::Key, RedisCleanup::ExactKey, _) => {
                if !resource.key_template.contains("{marker}") {
                    return Err(format!(
                        "exact Redis cleanup is not marker-bound: {}",
                        resource.id
                    ));
                }
            }
            (MarkerLocation::HashField, RedisCleanup::MatchingHashFields, RedisDataType::Hash) => {}
            _ => {
                return Err(format!(
                    "unsafe Redis marker/cleanup combination: {}",
                    resource.id
                ));
            }
        }
    }
    if !profile.redis.resources.is_empty()
        && profile.connections.redis_url_env.as_deref() != Some("MG_JAVA_REDIS_URL")
    {
        return Err("Java Redis resources require MG_JAVA_REDIS_URL".to_owned());
    }
    validate_semantics(profile)?;
    Ok(())
}

fn validate_semantics(profile: &Profile) -> Result<(), String> {
    let expected = BTreeSet::from([
        SemanticRole::Projection,
        SemanticRole::Idempotency,
        SemanticRole::Commit,
        SemanticRole::Undo,
        SemanticRole::Outbox,
        SemanticRole::SchemaLedger,
        SemanticRole::Progress,
        SemanticRole::BatchLease,
        SemanticRole::SchemaLease,
    ]);
    let roles = profile
        .semantics
        .iter()
        .map(|binding| binding.role)
        .collect::<BTreeSet<_>>();
    if roles != expected || profile.semantics.len() != expected.len() {
        return Err("Java profile must classify each semantic role once".to_owned());
    }
    let mysql_by_id = profile
        .mysql
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource.role))
        .collect::<BTreeMap<_, _>>();
    let redis_by_id = profile
        .redis
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource.role))
        .collect::<BTreeMap<_, _>>();
    let mut referenced_mysql = BTreeSet::new();
    let mut referenced_redis = BTreeSet::new();
    for binding in &profile.semantics {
        match binding.storage {
            SemanticStorage::Mysql => {
                let expected_role = semantic_mysql_role(binding.role).ok_or_else(|| {
                    format!("semantic role cannot use MySQL storage: {:?}", binding.role)
                })?;
                if binding.resource_ids.is_empty()
                    || (binding.role == SemanticRole::Projection && binding.resource_ids.len() != 1)
                    || binding.collector.is_some()
                    || binding.rationale.is_some()
                {
                    return Err(format!(
                        "invalid MySQL semantic binding: {:?}",
                        binding.role
                    ));
                }
                for id in &binding.resource_ids {
                    if mysql_by_id.get(id.as_str()) != Some(&expected_role)
                        || !referenced_mysql.insert(id.as_str())
                    {
                        return Err(format!("invalid MySQL semantic resource: {id}"));
                    }
                }
            }
            SemanticStorage::Redis => {
                let expected_role = semantic_redis_role(binding.role).ok_or_else(|| {
                    format!("semantic role cannot use Redis storage: {:?}", binding.role)
                })?;
                if binding.resource_ids.is_empty()
                    || binding.collector.is_some()
                    || binding.rationale.is_some()
                {
                    return Err(format!(
                        "invalid Redis semantic binding: {:?}",
                        binding.role
                    ));
                }
                for id in &binding.resource_ids {
                    if redis_by_id.get(id.as_str()) != Some(&expected_role)
                        || !referenced_redis.insert(id.as_str())
                    {
                        return Err(format!("invalid Redis semantic resource: {id}"));
                    }
                }
            }
            SemanticStorage::VolatileEvent => {
                if binding.role != SemanticRole::Progress
                    || !binding.resource_ids.is_empty()
                    || binding.collector.as_deref() != Some("websocket")
                    || !valid_rationale(binding.rationale.as_deref())
                {
                    return Err(
                        "volatile-event is allowed only for reviewed WebSocket progress".to_owned(),
                    );
                }
            }
            SemanticStorage::Absent => {
                if binding.role == SemanticRole::Projection
                    || !binding.resource_ids.is_empty()
                    || binding.collector.is_some()
                    || !valid_rationale(binding.rationale.as_deref())
                {
                    return Err(format!(
                        "invalid absent semantic binding: {:?}",
                        binding.role
                    ));
                }
            }
        }
    }
    if referenced_mysql.len() != mysql_by_id.len() || referenced_redis.len() != redis_by_id.len() {
        return Err("every physical resource must belong to one semantic binding".to_owned());
    }
    Ok(())
}

fn semantic_mysql_role(role: SemanticRole) -> Option<MysqlRole> {
    match role {
        SemanticRole::Projection => Some(MysqlRole::Projection),
        SemanticRole::Idempotency => Some(MysqlRole::Idempotency),
        SemanticRole::Commit => Some(MysqlRole::Commit),
        SemanticRole::Undo => Some(MysqlRole::Undo),
        SemanticRole::Outbox => Some(MysqlRole::Outbox),
        SemanticRole::SchemaLedger => Some(MysqlRole::SchemaLedger),
        _ => None,
    }
}

fn semantic_redis_role(role: SemanticRole) -> Option<RedisRole> {
    match role {
        SemanticRole::Progress => Some(RedisRole::Progress),
        SemanticRole::BatchLease => Some(RedisRole::BatchLease),
        SemanticRole::SchemaLease => Some(RedisRole::SchemaLease),
        _ => None,
    }
}

fn valid_rationale(value: Option<&str>) -> bool {
    value.is_some_and(|item| {
        let length = item.trim().len();
        (12..=512).contains(&length) && !item.chars().any(|character| character.is_control())
    })
}

fn validate_profile_scope(profile: &Profile, scope: &Scope) -> Result<(), String> {
    if !profile
        .applicable_scenarios
        .iter()
        .any(|scenario| scenario == &scope.scenario_id)
    {
        return Err(format!(
            "Java state profile is not approved for scenario: {}",
            scope.scenario_id
        ));
    }
    let projection = profile
        .mysql
        .resources
        .iter()
        .find(|resource| resource.role == MysqlRole::Projection)
        .ok_or_else(|| "Java projection resource is missing".to_owned())?;
    if projection.table != scope.table {
        return Err("Java projection table does not match approved scope".to_owned());
    }
    Ok(())
}

async fn doctor(
    pool: &MySqlPool,
    mut redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
    profile_hash: &str,
) -> Result<Value, String> {
    for resource in &profile.mysql.resources {
        let columns: Vec<String> = sqlx::query(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
        )
        .bind(&scope.database)
        .bind(&resource.table)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("inspect Java table {}: {error}", resource.table))?
        .into_iter()
        .map(|row| {
            row.try_get("COLUMN_NAME")
                .map_err(|error| format!("decode Java column name: {error}"))
        })
        .collect::<Result<_, _>>()?;
        let actual = columns.into_iter().collect::<BTreeSet<_>>();
        let required = resource_columns(resource);
        if !required.is_subset(&actual) {
            return Err(format!(
                "Java table {} is missing reviewed columns",
                resource.table
            ));
        }
    }
    let pong = if let Some(connection) = redis.as_deref_mut() {
        redis::cmd("PING")
            .query_async::<String>(connection)
            .await
            .map_err(|error| format!("Java Redis doctor query: {error}"))?
    } else {
        "not-configured".to_owned()
    };
    for resource in &profile.redis.resources {
        let connection = redis
            .as_deref_mut()
            .ok_or_else(|| "Java Redis resource has no configured connection".to_owned())?;
        let key = materialize_key(&resource.key_template, scope)?;
        let actual: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut *connection)
            .await
            .map_err(|error| format!("inspect Java Redis key type: {error}"))?;
        let expected = match resource.data_type {
            RedisDataType::Hash => "hash",
            RedisDataType::String => "string",
        };
        if actual != "none" && actual != expected {
            return Err(format!(
                "Java Redis resource has wrong type: {}",
                resource.id
            ));
        }
    }
    let state = mysql_state(pool, scope, profile).await?;
    guard_row_limit(scope, state.fixture_rows)?;
    Ok(json!({
        "rowCount": state.fixture_rows,
        "diagnostic": {
            "adapter": ADAPTER_ID,
            "profileHash": profile_hash,
            "mysql": "ready",
            "redis": pong,
            "database": scope.database,
            "table": scope.table,
        }
    }))
}

async fn seed(
    pool: &MySqlPool,
    redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
    profile_hash: &str,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope, profile).await?;
    let redis = redis_state(redis, scope, profile).await?;
    let residue = mysql.fixture_rows
        + mysql.idempotency_rows
        + mysql.undo_rows
        + mysql.outbox_rows
        + mysql.commit_rows
        + mysql.schema_ledger_rows
        + redis.progress_keys
        + redis.lease_fields;
    if residue != 0 {
        return Err(format!(
            "Java marker-scoped residue exists before seed: {}",
            scope.marker
        ));
    }
    let (seed_profile, seed_hash) = load_seed_profile(profile, profile_hash, scope)?;
    let outcome = apply_seed(pool, scope, profile, &seed_profile).await?;
    Ok(json!({
        "rowCount": outcome.inserted,
        "seedHash": seed_hash,
        "bindings": outcome.bindings,
        "snapshot": {
            "seedMode": "declarative-profile",
            "scenarioId": scope.scenario_id,
            "seedHash": seed_hash,
        }
    }))
}

async fn snapshot(
    pool: &MySqlPool,
    redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope, profile).await?;
    guard_row_limit(scope, mysql.fixture_rows)?;
    let redis = redis_state(redis, scope, profile).await?;
    Ok(json!({
        "rowCount": mysql.fixture_rows,
        "snapshot": { "mysql": mysql, "redis": redis }
    }))
}

async fn collect(
    pool: &MySqlPool,
    redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<Value, String> {
    let mut mysql = mysql_state(pool, scope, profile).await?;
    let expects_undo = profile.semantics.iter().any(|binding| {
        binding.role == SemanticRole::Undo && binding.storage == SemanticStorage::Mysql
    });
    if expects_undo && mysql.fixture_rows > 0 && mysql.undo_rows == 0 {
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            mysql = mysql_state(pool, scope, profile).await?;
            if mysql.undo_rows > 0 {
                break;
            }
        }
    }
    guard_row_limit(scope, mysql.fixture_rows)?;
    let redis = redis_state(redis, scope, profile).await?;
    let volatile_progress = profile.semantics.iter().any(|binding| {
        binding.role == SemanticRole::Progress && binding.storage == SemanticStorage::VolatileEvent
    });
    let event_state = if volatile_progress {
        websocket_event_state(scope)?
    } else {
        json!({
            "verified": true,
            "collector": "state-profile",
            "redis": redis,
        })
    };
    Ok(json!({
        "rowCount": mysql.fixture_rows,
        "observation": {
            "dimensions": {
                "http": { "verified": true, "collector": "operation-driver" },
                "context": {
                    "verified": true,
                    "tenantId": scope.tenant_id,
                    "panelId": scope.panel_id,
                    "database": scope.database,
                    "table": scope.table,
                },
                "decisions": {
                    "verified": true,
                    "scenarioId": scope.scenario_id,
                },
                "effects": {
                    "verified": true,
                    "fixtureRows": mysql.fixture_rows,
                    "commitRows": mysql.commit_rows,
                    "undoRows": mysql.undo_rows,
                    "outboxRows": mysql.outbox_rows,
                },
                "state": { "verified": true, "mysql": mysql },
                "events": event_state,
                "failures": { "verified": true, "markerScoped": true },
                "performance": {
                    "verified": true,
                    "rowCount": mysql.fixture_rows,
                    "withinBudget": mysql.fixture_rows <= scope.max_rows,
                },
            },
            "metadata": {
                "collector": "l4c-state-hook",
                "volatileProgressPending": false,
            }
        }
    }))
}

fn websocket_event_state(scope: &Scope) -> Result<Value, String> {
    let output_root = required_env("MG_L4C_OUTPUT_ROOT")?;
    let event_path = Path::new(&output_root)
        .join("events")
        .join("source")
        .join(&scope.scenario_id)
        .join(format!("{}.jsonl", scope.marker));
    let content =
        fs::read(&event_path).map_err(|error| format!("read Java WebSocket evidence: {error}"))?;
    decode_websocket_event_state(scope, &content)
}

fn decode_websocket_event_state(scope: &Scope, content: &[u8]) -> Result<Value, String> {
    if content.is_empty() {
        if scope.scenario_id != "validation-failure" {
            return Err("Java WebSocket terminal evidence is missing".to_owned());
        }
        return Ok(json!({
            "verified": true,
            "collector": "websocket",
            "protocol": EVENT_PROTOCOL,
            "completionMode": "no-event",
            "eventCount": 0,
            "terminalEventCount": 0,
        }));
    }
    if content.len() > 1024 * 1024 {
        return Err("Java WebSocket evidence size is invalid".to_owned());
    }
    let text = std::str::from_utf8(content)
        .map_err(|_| "Java WebSocket evidence is not UTF-8".to_owned())?;
    let mut event_count = 0u64;
    let mut terminal_count = 0u64;
    let mut batch_ids = BTreeSet::new();
    let mut terminal_batch_ids = BTreeSet::new();
    let mut terminal_statuses = BTreeSet::new();
    let mut terminal_percentage = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line)
            .map_err(|error| format!("decode Java WebSocket evidence: {error}"))?;
        let event_batch_id = event
            .get("batchId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Java WebSocket event batchId is missing".to_owned())?;
        if event.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || event.get("protocol").and_then(Value::as_str) != Some(EVENT_PROTOCOL)
            || event.get("scenarioId").and_then(Value::as_str) != Some(&scope.scenario_id)
            || event.get("marker").and_then(Value::as_str) != Some(&scope.marker)
            || event.get("panelId").and_then(Value::as_str) != Some(&scope.panel_id)
            || event.get("type").and_then(Value::as_str) != Some("panel-data-update")
            || event_batch_id.len() > 192
            || event_batch_id.chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | ':' | '-')
            })
        {
            return Err("Java WebSocket event identity is invalid".to_owned());
        }
        batch_ids.insert(event_batch_id.to_owned());
        if scope.scenario_id != "concurrent-write" && batch_ids.len() > 1 {
            return Err("Java WebSocket event identity is invalid".to_owned());
        }
        event_count += 1;
        if event.get("terminal").and_then(Value::as_bool) == Some(true) {
            terminal_count += 1;
            terminal_batch_ids.insert(event_batch_id.to_owned());
            if let Some(status) = event.get("status").and_then(Value::as_str) {
                terminal_statuses.insert(status.to_owned());
            }
            if let Some(percentage) = event.get("percentage").and_then(Value::as_f64) {
                terminal_percentage = Some(
                    terminal_percentage.map_or(percentage, |current: f64| current.min(percentage)),
                );
            }
        }
        if event_count > 1000 {
            return Err("Java WebSocket evidence exceeds event limit".to_owned());
        }
    }
    if event_count == 0
        || terminal_count == 0
        || batch_ids.is_empty()
        || (scope.scenario_id == "concurrent-write" && batch_ids.len() != 2)
        || terminal_batch_ids != batch_ids
    {
        return Err("Java WebSocket terminal evidence is missing".to_owned());
    }
    let batch_ids = batch_ids.into_iter().collect::<Vec<_>>();
    let terminal_statuses = terminal_statuses.into_iter().collect::<Vec<_>>();
    Ok(json!({
        "verified": true,
        "collector": "websocket",
        "protocol": EVENT_PROTOCOL,
        "batchId": (batch_ids.len() == 1).then(|| batch_ids[0].clone()),
        "batchIds": batch_ids,
        "eventCount": event_count,
        "terminalEventCount": terminal_count,
        "terminalStatus": (terminal_statuses.len() == 1)
            .then(|| terminal_statuses[0].clone()),
        "terminalStatuses": terminal_statuses,
        "terminalPercentage": terminal_percentage,
    }))
}

async fn cleanup(
    pool: &MySqlPool,
    mut redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<Value, String> {
    let before = mysql_state(pool, scope, profile).await?;
    guard_row_limit(scope, before.fixture_rows)?;
    let before_redis = redis_state(redis.as_deref_mut(), scope, profile).await?;
    guard_cleanup_limits(scope, &before, &before_redis)?;
    let mut resources = profile.mysql.resources.iter().collect::<Vec<_>>();
    resources.sort_by_key(|resource| resource.cleanup_order);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin Java scoped cleanup: {error}"))?;
    for resource in resources {
        let sql = resource_delete_sql(resource);
        let marker = marker_value(resource.marker_match, &scope.marker);
        let mut query = sqlx::query(&sql).bind(&scope.tenant_id);
        if resource.panel_column.is_some() {
            query = query.bind(&scope.panel_id);
        }
        query
            .bind(marker)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("cleanup Java resource {}: {error}", resource.id))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit Java scoped cleanup: {error}"))?;
    cleanup_redis(redis, scope, profile).await?;
    Ok(json!({
        "rowCount": before.fixture_rows,
        "snapshot": { "cleanupAttempted": true }
    }))
}

async fn verify_cleanup(
    pool: &MySqlPool,
    redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope, profile).await?;
    let redis = redis_state(redis, scope, profile).await?;
    Ok(json!({
        "rowCount": mysql.fixture_rows,
        "cleanup": CleanupCounters {
            fixture_rows: mysql.fixture_rows + mysql.idempotency_rows,
            undo_rows: mysql.undo_rows,
            outbox_rows: mysql.outbox_rows,
            commit_rows: mysql.commit_rows,
            redis_keys: redis.progress_keys,
            lease_keys: redis.lease_fields,
            schema_artifacts: mysql.schema_ledger_rows,
            fault_artifacts: 0,
        }
    }))
}

async fn mysql_state(
    pool: &MySqlPool,
    scope: &Scope,
    profile: &Profile,
) -> Result<MysqlState, String> {
    let mut counts = BTreeMap::new();
    let mut projection = Vec::new();
    for resource in &profile.mysql.resources {
        let snapshot = query_mysql_resource(pool, scope, resource).await?;
        *counts.entry(resource.role).or_insert(0) += snapshot.count;
        if resource.role == MysqlRole::Projection {
            projection.extend(snapshot.rows);
        }
    }
    Ok(MysqlState {
        fixture_rows: count_role(&counts, MysqlRole::Projection),
        idempotency_rows: count_role(&counts, MysqlRole::Idempotency),
        undo_rows: count_role(&counts, MysqlRole::Undo),
        outbox_rows: count_role(&counts, MysqlRole::Outbox),
        commit_rows: count_role(&counts, MysqlRole::Commit),
        schema_ledger_rows: count_role(&counts, MysqlRole::SchemaLedger),
        projection,
    })
}

async fn query_mysql_resource(
    pool: &MySqlPool,
    scope: &Scope,
    resource: &MysqlResource,
) -> Result<ResourceSnapshot, String> {
    let (count_sql, select_sql) = resource_query_sql(resource, scope.max_rows);
    let marker = marker_value(resource.marker_match, &scope.marker);
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(&scope.tenant_id);
    if resource.panel_column.is_some() {
        count_query = count_query.bind(&scope.panel_id);
    }
    let count = count_query
        .bind(&marker)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("count Java resource {}: {error}", resource.id))?;
    let count = u64::try_from(count)
        .map_err(|_| format!("negative Java resource count: {}", resource.id))?;

    let mut select_query = sqlx::query(&select_sql).bind(&scope.tenant_id);
    if resource.panel_column.is_some() {
        select_query = select_query.bind(&scope.panel_id);
    }
    let rows = select_query
        .bind(marker)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("snapshot Java resource {}: {error}", resource.id))?
        .into_iter()
        .map(decode_document)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ResourceSnapshot { count, rows })
}

fn decode_document(row: MySqlRow) -> Result<Value, String> {
    if let Ok(Json(document)) = row.try_get::<Json<Value>, _>("document") {
        return Ok(document);
    }
    let document: String = row
        .try_get("document")
        .map_err(|error| format!("decode Java resource document: {error}"))?;
    serde_json::from_str(&document)
        .map_err(|error| format!("parse Java resource document: {error}"))
}

fn resource_query_sql(resource: &MysqlResource, max_rows: u64) -> (String, String) {
    let where_clause = resource_where_clause(resource);
    let document = resource
        .columns
        .iter()
        .flat_map(|column| {
            let expression = match column.kind {
                ColumnKind::Scalar => quote_identifier(&column.name),
                ColumnKind::Json => {
                    format!("JSON_EXTRACT({}, '$')", quote_identifier(&column.name))
                }
                ColumnKind::Text => {
                    format!("CAST({} AS CHAR)", quote_identifier(&column.name))
                }
            };
            [format!("'{}'", column.alias), expression]
        })
        .collect::<Vec<_>>()
        .join(",");
    (
        format!(
            "SELECT COUNT(*) FROM {} WHERE {where_clause}",
            quote_identifier(&resource.table)
        ),
        format!(
            "SELECT JSON_OBJECT({document}) AS document FROM {} \
             WHERE {where_clause} ORDER BY {} LIMIT {}",
            quote_identifier(&resource.table),
            quote_identifier(&resource.order_column),
            max_rows + 1
        ),
    )
}

fn resource_delete_sql(resource: &MysqlResource) -> String {
    format!(
        "DELETE FROM {} WHERE {}",
        quote_identifier(&resource.table),
        resource_where_clause(resource)
    )
}

fn resource_where_clause(resource: &MysqlResource) -> String {
    let mut predicates = vec![format!("{}=?", quote_identifier(&resource.tenant_column))];
    if let Some(panel) = &resource.panel_column {
        predicates.push(format!("{}=?", quote_identifier(panel)));
    }
    let marker_expression = match resource.marker_match {
        MarkerMatch::JsonPathExact => format!(
            "JSON_UNQUOTE(JSON_EXTRACT({}, '{}'))",
            quote_identifier(&resource.marker_column),
            resource
                .marker_json_path
                .as_deref()
                .expect("validated JSON marker path")
        ),
        MarkerMatch::Exact | MarkerMatch::Prefix => quote_identifier(&resource.marker_column),
    };
    predicates.push(format!(
        "{} {} ?{}",
        marker_expression,
        match resource.marker_match {
            MarkerMatch::Exact | MarkerMatch::JsonPathExact => "=",
            MarkerMatch::Prefix => "LIKE",
        },
        match resource.marker_match {
            MarkerMatch::Exact | MarkerMatch::JsonPathExact => "",
            MarkerMatch::Prefix => " ESCAPE '\\\\'",
        }
    ));
    predicates.join(" AND ")
}

async fn redis_state(
    mut redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<RedisState, String> {
    let mut progress_keys = 0u64;
    let mut lease_fields = 0u64;
    let mut progress = BTreeMap::new();
    for resource in &profile.redis.resources {
        let connection = redis
            .as_deref_mut()
            .ok_or_else(|| "Java Redis resource has no configured connection".to_owned())?;
        let key = materialize_key(&resource.key_template, scope)?;
        match resource.role {
            RedisRole::Progress => {
                let (exists, value) = read_progress_resource(connection, resource, &key).await?;
                progress_keys += u64::from(exists);
                progress.extend(value);
            }
            RedisRole::BatchLease | RedisRole::SchemaLease => {
                let fields: Vec<String> = redis::cmd("HKEYS")
                    .arg(key)
                    .query_async(&mut *connection)
                    .await
                    .map_err(|error| {
                        format!("snapshot Java lease resource {}: {error}", resource.id)
                    })?;
                lease_fields += fields
                    .iter()
                    .filter(|field| field.contains(&scope.marker))
                    .count() as u64;
            }
        }
    }
    Ok(RedisState {
        progress_keys,
        lease_fields,
        progress,
    })
}

async fn read_progress_resource(
    redis: &mut MultiplexedConnection,
    resource: &RedisResource,
    key: &str,
) -> Result<(bool, BTreeMap<String, String>), String> {
    match resource.data_type {
        RedisDataType::Hash => {
            let values: BTreeMap<String, String> = redis::cmd("HGETALL")
                .arg(key)
                .query_async(&mut *redis)
                .await
                .map_err(|error| format!("snapshot Java progress hash: {error}"))?;
            let filtered = if resource.fields.is_empty() {
                values
            } else {
                resource
                    .fields
                    .iter()
                    .filter_map(|field| {
                        values
                            .get(&field.name)
                            .map(|value| (field.alias.clone(), value.clone()))
                    })
                    .collect()
            };
            Ok((!filtered.is_empty(), filtered))
        }
        RedisDataType::String => {
            let value: Option<String> =
                redis::cmd("GET")
                    .arg(key)
                    .query_async(&mut *redis)
                    .await
                    .map_err(|error| format!("snapshot Java progress string: {error}"))?;
            Ok((
                value.is_some(),
                value
                    .map(|item| BTreeMap::from([("value".to_owned(), item)]))
                    .unwrap_or_default(),
            ))
        }
    }
}

async fn cleanup_redis(
    mut redis: Option<&mut MultiplexedConnection>,
    scope: &Scope,
    profile: &Profile,
) -> Result<(), String> {
    for resource in &profile.redis.resources {
        let connection = redis
            .as_deref_mut()
            .ok_or_else(|| "Java Redis resource has no configured connection".to_owned())?;
        let key = materialize_key(&resource.key_template, scope)?;
        match resource.cleanup {
            RedisCleanup::ExactKey => {
                redis::cmd("DEL")
                    .arg(key)
                    .query_async::<i64>(&mut *connection)
                    .await
                    .map_err(|error| {
                        format!("cleanup Java Redis resource {}: {error}", resource.id)
                    })?;
            }
            RedisCleanup::MatchingHashFields => {
                let fields: Vec<String> = redis::cmd("HKEYS")
                    .arg(&key)
                    .query_async(&mut *connection)
                    .await
                    .map_err(|error| {
                        format!("load Java Redis lease fields {}: {error}", resource.id)
                    })?;
                let scoped = fields
                    .into_iter()
                    .filter(|field| field.contains(&scope.marker))
                    .collect::<Vec<_>>();
                if !scoped.is_empty() {
                    redis::cmd("HDEL")
                        .arg(&key)
                        .arg(scoped)
                        .query_async::<i64>(&mut *connection)
                        .await
                        .map_err(|error| {
                            format!("cleanup Java Redis lease fields {}: {error}", resource.id)
                        })?;
                }
                let remaining: i64 = redis::cmd("HLEN")
                    .arg(&key)
                    .query_async(&mut *connection)
                    .await
                    .map_err(|error| format!("verify Java Redis lease {}: {error}", resource.id))?;
                if remaining == 0 {
                    redis::cmd("DEL")
                        .arg(&key)
                        .query_async::<i64>(&mut *connection)
                        .await
                        .map_err(|error| {
                            format!("remove empty Java Redis lease {}: {error}", resource.id)
                        })?;
                }
            }
        }
    }
    Ok(())
}

async fn verify_database_scope(pool: &MySqlPool, scope: &Scope) -> Result<(), String> {
    let database: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("read selected Java MySQL database: {error}"))?;
    if database.as_deref() != Some(scope.database.as_str()) {
        return Err("connected Java MySQL database does not match approved scope".to_owned());
    }
    Ok(())
}

fn resource_columns(resource: &MysqlResource) -> BTreeSet<String> {
    let mut columns = BTreeSet::from([
        resource.tenant_column.clone(),
        resource.marker_column.clone(),
        resource.order_column.clone(),
    ]);
    if let Some(panel) = &resource.panel_column {
        columns.insert(panel.clone());
    }
    columns.extend(resource.columns.iter().map(|column| column.name.clone()));
    columns
}

fn count_role(counts: &BTreeMap<MysqlRole, u64>, role: MysqlRole) -> u64 {
    counts.get(&role).copied().unwrap_or_default()
}

fn marker_value(marker_match: MarkerMatch, marker: &str) -> String {
    match marker_match {
        MarkerMatch::Exact | MarkerMatch::JsonPathExact => marker.to_owned(),
        MarkerMatch::Prefix => format!("{}-%", escape_like(marker)),
    }
}

fn valid_json_path(value: &str) -> bool {
    let Some(member) = value.strip_prefix("$.") else {
        return false;
    };
    !member.is_empty()
        && member.len() <= 64
        && member
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && member
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn materialize_key(template: &str, scope: &Scope) -> Result<String, String> {
    let value = template
        .replace("{tenantId}", &scope.tenant_id)
        .replace("{panelId}", &scope.panel_id)
        .replace("{marker}", &scope.marker);
    if value.contains('{')
        || value.contains('}')
        || value.contains('*')
        || value.contains('?')
        || value.contains('[')
        || value.contains(']')
        || value.len() > 255
    {
        return Err("materialized Java Redis key is unsafe".to_owned());
    }
    Ok(value)
}

fn valid_key_template(value: &str) -> bool {
    if value.len() < 3
        || value.len() > 255
        || value.contains('*')
        || value.contains('?')
        || value.contains('[')
        || value.contains(']')
        || value.chars().any(|character| character.is_control())
    {
        return false;
    }
    let mut remainder = value;
    while let Some(start) = remainder.find('{') {
        let Some(end) = remainder[start..].find('}') else {
            return false;
        };
        let placeholder = &remainder[start + 1..start + end];
        if !matches!(placeholder, "tenantId" | "panelId" | "marker") {
            return false;
        }
        remainder = &remainder[start + end + 1..];
    }
    !remainder.contains('}')
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn require_env_value(name: &str, expected: &str) -> Result<(), String> {
    if required_env(name)? != expected {
        return Err(format!("{name} is invalid"));
    }
    Ok(())
}

fn parse_u64(name: &str) -> Result<u64, String> {
    required_env(name)?
        .parse()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn normalize_mysql_url(value: &str) -> Result<String, String> {
    let normalized = value.strip_prefix("jdbc:").unwrap_or(value).to_owned();
    if !normalized.starts_with("mysql://") {
        return Err("Java MySQL URL must use mysql:// or jdbc:mysql://".to_owned());
    }
    Ok(normalized)
}

fn validate_token(label: &str, value: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_len
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(format!("{label} contains unsafe characters"));
    }
    Ok(())
}

fn guard_row_limit(scope: &Scope, count: u64) -> Result<(), String> {
    if count > scope.max_rows {
        return Err(format!(
            "Java marker-scoped row count {count} exceeds approved maximum {}",
            scope.max_rows
        ));
    }
    Ok(())
}

fn guard_cleanup_limits(
    scope: &Scope,
    mysql: &MysqlState,
    redis: &RedisState,
) -> Result<(), String> {
    let expanded = scope.max_rows.saturating_mul(4);
    if mysql.idempotency_rows > expanded
        || mysql.undo_rows > scope.max_rows
        || mysql.commit_rows > scope.max_rows
        || mysql.outbox_rows > expanded
        || mysql.schema_ledger_rows > scope.max_rows
        || redis.progress_keys > 1
        || redis.lease_fields > expanded
    {
        return Err("Java cleanup evidence count exceeds approved bounds".to_owned());
    }
    Ok(())
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn is_alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn is_profile_id(value: &str) -> bool {
    (3..=64).contains(&value.len())
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn quote_identifier(value: &str) -> String {
    debug_assert!(is_identifier(value));
    format!("`{value}`")
}

fn is_safe_dynamic_table(value: &str) -> bool {
    value.strip_prefix("cust_table").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
    })
}

fn is_safe_database(value: &str) -> bool {
    !value.to_ascii_lowercase().contains("prod")
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
        && ["dev", "fixture", "migration", "sandbox", "staging", "test"]
            .iter()
            .any(|marker| value.to_ascii_lowercase().contains(marker))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_no_event_evidence_is_explicit_and_scenario_bounded() {
        let mut validation = fixture_scope();
        validation.scenario_id = "validation-failure".to_owned();
        let evidence = decode_websocket_event_state(&validation, b"").unwrap();
        assert_eq!(evidence["completionMode"], "no-event");
        assert_eq!(evidence["eventCount"], 0);

        let primary = fixture_scope();
        assert!(decode_websocket_event_state(&primary, b"").is_err());
    }

    #[test]
    fn concurrent_event_evidence_requires_terminal_events_for_both_batches() {
        let mut scope = fixture_scope();
        scope.scenario_id = "concurrent-write".to_owned();
        let line = |batch_id: &str| {
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "protocol": EVENT_PROTOCOL,
                "scenarioId": scope.scenario_id,
                "marker": scope.marker,
                "panelId": scope.panel_id,
                "type": "panel-data-update",
                "batchId": batch_id,
                "status": "SUCCESS",
                "percentage": 100,
                "terminal": true,
            }))
            .unwrap()
        };
        let content = format!("{}\n{}\n", line("batch-a"), line("batch-b"));
        let evidence = decode_websocket_event_state(&scope, content.as_bytes()).unwrap();
        assert_eq!(evidence["batchIds"].as_array().unwrap().len(), 2);
        assert_eq!(evidence["terminalEventCount"], 2);
        assert_eq!(evidence["terminalStatuses"][0], "SUCCESS");

        assert!(decode_websocket_event_state(&scope, line("batch-a").as_bytes()).is_err());
    }

    #[test]
    fn approved_profile_maps_each_role_without_raw_sql() {
        let profile = fixture_profile();
        validate_profile(&profile).unwrap();
        let serialized = serde_json::to_string(&json!({
            "mysql": profile.mysql.resources.len(),
            "redis": profile.redis.resources.len(),
        }))
        .unwrap();
        assert!(!serialized.to_ascii_lowercase().contains("select "));
    }

    #[test]
    fn query_plan_uses_identifiers_and_bound_values_only() {
        let profile = fixture_profile();
        let projection = profile
            .mysql
            .resources
            .iter()
            .find(|resource| resource.role == MysqlRole::Projection)
            .unwrap();
        let (count, select) = resource_query_sql(projection, 20);
        assert!(count.contains("`fixture_projection`"));
        assert!(count.contains("LIKE ?"));
        assert!(select.contains("LIMIT 21"));
        assert!(!select.contains("mg-l4c"));
    }

    #[test]
    fn redis_profile_rejects_wildcards_and_unbound_exact_cleanup() {
        let mut profile = fixture_profile();
        profile.redis.resources[0].key_template = "progress:*".to_owned();
        assert!(validate_profile(&profile).is_err());
        let mut profile = fixture_profile();
        profile.redis.resources[0].key_template = "progress:{tenantId}".to_owned();
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn materializes_only_known_redis_placeholders() {
        let scope = fixture_scope();
        assert_eq!(
            materialize_key("progress:{tenantId}:{marker}", &scope).unwrap(),
            "progress:9001:mg-l4c-test"
        );
        assert!(!valid_key_template("progress:{unknown}"));
    }

    #[test]
    fn marker_prefix_is_escaped_for_bound_like_query() {
        assert_eq!(
            marker_value(MarkerMatch::Prefix, "mg_l4c%"),
            "mg\\_l4c\\%-%"
        );
    }

    #[test]
    fn evidence_hash_is_stable_across_line_endings() {
        assert_eq!(
            canonical_file_hash(b"{\r\n  \"status\": \"approved\"\r\n}\r\n"),
            canonical_file_hash(b"{\n  \"status\": \"approved\"\n}\n")
        );
    }

    #[test]
    fn projection_table_is_bound_to_approved_scope() {
        let mut profile = fixture_profile();
        let scope = fixture_scope();
        assert!(validate_profile_scope(&profile, &scope).is_err());
        profile
            .mysql
            .resources
            .iter_mut()
            .find(|resource| resource.role == MysqlRole::Projection)
            .unwrap()
            .table = scope.table.clone();
        validate_profile_scope(&profile, &scope).unwrap();
    }

    #[test]
    fn profile_scenario_approval_is_explicit_and_unique() {
        let mut profile = fixture_profile();
        profile.applicable_scenarios.clear();
        assert!(validate_profile(&profile).is_err());

        let mut profile = fixture_profile();
        profile
            .applicable_scenarios
            .push("primary-success".to_owned());
        assert!(validate_profile(&profile).is_err());

        let mut profile = fixture_profile();
        let mut scope = fixture_scope();
        scope.scenario_id = "dependency-failure".to_owned();
        profile
            .mysql
            .resources
            .iter_mut()
            .find(|resource| resource.role == MysqlRole::Projection)
            .unwrap()
            .table = scope.table.clone();
        assert!(validate_profile_scope(&profile, &scope).is_err());
    }

    #[test]
    fn volatile_and_absent_semantics_require_explicit_evidence() {
        let mut profile = fixture_profile();
        profile.semantics = fixture_source_semantics();
        profile
            .mysql
            .resources
            .retain(|resource| matches!(resource.role, MysqlRole::Projection | MysqlRole::Undo));
        profile.redis.resources.clear();
        profile.connections.redis_url_env = None;
        validate_profile(&profile).unwrap();

        profile
            .semantics
            .iter_mut()
            .find(|binding| binding.role == SemanticRole::Progress)
            .unwrap()
            .collector = None;
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn seed_plan_uses_reviewed_aliases_and_scope_values() {
        let mut profile = fixture_profile();
        let scope = fixture_scope();
        {
            let projection = profile
                .mysql
                .resources
                .iter_mut()
                .find(|resource| resource.role == MysqlRole::Projection)
                .unwrap();
            projection.table = scope.table.clone();
            projection.order_column = "sort_order".to_owned();
            projection.columns.push(ProfileColumn {
                name: "sort_order".to_owned(),
                alias: "sortOrder".to_owned(),
                kind: ColumnKind::Scalar,
            });
        }
        let seed = SeedProfile {
            schema_version: 1,
            protocol: SEED_PROTOCOL.to_owned(),
            status: "approved".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            target_kind: "source".to_owned(),
            scenario_id: scope.scenario_id.clone(),
            state_profile_sha256: "a".repeat(64),
            resources: vec![SeedResource {
                resource_id: "projection".to_owned(),
                rows: vec![SeedRow {
                    marker_suffix: "row-001".to_owned(),
                    values: BTreeMap::from([(
                        "sortOrder".to_owned(),
                        Value::String("1".to_owned()),
                    )]),
                }],
            }],
        };
        validate_seed_profile(&seed, &profile, &"a".repeat(64), &scope).unwrap();
        let projection = profile
            .mysql
            .resources
            .iter()
            .find(|resource| resource.role == MysqlRole::Projection)
            .unwrap();
        let (columns, values) =
            seed_insert_values(projection, &seed.resources[0].rows[0], &scope).unwrap();
        assert_eq!(columns, ["tenant_id", "panel_id", "batch_id", "sort_order"]);
        assert!(
            values
                .iter()
                .flatten()
                .any(|value| value.ends_with("row-001"))
        );
        assert!(
            !serde_json::to_string(&seed.resources[0].rows[0].values)
                .unwrap()
                .contains("cust_table")
        );
    }

    fn fixture_scope() -> Scope {
        Scope {
            scenario_id: "primary-success".to_owned(),
            marker: "mg-l4c-test".to_owned(),
            tenant_id: "9001".to_owned(),
            panel_id: "9002".to_owned(),
            table: "cust_table9003".to_owned(),
            database: "migration_guard_test".to_owned(),
            max_rows: 20,
        }
    }

    fn fixture_profile() -> Profile {
        let mysql_resource = |id: &str, role: MysqlRole, panel: bool| MysqlResource {
            id: id.to_owned(),
            role,
            table: format!("fixture_{}", id.replace('-', "_")),
            tenant_column: "tenant_id".to_owned(),
            panel_column: panel.then(|| "panel_id".to_owned()),
            marker_column: "batch_id".to_owned(),
            marker_match: if role == MysqlRole::Projection {
                MarkerMatch::Prefix
            } else {
                MarkerMatch::Exact
            },
            marker_json_path: None,
            order_column: "batch_id".to_owned(),
            columns: vec![ProfileColumn {
                name: "batch_id".to_owned(),
                alias: "primaryKey".to_owned(),
                kind: ColumnKind::Scalar,
            }],
            cleanup: true,
            cleanup_order: 10,
        };
        let redis_resource =
            |id: &str, role: RedisRole, marker_location: MarkerLocation| RedisResource {
                id: id.to_owned(),
                role,
                data_type: RedisDataType::Hash,
                key_template: if matches!(marker_location, MarkerLocation::Key) {
                    "progress:{tenantId}:{marker}".to_owned()
                } else {
                    format!("{id}:{{tenantId}}:{{panelId}}")
                },
                marker_location,
                fields: vec![],
                cleanup: if matches!(marker_location, MarkerLocation::Key) {
                    RedisCleanup::ExactKey
                } else {
                    RedisCleanup::MatchingHashFields
                },
            };
        Profile {
            schema_version: 1,
            protocol: PROFILE_PROTOCOL.to_owned(),
            status: "approved".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            target_kind: "source".to_owned(),
            adapter: ADAPTER_ID.to_owned(),
            applicable_scenarios: vec!["primary-success".to_owned()],
            connections: Connections {
                mysql_url_env: "MG_JAVA_DATABASE_URL".to_owned(),
                redis_url_env: Some("MG_JAVA_REDIS_URL".to_owned()),
            },
            semantics: fixture_all_physical_semantics(),
            mysql: MysqlProfile {
                resources: vec![
                    mysql_resource("projection", MysqlRole::Projection, true),
                    mysql_resource("idempotency", MysqlRole::Idempotency, true),
                    mysql_resource("commit", MysqlRole::Commit, false),
                    mysql_resource("undo", MysqlRole::Undo, false),
                    mysql_resource("outbox", MysqlRole::Outbox, false),
                    mysql_resource("schema-ledger", MysqlRole::SchemaLedger, true),
                ],
            },
            redis: RedisProfile {
                resources: vec![
                    redis_resource("progress", RedisRole::Progress, MarkerLocation::Key),
                    redis_resource(
                        "batch-lease",
                        RedisRole::BatchLease,
                        MarkerLocation::HashField,
                    ),
                    redis_resource(
                        "schema-lease",
                        RedisRole::SchemaLease,
                        MarkerLocation::HashField,
                    ),
                ],
            },
        }
    }

    fn fixture_all_physical_semantics() -> Vec<SemanticBinding> {
        vec![
            semantic_mysql(SemanticRole::Projection, &["projection"]),
            semantic_mysql(SemanticRole::Idempotency, &["idempotency"]),
            semantic_mysql(SemanticRole::Commit, &["commit"]),
            semantic_mysql(SemanticRole::Undo, &["undo"]),
            semantic_mysql(SemanticRole::Outbox, &["outbox"]),
            semantic_mysql(SemanticRole::SchemaLedger, &["schema-ledger"]),
            semantic_redis(SemanticRole::Progress, &["progress"]),
            semantic_redis(SemanticRole::BatchLease, &["batch-lease"]),
            semantic_redis(SemanticRole::SchemaLease, &["schema-lease"]),
        ]
    }

    fn fixture_source_semantics() -> Vec<SemanticBinding> {
        vec![
            semantic_mysql(SemanticRole::Projection, &["projection"]),
            semantic_mysql(SemanticRole::Undo, &["undo"]),
            semantic_absent(SemanticRole::Idempotency),
            semantic_absent(SemanticRole::Commit),
            semantic_absent(SemanticRole::Outbox),
            semantic_absent(SemanticRole::SchemaLedger),
            SemanticBinding {
                role: SemanticRole::Progress,
                storage: SemanticStorage::VolatileEvent,
                resource_ids: vec![],
                collector: Some("websocket".to_owned()),
                rationale: Some(
                    "BatchUpdateProgressManager keeps progress in process-local maps.".to_owned(),
                ),
            },
            semantic_absent(SemanticRole::BatchLease),
            semantic_absent(SemanticRole::SchemaLease),
        ]
    }

    fn semantic_mysql(role: SemanticRole, ids: &[&str]) -> SemanticBinding {
        SemanticBinding {
            role,
            storage: SemanticStorage::Mysql,
            resource_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            collector: None,
            rationale: None,
        }
    }

    fn semantic_redis(role: SemanticRole, ids: &[&str]) -> SemanticBinding {
        SemanticBinding {
            role,
            storage: SemanticStorage::Redis,
            resource_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            collector: None,
            rationale: None,
        }
    }

    fn semantic_absent(role: SemanticRole) -> SemanticBinding {
        SemanticBinding {
            role,
            storage: SemanticStorage::Absent,
            resource_ids: vec![],
            collector: None,
            rationale: Some(
                "No dedicated durable resource exists on the inspected Java path.".to_owned(),
            ),
        }
    }
}
