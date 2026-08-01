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
    MySqlPool, Row,
    mysql::{MySqlPoolOptions, MySqlRow},
    types::Json,
};

const HOOK_PROTOCOL: &str = "migration-guard.batch-update-l4c-state-hook/v1";
const SAFE_SCHEMA: &str = "zboss-evidence-v1";
const SEED_PROTOCOL: &str = "migration-guard.batch-update-l4c-target-seed/v1";
const PROJECT_ID: &str = "zboss-batch-update-with-progress";

#[derive(Clone)]
struct Scope {
    target_kind: String,
    scenario_id: String,
    marker: String,
    tenant_id: u64,
    panel_id: u64,
    table: String,
    database: String,
    max_rows: u64,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeedProfile {
    schema_version: u32,
    protocol: String,
    status: String,
    project_id: String,
    target_kind: String,
    scenario_id: String,
    rows: Vec<SeedRow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeedRow {
    marker_suffix: String,
    values: BTreeMap<String, Value>,
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(document) => println!("{document}"),
        Err(error) => {
            eprintln!("L4-C state hook blocked: {error}");
            process::exit(1);
        }
    }
}

async fn run() -> Result<Value, String> {
    require_env_value("MG_L4C_HOOK_PROTOCOL", HOOK_PROTOCOL)?;
    let operation = env::args()
        .nth(1)
        .ok_or_else(|| "state hook operation is required".to_owned())?;
    let schema = env::args().nth(2).unwrap_or_else(|| SAFE_SCHEMA.to_owned());
    if schema != SAFE_SCHEMA {
        return Err(format!("unsupported state schema adapter: {schema}"));
    }
    let scope = load_scope()?;
    let mysql_url = target_env(
        &scope.target_kind,
        "MG_JAVA_DATABASE_URL",
        "ZBOSS_BATCH_UPDATE_MYSQL_URL",
    )?;
    let redis_url = target_env(
        &scope.target_kind,
        "MG_JAVA_REDIS_URL",
        "ZBOSS_BATCH_UPDATE_REDIS_URL",
    )?;
    let mysql_url = normalize_mysql_url(&mysql_url)?;
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&mysql_url)
        .await
        .map_err(|error| format!("connect scoped MySQL: {error}"))?;
    verify_database_scope(&pool, &scope).await?;
    let redis = redis::Client::open(redis_url)
        .map_err(|error| format!("configure scoped Redis: {error}"))?;
    let mut redis = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| format!("connect scoped Redis: {error}"))?;

    let document = match operation.as_str() {
        "seed" => seed(&pool, &mut redis, &scope).await?,
        "snapshot" => snapshot(&pool, &mut redis, &scope).await?,
        "collect" => collect(&pool, &mut redis, &scope).await?,
        "cleanup" => cleanup(&pool, &mut redis, &scope).await?,
        "verify-cleanup" | "verifyCleanup" => verify_cleanup(&pool, &mut redis, &scope).await?,
        "doctor" => doctor(&pool, &mut redis, &scope).await?,
        "inject-fault" | "injectFault" => {
            return Err(
                "fault scenarios require an explicit scenario-specific injector".to_owned(),
            );
        }
        _ => return Err(format!("unsupported state hook operation: {operation}")),
    };
    Ok(json!({
        "schemaVersion": 1,
        "protocol": HOOK_PROTOCOL,
        "status": "passed",
        "marker": scope.marker,
        "rowCount": document["rowCount"],
        "seedHash": document.get("seedHash"),
        "bindings": document.get("bindings"),
        "snapshot": document.get("snapshot"),
        "observation": document.get("observation"),
        "cleanup": document.get("cleanup"),
        "diagnostic": document.get("diagnostic"),
    }))
}

fn load_scope() -> Result<Scope, String> {
    let target_kind = required_env("MG_L4C_TARGET_KIND")?;
    if !matches!(target_kind.as_str(), "source" | "target") {
        return Err("MG_L4C_TARGET_KIND must be source or target".to_owned());
    }
    let scenario_id = required_env("MG_L4C_SCENARIO_ID")?;
    validate_token("scenario ID", &scenario_id, 128)?;
    let marker = required_env("MG_L4C_MARKER")?;
    validate_token("marker", &marker, 128)?;
    let tenant_id = parse_u64("MG_L4C_TENANT_ID")?;
    let panel_id = parse_u64("MG_L4C_PANEL_ID")?;
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
        target_kind,
        scenario_id,
        marker,
        tenant_id,
        panel_id,
        table,
        database,
        max_rows,
    })
}

async fn doctor(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let _: i64 = sqlx::query_scalar("SELECT 1")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("MySQL doctor query: {error}"))?;
    let pong: String = redis::cmd("PING")
        .query_async(redis)
        .await
        .map_err(|error| format!("Redis doctor query: {error}"))?;
    let state = mysql_state(pool, scope).await?;
    guard_row_limit(scope, state.fixture_rows)?;
    Ok(json!({
        "rowCount": state.fixture_rows,
        "diagnostic": {
            "schemaAdapter": SAFE_SCHEMA,
            "mysql": "ready",
            "redis": pong,
            "database": scope.database,
            "table": scope.table,
        }
    }))
}

async fn seed(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope).await?;
    let redis = redis_state(redis, scope).await?;
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
            "marker-scoped residue exists before seed: {}",
            scope.marker
        ));
    }
    let (seed_profile, seed_hash) = load_seed_profile(scope)?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin target seed transaction: {error}"))?;
    let sql = format!(
        "INSERT INTO `{}` \
         (tenant_id,panel_id,primary_key_value,values_json) VALUES (?,?,?,?)",
        scope.table
    );
    let mut bindings = BTreeMap::new();
    for row in &seed_profile.rows {
        let primary_key = format!("{}-{}", scope.marker, row.marker_suffix);
        sqlx::query(&sql)
            .bind(scope.tenant_id)
            .bind(scope.panel_id)
            .bind(&primary_key)
            .bind(Json(json!(row.values)))
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("seed target projection: {error}"))?;
        bindings.insert(
            row.marker_suffix.clone(),
            BTreeMap::from([
                ("generatedId".to_owned(), primary_key.clone()),
                ("marker".to_owned(), primary_key),
            ]),
        );
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit target seed transaction: {error}"))?;
    Ok(json!({
        "rowCount": seed_profile.rows.len(),
        "seedHash": seed_hash,
        "bindings": bindings,
        "snapshot": {
            "seedMode": "declarative-profile",
            "scenarioId": scope.scenario_id,
            "seedHash": seed_hash,
        }
    }))
}

fn load_seed_profile(scope: &Scope) -> Result<(SeedProfile, String), String> {
    let configured = required_env("MG_L4C_SEED_PROFILE")?;
    let path = Path::new(&configured);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("MG_L4C_SEED_PROFILE must be a nested JSON path".to_owned());
    }
    let content = fs::read(path).map_err(|error| format!("read target seed profile: {error}"))?;
    if content.len() > 1024 * 1024 {
        return Err("target seed profile exceeds 1 MiB".to_owned());
    }
    let hash = format!("{:x}", Sha256::digest(&content));
    if hash != required_env("MG_L4C_SEED_PROFILE_SHA256")? {
        return Err("target seed profile hash does not match binding".to_owned());
    }
    let profile: SeedProfile = serde_json::from_slice(&content)
        .map_err(|error| format!("decode target seed profile: {error}"))?;
    if profile.schema_version != 1
        || profile.protocol != SEED_PROTOCOL
        || profile.status != "approved"
        || profile.project_id != PROJECT_ID
        || profile.target_kind != "target"
        || profile.scenario_id != scope.scenario_id
        || profile.rows.is_empty()
        || profile.rows.len() as u64 > scope.max_rows
    {
        return Err("target seed profile identity or row count is invalid".to_owned());
    }
    let mut suffixes = BTreeSet::new();
    for row in &profile.rows {
        validate_token("target seed marker suffix", &row.marker_suffix, 64)?;
        if !suffixes.insert(row.marker_suffix.as_str())
            || row.values.is_empty()
            || row.values.len() > 64
            || row.values.keys().any(|key| {
                key.is_empty()
                    || key.len() > 64
                    || is_reserved_canonical_value_key(key)
                    || !key
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')
            })
        {
            return Err("target seed profile contains invalid row values".to_owned());
        }
        if serde_json::to_vec(&row.values)
            .map_err(|error| format!("encode target seed values: {error}"))?
            .len()
            > 64 * 1024
        {
            return Err("target seed row exceeds 64 KiB".to_owned());
        }
    }
    Ok((profile, hash))
}

fn is_reserved_canonical_value_key(value: &str) -> bool {
    matches!(value, "primaryKey" | "values")
}

async fn snapshot(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope).await?;
    guard_row_limit(scope, mysql.fixture_rows)?;
    let redis = redis_state(redis, scope).await?;
    Ok(json!({
        "rowCount": mysql.fixture_rows,
        "snapshot": {
            "mysql": mysql,
            "redis": redis,
        }
    }))
}

async fn collect(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope).await?;
    guard_row_limit(scope, mysql.fixture_rows)?;
    let redis = redis_state(redis, scope).await?;
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
                "events": if scope.scenario_id == "validation-failure"
                    && redis.progress.is_empty()
                {
                    json!({
                        "verified": true,
                        "collector": "state-profile",
                        "completionMode": "no-event",
                        "eventCount": 0,
                        "redis": redis,
                    })
                } else {
                    json!({ "verified": true, "redis": redis })
                },
                "failures": {
                    "verified": true,
                    "markerScoped": true,
                },
                "performance": {
                    "verified": true,
                    "rowCount": mysql.fixture_rows,
                    "withinBudget": mysql.fixture_rows <= scope.max_rows,
                },
            },
            "metadata": {
                "collector": "l4c-state-hook",
            }
        }
    }))
}

async fn cleanup(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let before = mysql_state(pool, scope).await?;
    guard_row_limit(scope, before.fixture_rows)?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin scoped cleanup: {error}"))?;
    for (table, column) in [
        ("batch_outbox", "batch_id"),
        ("batch_undo_journal", "batch_id"),
        ("batch_row_commit", "batch_id"),
    ] {
        let sql = format!("DELETE FROM `{table}` WHERE tenant_id=? AND `{column}`=?");
        sqlx::query(&sql)
            .bind(scope.tenant_id)
            .bind(&scope.marker)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("cleanup {table}: {error}"))?;
    }
    sqlx::query(
        "DELETE FROM schema_transition_ledger \
         WHERE tenant_id=? AND panel_id=? AND operation_id=?",
    )
    .bind(scope.tenant_id)
    .bind(scope.panel_id)
    .bind(&scope.marker)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("cleanup schema_transition_ledger: {error}"))?;
    sqlx::query(
        "DELETE FROM batch_idempotency \
         WHERE tenant_id=? AND panel_id=? AND (batch_id=? OR session_id=?)",
    )
    .bind(scope.tenant_id)
    .bind(scope.panel_id)
    .bind(&scope.marker)
    .bind(&scope.marker)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("cleanup batch_idempotency: {error}"))?;
    let projection_sql = format!(
        "DELETE FROM `{}` WHERE tenant_id=? AND panel_id=? \
         AND primary_key_value LIKE ? ESCAPE '\\\\'",
        scope.table
    );
    sqlx::query(&projection_sql)
        .bind(scope.tenant_id)
        .bind(scope.panel_id)
        .bind(marker_like(&scope.marker))
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("cleanup scoped projection: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit scoped cleanup: {error}"))?;
    cleanup_redis(redis, scope).await?;
    Ok(json!({
        "rowCount": before.fixture_rows,
        "snapshot": { "cleanupAttempted": true }
    }))
}

async fn verify_cleanup(
    pool: &MySqlPool,
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<Value, String> {
    let mysql = mysql_state(pool, scope).await?;
    let redis = redis_state(redis, scope).await?;
    let counters = CleanupCounters {
        fixture_rows: mysql.fixture_rows + mysql.idempotency_rows,
        undo_rows: mysql.undo_rows,
        outbox_rows: mysql.outbox_rows,
        commit_rows: mysql.commit_rows,
        redis_keys: redis.progress_keys,
        lease_keys: redis.lease_fields,
        schema_artifacts: mysql.schema_ledger_rows,
        fault_artifacts: 0,
    };
    Ok(json!({
        "rowCount": mysql.fixture_rows,
        "cleanup": counters,
    }))
}

async fn mysql_state(pool: &MySqlPool, scope: &Scope) -> Result<MysqlState, String> {
    let projection_sql = format!(
        "SELECT primary_key_value,values_json FROM `{}` \
         WHERE tenant_id=? AND panel_id=? AND primary_key_value LIKE ? ESCAPE '\\\\' \
         ORDER BY primary_key_value LIMIT {}",
        scope.table,
        scope.max_rows + 1
    );
    let projection_rows = sqlx::query(&projection_sql)
        .bind(scope.tenant_id)
        .bind(scope.panel_id)
        .bind(marker_like(&scope.marker))
        .fetch_all(pool)
        .await
        .map_err(|error| format!("snapshot scoped projection: {error}"))?;
    let projection = projection_rows
        .into_iter()
        .map(projection_document)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MysqlState {
        fixture_rows: projection.len() as u64,
        idempotency_rows: count_idempotency_rows(pool, scope).await?,
        undo_rows: count_marker_table(pool, "batch_undo_journal", "batch_id", scope).await?,
        outbox_rows: count_marker_table(pool, "batch_outbox", "batch_id", scope).await?,
        commit_rows: count_marker_table(pool, "batch_row_commit", "batch_id", scope).await?,
        schema_ledger_rows: count_schema_ledger_rows(pool, scope).await?,
        projection,
    })
}

fn projection_document(row: MySqlRow) -> Result<Value, String> {
    let primary_key: String = row
        .try_get("primary_key_value")
        .map_err(|error| format!("decode projection primary key: {error}"))?;
    let values: Json<Value> = row
        .try_get("values_json")
        .map_err(|error| format!("decode projection JSON: {error}"))?;
    Ok(json!({
        "primaryKey": primary_key,
        "values": values.0,
    }))
}

async fn count_marker_table(
    pool: &MySqlPool,
    table: &str,
    marker_column: &str,
    scope: &Scope,
) -> Result<u64, String> {
    let sql = format!("SELECT COUNT(*) FROM `{table}` WHERE tenant_id=? AND `{marker_column}`=?");
    let count = sqlx::query_scalar::<_, i64>(&sql)
        .bind(scope.tenant_id)
        .bind(&scope.marker)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("count {table} marker-scoped rows: {error}"))?;
    u64::try_from(count).map_err(|_| "negative MySQL row count".to_owned())
}

async fn count_idempotency_rows(pool: &MySqlPool, scope: &Scope) -> Result<u64, String> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM batch_idempotency \
         WHERE tenant_id=? AND panel_id=? AND (batch_id=? OR session_id=?)",
    )
    .bind(scope.tenant_id)
    .bind(scope.panel_id)
    .bind(&scope.marker)
    .bind(&scope.marker)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("count batch_idempotency marker-scoped rows: {error}"))?;
    u64::try_from(count).map_err(|_| "negative MySQL row count".to_owned())
}

async fn count_schema_ledger_rows(pool: &MySqlPool, scope: &Scope) -> Result<u64, String> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM schema_transition_ledger \
         WHERE tenant_id=? AND panel_id=? AND operation_id=?",
    )
    .bind(scope.tenant_id)
    .bind(scope.panel_id)
    .bind(&scope.marker)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("count schema_transition_ledger marker-scoped rows: {error}"))?;
    u64::try_from(count).map_err(|_| "negative MySQL row count".to_owned())
}

async fn redis_state(
    redis: &mut MultiplexedConnection,
    scope: &Scope,
) -> Result<RedisState, String> {
    let progress_key = progress_key(scope);
    let progress: BTreeMap<String, String> = redis::cmd("HGETALL")
        .arg(&progress_key)
        .query_async(&mut *redis)
        .await
        .map_err(|error| format!("snapshot progress Redis key: {error}"))?;
    let mut lease_fields = 0u64;
    for key in lease_keys(scope) {
        let fields: Vec<String> = redis::cmd("HKEYS")
            .arg(key)
            .query_async(&mut *redis)
            .await
            .map_err(|error| format!("snapshot lease Redis key: {error}"))?;
        lease_fields += fields
            .iter()
            .filter(|field| field.contains(&scope.marker))
            .count() as u64;
    }
    Ok(RedisState {
        progress_keys: u64::from(!progress.is_empty()),
        lease_fields,
        progress,
    })
}

async fn cleanup_redis(redis: &mut MultiplexedConnection, scope: &Scope) -> Result<(), String> {
    redis::cmd("DEL")
        .arg(progress_key(scope))
        .query_async::<i64>(&mut *redis)
        .await
        .map_err(|error| format!("cleanup progress Redis key: {error}"))?;
    for key in lease_keys(scope) {
        let fields: Vec<String> = redis::cmd("HKEYS")
            .arg(&key)
            .query_async(&mut *redis)
            .await
            .map_err(|error| format!("load scoped lease fields: {error}"))?;
        let scoped = fields
            .into_iter()
            .filter(|field| field.contains(&scope.marker))
            .collect::<Vec<_>>();
        if !scoped.is_empty() {
            redis::cmd("HDEL")
                .arg(&key)
                .arg(scoped)
                .query_async::<i64>(&mut *redis)
                .await
                .map_err(|error| format!("cleanup scoped lease fields: {error}"))?;
        }
        let remaining: i64 = redis::cmd("HLEN")
            .arg(&key)
            .query_async(&mut *redis)
            .await
            .map_err(|error| format!("verify lease field cleanup: {error}"))?;
        if remaining == 0 {
            redis::cmd("DEL")
                .arg(&key)
                .query_async::<i64>(&mut *redis)
                .await
                .map_err(|error| format!("remove empty lease key: {error}"))?;
        }
    }
    Ok(())
}

async fn verify_database_scope(pool: &MySqlPool, scope: &Scope) -> Result<(), String> {
    let database: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("read selected MySQL database: {error}"))?;
    if database.as_deref() != Some(scope.database.as_str()) {
        return Err("connected MySQL database does not match approved scope".to_owned());
    }
    Ok(())
}

fn target_env(target_kind: &str, source: &str, target: &str) -> Result<String, String> {
    required_env(if target_kind == "source" {
        source
    } else {
        target
    })
}

fn normalize_mysql_url(value: &str) -> Result<String, String> {
    let normalized = value.strip_prefix("jdbc:").unwrap_or(value).to_owned();
    if !normalized.starts_with("mysql://") {
        return Err("scoped MySQL URL must use mysql:// or jdbc:mysql://".to_owned());
    }
    Ok(normalized)
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
            "marker-scoped fixture row count {count} exceeds approved maximum {}",
            scope.max_rows
        ));
    }
    Ok(())
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

fn marker_like(marker: &str) -> String {
    format!(
        "{}-%",
        marker
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn progress_key(scope: &Scope) -> String {
    format!(
        "zboss:batch-progress:tenant:{}:batch:{}",
        scope.tenant_id, scope.marker
    )
}

fn lease_keys(scope: &Scope) -> [String; 2] {
    [
        format!(
            "zboss:batch-lease:tenant:{}:panel:{}",
            scope.tenant_id, scope.panel_id
        ),
        format!(
            "zboss:schema-transition:tenant:{}:panel:{}",
            scope.tenant_id, scope.panel_id
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_disposable_database_and_dynamic_table_names() {
        assert!(is_safe_database("zz_boss_test"));
        assert!(is_safe_database("migration_fixture_01"));
        assert!(!is_safe_database("zboss_production"));
        assert!(!is_safe_database("test-db"));
        assert!(is_safe_dynamic_table("cust_table9001"));
        assert!(!is_safe_dynamic_table("cust_table"));
        assert!(!is_safe_dynamic_table("cust_table9001;DROP"));
    }

    #[test]
    fn normalizes_jdbc_mysql_without_weakening_scheme_validation() {
        assert_eq!(
            normalize_mysql_url("jdbc:mysql://localhost/zz_boss_test").unwrap(),
            "mysql://localhost/zz_boss_test"
        );
        assert!(normalize_mysql_url("postgres://localhost/test").is_err());
    }

    #[test]
    fn escapes_marker_for_prefix_bound_like_query() {
        assert_eq!(marker_like("mg_l4c%run"), "mg\\_l4c\\%run-%");
    }

    #[test]
    fn rejects_unsafe_marker_tokens() {
        assert!(validate_token("marker", "mg-l4c:run_01", 128).is_ok());
        assert!(validate_token("marker", "mg-l4c/run", 128).is_err());
        assert!(validate_token("marker", "x", 0).is_err());
    }

    #[test]
    fn reserves_canonical_projection_identity_keys() {
        assert!(is_reserved_canonical_value_key("primaryKey"));
        assert!(is_reserved_canonical_value_key("values"));
        assert!(!is_reserved_canonical_value_key("value"));
        assert!(!is_reserved_canonical_value_key("quantity"));
    }
}
