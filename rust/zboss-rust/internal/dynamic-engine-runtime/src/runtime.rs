use std::net::SocketAddr;

#[cfg(feature = "memory")]
use std::sync::Arc;

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{RawQuery, State},
    http::{HeaderMap, Response, StatusCode, header},
    routing::{delete, get, post, put},
};

use crate::{
    CONTRACT_VERSION, FIELD_DETAIL_ENTRYPOINT, FIELD_SCHEMA_DELETE_ENTRYPOINT,
    FIELD_SCHEMA_UPDATE_ENTRYPOINT, HORIZONTAL_LIST_ENTRYPOINT, INIT_ENTRYPOINT, PAGE_ENTRYPOINT,
    QUERY_ENTRYPOINT,
    config::{Config, Profile},
    http::server,
};

#[cfg(feature = "memory")]
use crate::{adapters::memory::MemoryAdapters, application::data::page::DynamicEngineApplication};
#[cfg(all(feature = "mysql", feature = "redis"))]
use crate::{
    adapters::production::ProductionAdapters,
    application::data::page::DynamicEngineApplication as ProductionDynamicEngineApplication,
};
#[cfg(not(all(feature = "mysql", feature = "redis")))]
use crate::{
    domain::context::RequestContext,
    http::{
        dto::{
            FieldSchemaUpdateRequest, FieldSchemaUpdateResponse, HorizontalListRequest,
            HorizontalListResponse, InitRequest, InitResponse, MetadataQueryRequest,
            MetadataQueryResponse, PageRequest, PageResponse,
        },
        error::ApiError,
        handler::{
            FieldDeleteUseCase, FieldDetailUseCase, FieldSchemaUseCase, HorizontalListUseCase,
            InitUseCase, MetadataQueryUseCase, PageUseCase,
        },
    },
    ports::field_catalog::FieldCatalogEntry,
};

#[derive(Clone)]
pub struct RuntimeState {
    config: Config,
    application: RuntimeApplication,
}

#[derive(Clone)]
enum RuntimeApplication {
    #[cfg(feature = "memory")]
    Memory(DynamicEngineApplication<MemoryAdapters>),
    #[cfg(all(feature = "mysql", feature = "redis"))]
    Production(ProductionDynamicEngineApplication<ProductionAdapters>),
    #[cfg(not(all(feature = "mysql", feature = "redis")))]
    ProductionUnavailable(ProductionUnavailable),
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
#[derive(Debug, Clone, Copy)]
struct ProductionUnavailable;

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl PageUseCase for ProductionUnavailable {
    fn execute(
        &self,
        _context: &RequestContext,
        _request: PageRequest,
    ) -> Result<PageResponse, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl MetadataQueryUseCase for ProductionUnavailable {
    fn query_metadata(
        &self,
        _context: &RequestContext,
        _request: MetadataQueryRequest,
    ) -> Result<MetadataQueryResponse, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl HorizontalListUseCase for ProductionUnavailable {
    fn list_horizontal(
        &self,
        _context: &RequestContext,
        _request: HorizontalListRequest,
    ) -> Result<HorizontalListResponse, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl InitUseCase for ProductionUnavailable {
    fn init(
        &self,
        _context: &RequestContext,
        _request: InitRequest,
    ) -> Result<InitResponse, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl FieldSchemaUseCase for ProductionUnavailable {
    fn update_field_schema(
        &self,
        _context: &RequestContext,
        _request: FieldSchemaUpdateRequest,
    ) -> Result<FieldSchemaUpdateResponse, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl FieldDeleteUseCase for ProductionUnavailable {
    fn delete_field(&self, _context: &RequestContext, _field_id: u64) -> Result<bool, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
impl FieldDetailUseCase for ProductionUnavailable {
    fn get_field(
        &self,
        _context: &RequestContext,
        _field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError> {
        Err(production_unavailable())
    }
}

#[cfg(not(all(feature = "mysql", feature = "redis")))]
fn production_unavailable() -> ApiError {
    ApiError::query(
        "production adapters are not fully configured; request rejected",
        true,
    )
}

impl RuntimeState {
    #[cfg(feature = "memory")]
    pub fn memory(config: Config, adapters: Arc<MemoryAdapters>) -> Self {
        assert_eq!(config.profile, Profile::Memory);
        Self {
            config,
            application: RuntimeApplication::Memory(DynamicEngineApplication::new(adapters)),
        }
    }

    pub fn production(config: Config) -> Result<Self, String> {
        assert_eq!(config.profile, Profile::Production);
        #[cfg(all(feature = "mysql", feature = "redis"))]
        {
            let adapters = ProductionAdapters::from_env()?;
            Ok(Self {
                config,
                application: RuntimeApplication::Production(
                    ProductionDynamicEngineApplication::new(adapters),
                ),
            })
        }
        #[cfg(not(all(feature = "mysql", feature = "redis")))]
        {
            Ok(Self {
                config,
                application: RuntimeApplication::ProductionUnavailable(ProductionUnavailable),
            })
        }
    }
}

pub fn router(state: RuntimeState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route(PAGE_ENTRYPOINT, post(page))
        .route(QUERY_ENTRYPOINT, post(metadata_query))
        .route(HORIZONTAL_LIST_ENTRYPOINT, post(horizontal_list))
        .route(INIT_ENTRYPOINT, post(init))
        .route(FIELD_SCHEMA_UPDATE_ENTRYPOINT, put(field_schema_update))
        .route(FIELD_SCHEMA_DELETE_ENTRYPOINT, delete(field_schema_delete))
        .route(FIELD_DETAIL_ENTRYPOINT, get(field_detail))
        .with_state(state)
}

pub async fn serve(
    bind: SocketAddr,
    state: RuntimeState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    println!(
        "zboss-dynamic-engine listening={} profile={} contract={}",
        listener.local_addr()?,
        state.config.profile.as_str(),
        CONTRACT_VERSION
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn health(State(state): State<RuntimeState>) -> Response<Body> {
    dispatch(state, HeaderMap::new(), Bytes::new(), "GET", "/health").await
}

async fn ready(State(state): State<RuntimeState>) -> Response<Body> {
    dispatch(state, HeaderMap::new(), Bytes::new(), "GET", "/ready").await
}

async fn page(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    dispatch(state, headers, body, "POST", PAGE_ENTRYPOINT).await
}

async fn metadata_query(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    dispatch(state, headers, body, "POST", QUERY_ENTRYPOINT).await
}

async fn horizontal_list(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    dispatch(state, headers, body, "POST", HORIZONTAL_LIST_ENTRYPOINT).await
}

async fn init(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    dispatch(state, headers, body, "POST", INIT_ENTRYPOINT).await
}

async fn field_schema_update(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    dispatch(state, headers, body, "PUT", FIELD_SCHEMA_UPDATE_ENTRYPOINT).await
}

async fn field_schema_delete(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response<Body> {
    let target = query.map_or_else(
        || FIELD_SCHEMA_DELETE_ENTRYPOINT.to_owned(),
        |query| format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?{query}"),
    );
    dispatch(state, headers, Bytes::new(), "DELETE", target).await
}

async fn field_detail(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response<Body> {
    let target = query.map_or_else(
        || FIELD_DETAIL_ENTRYPOINT.to_owned(),
        |query| format!("{FIELD_DETAIL_ENTRYPOINT}?{query}"),
    );
    dispatch(state, headers, Bytes::new(), "GET", target).await
}

async fn dispatch<P>(
    state: RuntimeState,
    headers: HeaderMap,
    body: Bytes,
    method: &'static str,
    path: P,
) -> Response<Body>
where
    P: Into<String>,
{
    let path = path.into();
    let raw_request = raw_request(method, &path, &headers, &body);
    let result = tokio::task::spawn_blocking(move || match &state.application {
        #[cfg(feature = "memory")]
        RuntimeApplication::Memory(application) => {
            server::route(&raw_request, &state.config, application)
        }
        #[cfg(all(feature = "mysql", feature = "redis"))]
        RuntimeApplication::Production(application) => {
            server::route(&raw_request, &state.config, application)
        }
        #[cfg(not(all(feature = "mysql", feature = "redis")))]
        RuntimeApplication::ProductionUnavailable(application) => {
            server::route(&raw_request, &state.config, application)
        }
    })
    .await;
    match result {
        Ok((status, body)) => json_response(status_code(status), body),
        Err(error) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{{\"code\":500001,\"msg\":\"request worker failed: {error}\",\"data\":null}}"),
        ),
    }
}

fn raw_request(method: &str, path: &str, headers: &HeaderMap, body: &[u8]) -> String {
    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    for (name, value) in headers {
        if let Ok(value) = value.to_str() {
            request.push_str(name.as_str());
            request.push_str(": ");
            request.push_str(value);
            request.push_str("\r\n");
        }
    }
    request.push_str("\r\n");
    request.push_str(&String::from_utf8_lossy(body));
    request
}

fn status_code(status: &str) -> StatusCode {
    status
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .and_then(|value| StatusCode::from_u16(value).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn json_response(status: StatusCode, body: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("valid HTTP response")
}

async fn shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        eprintln!("failed to install Ctrl+C shutdown signal");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_large_numeric_headers_and_json_body() {
        let headers = HeaderMap::from_iter([
            (
                "x-tenant-id".parse().unwrap(),
                "9007199254740993".parse().unwrap(),
            ),
            (
                "x-request-id".parse().unwrap(),
                "request-1".parse().unwrap(),
            ),
        ]);
        let body = br#"{"usePageId":"2059838047023181826"}"#;

        let raw = raw_request("POST", PAGE_ENTRYPOINT, &headers, body);

        assert!(raw.contains("x-tenant-id: 9007199254740993"));
        assert!(raw.ends_with(r#"{"usePageId":"2059838047023181826"}"#));
    }

    #[test]
    fn maps_internal_status_lines_to_http_status_codes() {
        assert_eq!(status_code("200 OK"), StatusCode::OK);
        assert_eq!(
            status_code("503 Service Unavailable"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(status_code("invalid"), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[cfg(not(all(feature = "mysql", feature = "redis")))]
    #[test]
    fn production_runtime_rejects_business_requests_when_adapters_are_unavailable() {
        let config = Config {
            profile: Profile::Production,
            ..Config::default()
        };
        let state = RuntimeState::production(config.clone()).unwrap();
        let raw = format!(
            "POST {QUERY_ENTRYPOINT} HTTP/1.1\r\n\
             X-Tenant-Id: 1\r\n\
             X-User-Id: 2\r\n\
             X-Device-Id: device\r\n\
             X-Request-Id: request\r\n\
             X-Trace-Id: trace\r\n\
             X-Datasource: primary\r\n\
             X-Snapshot-Id: snapshot\r\n\r\n\
             {{\"usePageId\":\"1\",\"viewId\":\"2\"}}"
        );

        let response = server::route(
            &raw,
            &config,
            match &state.application {
                RuntimeApplication::ProductionUnavailable(application) => application,
                #[cfg(feature = "memory")]
                RuntimeApplication::Memory(_) => unreachable!(),
            },
        );

        assert_eq!(response.0, "503 Service Unavailable");
        assert!(
            response
                .1
                .contains("production adapters are not fully configured")
        );
    }
}
