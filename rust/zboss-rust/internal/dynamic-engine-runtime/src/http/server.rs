use std::collections::BTreeMap;

use serde::de::DeserializeOwned;

use crate::{
    CONTRACT_VERSION, FIELD_DETAIL_ENTRYPOINT, FIELD_SCHEMA_DELETE_ENTRYPOINT,
    FIELD_SCHEMA_UPDATE_ENTRYPOINT, HORIZONTAL_LIST_ENTRYPOINT, INIT_ENTRYPOINT, PAGE_ENTRYPOINT,
    PROJECT_ID, QUERY_ENTRYPOINT,
    config::Config,
    domain::context::RequestContext,
    http::{
        dto::{
            FieldSchemaUpdateRequest, FieldSchemaUpdateResponse, HorizontalListRequest,
            HorizontalListResponse, InitRequest, InitResponse, MetadataQueryRequest,
            MetadataQueryResponse, PageRequest, PageResponse,
        },
        envelope::Envelope,
        handler::{
            FieldDeleteUseCase, FieldDetailUseCase, FieldSchemaUseCase, HorizontalListUseCase,
            InitUseCase, MetadataQueryUseCase, PageUseCase, handle_field_delete,
            handle_field_detail, handle_field_schema, handle_horizontal_list, handle_init,
            handle_metadata_query, handle_page,
        },
    },
    ports::field_catalog::FieldCatalogEntry,
    profile_ready,
};

pub fn route<U>(raw_request: &str, config: &Config, application: &U) -> (&'static str, String)
where
    U: PageUseCase
        + MetadataQueryUseCase
        + HorizontalListUseCase
        + InitUseCase
        + FieldSchemaUseCase
        + FieldDeleteUseCase
        + FieldDetailUseCase,
{
    let first_line = raw_request.lines().next().unwrap_or_default();
    let request_line = first_line.split_whitespace().collect::<Vec<_>>();
    let method = request_line.first().copied().unwrap_or_default();
    let target = request_line.get(1).copied().unwrap_or_default();
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    match (method, path) {
        ("GET", "/health") => (
            "200 OK",
            format!("{{\"status\":\"UP\",\"project\":\"{PROJECT_ID}\"}}"),
        ),
        ("GET", "/ready") => {
            let ready = profile_ready(config.profile);
            (
                if ready {
                    "200 OK"
                } else {
                    "503 Service Unavailable"
                },
                format!(
                    "{{\"ready\":{},\"profile\":\"{}\",\"contractVersion\":{}}}",
                    ready,
                    config.profile.as_str(),
                    CONTRACT_VERSION
                ),
            )
        }
        ("POST", path) if path == PAGE_ENTRYPOINT => route_page(raw_request, application),
        ("POST", path) if path == QUERY_ENTRYPOINT => {
            route_metadata_query(raw_request, application)
        }
        ("POST", path) if path == HORIZONTAL_LIST_ENTRYPOINT => {
            route_horizontal_list(raw_request, application)
        }
        ("POST", path) if path == INIT_ENTRYPOINT => route_init(raw_request, application),
        ("PUT", path) if path == FIELD_SCHEMA_UPDATE_ENTRYPOINT => {
            route_field_schema(raw_request, application)
        }
        ("DELETE", path) if path == FIELD_SCHEMA_DELETE_ENTRYPOINT => {
            route_field_delete(raw_request, target, application)
        }
        ("GET", path) if path == FIELD_DETAIL_ENTRYPOINT => {
            route_field_detail(raw_request, target, application)
        }
        _ => (
            "404 Not Found",
            "{\"code\":404001,\"msg\":\"not found\",\"data\":null}".to_owned(),
        ),
    }
}

fn route_field_detail<U: FieldDetailUseCase>(
    raw_request: &str,
    target: &str,
    application: &U,
) -> (&'static str, String) {
    let field_id = match parse_positive_query_id(target) {
        Ok(field_id) => field_id,
        Err(message) => {
            return (
                "400 Bad Request",
                serde_json::to_string(&Envelope::<Option<FieldCatalogEntry>>::failure(
                    400_001, message,
                ))
                .expect("error envelope serialization"),
            );
        }
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<Option<FieldCatalogEntry>>::failure(
                    403_001, message,
                ))
                .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_field_detail(application, &context, field_id);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("field detail envelope serialization"),
    )
}

fn route_field_delete<U: FieldDeleteUseCase>(
    raw_request: &str,
    target: &str,
    application: &U,
) -> (&'static str, String) {
    let field_id = match parse_positive_query_id(target) {
        Ok(field_id) => field_id,
        Err(message) => {
            return (
                "400 Bad Request",
                serde_json::to_string(&Envelope::<bool>::failure(400_001, message))
                    .expect("error envelope serialization"),
            );
        }
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<bool>::failure(403_001, message))
                    .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_field_delete(application, &context, field_id);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("field delete envelope serialization"),
    )
}

fn parse_positive_query_id(target: &str) -> Result<u64, &'static str> {
    let (_, query) = target
        .split_once('?')
        .ok_or("id query parameter is required")?;
    let mut id = None;
    for pair in query.split('&') {
        let (name, value) = pair
            .split_once('=')
            .ok_or("invalid field delete query parameter")?;
        if name != "id" || id.is_some() {
            return Err("only one id query parameter is allowed");
        }
        let parsed = value
            .parse::<u64>()
            .map_err(|_| "id must be a positive unsigned integer")?;
        if parsed == 0 {
            return Err("id must be positive");
        }
        id = Some(parsed);
    }
    id.ok_or("id query parameter is required")
}

fn route_field_schema<U: FieldSchemaUseCase>(
    raw_request: &str,
    application: &U,
) -> (&'static str, String) {
    let request = match parse_body::<FieldSchemaUpdateRequest>(raw_request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<FieldSchemaUpdateResponse>::failure(
                    403_001, message,
                ))
                .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_field_schema(application, &context, request);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("field schema envelope serialization"),
    )
}

fn route_init<U: InitUseCase>(raw_request: &str, application: &U) -> (&'static str, String) {
    let request = match parse_body::<InitRequest>(raw_request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<InitResponse>::failure(403_001, message))
                    .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_init(application, &context, request);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("init envelope serialization"),
    )
}

fn route_page<U: PageUseCase>(raw_request: &str, application: &U) -> (&'static str, String) {
    let request = match parse_body::<PageRequest>(raw_request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<PageResponse>::failure(403_001, message))
                    .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_page(application, &context, request);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("page envelope serialization"),
    )
}

fn route_metadata_query<U: MetadataQueryUseCase>(
    raw_request: &str,
    application: &U,
) -> (&'static str, String) {
    let request = match parse_body::<MetadataQueryRequest>(raw_request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<MetadataQueryResponse>::failure(
                    403_001, message,
                ))
                .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_metadata_query(application, &context, request);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("metadata envelope serialization"),
    )
}

fn route_horizontal_list<U: HorizontalListUseCase>(
    raw_request: &str,
    application: &U,
) -> (&'static str, String) {
    let request = match parse_body::<HorizontalListRequest>(raw_request) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let context = match request_context(raw_request) {
        Ok(context) => context,
        Err(message) => {
            return (
                "403 Forbidden",
                serde_json::to_string(&Envelope::<HorizontalListResponse>::failure(
                    403_001, message,
                ))
                .expect("error envelope serialization"),
            );
        }
    };
    let (status, envelope) = handle_horizontal_list(application, &context, request);
    (
        status_line(status),
        serde_json::to_string(&envelope).expect("horizontal envelope serialization"),
    )
}

fn parse_body<T: DeserializeOwned>(raw_request: &str) -> Result<T, (&'static str, String)> {
    raw_request
        .split_once("\r\n\r\n")
        .or_else(|| raw_request.split_once("\n\n"))
        .and_then(|(_, body)| serde_json::from_str::<T>(body.trim()).ok())
        .ok_or_else(|| {
            (
                "400 Bad Request",
                serde_json::to_string(&Envelope::<serde_json::Value>::failure(
                    400_001,
                    "invalid JSON request",
                ))
                .expect("error envelope serialization"),
            )
        })
}

fn request_context(raw_request: &str) -> Result<RequestContext, &'static str> {
    let headers = raw_request
        .lines()
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let required = |name: &str| {
        headers
            .get(name)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or("required request context header is missing")
    };
    Ok(RequestContext {
        tenant_id: headers
            .get("x-tenant-id")
            .or_else(|| headers.get("tenant-id"))
            .filter(|value| !value.is_empty())
            .ok_or("required request context header is missing")?
            .parse()
            .map_err(|_| "invalid tenant context")?,
        user_id: required("x-user-id")?
            .parse()
            .map_err(|_| "invalid user context")?,
        device_id: required("x-device-id")?,
        request_id: required("x-request-id")?,
        trace_id: required("x-trace-id")?,
        datasource: required("x-datasource")?,
        snapshot_id: required("x-snapshot-id")?,
    })
}

fn status_line(status: u16) -> &'static str {
    match status {
        200 => "200 OK",
        400 => "400 Bad Request",
        403 => "403 Forbidden",
        409 => "409 Conflict",
        503 => "503 Service Unavailable",
        _ => "500 Internal Server Error",
    }
}
