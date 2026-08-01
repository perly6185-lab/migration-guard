use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use redis::Script;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row, mysql::MySqlPoolOptions};
use std::{
    env,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

use super::adapters::redis::{ACQUIRE_SCRIPT, RELEASE_SCRIPT, RENEW_SCRIPT};

pub const SCHEMA_TRANSITION_PATH: &str = "/internal/schema-transition";
pub const SCHEMA_READINESS_PATH: &str = "/health/ready";

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub mysql_url: String,
    pub redis_url: String,
    pub bind_addr: SocketAddr,
    pub lease_ttl_millis: u64,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, String> {
        let config = Self {
            mysql_url: required_env("ZBOSS_SCHEMA_TRANSITION_MYSQL_URL")?,
            redis_url: required_env("ZBOSS_SCHEMA_TRANSITION_REDIS_URL")?,
            bind_addr: required_env("ZBOSS_SCHEMA_TRANSITION_BIND_ADDR")?
                .parse()
                .map_err(|_| "ZBOSS_SCHEMA_TRANSITION_BIND_ADDR is invalid".to_owned())?,
            lease_ttl_millis: optional_u64("ZBOSS_SCHEMA_TRANSITION_LEASE_TTL_MS", 30_000)?,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.mysql_url.starts_with("mysql://") {
            return Err("schema-transition MySQL URL must use mysql://".to_owned());
        }
        if !self.redis_url.starts_with("redis://") {
            return Err("schema-transition Redis URL must use redis://".to_owned());
        }
        if self.lease_ttl_millis < 1_000 {
            return Err("schema-transition lease TTL must be at least 1000ms".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone)]
struct AppState {
    pool: MySqlPool,
    redis: redis::Client,
    config: Arc<ServiceConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchemaChangeInput {
    CreateTable {
        table: String,
    },
    AddColumn {
        table: String,
        column: String,
        column_type: ColumnTypeInput,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColumnTypeInput {
    BigInt,
    Varchar { length: u16 },
    Decimal { precision: u8, scale: u8 },
    DateTime,
    Text,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTransitionHttpRequest {
    pub tenant_id: u64,
    pub panel_id: u64,
    pub operation_id: String,
    pub request_hash: String,
    pub owner_token: String,
    pub change: SchemaChangeInput,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTransitionHttpResponse {
    pub outcome: String,
    pub attempt: u32,
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
    config.validate()?;
    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .map_err(|error| format!("bind schema-transition listener: {error}"))?;
    let app = build_router(config).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("serve schema-transition HTTP: {error}"))
}

async fn build_router(config: ServiceConfig) -> Result<Router, String> {
    let pool = MySqlPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.mysql_url)
        .await
        .map_err(|error| format!("connect schema-transition MySQL: {error}"))?;
    let redis = redis::Client::open(config.redis_url.clone())
        .map_err(|error| format!("configure schema-transition Redis: {error}"))?;
    let state = AppState {
        pool,
        redis,
        config: Arc::new(config),
    };
    readiness(&state)
        .await
        .map_err(|error| error.message.clone())?;
    Ok(Router::new()
        .route(SCHEMA_TRANSITION_PATH, post(transition))
        .route(SCHEMA_READINESS_PATH, get(ready))
        .with_state(state))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    readiness(&state).await?;
    Ok(Json(json!({ "status": "UP" })))
}

async fn readiness(state: &AppState) -> Result<(), AppError> {
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

async fn transition(
    State(state): State<AppState>,
    Json(request): Json<SchemaTransitionHttpRequest>,
) -> Result<Json<CommonResult<SchemaTransitionHttpResponse>>, AppError> {
    validate_request(&request)?;
    let lease_key = format!(
        "zboss:schema-transition:tenant:{}:panel:{}",
        request.tenant_id, request.panel_id
    );
    acquire_lease(&state, &lease_key, &request.owner_token).await?;

    let result = execute_transition(&state, &request, &lease_key).await;
    let release = release_lease(&state, &lease_key, &request.owner_token).await;
    match (result, release) {
        (Ok(response), Ok(())) => Ok(Json(CommonResult {
            code: 0,
            data: response,
            msg: String::new(),
        })),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn execute_transition(
    state: &AppState,
    request: &SchemaTransitionHttpRequest,
    lease_key: &str,
) -> Result<SchemaTransitionHttpResponse, AppError> {
    let previous = sqlx::query(
        "SELECT request_hash, attempt, state FROM schema_transition_ledger \
         WHERE tenant_id=? AND panel_id=? AND operation_id=?",
    )
    .bind(request.tenant_id)
    .bind(request.panel_id)
    .bind(&request.operation_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("load transition ledger: {error}")))?;

    let mut resumed = false;
    let attempt = if let Some(row) = previous {
        let stored_hash: String = row
            .try_get("request_hash")
            .map_err(|error| AppError::dependency(format!("decode transition hash: {error}")))?;
        if stored_hash != request.request_hash {
            return Err(AppError::conflict(
                "SCHEMA_IDEMPOTENCY_CONFLICT",
                "schema operation id is bound to a different request hash",
            ));
        }
        let stored_attempt = decode_u32(&row, "attempt")?;
        let stored_state: String = row
            .try_get("state")
            .map_err(|error| AppError::dependency(format!("decode transition state: {error}")))?;
        if stored_state == "SUCCEEDED" {
            return Ok(SchemaTransitionHttpResponse {
                outcome: "REPLAYED".to_owned(),
                attempt: stored_attempt,
            });
        }
        resumed = true;
        stored_attempt.saturating_add(1)
    } else {
        1
    };

    sqlx::query(
        "INSERT INTO schema_transition_ledger \
         (tenant_id,panel_id,operation_id,request_hash,attempt,state,error_message) \
         VALUES (?,?,?,?,?,'STARTED',NULL) \
         ON DUPLICATE KEY UPDATE attempt=VALUES(attempt), state='STARTED', \
           error_message=NULL",
    )
    .bind(request.tenant_id)
    .bind(request.panel_id)
    .bind(&request.operation_id)
    .bind(&request.request_hash)
    .bind(attempt)
    .execute(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("record transition start: {error}")))?;

    let renewal_failed = Arc::new(AtomicBool::new(false));
    let (stop_tx, stop_rx) = watch::channel(false);
    let renewal = spawn_renewal(
        state.clone(),
        lease_key.to_owned(),
        request.owner_token.clone(),
        Arc::clone(&renewal_failed),
        stop_rx,
    );
    let ddl_result = execute_ddl(&state.pool, &request.change).await;
    let _ = stop_tx.send(true);
    let _ = renewal.await;
    if renewal_failed.load(Ordering::Relaxed) {
        return Err(AppError::dependency(
            "schema-transition lease renewal failed during DDL",
        ));
    }

    if let Err(message) = ddl_result {
        sqlx::query(
            "UPDATE schema_transition_ledger SET state='FAILED', error_message=? \
             WHERE tenant_id=? AND panel_id=? AND operation_id=? AND attempt=?",
        )
        .bind(truncate_message(&message))
        .bind(request.tenant_id)
        .bind(request.panel_id)
        .bind(&request.operation_id)
        .bind(attempt)
        .execute(&state.pool)
        .await
        .map_err(|error| {
            AppError::dependency(format!(
                "DDL failed ({message}); recording failure also failed: {error}"
            ))
        })?;
        return Err(AppError::dependency(format!(
            "structured DDL failed: {message}"
        )));
    }

    let affected = sqlx::query(
        "UPDATE schema_transition_ledger SET state='SUCCEEDED', error_message=NULL \
         WHERE tenant_id=? AND panel_id=? AND operation_id=? AND attempt=?",
    )
    .bind(request.tenant_id)
    .bind(request.panel_id)
    .bind(&request.operation_id)
    .bind(attempt)
    .execute(&state.pool)
    .await
    .map_err(|error| AppError::dependency(format!("record transition success: {error}")))?
    .rows_affected();
    if affected != 1 {
        return Err(AppError::dependency(
            "schema transition completed without durable success ownership",
        ));
    }
    Ok(SchemaTransitionHttpResponse {
        outcome: if resumed { "RESUMED" } else { "APPLIED" }.to_owned(),
        attempt,
    })
}

fn spawn_renewal(
    state: AppState,
    lease_key: String,
    owner_token: String,
    failed: Arc<AtomicBool>,
    mut stop: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let interval = Duration::from_millis((state.config.lease_ttl_millis / 3).max(100));
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                () = tokio::time::sleep(interval) => {
                    if renew_lease(&state, &lease_key, &owner_token).await.is_err() {
                        failed.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
        }
    })
}

async fn acquire_lease(state: &AppState, key: &str, owner_token: &str) -> Result<(), AppError> {
    let now = unix_millis();
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect Redis lease: {error}")))?;
    let response: String = Script::new(ACQUIRE_SCRIPT)
        .key(key)
        .arg("refresh")
        .arg(owner_token)
        .arg(now)
        .arg(now.saturating_add(state.config.lease_ttl_millis))
        .invoke_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("acquire schema lease: {error}")))?;
    match response.as_str() {
        "ACQUIRED" => Ok(()),
        "BUSY" | "OWNER_CONFLICT" => Err(AppError::conflict(
            "SCHEMA_TRANSITION_BUSY",
            "schema transition lease is busy",
        )),
        _ => Err(AppError::dependency(format!(
            "unexpected schema lease response: {response}"
        ))),
    }
}

async fn renew_lease(state: &AppState, key: &str, owner_token: &str) -> Result<(), AppError> {
    let now = unix_millis();
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect Redis renewal: {error}")))?;
    let response: String = Script::new(RENEW_SCRIPT)
        .key(key)
        .arg("refresh")
        .arg(owner_token)
        .arg(now)
        .arg(now.saturating_add(state.config.lease_ttl_millis))
        .invoke_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("renew schema lease: {error}")))?;
    if response == "RENEWED" {
        Ok(())
    } else {
        Err(AppError::dependency(format!(
            "schema lease renewal rejected: {response}"
        )))
    }
}

async fn release_lease(state: &AppState, key: &str, owner_token: &str) -> Result<(), AppError> {
    let mut connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|error| AppError::dependency(format!("connect Redis release: {error}")))?;
    let response: String = Script::new(RELEASE_SCRIPT)
        .key(key)
        .arg("refresh")
        .arg(owner_token)
        .invoke_async(&mut connection)
        .await
        .map_err(|error| AppError::dependency(format!("release schema lease: {error}")))?;
    if matches!(response.as_str(), "RELEASED" | "OWNER_MISSING") {
        Ok(())
    } else {
        Err(AppError::dependency(format!(
            "schema lease release rejected: {response}"
        )))
    }
}

async fn execute_ddl(pool: &MySqlPool, change: &SchemaChangeInput) -> Result<(), String> {
    let statement = match change {
        SchemaChangeInput::CreateTable { table } => {
            format!("CREATE TABLE IF NOT EXISTS `{table}` (id BIGINT NOT NULL PRIMARY KEY)")
        }
        SchemaChangeInput::AddColumn {
            table,
            column,
            column_type,
        } => format!(
            "ALTER TABLE `{table}` ADD COLUMN `{column}` {} NULL",
            column_sql(column_type)
        ),
    };
    sqlx::query(&statement)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn column_sql(column_type: &ColumnTypeInput) -> String {
    match column_type {
        ColumnTypeInput::BigInt => "BIGINT".to_owned(),
        ColumnTypeInput::Varchar { length } => format!("VARCHAR({length})"),
        ColumnTypeInput::Decimal { precision, scale } => {
            format!("DECIMAL({precision},{scale})")
        }
        ColumnTypeInput::DateTime => "DATETIME(6)".to_owned(),
        ColumnTypeInput::Text => "TEXT".to_owned(),
    }
}

fn validate_request(request: &SchemaTransitionHttpRequest) -> Result<(), AppError> {
    if request.tenant_id == 0 || request.panel_id == 0 {
        return Err(AppError::bad_request(
            "tenantId and panelId must be non-zero",
        ));
    }
    if !safe_identifier(&request.operation_id) {
        return Err(AppError::bad_request("operationId is unsafe"));
    }
    if request.request_hash.len() != 64
        || !request
            .request_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::bad_request("requestHash must be SHA-256 hex"));
    }
    if request.owner_token.trim().is_empty() || request.owner_token.len() > 128 {
        return Err(AppError::bad_request("ownerToken is invalid"));
    }
    match &request.change {
        SchemaChangeInput::CreateTable { table } => validate_identifier(table)?,
        SchemaChangeInput::AddColumn {
            table,
            column,
            column_type,
        } => {
            validate_identifier(table)?;
            validate_identifier(column)?;
            match column_type {
                ColumnTypeInput::Varchar { length } if *length == 0 => {
                    return Err(AppError::bad_request("varchar length must be positive"));
                }
                ColumnTypeInput::Decimal { precision, scale }
                    if *precision == 0 || *scale > *precision =>
                {
                    return Err(AppError::bad_request(
                        "decimal precision and scale are invalid",
                    ));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), AppError> {
    if safe_identifier(value) {
        Ok(())
    } else {
        Err(AppError::bad_request("schema identifier is unsafe"))
    }
}

fn safe_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 64
        && (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn decode_u32(row: &sqlx::mysql::MySqlRow, field: &str) -> Result<u32, AppError> {
    let value: i64 = row
        .try_get(field)
        .map_err(|error| AppError::dependency(format!("decode {field}: {error}")))?;
    u32::try_from(value).map_err(|_| AppError::dependency(format!("{field} is out of range")))
}

fn truncate_message(value: &str) -> String {
    value.chars().take(1_000).collect()
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .map_err(|_| format!("{name} is required"))
        .and_then(|value| {
            if value.trim().is_empty() {
                Err(format!("{name} must not be empty"))
            } else {
                Ok(value)
            }
        })
}

fn optional_u64(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("{name} must be a positive integer")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    }
}

fn unix_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
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

    #[test]
    fn schema_request_rejects_identifier_and_type_injection() {
        let mut request = SchemaTransitionHttpRequest {
            tenant_id: 1,
            panel_id: 2,
            operation_id: "add_status".to_owned(),
            request_hash: "a".repeat(64),
            owner_token: "owner".to_owned(),
            change: SchemaChangeInput::AddColumn {
                table: "cust_table9001".to_owned(),
                column: "status".to_owned(),
                column_type: ColumnTypeInput::Varchar { length: 32 },
            },
        };
        assert!(validate_request(&request).is_ok());
        request.operation_id = "bad;drop".to_owned();
        assert_eq!(
            validate_request(&request).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        request.operation_id = "add_status".to_owned();
        request.change = SchemaChangeInput::AddColumn {
            table: "cust_table9001".to_owned(),
            column: "status".to_owned(),
            column_type: ColumnTypeInput::Decimal {
                precision: 2,
                scale: 3,
            },
        };
        assert_eq!(
            validate_request(&request).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn service_config_fails_closed() {
        let config = ServiceConfig {
            mysql_url: "postgres://invalid".to_owned(),
            redis_url: "redis://127.0.0.1/".to_owned(),
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            lease_ttl_millis: 30_000,
        };
        assert!(config.validate().unwrap_err().contains("mysql://"));
    }
}
