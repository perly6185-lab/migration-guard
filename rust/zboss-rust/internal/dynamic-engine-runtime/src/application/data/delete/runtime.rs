use crate::application::data::delete::adapters::mysql::is_safe_dynamic_table;
use crate::application::data::delete::adapters::redis::{
    ACQUIRE_SCRIPT, PROGRESS_SCRIPT, RELEASE_SCRIPT, RENEW_SCRIPT,
};
use crate::application::data::delete::{COMPENSATION_STEPS, HTTP_PATH, MAX_ROWS, ProgressState};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::{MySql, MySqlPool, QueryBuilder, Row as SqlxRow, Transaction};
use std::collections::BTreeSet;
use std::env;
use std::net::SocketAddr;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub mysql_url: String,
    pub redis_url: String,
    pub bind_addr: SocketAddr,
    pub table_name: String,
    pub lease_ttl_millis: u64,
    pub worker_interval_millis: u64,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, String> {
        let bind_addr = required_env("ZBOSS_BATCH_DELETE_BIND_ADDR")?
            .parse()
            .map_err(|_| "ZBOSS_BATCH_DELETE_BIND_ADDR is invalid".to_owned())?;
        Self::from_env_with_bind(bind_addr)
    }

    pub fn from_env_embedded() -> Result<Self, String> {
        let bind_addr = match env::var("ZBOSS_BATCH_DELETE_BIND_ADDR") {
            Ok(value) => value
                .parse()
                .map_err(|_| "ZBOSS_BATCH_DELETE_BIND_ADDR is invalid".to_owned())?,
            Err(_) => "127.0.0.1:0"
                .parse()
                .expect("the embedded fallback bind address is valid"),
        };
        Self::from_env_with_bind(bind_addr)
    }

    fn from_env_with_bind(bind_addr: SocketAddr) -> Result<Self, String> {
        let config = Self {
            mysql_url: required_env("ZBOSS_BATCH_DELETE_MYSQL_URL")?,
            redis_url: required_env("ZBOSS_BATCH_DELETE_REDIS_URL")?,
            bind_addr,
            table_name: required_env("ZBOSS_BATCH_DELETE_TABLE")?,
            lease_ttl_millis: optional_u64("ZBOSS_BATCH_DELETE_LEASE_TTL_MS", 30_000)?,
            worker_interval_millis: optional_u64("ZBOSS_BATCH_DELETE_WORKER_INTERVAL_MS", 100)?,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.mysql_url.starts_with("mysql://") {
            return Err("MySQL URL must use mysql://".into());
        }
        if !self.redis_url.starts_with("redis://") {
            return Err("Redis URL must use redis://".into());
        }
        if !is_safe_dynamic_table(&self.table_name) {
            return Err("ZBOSS_BATCH_DELETE_TABLE must match cust_table<digits>".into());
        }
        if self.lease_ttl_millis < 1_000 || self.worker_interval_millis == 0 {
            return Err("lease and worker intervals are invalid".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct AppState {
    pool: MySqlPool,
    redis: redis::Client,
    config: Arc<ServiceConfig>,
    worker_failures: Arc<AtomicU64>,
}

const WORKER_READINESS_FAILURE_THRESHOLD: u64 = 3;

#[derive(Clone)]
pub struct ReadinessProbe {
    state: AppState,
}

impl ReadinessProbe {
    pub async fn check(&self) -> Result<(), String> {
        readiness(&self.state).await.map_err(|error| error.message)
    }
}

/// Embeddable batch-delete runtime used by the unified ZBoss process.
///
/// The router already owns a cloned application state. The handle keeps the
/// compensation worker alive and provides an explicit shutdown boundary.
pub struct EmbeddedRuntime {
    router: Router,
    router_state: AppState,
    shutdown_tx: watch::Sender<bool>,
    worker: JoinHandle<()>,
}

impl EmbeddedRuntime {
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn readiness_probe(&self) -> ReadinessProbe {
        ReadinessProbe {
            state: self.router_state.clone(),
        }
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.worker.await;
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum IdInput {
    Text(String),
    Number(u64),
}

impl IdInput {
    fn parse(&self, name: &str) -> Result<u64, AppError> {
        match self {
            Self::Text(value) => value
                .parse()
                .map_err(|_| AppError::bad_request(format!("{name} is invalid"))),
            Self::Number(value) => Ok(*value),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchRowInput {
    id: IdInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpDeleteRequest {
    inter_id: IdInput,
    http_id: IdInput,
    use_page_id: IdInput,
    panel_id: IdInput,
    batch_post_value_list: Vec<BatchRowInput>,
    operation_kind: String,
    operation_label: String,
}

#[derive(Clone, Debug)]
struct DeleteCommand {
    tenant_id: u64,
    actor_id: u64,
    request_id: String,
    idempotency_key: String,
    request_hash: String,
    batch_id: String,
    panel_id: u64,
    row_ids: Vec<u64>,
}

#[derive(Clone, Copy, Debug)]
struct ProgressCounts {
    requested: usize,
    deleted: usize,
    skipped: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpDeleteResponse {
    pub request_id: String,
    pub batch_id: String,
    pub deleted_row_ids: Vec<u64>,
    pub skipped_row_ids: Vec<u64>,
    pub replayed: bool,
    pub progress_state: String,
}

#[derive(Serialize)]
struct CommonResult<T: Serialize> {
    code: i32,
    data: T,
    msg: String,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "BAD_REQUEST",
            message: message.into(),
        }
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }

    fn dependency(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "DEPENDENCY_FAILURE",
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(CommonResult {
                code: -1,
                data: json!({ "error": self.code }),
                msg: self.message,
            }),
        )
            .into_response()
    }
}

pub async fn run_from_env() -> Result<(), String> {
    run(ServiceConfig::from_env()?).await
}

pub async fn run(config: ServiceConfig) -> Result<(), String> {
    let bind_addr = config.bind_addr;
    let runtime = embedded(config).await?;
    let app = runtime.router();
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|error| format!("bind HTTP listener: {error}"))?;
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("serve HTTP: {error}"));
    runtime.shutdown().await;
    result
}

pub async fn embedded(config: ServiceConfig) -> Result<EmbeddedRuntime, String> {
    config.validate()?;
    let pool = MySqlPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.mysql_url)
        .await
        .map_err(|error| format!("connect MySQL: {error}"))?;
    let redis = redis::Client::open(config.redis_url.clone())
        .map_err(|error| format!("configure Redis: {error}"))?;
    let state = AppState {
        pool,
        redis,
        config: Arc::new(config.clone()),
        worker_failures: Arc::new(AtomicU64::new(0)),
    };
    readiness(&state)
        .await
        .map_err(|error| error.message.clone())?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        compensation_worker(worker_state, shutdown_rx).await;
    });
    Ok(EmbeddedRuntime {
        router: router(state.clone()),
        router_state: state,
        shutdown_tx,
        worker,
    })
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(HTTP_PATH, post(batch_delete))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/internal/progress/{batch_id}", get(progress_status))
        .with_state(state)
}

async fn live() -> Json<Value> {
    Json(json!({ "status": "UP" }))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    readiness(&state).await?;
    Ok(Json(json!({ "status": "UP" })))
}

async fn readiness(state: &AppState) -> Result<(), AppError> {
    let worker_failures = state.worker_failures.load(Ordering::Relaxed);
    if worker_failures >= WORKER_READINESS_FAILURE_THRESHOLD {
        return Err(AppError::dependency(format!(
            "compensation worker has failed {worker_failures} consecutive polls"
        )));
    }
    sqlx::query("SELECT 1")
        .execute(&state.pool)
        .await
        .map_err(|error| AppError::dependency(format!("MySQL not ready: {error}")))?;
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("Redis not ready: {error}")))?;
    let pong: String = redis::cmd("PING")
        .query_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("Redis ping failed: {error}")))?;
    if pong != "PONG" {
        return Err(AppError::dependency("Redis returned a non-PONG response"));
    }
    Ok(())
}

async fn batch_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HttpDeleteRequest>,
) -> Result<Json<CommonResult<HttpDeleteResponse>>, AppError> {
    let command = build_command(&headers, &request)?;
    let lease_owner = format!("{}:{}", command.batch_id, command.request_id);
    acquire_lease(&state, &command, &lease_owner).await?;
    let result = execute_with_lease(&state, &command).await;
    let release_result = release_lease(&state, &command, &lease_owner).await;
    match (result, release_result) {
        (Ok(response), Ok(())) => Ok(Json(CommonResult {
            code: 0,
            data: response,
            msg: String::new(),
        })),
        (Err(error), _) => {
            publish_failure_if_uncommitted(&state, &command).await;
            Err(error)
        }
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn publish_failure_if_uncommitted(state: &AppState, command: &DeleteCommand) {
    let committed = sqlx::query(
        "SELECT 1 FROM delete_idempotency \
         WHERE tenant_id=? AND panel_id=? AND idempotency_key=? AND response_json IS NOT NULL",
    )
    .bind(command.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .fetch_optional(&state.pool)
    .await
    .is_ok_and(|row| row.is_some());
    if !committed {
        let _ = publish_progress(
            state,
            command.tenant_id,
            &command.batch_id,
            2,
            ProgressState::Failed,
            ProgressCounts {
                requested: command.row_ids.len(),
                deleted: 0,
                skipped: 0,
            },
        )
        .await;
    }
}

async fn execute_with_lease(
    state: &AppState,
    command: &DeleteCommand,
) -> Result<HttpDeleteResponse, AppError> {
    if let Some(response) = load_replay(state, command).await? {
        return Ok(response);
    }
    publish_progress(
        state,
        command.tenant_id,
        &command.batch_id,
        1,
        ProgressState::Running,
        ProgressCounts {
            requested: command.row_ids.len(),
            deleted: 0,
            skipped: 0,
        },
    )
    .await?;

    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|error| AppError::dependency(format!("begin transaction: {error}")))?;
    insert_idempotency(&mut transaction, command).await?;
    let rows = load_rows_for_update(&mut transaction, command, &state.config.table_name).await?;
    if rows.len() != command.row_ids.len() {
        return Err(AppError::conflict(
            "MISSING_ACTIVE_ROW",
            "one or more requested rows are missing or already deleted",
        ));
    }
    let skipped = command
        .row_ids
        .iter()
        .filter(|id| rows.iter().any(|row| row.id == **id && row.referenced))
        .copied()
        .collect::<Vec<_>>();
    let skipped_set = skipped.iter().copied().collect::<BTreeSet<_>>();
    let deleted = command
        .row_ids
        .iter()
        .filter(|id| !skipped_set.contains(id))
        .copied()
        .collect::<Vec<_>>();
    for row_id in &deleted {
        let row = rows
            .iter()
            .find(|row| row.id == *row_id)
            .expect("loaded row");
        persist_row_delete(&mut transaction, command, row, &state.config.table_name).await?;
    }
    if !deleted.is_empty() {
        persist_compensation_outbox(&mut transaction, command, &deleted, skipped.len()).await?;
    }
    let mut response = HttpDeleteResponse {
        request_id: command.request_id.clone(),
        batch_id: command.batch_id.clone(),
        deleted_row_ids: deleted.clone(),
        skipped_row_ids: skipped.clone(),
        replayed: false,
        progress_state: if deleted.is_empty() {
            "SUCCESS".into()
        } else {
            "MAIN_COMMITTED".into()
        },
    };
    persist_main_response(&mut transaction, command, &response).await?;
    transaction
        .commit()
        .await
        .map_err(|error| AppError::dependency(format!("commit delete transaction: {error}")))?;

    publish_progress(
        state,
        command.tenant_id,
        &command.batch_id,
        2,
        ProgressState::MainCommitted,
        ProgressCounts {
            requested: command.row_ids.len(),
            deleted: deleted.len(),
            skipped: skipped.len(),
        },
    )
    .await?;
    if deleted.is_empty() {
        publish_progress(
            state,
            command.tenant_id,
            &command.batch_id,
            3,
            ProgressState::Success,
            ProgressCounts {
                requested: command.row_ids.len(),
                deleted: 0,
                skipped: skipped.len(),
            },
        )
        .await?;
        response.progress_state = "SUCCESS".into();
    }
    Ok(response)
}

async fn load_replay(
    state: &AppState,
    command: &DeleteCommand,
) -> Result<Option<HttpDeleteResponse>, AppError> {
    let row = sqlx::query(
        "SELECT request_hash, response_json FROM delete_idempotency \
         WHERE tenant_id=? AND panel_id=? AND idempotency_key=?",
    )
    .bind(command.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("load replay: {error}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let existing_hash: String = row
        .try_get("request_hash")
        .map_err(|error| AppError::dependency(format!("decode replay hash: {error}")))?;
    if existing_hash != command.request_hash {
        return Err(AppError::conflict(
            "IDEMPOTENCY_CONFLICT",
            "idempotency key is bound to a different request hash",
        ));
    }
    let value: Value = row
        .try_get("response_json")
        .map_err(|error| AppError::dependency(format!("decode replay response: {error}")))?;
    let mut response: HttpDeleteResponse = serde_json::from_value(value)
        .map_err(|error| AppError::dependency(format!("parse replay response: {error}")))?;
    response.replayed = true;
    Ok(Some(response))
}

#[derive(Clone, Debug)]
struct LockedRow {
    id: u64,
    material_name: String,
    material_quantity: i32,
    referenced: bool,
    row_version: u64,
}

async fn load_rows_for_update(
    transaction: &mut Transaction<'_, MySql>,
    command: &DeleteCommand,
    table_name: &str,
) -> Result<Vec<LockedRow>, AppError> {
    let mut query = QueryBuilder::<MySql>::new(format!(
        "SELECT id, material_name, material_quantity, referenced_flag, row_version \
         FROM `{table_name}` WHERE tenant_id="
    ));
    query
        .push_bind(command.tenant_id)
        .push(" AND panel_id=")
        .push_bind(command.panel_id)
        .push(" AND deleted=0 AND id IN (");
    let mut separated = query.separated(", ");
    for row_id in &command.row_ids {
        separated.push_bind(*row_id);
    }
    separated.push_unseparated(") FOR UPDATE");
    let rows = query
        .build()
        .fetch_all(&mut **transaction)
        .await
        .map_err(|error| AppError::dependency(format!("lock delete rows: {error}")))?;
    rows.into_iter()
        .map(|row| {
            Ok(LockedRow {
                id: decode_nonnegative_u64(&row, "id")?,
                material_name: row.try_get("material_name").map_err(|error| {
                    AppError::dependency(format!("decode material_name: {error}"))
                })?,
                material_quantity: row.try_get("material_quantity").map_err(|error| {
                    AppError::dependency(format!("decode material_quantity: {error}"))
                })?,
                referenced: row.try_get::<i8, _>("referenced_flag").map_err(|error| {
                    AppError::dependency(format!("decode referenced_flag: {error}"))
                })? != 0,
                row_version: decode_nonnegative_u64(&row, "row_version")?,
            })
        })
        .collect()
}

async fn insert_idempotency(
    transaction: &mut Transaction<'_, MySql>,
    command: &DeleteCommand,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO delete_idempotency \
         (tenant_id,panel_id,idempotency_key,request_hash,batch_id,state) \
         VALUES (?,?,?,?,?,'STARTED')",
    )
    .bind(command.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .bind(&command.request_hash)
    .bind(&command.batch_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| AppError::conflict("IDEMPOTENCY_RACE", error.to_string()))?;
    Ok(())
}

async fn persist_row_delete(
    transaction: &mut Transaction<'_, MySql>,
    command: &DeleteCommand,
    row: &LockedRow,
    table_name: &str,
) -> Result<(), AppError> {
    let snapshot = json!({
        "id": row.id,
        "materialName": row.material_name,
        "materialQuantity": row.material_quantity,
        "deleted": 0,
        "rowVersion": row.row_version,
    });
    sqlx::query(
        "INSERT INTO delete_snapshot \
         (tenant_id,batch_id,row_id,row_version,snapshot_json) VALUES (?,?,?,?,?)",
    )
    .bind(command.tenant_id)
    .bind(&command.batch_id)
    .bind(row.id)
    .bind(row.row_version)
    .bind(snapshot)
    .execute(&mut **transaction)
    .await
    .map_err(|error| AppError::dependency(format!("persist snapshot: {error}")))?;

    let update = format!(
        "UPDATE `{table_name}` SET deleted=1,row_version=row_version+1,updated_by=? \
         WHERE tenant_id=? AND panel_id=? AND id=? AND deleted=0 AND row_version=?"
    );
    let affected = sqlx::query(&update)
        .bind(command.actor_id)
        .bind(command.tenant_id)
        .bind(command.panel_id)
        .bind(row.id)
        .bind(row.row_version)
        .execute(&mut **transaction)
        .await
        .map_err(|error| AppError::dependency(format!("soft delete row: {error}")))?
        .rows_affected();
    if affected != 1 {
        return Err(AppError::conflict(
            "CONCURRENT_WRITE",
            format!("row {} changed concurrently", row.id),
        ));
    }
    sqlx::query(
        "INSERT INTO delete_undo_anchor \
         (tenant_id,batch_id,row_id,snapshot_row_id) VALUES (?,?,?,?)",
    )
    .bind(command.tenant_id)
    .bind(&command.batch_id)
    .bind(row.id)
    .bind(row.id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| AppError::dependency(format!("persist undo anchor: {error}")))?;
    Ok(())
}

async fn persist_compensation_outbox(
    transaction: &mut Transaction<'_, MySql>,
    command: &DeleteCommand,
    deleted: &[u64],
    skipped: usize,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO delete_compensation_outbox \
         (tenant_id,panel_id,batch_id,idempotency_key,request_hash,row_ids,\
          requested_rows,deleted_rows,skipped_rows,progress_sequence) \
         VALUES (?,?,?,?,?,?,?,?,?,2)",
    )
    .bind(command.tenant_id)
    .bind(command.panel_id)
    .bind(&command.batch_id)
    .bind(&command.idempotency_key)
    .bind(&command.request_hash)
    .bind(json!(deleted))
    .bind(command.row_ids.len() as u32)
    .bind(deleted.len() as u32)
    .bind(skipped as u32)
    .execute(&mut **transaction)
    .await
    .map_err(|error| AppError::dependency(format!("persist compensation outbox: {error}")))?;
    for (index, name) in COMPENSATION_STEPS.iter().enumerate() {
        sqlx::query(
            "INSERT INTO delete_compensation_step \
             (tenant_id,batch_id,step_index,step_name) VALUES (?,?,?,?)",
        )
        .bind(command.tenant_id)
        .bind(&command.batch_id)
        .bind(index as u32)
        .bind(name)
        .execute(&mut **transaction)
        .await
        .map_err(|error| AppError::dependency(format!("persist compensation step: {error}")))?;
    }
    Ok(())
}

async fn persist_main_response(
    transaction: &mut Transaction<'_, MySql>,
    command: &DeleteCommand,
    response: &HttpDeleteResponse,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE delete_idempotency SET state=?,response_json=? \
         WHERE tenant_id=? AND panel_id=? AND idempotency_key=? AND request_hash=?",
    )
    .bind(&response.progress_state)
    .bind(serde_json::to_value(response).expect("serializable response"))
    .bind(command.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .bind(&command.request_hash)
    .execute(&mut **transaction)
    .await
    .map_err(|error| AppError::dependency(format!("persist delete response: {error}")))?;
    Ok(())
}

async fn acquire_lease(
    state: &AppState,
    command: &DeleteCommand,
    owner: &str,
) -> Result<(), AppError> {
    let now = epoch_millis();
    let result = eval_script(
        state,
        ACQUIRE_SCRIPT,
        &lease_key(command.tenant_id, command.panel_id),
        &[
            owner.to_owned(),
            "delete".into(),
            now.to_string(),
            now.saturating_add(state.config.lease_ttl_millis)
                .to_string(),
        ],
    )
    .await?;
    match result.as_str() {
        "ACQUIRED" => Ok(()),
        "BUSY" => Err(AppError::conflict(
            "CONCURRENT_MUTATION",
            "tenant-panel mutation gate is busy",
        )),
        value => Err(AppError::dependency(format!(
            "unexpected lease result: {value}"
        ))),
    }
}

#[allow(dead_code)]
async fn renew_lease(
    state: &AppState,
    command: &DeleteCommand,
    owner: &str,
) -> Result<(), AppError> {
    let now = epoch_millis();
    let result = eval_script(
        state,
        RENEW_SCRIPT,
        &lease_key(command.tenant_id, command.panel_id),
        &[
            owner.to_owned(),
            now.to_string(),
            now.saturating_add(state.config.lease_ttl_millis)
                .to_string(),
        ],
    )
    .await?;
    if result == "RENEWED" {
        Ok(())
    } else {
        Err(AppError::dependency(format!(
            "lease renewal failed: {result}"
        )))
    }
}

async fn release_lease(
    state: &AppState,
    command: &DeleteCommand,
    owner: &str,
) -> Result<(), AppError> {
    let result = eval_script(
        state,
        RELEASE_SCRIPT,
        &lease_key(command.tenant_id, command.panel_id),
        &[owner.to_owned()],
    )
    .await?;
    if matches!(result.as_str(), "RELEASED" | "OWNER_MISSING") {
        Ok(())
    } else {
        Err(AppError::dependency(format!(
            "lease release failed: {result}"
        )))
    }
}

async fn publish_progress(
    state: &AppState,
    tenant_id: u64,
    batch_id: &str,
    sequence: u64,
    progress_state: ProgressState,
    counts: ProgressCounts,
) -> Result<String, AppError> {
    let state_name = match progress_state {
        ProgressState::Running => "RUNNING",
        ProgressState::MainCommitted => "MAIN_COMMITTED",
        ProgressState::CompensationRetrying => "COMPENSATION_RETRYING",
        ProgressState::Success => "SUCCESS",
        ProgressState::Failed => "FAILED",
        ProgressState::CompensationFailed => "COMPENSATION_FAILED",
    };
    let event_hash = hex_hash(&json!({
        "batchId": batch_id,
        "sequence": sequence,
        "state": state_name,
        "requested": counts.requested,
        "deleted": counts.deleted,
        "skipped": counts.skipped,
    }));
    eval_script(
        state,
        PROGRESS_SCRIPT,
        &progress_key(tenant_id, batch_id),
        &[
            sequence.to_string(),
            state_name.into(),
            event_hash,
            counts.requested.to_string(),
            counts.deleted.to_string(),
            counts.skipped.to_string(),
        ],
    )
    .await
}

async fn eval_script(
    state: &AppState,
    script: &str,
    key: &str,
    args: &[String],
) -> Result<String, AppError> {
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect Redis: {error}")))?;
    let redis_script = redis::Script::new(script);
    let mut invocation = redis_script.prepare_invoke();
    invocation.key(key);
    for argument in args {
        invocation.arg(argument);
    }
    invocation
        .invoke_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("execute Redis script: {error}")))
}

async fn progress_status(
    State(state): State<AppState>,
    Path(batch_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let tenant_id = header_u64(&headers, "tenant-id")?;
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect Redis: {error}")))?;
    let values: Vec<String> = connection
        .hget(
            progress_key(tenant_id, &batch_id),
            &[
                "sequence",
                "state",
                "requested",
                "deleted",
                "skipped",
                "terminal",
            ],
        )
        .await
        .map_err(|error| AppError::dependency(format!("read progress: {error}")))?;
    if values.is_empty() {
        return Err(AppError::conflict("PROGRESS_MISSING", "progress not found"));
    }
    Ok(Json(json!({
        "batchId": batch_id,
        "sequence": values.first(),
        "state": values.get(1),
        "requested": values.get(2),
        "deleted": values.get(3),
        "skipped": values.get(4),
        "terminal": values.get(5),
    })))
}

async fn compensation_worker(state: AppState, mut shutdown: watch::Receiver<bool>) {
    let interval = Duration::from_millis(state.config.worker_interval_millis);
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = tokio::time::sleep(interval) => {
                match run_compensation_once(&state).await {
                    Ok(()) => {
                        let recovered = state.worker_failures.swap(0, Ordering::Relaxed);
                        if recovered > 0 {
                            eprintln!(
                                "{}",
                                json!({
                                    "event": "batch_delete_compensation_worker_recovered",
                                    "previousConsecutiveFailures": recovered,
                                })
                            );
                        }
                    }
                    Err(error) => {
                        let failures = state.worker_failures.fetch_add(1, Ordering::Relaxed) + 1;
                        eprintln!(
                            "{}",
                            json!({
                                "event": "batch_delete_compensation_worker_failed",
                                "consecutiveFailures": failures,
                                "errorCode": error.code,
                                "error": error.message,
                            })
                        );
                    }
                }
            }
        }
    }
}

async fn run_compensation_once(state: &AppState) -> Result<(), AppError> {
    let row = sqlx::query(
        "SELECT tenant_id,panel_id,batch_id,idempotency_key,next_step,\
         requested_rows,deleted_rows,skipped_rows,progress_sequence \
         FROM delete_compensation_outbox \
         WHERE state IN ('PENDING','RUNNING','RETRY') AND next_step < 9 \
         ORDER BY created_at LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("poll compensation outbox: {error}")))?;
    let Some(row) = row else {
        return Ok(());
    };
    let tenant_id = decode_nonnegative_u64(&row, "tenant_id")?;
    let panel_id = decode_nonnegative_u64(&row, "panel_id")?;
    let batch_id: String = row.try_get("batch_id").map_err(decode_error)?;
    let idempotency_key: String = row.try_get("idempotency_key").map_err(decode_error)?;
    let step_index = decode_nonnegative_u32(&row, "next_step")?;
    let requested = decode_nonnegative_u32(&row, "requested_rows")?;
    let deleted = decode_nonnegative_u32(&row, "deleted_rows")?;
    let skipped = decode_nonnegative_u32(&row, "skipped_rows")?;
    let sequence = decode_nonnegative_u64(&row, "progress_sequence")?;
    let owner = format!("worker:{}:{}", std::process::id(), step_index);

    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|error| AppError::dependency(format!("begin compensation: {error}")))?;
    let claimed = sqlx::query(
        "UPDATE delete_compensation_step SET state='RUNNING',attempts=attempts+1,owner_token=? \
         WHERE tenant_id=? AND batch_id=? AND step_index=? \
         AND state IN ('PENDING','RETRY') AND owner_token IS NULL",
    )
    .bind(&owner)
    .bind(tenant_id)
    .bind(&batch_id)
    .bind(step_index)
    .execute(&mut *transaction)
    .await
    .map_err(|error| AppError::dependency(format!("claim compensation: {error}")))?
    .rows_affected();
    if claimed == 0 {
        transaction
            .rollback()
            .await
            .map_err(|error| AppError::dependency(format!("rollback claim: {error}")))?;
        return Ok(());
    }
    let step_name = COMPENSATION_STEPS[step_index as usize];
    sqlx::query(
        "INSERT INTO delete_compensation_effect \
         (tenant_id,batch_id,step_index,step_name,effect_payload) VALUES (?,?,?,?,?) \
         ON DUPLICATE KEY UPDATE step_name=VALUES(step_name)",
    )
    .bind(tenant_id)
    .bind(&batch_id)
    .bind(step_index)
    .bind(step_name)
    .bind(json!({ "status": "protocol-bound", "panelId": panel_id }))
    .execute(&mut *transaction)
    .await
    .map_err(|error| AppError::dependency(format!("execute compensation effect: {error}")))?;
    sqlx::query(
        "UPDATE delete_compensation_step SET state='COMPLETED',owner_token=NULL,error_message=NULL \
         WHERE tenant_id=? AND batch_id=? AND step_index=? AND owner_token=?",
    )
    .bind(tenant_id)
    .bind(&batch_id)
    .bind(step_index)
    .bind(&owner)
    .execute(&mut *transaction)
    .await
    .map_err(|error| AppError::dependency(format!("complete compensation: {error}")))?;
    let next_step = step_index + 1;
    let terminal = next_step == COMPENSATION_STEPS.len() as u32;
    sqlx::query(
        "UPDATE delete_compensation_outbox \
         SET next_step=?,state=?,progress_sequence=? WHERE tenant_id=? AND batch_id=?",
    )
    .bind(next_step)
    .bind(if terminal { "SUCCESS" } else { "RUNNING" })
    .bind(if terminal { sequence + 1 } else { sequence })
    .bind(tenant_id)
    .bind(&batch_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| AppError::dependency(format!("advance compensation: {error}")))?;
    if terminal {
        sqlx::query(
            "UPDATE delete_idempotency \
             SET state='SUCCESS',response_json=JSON_SET(response_json,'$.progressState','SUCCESS') \
             WHERE tenant_id=? AND panel_id=? AND idempotency_key=? AND batch_id=?",
        )
        .bind(tenant_id)
        .bind(panel_id)
        .bind(&idempotency_key)
        .bind(&batch_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| AppError::dependency(format!("persist terminal response: {error}")))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| AppError::dependency(format!("commit compensation: {error}")))?;
    if terminal {
        publish_progress(
            state,
            tenant_id,
            &batch_id,
            sequence + 1,
            ProgressState::Success,
            ProgressCounts {
                requested: requested as usize,
                deleted: deleted as usize,
                skipped: skipped as usize,
            },
        )
        .await?;
    }
    Ok(())
}

fn build_command(
    headers: &HeaderMap,
    request: &HttpDeleteRequest,
) -> Result<DeleteCommand, AppError> {
    if request.operation_kind != "ROW_DELETE" {
        return Err(AppError::bad_request("operationKind must be ROW_DELETE"));
    }
    let tenant_id = header_u64(headers, "tenant-id")?;
    let actor_id = header_u64(headers, "x-user-id")?;
    let idempotency_key = header_text(headers, "x-idempotency-key")?;
    let request_id = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&idempotency_key)
        .to_owned();
    if idempotency_key.len() > 128 || request_id.len() > 128 {
        return Err(AppError::bad_request("request identity is too long"));
    }
    let mut seen = BTreeSet::new();
    let row_ids = request
        .batch_post_value_list
        .iter()
        .map(|row| row.id.parse("batchPostValueList.id"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|id| seen.insert(*id))
        .collect::<Vec<_>>();
    if row_ids.is_empty() || row_ids.len() > MAX_ROWS || row_ids.contains(&0) {
        return Err(AppError::bad_request(
            "batchPostValueList must contain 1..10000 positive distinct ids",
        ));
    }
    let inter_id = request.inter_id.parse("interId")?;
    let http_id = request.http_id.parse("httpId")?;
    let use_page_id = request.use_page_id.parse("usePageId")?;
    let panel_id = request.panel_id.parse("panelId")?;
    let hash_value = json!({
        "tenantId": tenant_id,
        "actorId": actor_id,
        "interId": inter_id,
        "httpId": http_id,
        "usePageId": use_page_id,
        "panelId": panel_id,
        "rowIds": row_ids,
        "operationKind": request.operation_kind,
        "operationLabel": request.operation_label,
    });
    let request_hash = hex_hash(&hash_value);
    Ok(DeleteCommand {
        tenant_id,
        actor_id,
        request_id,
        idempotency_key,
        batch_id: format!("bd-{}", &request_hash[..24]),
        request_hash,
        panel_id,
        row_ids,
    })
}

fn header_u64(headers: &HeaderMap, name: &'static str) -> Result<u64, AppError> {
    header_text(headers, name)?
        .parse()
        .map_err(|_| AppError::bad_request(format!("{name} header is invalid")))
}

fn header_text(headers: &HeaderMap, name: &'static str) -> Result<String, AppError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::bad_request(format!("{name} header is required")))
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn optional_u64(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("{name} is invalid")),
        Err(_) => Ok(default),
    }
}

fn lease_key(tenant_id: u64, panel_id: u64) -> String {
    format!("zboss:batch-delete:lease:tenant:{tenant_id}:panel:{panel_id}")
}

fn progress_key(tenant_id: u64, batch_id: &str) -> String {
    format!("zboss:batch-delete:progress:tenant:{tenant_id}:batch:{batch_id}")
}

fn hex_hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn decode_error(error: sqlx::Error) -> AppError {
    AppError::dependency(format!("decode compensation row: {error}"))
}

fn decode_nonnegative_u64(row: &MySqlRow, column: &str) -> Result<u64, AppError> {
    let value: i64 = row.try_get(column).map_err(decode_error)?;
    value.try_into().map_err(|_| {
        AppError::dependency(format!(
            "decode {column}: expected a non-negative BIGINT value"
        ))
    })
}

fn decode_nonnegative_u32(row: &MySqlRow, column: &str) -> Result<u32, AppError> {
    let value: i32 = row.try_get(column).map_err(decode_error)?;
    value.try_into().map_err(|_| {
        AppError::dependency(format!(
            "decode {column}: expected a non-negative INT value"
        ))
    })
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_config_rejects_unsafe_dynamic_table() {
        let config = ServiceConfig {
            mysql_url: "mysql://configured-at-runtime".into(),
            redis_url: "redis://localhost/".into(),
            bind_addr: "127.0.0.1:18088".parse().unwrap(),
            table_name: "cust_table9001;DROP TABLE x".into(),
            lease_ttl_millis: 30_000,
            worker_interval_millis: 100,
        };
        assert!(config.validate().unwrap_err().contains("cust_table"));
    }

    #[test]
    fn route_constant_is_the_source_compatible_endpoint() {
        assert_eq!(
            HTTP_PATH,
            "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchDelete"
        );
    }
}
