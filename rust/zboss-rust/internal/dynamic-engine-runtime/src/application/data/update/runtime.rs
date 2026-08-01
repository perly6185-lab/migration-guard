use std::{
    collections::BTreeMap,
    env,
    future::Future,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use redis::Script;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{MySql, MySqlPool, QueryBuilder, Row, Transaction, mysql::MySqlPoolOptions};
use tokio::{runtime::Handle, sync::watch, task::JoinHandle};

use super::{
    adapters::{
        mysql::{
            MysqlBatchAdapter, MysqlBatchExecutor, MysqlCommitResult, MysqlRowTransaction,
            MysqlTerminalIntent,
        },
        redis::{PROGRESS_SCRIPT, RedisBatchRefreshLeaseAdapter, RedisScriptExecutor},
    },
    batch::DEFAULT_ROW_LIMIT,
    coordination::{CoordinationKey, LeaseError, LeaseMode},
    entrypoint::HTTP_PATH,
    execution::{
        BatchCommand, BatchExecutionResult, CommitDisposition, ProgressJournal, RowCommand,
        TerminalStatus, all_rows_rejected_by_validation, execute_batch,
    },
};

const LIVE_PATH: &str = "/internal/batch-update/health/live";
const READY_PATH: &str = "/internal/batch-update/health/ready";
const L4C_READY_PATH: &str = "/internal/ready";
const PROGRESS_PATH: &str = "/internal/batch-update/progress/{batch_id}";
const WORKER_READINESS_FAILURE_THRESHOLD: u64 = 3;

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
        let bind_addr = required_env("ZBOSS_BATCH_UPDATE_BIND_ADDR")?
            .parse()
            .map_err(|_| "ZBOSS_BATCH_UPDATE_BIND_ADDR is invalid".to_owned())?;
        Self::from_env_with_bind(bind_addr)
    }

    pub fn from_env_embedded() -> Result<Self, String> {
        let bind_addr = match env::var("ZBOSS_BATCH_UPDATE_BIND_ADDR") {
            Ok(value) => value
                .parse()
                .map_err(|_| "ZBOSS_BATCH_UPDATE_BIND_ADDR is invalid".to_owned())?,
            Err(_) => "127.0.0.1:0"
                .parse()
                .expect("embedded batch-update fallback bind is valid"),
        };
        Self::from_env_with_bind(bind_addr)
    }

    fn from_env_with_bind(bind_addr: SocketAddr) -> Result<Self, String> {
        let config = Self {
            mysql_url: required_env("ZBOSS_BATCH_UPDATE_MYSQL_URL")?,
            redis_url: required_env("ZBOSS_BATCH_UPDATE_REDIS_URL")?,
            bind_addr,
            table_name: required_env("ZBOSS_BATCH_UPDATE_TABLE")?,
            lease_ttl_millis: optional_u64("ZBOSS_BATCH_UPDATE_LEASE_TTL_MS", 30_000)?,
            worker_interval_millis: optional_u64("ZBOSS_BATCH_UPDATE_WORKER_INTERVAL_MS", 100)?,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.mysql_url.starts_with("mysql://") {
            return Err("batch-update MySQL URL must use mysql://".to_owned());
        }
        if !self.redis_url.starts_with("redis://") {
            return Err("batch-update Redis URL must use redis://".to_owned());
        }
        if !is_safe_dynamic_table(&self.table_name) {
            return Err("ZBOSS_BATCH_UPDATE_TABLE must match cust_table<digits>".to_owned());
        }
        if self.lease_ttl_millis < 1_000 || self.worker_interval_millis == 0 {
            return Err("batch-update lease and worker intervals are invalid".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone)]
struct AppState {
    pool: MySqlPool,
    redis: redis::Client,
    config: Arc<ServiceConfig>,
    worker_failures: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct ReadinessProbe {
    state: AppState,
}

impl ReadinessProbe {
    pub async fn check(&self) -> Result<(), String> {
        readiness(&self.state).await.map_err(|error| error.message)
    }
}

pub struct EmbeddedRuntime {
    router: Router,
    state: AppState,
    shutdown_tx: watch::Sender<bool>,
    worker: JoinHandle<()>,
}

impl EmbeddedRuntime {
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn unified_router(&self) -> Router {
        router_with_internal_readiness(self.state.clone(), false)
    }

    pub fn readiness_probe(&self) -> ReadinessProbe {
        ReadinessProbe {
            state: self.state.clone(),
        }
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.worker.await;
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum IdInput {
    Text(String),
    Number(u64),
}

impl IdInput {
    fn parse(&self, name: &'static str) -> Result<u64, AppError> {
        let value = match self {
            Self::Text(value) => value
                .parse()
                .map_err(|_| AppError::bad_request(format!("{name} is invalid")))?,
            Self::Number(value) => *value,
        };
        if value == 0 {
            return Err(AppError::bad_request(format!("{name} must be positive")));
        }
        Ok(value)
    }

    fn text(&self) -> String {
        match self {
            Self::Text(value) => value.clone(),
            Self::Number(value) => value.to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchRowInput {
    #[serde(default)]
    id: Option<IdInput>,
    #[serde(default)]
    values: BTreeMap<String, Value>,
    #[serde(default)]
    horizontal_values: BTreeMap<String, BTreeMap<String, Value>>,
    #[serde(default)]
    validation_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpBatchUpdateRequest {
    inter_id: IdInput,
    http_id: IdInput,
    use_page_id: IdInput,
    panel_id: IdInput,
    #[serde(default)]
    batch_post_value_list: Vec<BatchRowInput>,
    #[serde(default)]
    batch_header_value_list: Vec<Value>,
    client_session_id: String,
    #[serde(default)]
    chunk_no: u32,
    #[serde(default)]
    is_last_chunk: bool,
    #[serde(default)]
    batch_id: Option<String>,
}

#[derive(Clone, Debug)]
struct RequestContext {
    tenant_id: u64,
    request_id: String,
}

#[derive(Clone, Debug)]
struct RuntimeCommand {
    context: RequestContext,
    panel_id: u64,
    session_id: String,
    chunk_no: u32,
    final_chunk: bool,
    idempotency_key: String,
    request_hash: String,
    batch_id: String,
    command: BatchCommand,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBatchUpdateResponse {
    pub request_id: String,
    pub batch_id: String,
    pub client_session_id: String,
    pub chunk_no: u32,
    pub committed_rows: Vec<usize>,
    pub replayed_rows: Vec<usize>,
    pub failed_rows: Vec<usize>,
    pub status: String,
    pub replayed: bool,
    pub final_chunk: bool,
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

/// Concrete production MySQL executor. Every row mutation, commit marker,
/// undo record and downstream intent is committed in one sqlx transaction.
pub struct SqlxMysqlBatchExecutor {
    pool: MySqlPool,
    table_name: String,
    request_hash: String,
    runtime: Handle,
}

impl SqlxMysqlBatchExecutor {
    fn new(pool: MySqlPool, table_name: String, request_hash: String, runtime: Handle) -> Self {
        Self {
            pool,
            table_name,
            request_hash,
            runtime,
        }
    }

    fn wait<T>(&self, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        self.runtime.block_on(future)
    }
}

impl MysqlBatchExecutor for SqlxMysqlBatchExecutor {
    fn commit_row_atomically(
        &mut self,
        request: &MysqlRowTransaction,
    ) -> Result<MysqlCommitResult, String> {
        let pool = self.pool.clone();
        let table_name = self.table_name.clone();
        let request_hash = self.request_hash.clone();
        self.wait(
            async move { commit_row_atomically(&pool, &table_name, &request_hash, request).await },
        )
    }

    fn persist_terminal_idempotently(
        &mut self,
        request: &MysqlTerminalIntent,
    ) -> Result<(), String> {
        let pool = self.pool.clone();
        self.wait(async move { persist_terminal_idempotently(&pool, request).await })
    }
}

/// Concrete production Redis executor backed by the async Redis client. It is
/// driven from a blocking task when used through the synchronous domain port.
pub struct AsyncRedisScriptExecutor {
    client: redis::Client,
    runtime: Handle,
}

impl AsyncRedisScriptExecutor {
    fn new(client: redis::Client, runtime: Handle) -> Self {
        Self { client, runtime }
    }
}

impl RedisScriptExecutor for AsyncRedisScriptExecutor {
    fn eval(&mut self, script: &str, key: &str, arguments: &[String]) -> Result<String, String> {
        let client = self.client.clone();
        let script = script.to_owned();
        let key = key.to_owned();
        let arguments = arguments.to_vec();
        self.runtime.block_on(async move {
            let mut connection = client
                .get_multiplexed_async_connection()
                .await
                .map_err(|error| format!("connect Redis: {error}"))?;
            let script = Script::new(&script);
            let mut invocation = script.prepare_invoke();
            invocation.key(key);
            for argument in arguments {
                invocation.arg(argument);
            }
            invocation
                .invoke_async(&mut connection)
                .await
                .map_err(|error| format!("execute Redis script: {error}"))
        })
    }
}

pub async fn run_from_env() -> Result<(), String> {
    run(ServiceConfig::from_env()?).await
}

pub async fn run(config: ServiceConfig) -> Result<(), String> {
    let bind_addr = config.bind_addr;
    let runtime = embedded(config).await?;
    let router = runtime.router();
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|error| format!("bind batch-update HTTP listener: {error}"))?;
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("serve batch-update HTTP: {error}"));
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
        .map_err(|error| format!("connect batch-update MySQL: {error}"))?;
    let redis = redis::Client::open(config.redis_url.clone())
        .map_err(|error| format!("configure batch-update Redis: {error}"))?;
    let state = AppState {
        pool,
        redis,
        config: Arc::new(config),
        worker_failures: Arc::new(AtomicU64::new(0)),
    };
    readiness(&state)
        .await
        .map_err(|error| error.message.clone())?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        outbox_worker(worker_state, shutdown_rx).await;
    });
    Ok(EmbeddedRuntime {
        router: router(state.clone()),
        state,
        shutdown_tx,
        worker,
    })
}

fn router(state: AppState) -> Router {
    router_with_internal_readiness(state, true)
}

fn router_with_internal_readiness(state: AppState, include_internal_readiness: bool) -> Router {
    let router = Router::new()
        .route(HTTP_PATH, post(batch_update))
        .route(LIVE_PATH, get(live))
        .route(READY_PATH, get(ready))
        .route(PROGRESS_PATH, get(progress_status));
    let router = if include_internal_readiness {
        router.route(L4C_READY_PATH, get(l4c_ready))
    } else {
        router
    };
    router.with_state(state)
}

async fn live() -> Json<Value> {
    Json(json!({ "status": "UP" }))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    readiness(&state).await?;
    Ok(Json(json!({ "status": "UP" })))
}

async fn l4c_ready(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    readiness(&state).await?;
    Ok(Json(json!({ "status": "ready" })))
}

async fn readiness(state: &AppState) -> Result<(), AppError> {
    let failures = state.worker_failures.load(Ordering::Relaxed);
    if failures >= WORKER_READINESS_FAILURE_THRESHOLD {
        return Err(AppError::dependency(format!(
            "batch-update outbox worker has failed {failures} consecutive polls"
        )));
    }
    sqlx::query("SELECT 1 FROM batch_idempotency LIMIT 0")
        .execute(&state.pool)
        .await
        .map_err(|error| AppError::dependency(format!("MySQL protocol not ready: {error}")))?;
    let table_probe = format!("SELECT 1 FROM `{}` LIMIT 0", state.config.table_name);
    sqlx::query(&table_probe)
        .execute(&state.pool)
        .await
        .map_err(|error| AppError::dependency(format!("MySQL target table not ready: {error}")))?;
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

async fn batch_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<HttpBatchUpdateRequest>,
) -> Result<Json<CommonResult<HttpBatchUpdateResponse>>, AppError> {
    let command = build_command(&headers, &request)?;
    if all_rows_rejected_by_validation(&command.command) {
        return Ok(Json(CommonResult {
            code: 0,
            data: response_from_validation_rejection(&command),
            msg: String::new(),
        }));
    }
    if let Some(response) = load_replay(&state, &command).await? {
        return Ok(Json(CommonResult {
            code: 0,
            data: response,
            msg: String::new(),
        }));
    }
    validate_chunk_order(&state, &command).await?;
    register_request(&state, &command).await?;

    let coordination_key = CoordinationKey {
        tenant_id: command.context.tenant_id,
        panel_id: command.panel_id,
    };
    let owner_token = format!("{}:{}", command.batch_id, command.context.request_id);
    lease_operation(
        &state,
        coordination_key.clone(),
        owner_token.clone(),
        LeaseOperation::Acquire,
    )
    .await?;
    let (stop_tx, stop_rx) = watch::channel(false);
    let renewal = spawn_lease_renewal(
        state.clone(),
        coordination_key.clone(),
        owner_token.clone(),
        stop_rx,
    );

    let result = execute_registered_request(&state, &command).await;
    let _ = stop_tx.send(true);
    let _ = renewal.await;
    let release = lease_operation(
        &state,
        coordination_key,
        owner_token,
        LeaseOperation::Release,
    )
    .await;
    match (result, release) {
        (Ok(response), Ok(())) => Ok(Json(CommonResult {
            code: 0,
            data: response,
            msg: String::new(),
        })),
        (Err(error), _) => {
            let _ = publish_terminal_progress(&state, &command, TerminalStatus::Failed, 0).await;
            Err(error)
        }
        (Ok(_), Err(error)) => Err(error),
    }
}

fn response_from_validation_rejection(command: &RuntimeCommand) -> HttpBatchUpdateResponse {
    HttpBatchUpdateResponse {
        request_id: command.context.request_id.clone(),
        batch_id: command.batch_id.clone(),
        client_session_id: command.session_id.clone(),
        chunk_no: command.chunk_no,
        committed_rows: Vec::new(),
        replayed_rows: Vec::new(),
        failed_rows: command
            .command
            .validation_failures
            .keys()
            .copied()
            .collect(),
        status: TerminalStatus::Success.as_str().to_owned(),
        replayed: false,
        final_chunk: command.final_chunk,
    }
}

async fn execute_registered_request(
    state: &AppState,
    command: &RuntimeCommand,
) -> Result<HttpBatchUpdateResponse, AppError> {
    publish_running_progress(state, command).await?;
    let pool = state.pool.clone();
    let table_name = state.config.table_name.clone();
    let request_hash = command.request_hash.clone();
    let batch_command = command.command.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let executor =
            SqlxMysqlBatchExecutor::new(pool, table_name, request_hash, Handle::current());
        let mut adapter = MysqlBatchAdapter::new(executor);
        let mut progress = ProgressJournal::default();
        execute_batch(&batch_command, &mut adapter, &mut progress)
    })
    .await
    .map_err(|error| AppError::dependency(format!("join batch-update executor: {error}")))?
    .map_err(|error| AppError::dependency(format!("execute batch-update: {error:?}")))?;

    let mut response = response_from_execution(command, &execution);
    persist_response(state, command, &response).await?;
    publish_terminal_progress(state, command, execution.status, execution.committed.len()).await?;
    response.replayed = false;
    Ok(response)
}

fn response_from_execution(
    command: &RuntimeCommand,
    execution: &BatchExecutionResult,
) -> HttpBatchUpdateResponse {
    HttpBatchUpdateResponse {
        request_id: command.context.request_id.clone(),
        batch_id: command.batch_id.clone(),
        client_session_id: command.session_id.clone(),
        chunk_no: command.chunk_no,
        committed_rows: execution.committed.clone(),
        replayed_rows: execution.replayed.clone(),
        failed_rows: execution
            .failures
            .iter()
            .map(|failure| failure.index)
            .collect(),
        status: execution.status.as_str().to_owned(),
        replayed: false,
        final_chunk: command.final_chunk,
    }
}

fn build_command(
    headers: &HeaderMap,
    request: &HttpBatchUpdateRequest,
) -> Result<RuntimeCommand, AppError> {
    request.inter_id.parse("interId")?;
    request.http_id.parse("httpId")?;
    request.use_page_id.parse("usePageId")?;
    let panel_id = request.panel_id.parse("panelId")?;
    if request.batch_post_value_list.len() > DEFAULT_ROW_LIMIT {
        return Err(AppError::bad_request(format!(
            "batchPostValueList exceeds {DEFAULT_ROW_LIMIT} rows"
        )));
    }
    if !request.batch_header_value_list.is_empty() {
        return Err(AppError::bad_request(
            "batchHeaderValueList is not supported",
        ));
    }
    validate_token("clientSessionId", &request.client_session_id, 80)?;
    let tenant_id = required_header_u64(headers, "x-tenant-id")?;
    let actor_id = required_header_u64(headers, "x-user-id")?;
    let request_id = required_header(headers, "x-request-id", 128)?;
    let datasource = required_header(headers, "x-datasource", 128)?;
    let batch_id = request
        .batch_id
        .clone()
        .unwrap_or_else(|| format!("batch-{tenant_id}-{}", request.client_session_id));
    validate_token("batchId", &batch_id, 128)?;
    let request_hash = stable_hash(request)?;
    let idempotency_key = format!("{}:{}", request.client_session_id, request.chunk_no);
    validate_token("idempotencyKey", &idempotency_key, 128)?;

    let mut validation_failures = BTreeMap::new();
    let rows = request
        .batch_post_value_list
        .iter()
        .enumerate()
        .map(|(index, row)| {
            if let Some(message) = row.validation_error.as_deref() {
                validation_failures.insert(index, truncate(message, 512));
            }
            RowCommand {
                index,
                primary_key: row.id.as_ref().map(IdInput::text),
                values: row
                    .values
                    .iter()
                    .map(|(key, value)| (key.clone(), value_text(value)))
                    .collect(),
                horizontal_values: row
                    .horizontal_values
                    .iter()
                    .map(|(group, values)| {
                        (
                            group.clone(),
                            values
                                .iter()
                                .map(|(key, value)| (key.clone(), value_text(value)))
                                .collect(),
                        )
                    })
                    .collect(),
            }
        })
        .collect();
    let context = RequestContext {
        tenant_id,
        request_id: request_id.clone(),
    };
    Ok(RuntimeCommand {
        context: context.clone(),
        panel_id,
        session_id: request.client_session_id.clone(),
        chunk_no: request.chunk_no,
        final_chunk: request.is_last_chunk,
        idempotency_key,
        request_hash,
        batch_id: batch_id.clone(),
        command: BatchCommand {
            context: super::execution::ExecutionContext {
                tenant_id,
                panel_id,
                datasource,
                actor_id,
                trace_id: request_id,
            },
            batch_id,
            rows,
            header_row_count: 0,
            validation_failures,
            dependency_failure: None,
        },
    })
}

async fn load_replay(
    state: &AppState,
    command: &RuntimeCommand,
) -> Result<Option<HttpBatchUpdateResponse>, AppError> {
    let row = sqlx::query(
        "SELECT request_hash,response_json FROM batch_idempotency \
         WHERE tenant_id=? AND panel_id=? AND idempotency_key=?",
    )
    .bind(command.context.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("load batch replay: {error}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let existing_hash: String = row
        .try_get("request_hash")
        .map_err(|error| AppError::dependency(format!("decode replay hash: {error}")))?;
    if existing_hash != command.request_hash {
        return Err(AppError::conflict(
            "IDEMPOTENCY_CONFLICT",
            "client session chunk is bound to a different request hash",
        ));
    }
    let response: Option<Value> = row
        .try_get("response_json")
        .map_err(|error| AppError::dependency(format!("decode replay response: {error}")))?;
    response
        .map(|value| {
            let mut response: HttpBatchUpdateResponse = serde_json::from_value(value)
                .map_err(|error| AppError::dependency(format!("parse replay response: {error}")))?;
            response.replayed = true;
            Ok(response)
        })
        .transpose()
}

async fn validate_chunk_order(state: &AppState, command: &RuntimeCommand) -> Result<(), AppError> {
    if command.chunk_no == 0 {
        return Ok(());
    }
    let previous: Option<String> = sqlx::query_scalar(
        "SELECT state FROM batch_idempotency \
         WHERE tenant_id=? AND session_id=? AND chunk_no=?",
    )
    .bind(command.context.tenant_id)
    .bind(&command.session_id)
    .bind(command.chunk_no - 1)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("check previous chunk: {error}")))?;
    if previous.as_deref() != Some("SUCCEEDED") {
        return Err(AppError::conflict(
            "OUT_OF_ORDER_CHUNK",
            "previous chunk has not completed",
        ));
    }
    Ok(())
}

async fn register_request(state: &AppState, command: &RuntimeCommand) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO batch_idempotency \
         (tenant_id,panel_id,session_id,chunk_no,idempotency_key,request_hash,batch_id,final_chunk,state) \
         VALUES (?,?,?,?,?,?,?,?,'STARTED') \
         ON DUPLICATE KEY UPDATE updated_at=CURRENT_TIMESTAMP(6)",
    )
    .bind(command.context.tenant_id)
    .bind(command.panel_id)
    .bind(&command.session_id)
    .bind(command.chunk_no)
    .bind(&command.idempotency_key)
    .bind(&command.request_hash)
    .bind(&command.batch_id)
    .bind(command.final_chunk)
    .execute(&state.pool)
    .await
    .map_err(|error| AppError::conflict("IDEMPOTENCY_RACE", error.to_string()))?;
    Ok(())
}

async fn persist_response(
    state: &AppState,
    command: &RuntimeCommand,
    response: &HttpBatchUpdateResponse,
) -> Result<(), AppError> {
    let value = serde_json::to_value(response)
        .map_err(|error| AppError::dependency(format!("encode response: {error}")))?;
    sqlx::query(
        "UPDATE batch_idempotency SET state='SUCCEEDED',response_json=? \
         WHERE tenant_id=? AND panel_id=? AND idempotency_key=? AND request_hash=?",
    )
    .bind(value)
    .bind(command.context.tenant_id)
    .bind(command.panel_id)
    .bind(&command.idempotency_key)
    .bind(&command.request_hash)
    .execute(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("persist batch response: {error}")))?;
    Ok(())
}

async fn commit_row_atomically(
    pool: &MySqlPool,
    table_name: &str,
    request_hash: &str,
    request: &MysqlRowTransaction,
) -> Result<MysqlCommitResult, String> {
    if let Some(result) = load_commit(pool, request_hash, request).await? {
        return Ok(result);
    }
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin row transaction: {error}"))?;
    let primary_key = request
        .row
        .primary_key
        .clone()
        .unwrap_or_else(|| format!("{}-{}", request.batch_id, request.row.index));
    let before = load_projection(
        &mut transaction,
        table_name,
        request.context.tenant_id,
        request.context.panel_id,
        &primary_key,
    )
    .await?;
    let values = json!({
        "values": request.row.values,
        "horizontalValues": request.row.horizontal_values,
        "actorId": request.context.actor_id,
        "traceId": request.context.trace_id,
        "datasource": request.context.datasource,
    });
    upsert_projection(
        &mut transaction,
        table_name,
        request.context.tenant_id,
        request.context.panel_id,
        &primary_key,
        &values,
    )
    .await?;
    sqlx::query(
        "INSERT INTO batch_row_commit \
         (tenant_id,batch_id,row_index,request_hash,primary_key_value) VALUES (?,?,?,?,?)",
    )
    .bind(request.context.tenant_id)
    .bind(&request.batch_id)
    .bind(request.row.index as u32)
    .bind(request_hash)
    .bind(&primary_key)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("insert row commit marker: {error}"))?;
    sqlx::query(
        "INSERT INTO batch_undo_journal \
         (tenant_id,batch_id,row_index,primary_key_value,before_value) VALUES (?,?,?,?,?)",
    )
    .bind(request.context.tenant_id)
    .bind(&request.batch_id)
    .bind(request.row.index as u32)
    .bind(&primary_key)
    .bind(before.unwrap_or(Value::Null))
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("insert undo journal: {error}"))?;
    for kind in ["undo", "downstream"] {
        let dedupe_key = format!("{}:{kind}:{}", request.batch_id, request.row.index);
        sqlx::query(
            "INSERT INTO batch_outbox \
             (tenant_id,batch_id,event_kind,dedupe_key,payload) VALUES (?,?,?,?,?)",
        )
        .bind(request.context.tenant_id)
        .bind(&request.batch_id)
        .bind(kind)
        .bind(dedupe_key)
        .bind(json!({
            "panelId": request.context.panel_id,
            "rowIndex": request.row.index,
            "primaryKey": primary_key,
        }))
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("insert {kind} outbox: {error}"))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit row transaction: {error}"))?;
    Ok(MysqlCommitResult {
        disposition: CommitDisposition::Applied,
        primary_key,
    })
}

async fn load_commit(
    pool: &MySqlPool,
    request_hash: &str,
    request: &MysqlRowTransaction,
) -> Result<Option<MysqlCommitResult>, String> {
    let row = sqlx::query(
        "SELECT request_hash,primary_key_value FROM batch_row_commit \
         WHERE tenant_id=? AND batch_id=? AND row_index=?",
    )
    .bind(request.context.tenant_id)
    .bind(&request.batch_id)
    .bind(request.row.index as u32)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("load row commit marker: {error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let stored_hash: String = row
        .try_get("request_hash")
        .map_err(|error| format!("decode row request hash: {error}"))?;
    if stored_hash != request_hash {
        return Err("row commit marker request hash conflict".to_owned());
    }
    let primary_key = row
        .try_get("primary_key_value")
        .map_err(|error| format!("decode row primary key: {error}"))?;
    Ok(Some(MysqlCommitResult {
        disposition: CommitDisposition::Replayed,
        primary_key,
    }))
}

async fn load_projection(
    transaction: &mut Transaction<'_, MySql>,
    table_name: &str,
    tenant_id: u64,
    panel_id: u64,
    primary_key: &str,
) -> Result<Option<Value>, String> {
    let mut query = QueryBuilder::<MySql>::new(format!(
        "SELECT values_json FROM `{table_name}` WHERE tenant_id="
    ));
    query
        .push_bind(tenant_id)
        .push(" AND panel_id=")
        .push_bind(panel_id)
        .push(" AND primary_key_value=")
        .push_bind(primary_key)
        .push(" FOR UPDATE");
    query
        .build()
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| format!("load row projection: {error}"))?
        .map(|row| {
            row.try_get("values_json")
                .map_err(|error| format!("decode row projection: {error}"))
        })
        .transpose()
}

async fn upsert_projection(
    transaction: &mut Transaction<'_, MySql>,
    table_name: &str,
    tenant_id: u64,
    panel_id: u64,
    primary_key: &str,
    values: &Value,
) -> Result<(), String> {
    let mut query = QueryBuilder::<MySql>::new(format!(
        "INSERT INTO `{table_name}` \
         (tenant_id,panel_id,primary_key_value,values_json) VALUES ("
    ));
    query
        .push_bind(tenant_id)
        .push(",")
        .push_bind(panel_id)
        .push(",")
        .push_bind(primary_key)
        .push(",")
        .push_bind(values)
        .push(") ON DUPLICATE KEY UPDATE values_json=VALUES(values_json)");
    query
        .build()
        .execute(&mut **transaction)
        .await
        .map_err(|error| format!("upsert row projection: {error}"))?;
    Ok(())
}

async fn persist_terminal_idempotently(
    pool: &MySqlPool,
    request: &MysqlTerminalIntent,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO batch_outbox \
         (tenant_id,batch_id,event_kind,dedupe_key,payload) VALUES (?,?,?,?,?) \
         ON DUPLICATE KEY UPDATE dedupe_key=VALUES(dedupe_key)",
    )
    .bind(request.context.tenant_id)
    .bind(&request.batch_id)
    .bind(format!("terminal:{}", request.status.as_str()))
    .bind(&request.dedupe_key)
    .bind(json!({
        "panelId": request.context.panel_id,
        "status": request.status.as_str(),
        "traceId": request.context.trace_id,
    }))
    .execute(pool)
    .await
    .map_err(|error| format!("persist terminal outbox: {error}"))?;
    Ok(())
}

#[derive(Clone, Copy)]
enum LeaseOperation {
    Acquire,
    Renew,
    Release,
}

async fn lease_operation(
    state: &AppState,
    key: CoordinationKey,
    owner_token: String,
    operation: LeaseOperation,
) -> Result<(), AppError> {
    let client = state.redis.clone();
    let ttl = state.config.lease_ttl_millis;
    tokio::task::spawn_blocking(move || {
        let runtime = Handle::current();
        let executor = AsyncRedisScriptExecutor::new(client, runtime);
        let mut adapter = RedisBatchRefreshLeaseAdapter::new(executor);
        let now = unix_millis();
        match operation {
            LeaseOperation::Acquire => {
                adapter.acquire(&key, &owner_token, LeaseMode::BatchShared, now, ttl)
            }
            LeaseOperation::Renew => {
                adapter.renew(&key, &owner_token, LeaseMode::BatchShared, now, ttl)
            }
            LeaseOperation::Release => adapter.release(&key, &owner_token, LeaseMode::BatchShared),
        }
    })
    .await
    .map_err(|error| AppError::dependency(format!("join Redis lease operation: {error}")))?
    .map_err(map_lease_error)
}

fn spawn_lease_renewal(
    state: AppState,
    key: CoordinationKey,
    owner_token: String,
    mut stop: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let interval = Duration::from_millis((state.config.lease_ttl_millis / 3).max(250));
        loop {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {
                    if lease_operation(
                        &state,
                        key.clone(),
                        owner_token.clone(),
                        LeaseOperation::Renew,
                    ).await.is_err() {
                        break;
                    }
                }
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
            }
        }
    })
}

fn map_lease_error(error: LeaseError) -> AppError {
    match error {
        LeaseError::Busy | LeaseError::OwnerConflict => {
            AppError::conflict("BATCH_REFRESH_CONFLICT", "tenant-panel resource is busy")
        }
        LeaseError::InvalidClaim => AppError::bad_request("invalid lease claim"),
        LeaseError::OwnerMissing | LeaseError::Backend => {
            AppError::dependency(format!("Redis lease operation failed: {error:?}"))
        }
    }
}

async fn publish_running_progress(
    state: &AppState,
    command: &RuntimeCommand,
) -> Result<(), AppError> {
    publish_progress(
        state,
        command,
        1,
        "RUNNING",
        0,
        0,
        command.command.rows.len(),
    )
    .await
}

async fn publish_terminal_progress(
    state: &AppState,
    command: &RuntimeCommand,
    status: TerminalStatus,
    committed: usize,
) -> Result<(), AppError> {
    let total = command.command.rows.len();
    publish_progress(
        state,
        command,
        2,
        status.as_str(),
        committed,
        total.saturating_sub(committed),
        total,
    )
    .await
}

async fn publish_progress(
    state: &AppState,
    command: &RuntimeCommand,
    sequence: u32,
    status: &str,
    committed: usize,
    failed: usize,
    total: usize,
) -> Result<(), AppError> {
    let key = progress_key(command.context.tenant_id, &command.batch_id);
    let event_hash = stable_hash(&json!({
        "sequence": sequence,
        "status": status,
        "committed": committed,
        "failed": failed,
        "total": total,
    }))?;
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect progress Redis: {error}")))?;
    let response: String = Script::new(PROGRESS_SCRIPT)
        .key(key)
        .arg(sequence)
        .arg(status)
        .arg(event_hash)
        .arg(total)
        .arg(committed)
        .arg(failed)
        .invoke_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("publish progress: {error}")))?;
    if matches!(response.as_str(), "STORED" | "REPLAYED" | "TERMINAL") {
        Ok(())
    } else {
        Err(AppError::conflict(
            "PROGRESS_CONFLICT",
            format!("progress script rejected event: {response}"),
        ))
    }
}

async fn progress_status(
    State(state): State<AppState>,
    Path(batch_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    validate_token("batchId", &batch_id, 128)?;
    let tenant_id = required_header_u64(&headers, "x-tenant-id")?;
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect progress Redis: {error}")))?;
    let values: BTreeMap<String, String> = redis::cmd("HGETALL")
        .arg(progress_key(tenant_id, &batch_id))
        .query_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("load progress: {error}")))?;
    Ok(Json(json!({
        "batchId": batch_id,
        "progress": values,
    })))
}

async fn outbox_worker(state: AppState, mut shutdown: watch::Receiver<bool>) {
    let interval = Duration::from_millis(state.config.worker_interval_millis);
    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {
                match dispatch_outbox_batch(&state.pool).await {
                    Ok(_) => state.worker_failures.store(0, Ordering::Relaxed),
                    Err(error) => {
                        let failures = state.worker_failures.fetch_add(1, Ordering::Relaxed) + 1;
                        eprintln!("batch-update outbox worker failure={failures}: {error}");
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

async fn dispatch_outbox_batch(pool: &MySqlPool) -> Result<u64, String> {
    let result = sqlx::query(
        "UPDATE batch_outbox SET state='DELIVERED',attempts=attempts+1 \
         WHERE state='PENDING' ORDER BY id LIMIT 100",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("dispatch durable outbox batch: {error}"))?;
    Ok(result.rows_affected())
}

fn progress_key(tenant_id: u64, batch_id: &str) -> String {
    format!("zboss:batch-progress:tenant:{tenant_id}:batch:{batch_id}")
}

fn is_safe_dynamic_table(value: &str) -> bool {
    value
        .strip_prefix("cust_table")
        .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()))
}

fn required_header(
    headers: &HeaderMap,
    name: &'static str,
    max_len: usize,
) -> Result<String, AppError> {
    let value = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::bad_request(format!("missing {name} header")))?
        .to_owned();
    validate_token(name, &value, max_len)?;
    Ok(value)
}

fn required_header_u64(headers: &HeaderMap, name: &'static str) -> Result<u64, AppError> {
    let value = required_header(headers, name, 32)?;
    let value = value
        .parse()
        .map_err(|_| AppError::bad_request(format!("{name} must be a positive integer")))?;
    if value == 0 {
        return Err(AppError::bad_request(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(value)
}

fn validate_token(name: &'static str, value: &str, max_len: usize) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > max_len
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(AppError::bad_request(format!("{name} is invalid")));
    }
    Ok(())
}

fn stable_hash(value: &impl Serialize) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| AppError::bad_request(format!("request is not serializable: {error}")))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn truncate(value: &str, max_len: usize) -> String {
    value.chars().take(max_len).collect()
}

fn required_env(name: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Err(format!("{name} must not be empty")),
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Err(format!("{name} is required")),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    }
}

fn optional_u64(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("{name} must be an unsigned integer")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> HttpBatchUpdateRequest {
        HttpBatchUpdateRequest {
            inter_id: IdInput::Number(1),
            http_id: IdInput::Number(2),
            use_page_id: IdInput::Number(3),
            panel_id: IdInput::Number(4),
            batch_post_value_list: vec![BatchRowInput {
                id: Some(IdInput::Number(10)),
                values: BTreeMap::from([("name".to_owned(), json!("alpha"))]),
                horizontal_values: BTreeMap::new(),
                validation_error: None,
            }],
            batch_header_value_list: Vec::new(),
            client_session_id: "session-1".to_owned(),
            chunk_no: 0,
            is_last_chunk: true,
            batch_id: None,
        }
    }

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tenant-id", "1".parse().unwrap());
        headers.insert("x-user-id", "2".parse().unwrap());
        headers.insert("x-request-id", "request-1".parse().unwrap());
        headers.insert("x-datasource", "primary".parse().unwrap());
        headers
    }

    #[test]
    fn service_config_rejects_unsafe_dynamic_table() {
        let config = ServiceConfig {
            mysql_url: "mysql://localhost/test".to_owned(),
            redis_url: "redis://localhost/".to_owned(),
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            table_name: "cust_table1;drop".to_owned(),
            lease_ttl_millis: 30_000,
            worker_interval_millis: 100,
        };
        assert!(config.validate().unwrap_err().contains("cust_table"));
    }

    #[test]
    fn command_requires_context_and_preserves_row_index() {
        let command = build_command(&headers(), &request()).unwrap();
        assert_eq!(command.context.tenant_id, 1);
        assert_eq!(command.command.context.actor_id, 2);
        assert_eq!(command.panel_id, 4);
        assert_eq!(command.command.rows[0].index, 0);
        assert_eq!(command.command.rows[0].primary_key.as_deref(), Some("10"));
    }

    #[test]
    fn command_rejects_header_rows_before_side_effects() {
        let mut request = request();
        request.batch_header_value_list.push(json!({"id": 1}));
        assert!(
            build_command(&headers(), &request)
                .unwrap_err()
                .message
                .contains("batchHeaderValueList")
        );
    }

    #[test]
    fn validation_only_rejection_returns_success_without_execution() {
        let mut request = request();
        request.batch_post_value_list[0].validation_error = Some("type mismatch".to_owned());
        let command = build_command(&headers(), &request).unwrap();

        assert!(all_rows_rejected_by_validation(&command.command));
        let response = response_from_validation_rejection(&command);
        assert_eq!(response.status, TerminalStatus::Success.as_str());
        assert_eq!(response.failed_rows, [0]);
        assert!(response.committed_rows.is_empty());
        assert!(response.replayed_rows.is_empty());
        assert!(!response.replayed);
    }
}
