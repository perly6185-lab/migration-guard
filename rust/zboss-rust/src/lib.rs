use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::{Value, json};
use zboss_dynamic_engine::{
    application::data::delete::runtime::{EmbeddedRuntime, ReadinessProbe, ServiceConfig},
    config::{Config as DynamicEngineConfig, Profile as DynamicEngineProfile},
    runtime::RuntimeState as DynamicEngineRuntimeState,
};

pub mod data;
pub mod schema;

#[cfg(feature = "memory")]
use zboss_dynamic_engine::adapters::memory::MemoryAdapters;

pub const CAPABILITIES_PATH: &str = "/internal/capabilities";
pub const READINESS_PATH: &str = "/internal/ready";
const PROXY_SECRET_HEADER: &str = "x-zboss-proxy-secret";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BatchDeleteMode {
    Disabled,
    Production,
}

impl BatchDeleteMode {
    fn from_env() -> Result<Self, String> {
        match std::env::var("ZBOSS_UNIFIED_BATCH_DELETE_MODE")
            .unwrap_or_else(|_| "disabled".to_owned())
            .as_str()
        {
            "disabled" => Ok(Self::Disabled),
            "production" => Ok(Self::Production),
            value => Err(format!(
                "unsupported ZBOSS_UNIFIED_BATCH_DELETE_MODE: {value}"
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UnifiedConfig {
    pub bind: SocketAddr,
    pub dynamic_engine: DynamicEngineConfig,
    pub batch_delete_mode: BatchDeleteMode,
    pub proxy_shared_secret: Option<String>,
}

impl UnifiedConfig {
    pub fn from_env() -> Result<Self, String> {
        let bind = std::env::var("ZBOSS_UNIFIED_BIND")
            .unwrap_or_else(|_| "127.0.0.1:18080".to_owned())
            .parse()
            .map_err(|error| format!("invalid ZBOSS_UNIFIED_BIND: {error}"))?;
        let config = Self {
            bind,
            dynamic_engine: DynamicEngineConfig::from_env()?,
            batch_delete_mode: BatchDeleteMode::from_env()?,
            proxy_shared_secret: optional_secret("ZBOSS_UNIFIED_PROXY_SHARED_SECRET")?,
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        if !self.bind.ip().is_loopback() && self.proxy_shared_secret.is_none() {
            return Err(
                "non-loopback ZBOSS_UNIFIED_BIND requires ZBOSS_UNIFIED_PROXY_SHARED_SECRET"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

impl Default for UnifiedConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 18080),
            dynamic_engine: DynamicEngineConfig::default(),
            batch_delete_mode: BatchDeleteMode::Disabled,
            proxy_shared_secret: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityStatus {
    dynamic_engine: &'static str,
    batch_delete: &'static str,
    batch_update: &'static str,
    batch_update_contract_version: u32,
}

pub struct UnifiedRuntime {
    batch_delete: Option<EmbeddedRuntime>,
}

impl UnifiedRuntime {
    pub async fn shutdown(self) {
        if let Some(runtime) = self.batch_delete {
            runtime.shutdown().await;
        }
    }
}

pub async fn build(config: UnifiedConfig) -> Result<(Router, UnifiedRuntime), String> {
    config.validate()?;
    let proxy_shared_secret = config.proxy_shared_secret.clone();
    let dynamic_engine_profile = config.dynamic_engine.profile;
    let dynamic_engine_state = dynamic_engine_state(config.dynamic_engine)?;
    let mut app = zboss_dynamic_engine::runtime::router(dynamic_engine_state);

    let (delete_router, delete_runtime, delete_probe, delete_status) =
        match config.batch_delete_mode {
            BatchDeleteMode::Disabled => (
                unavailable_router(
                    zboss_dynamic_engine::application::data::delete::HTTP_PATH,
                    "batch-delete production runtime is disabled",
                ),
                None,
                None,
                "disabled",
            ),
            BatchDeleteMode::Production => {
                let runtime = zboss_dynamic_engine::application::data::delete::runtime::embedded(
                    ServiceConfig::from_env_embedded()?,
                )
                .await?;
                let probe = runtime.readiness_probe();
                let router = runtime.router();
                (router, Some(runtime), Some(probe), "production")
            }
        };
    app = app.merge(delete_router);

    // batch-update currently has verified domain and adapter contracts but no
    // concrete network persistence implementation. Registering the exact route
    // with a 503 keeps the combined process source-compatible and fail-closed.
    app = app.merge(unavailable_router(
        zboss_dynamic_engine::application::data::update::entrypoint::HTTP_PATH,
        "batch-update network persistence adapter is not implemented",
    ));

    let capability_status = Arc::new(CapabilityStatus {
        dynamic_engine: match dynamic_engine_profile {
            DynamicEngineProfile::Memory => "memory",
            DynamicEngineProfile::Production => "production",
        },
        batch_delete: delete_status,
        batch_update: "contract-only",
        batch_update_contract_version:
            zboss_dynamic_engine::application::data::update::CONTRACT_VERSION,
    });
    app = app.route(
        CAPABILITIES_PATH,
        get({
            let capability_status = Arc::clone(&capability_status);
            move || {
                let capability_status = Arc::clone(&capability_status);
                async move { Json(capability_status) }
            }
        }),
    );
    app = app.route(
        READINESS_PATH,
        get(move || {
            let delete_probe = delete_probe.clone();
            async move { unified_readiness(dynamic_engine_profile, delete_probe).await }
        }),
    );
    if let Some(secret) = proxy_shared_secret {
        app = app.layer(middleware::from_fn_with_state(
            Arc::<str>::from(secret),
            require_trusted_proxy,
        ));
    }

    Ok((
        app,
        UnifiedRuntime {
            batch_delete: delete_runtime,
        },
    ))
}

pub async fn serve(config: UnifiedConfig) -> Result<(), String> {
    let bind = config.bind;
    let (router, runtime) = build(config).await?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("bind unified HTTP listener: {error}"))?;
    println!(
        "zboss unified service listening={}",
        listener.local_addr().map_err(|error| error.to_string())?
    );
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("serve unified HTTP: {error}"));
    runtime.shutdown().await;
    result
}

async fn unified_readiness(
    dynamic_engine_profile: DynamicEngineProfile,
    delete_probe: Option<ReadinessProbe>,
) -> Response {
    let dynamic_engine_ready = zboss_dynamic_engine::profile_ready(dynamic_engine_profile);
    let delete_enabled = delete_probe.is_some();
    let delete_error = match delete_probe {
        Some(probe) => probe.check().await.err(),
        None => None,
    };
    let ready = dynamic_engine_ready && delete_error.is_none();
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({
            "ready": ready,
            "dynamicEngine": {
                "profile": match dynamic_engine_profile {
                    DynamicEngineProfile::Memory => "memory",
                    DynamicEngineProfile::Production => "production",
                },
                "ready": dynamic_engine_ready,
            },
            "batchDelete": {
                "enabled": delete_enabled,
                "ready": delete_error.is_none(),
                "error": delete_error,
            },
            "batchUpdate": {
                "mode": "contract-only",
                "requiredForReadiness": false,
            },
        })),
    )
        .into_response()
}

async fn require_trusted_proxy(
    State(secret): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Response {
    if is_probe_path(request.uri().path()) {
        return next.run(request).await;
    }
    let authorized = request
        .headers()
        .get(PROXY_SECRET_HEADER)
        .and_then(header_bytes)
        .is_some_and(|provided| constant_time_eq(provided, secret.as_bytes()));
    if authorized {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "code": -1,
                "data": Value::Null,
                "msg": "request did not originate from the trusted gateway",
            })),
        )
            .into_response()
    }
}

fn is_probe_path(path: &str) -> bool {
    matches!(
        path,
        "/health"
            | "/ready"
            | "/health/live"
            | "/health/ready"
            | CAPABILITIES_PATH
            | READINESS_PATH
    )
}

fn header_bytes(value: &HeaderValue) -> Option<&[u8]> {
    (!value.is_empty()).then(|| value.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn optional_secret(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) if value.trim().is_empty() => Err(format!("{name} must not be empty")),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    }
}

fn dynamic_engine_state(config: DynamicEngineConfig) -> Result<DynamicEngineRuntimeState, String> {
    match config.profile {
        DynamicEngineProfile::Memory => {
            #[cfg(feature = "memory")]
            {
                Ok(DynamicEngineRuntimeState::memory(
                    config,
                    Arc::new(MemoryAdapters::default()),
                ))
            }
            #[cfg(not(feature = "memory"))]
            {
                let _ = config;
                Err("page memory profile requires the unified memory feature".to_owned())
            }
        }
        DynamicEngineProfile::Production => {
            if !zboss_dynamic_engine::profile_ready(DynamicEngineProfile::Production) {
                return Err(
                    "dynamic-engine production profile requires the unified production feature and configured adapters"
                        .to_owned(),
                );
            }
            DynamicEngineRuntimeState::production(config)
        }
    }
}

fn unavailable_router(path: &'static str, reason: &'static str) -> Router {
    Router::new().route(
        path,
        post(move || async move {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "code": -1,
                    "data": Value::Null,
                    "msg": reason,
                })),
            )
        }),
    )
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
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    use super::*;

    #[test]
    fn business_facades_map_to_the_source_compatible_routes() {
        assert_eq!(data::page::HTTP_PATH, zboss_dynamic_engine::PAGE_ENTRYPOINT);
        assert_eq!(
            data::horizontal::HTTP_PATH,
            zboss_dynamic_engine::HORIZONTAL_LIST_ENTRYPOINT
        );
        assert_eq!(data::init::HTTP_PATH, zboss_dynamic_engine::INIT_ENTRYPOINT);
        assert_eq!(
            data::update::HTTP_PATH,
            zboss_dynamic_engine::application::data::update::entrypoint::HTTP_PATH
        );
        assert_eq!(
            data::delete::HTTP_PATH,
            zboss_dynamic_engine::application::data::delete::HTTP_PATH
        );
        assert_eq!(
            schema::query::HTTP_PATH,
            zboss_dynamic_engine::QUERY_ENTRYPOINT
        );
        assert_eq!(
            schema::get::HTTP_PATH,
            zboss_dynamic_engine::FIELD_DETAIL_ENTRYPOINT
        );
        assert_eq!(
            schema::update::HTTP_PATH,
            zboss_dynamic_engine::FIELD_SCHEMA_UPDATE_ENTRYPOINT
        );
        assert_eq!(
            schema::delete::HTTP_PATH,
            zboss_dynamic_engine::FIELD_SCHEMA_DELETE_ENTRYPOINT
        );
    }

    #[tokio::test]
    async fn unified_router_exposes_data_schema_and_capability_routes() {
        let (router, runtime) = build(UnifiedConfig::default()).await.unwrap();

        let page = router
            .clone()
            .oneshot(
                Request::post(zboss_dynamic_engine::PAGE_ENTRYPOINT)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(page.status(), StatusCode::NOT_FOUND);

        for path in [
            zboss_dynamic_engine::application::data::delete::HTTP_PATH,
            zboss_dynamic_engine::application::data::update::entrypoint::HTTP_PATH,
        ] {
            let response = router
                .clone()
                .oneshot(Request::post(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }

        let capabilities = router
            .oneshot(Request::get(CAPABILITIES_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(capabilities.status(), StatusCode::OK);
        let body = to_bytes(capabilities.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["dynamicEngine"], "memory");
        assert_eq!(value["batchDelete"], "disabled");
        assert_eq!(value["batchUpdate"], "contract-only");

        runtime.shutdown().await;
    }

    #[test]
    fn non_loopback_bind_requires_a_proxy_secret() {
        let config = UnifiedConfig {
            bind: "0.0.0.0:18080".parse().unwrap(),
            ..UnifiedConfig::default()
        };
        assert_eq!(
            config.validate().unwrap_err(),
            "non-loopback ZBOSS_UNIFIED_BIND requires ZBOSS_UNIFIED_PROXY_SHARED_SECRET"
        );
    }

    #[tokio::test]
    async fn proxy_secret_protects_business_routes_but_not_readiness() {
        let config = UnifiedConfig {
            proxy_shared_secret: Some("test-only-shared-secret".to_owned()),
            ..UnifiedConfig::default()
        };
        let (router, runtime) = build(config).await.unwrap();

        let rejected = router
            .clone()
            .oneshot(
                Request::post(zboss_dynamic_engine::PAGE_ENTRYPOINT)
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

        let accepted_by_proxy = router
            .clone()
            .oneshot(
                Request::post(zboss_dynamic_engine::PAGE_ENTRYPOINT)
                    .header(PROXY_SECRET_HEADER, "test-only-shared-secret")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(accepted_by_proxy.status(), StatusCode::UNAUTHORIZED);

        let readiness = router
            .oneshot(Request::get(READINESS_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(readiness.status(), StatusCode::OK);

        runtime.shutdown().await;
    }
}
