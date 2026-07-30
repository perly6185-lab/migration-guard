use std::{collections::BTreeMap, sync::Arc};

use serde_json::Value as JsonValue;
use zboss_dynamic_engine::{
    FIELD_DETAIL_ENTRYPOINT, FIELD_SCHEMA_DELETE_ENTRYPOINT, FIELD_SCHEMA_UPDATE_ENTRYPOINT,
    HORIZONTAL_LIST_ENTRYPOINT, INIT_ENTRYPOINT, PAGE_ENTRYPOINT, QUERY_ENTRYPOINT,
    adapters::memory::MemoryAdapters,
    application::data::page::PageApplication,
    config::Config,
    domain::{
        context::RequestContext,
        model::{FieldMetadata, PageMetadata, Row, Value, ViewMetadata},
    },
    http::{
        dto::{
            FieldSchemaUpdateRequest, HorizontalListRequest, InitRequest, MetadataQueryRequest,
            PageRequest,
        },
        server::route,
    },
    ports::field_schema::FieldSchemaCommit,
};

const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;
const VIEW_ID: u64 = 2_064_662_147_688_243_201;
const PANEL_ID: u64 = 2_059_838_046_666_665_986;
const PAGE_ID: u64 = 2_059_838_046_687_637_506;
const INTER_ID: u64 = 2_059_838_045_928_468_482;
const HTTP_ID: u64 = 2_059_838_047_035_764_738;
const HORIZONTAL_ID: u64 = 2_069_983_536_167_243_777;

fn context() -> RequestContext {
    RequestContext {
        tenant_id: 1,
        user_id: 2,
        device_id: "device".to_owned(),
        request_id: "calendar-request".to_owned(),
        trace_id: "calendar-trace".to_owned(),
        datasource: "primary".to_owned(),
        snapshot_id: "snapshot".to_owned(),
    }
}

fn raw(path: &str, body: &str) -> String {
    raw_method("POST", path, body)
}

fn raw_method(method: &str, path: &str, body: &str) -> String {
    raw_method_request_id(method, path, body, "calendar-request")
}

fn raw_method_request_id(method: &str, path: &str, body: &str, request_id: &str) -> String {
    format!(
        "{method} {path} HTTP/1.1\r\n\
         Tenant-Id: 1\r\n\
         X-User-Id: 2\r\n\
         X-Device-Id: device\r\n\
         X-Request-Id: {request_id}\r\n\
         X-Trace-Id: calendar-trace\r\n\
         X-Datasource: primary\r\n\
         X-Snapshot-Id: snapshot\r\n\r\n{body}"
    )
}

fn application() -> (Arc<MemoryAdapters>, PageApplication<MemoryAdapters>) {
    let ports = Arc::new(MemoryAdapters::default());
    ports.insert_metadata(
        &context(),
        PageMetadata {
            version: 1,
            page_id: USE_PAGE_ID,
            panel_id: PANEL_ID,
            table: "calendar_records".to_owned(),
            business_key: vec!["custField59622".to_owned()],
            fields: vec![
                FieldMetadata {
                    key: "custField59622".to_owned(),
                    column: "custField59622".to_owned(),
                    aggregate: None,
                },
                FieldMetadata {
                    key: "custField59623".to_owned(),
                    column: "custField59623".to_owned(),
                    aggregate: None,
                },
            ],
        },
    );
    ports.insert_view_metadata(
        &context(),
        ViewMetadata {
            use_page_id: USE_PAGE_ID,
            view_id: VIEW_ID,
            page_id: PAGE_ID,
            panel_id: PANEL_ID,
            inter_id: INTER_ID,
            http_id: HTTP_ID,
            view_type: "calendar".to_owned(),
            panel_resp_keys: vec!["calendar_records".to_owned()],
            data: BTreeMap::from([
                (
                    "panelId".to_owned(),
                    JsonValue::String(PANEL_ID.to_string()),
                ),
                (
                    "interId".to_owned(),
                    JsonValue::String(INTER_ID.to_string()),
                ),
                ("httpId".to_owned(), JsonValue::String(HTTP_ID.to_string())),
            ]),
        },
    );
    ports.insert_rows(
        &context(),
        "calendar_records",
        vec![Row::from([
            (
                "custField59622".to_owned(),
                Value::Text("event-1".to_owned()),
            ),
            (
                "custField59623".to_owned(),
                Value::Text("2026-07-30T09:00:00+08:00".to_owned()),
            ),
        ])],
    );
    ports.insert_horizontal_rows(
        &context(),
        HORIZONTAL_ID,
        vec![
            Row::from([
                ("custField59623".to_owned(), Value::Text("B".to_owned())),
                ("custField60040_0".to_owned(), Value::Integer(2)),
                (
                    "custField60040_0|custField59627".to_owned(),
                    Value::Text("B-2".to_owned()),
                ),
            ]),
            Row::from([
                ("custField59623".to_owned(), Value::Text("A".to_owned())),
                ("custField60040_0".to_owned(), Value::Integer(1)),
                (
                    "custField60040_0|custField59627".to_owned(),
                    Value::Text("A-1".to_owned()),
                ),
            ]),
        ],
    );
    let application = PageApplication::new(Arc::clone(&ports));
    (ports, application)
}

#[test]
fn supplied_requests_deserialize_without_precision_loss() {
    let query: MetadataQueryRequest =
        serde_json::from_str(include_str!("../contracts/calendar-query-request.json")).unwrap();
    assert_eq!(query.use_page_id, Some(USE_PAGE_ID));
    assert_eq!(query.view_id, Some(VIEW_ID));

    let ledger_fields: MetadataQueryRequest = serde_json::from_str(include_str!(
        "../contracts/ledger-fields-query-request.json"
    ))
    .unwrap();
    assert_eq!(ledger_fields.use_page_id, Some(USE_PAGE_ID));
    assert_eq!(ledger_fields.view_id, None);
    assert_eq!(ledger_fields.validate(), Ok(()));

    let field_detail: JsonValue =
        serde_json::from_str(include_str!("../contracts/field-detail-query.json")).unwrap();
    assert_eq!(field_detail["id"], "2064558100025122818");

    let page: PageRequest =
        serde_json::from_str(include_str!("../contracts/calendar-page-request.json")).unwrap();
    assert_eq!(page.page_size, Some(10_000));
    assert_eq!(page.use_page_id, Some(USE_PAGE_ID));
    assert_eq!(page.page_id, Some(PAGE_ID));
    assert_eq!(page.validate(), Ok(()));

    let horizontal: HorizontalListRequest =
        serde_json::from_str(include_str!("../contracts/horizontal-list-request.json")).unwrap();
    assert_eq!(horizontal.horizontal_id, Some(HORIZONTAL_ID));
    assert_eq!(horizontal.page_size, Some(10_000));
    assert_eq!(horizontal.validate(), Ok(()));

    let init: InitRequest =
        serde_json::from_str(include_str!("../contracts/init-request.json")).unwrap();
    assert_eq!(init.panel_id, Some(PANEL_ID));
    assert_eq!(init.use_page_id, Some(USE_PAGE_ID));
    assert_eq!(init.validate(), Ok(()));

    let field_schema: FieldSchemaUpdateRequest = serde_json::from_str(include_str!(
        "../contracts/field-schema-update-request.json"
    ))
    .unwrap();
    assert_eq!(field_schema.panel_id, Some(PANEL_ID));
    assert_eq!(field_schema.use_page_id, Some(USE_PAGE_ID));
    assert_eq!(field_schema.validate(), Ok(()));
}

#[test]
fn calendar_query_and_page_routes_share_scoped_identity() {
    let (_, application) = application();
    let query_response = route(
        &raw(
            QUERY_ENTRYPOINT,
            include_str!("../contracts/calendar-query-request.json"),
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(query_response.0, "200 OK");
    let query_json: JsonValue = serde_json::from_str(&query_response.1).unwrap();
    assert_eq!(query_json["code"], 0);
    assert_eq!(query_json["data"]["usePageId"].as_u64(), Some(USE_PAGE_ID));
    assert_eq!(query_json["data"]["viewId"].as_u64(), Some(VIEW_ID));
    assert_eq!(query_json["data"]["viewType"], "calendar");

    let page_response = route(
        &raw(
            PAGE_ENTRYPOINT,
            include_str!("../contracts/calendar-page-request.json"),
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(page_response.0, "200 OK", "{}", page_response.1);
    let page_json: JsonValue = serde_json::from_str(&page_response.1).unwrap();
    assert_eq!(page_json["code"], 0);
    assert_eq!(page_json["data"]["reqId"], "calendar-request");
    assert_eq!(page_json["data"]["respData"][0]["total"], 1);
}

#[test]
fn horizontal_list_route_sorts_and_preserves_composite_projection() {
    let (_, application) = application();
    let response = route(
        &raw(
            HORIZONTAL_LIST_ENTRYPOINT,
            include_str!("../contracts/horizontal-list-request.json"),
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(response.0, "200 OK");
    let json: JsonValue = serde_json::from_str(&response.1).unwrap();
    assert_eq!(json["code"], 0);
    assert_eq!(json["data"]["total"], 2);
    assert_eq!(json["data"]["respData"][0]["custField59623"], "A");
    assert_eq!(
        json["data"]["respData"][0]["custField60040_0|custField59627"],
        "A-1"
    );
}

#[test]
fn horizontal_refresh_runs_coordinator_before_list() {
    let (ports, application) = application();
    let mut request: JsonValue =
        serde_json::from_str(include_str!("../contracts/horizontal-list-request.json")).unwrap();
    request["operator"] = JsonValue::String("REFRESH".to_owned());
    let response = route(
        &raw(HORIZONTAL_LIST_ENTRYPOINT, &request.to_string()),
        &Config::default(),
        &application,
    );
    assert_eq!(response.0, "200 OK");
    assert_eq!(
        ports
            .events()
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["horizontal.refresh.sync"]
    );
}

#[test]
fn init_route_returns_java_compatible_engine_envelope_and_is_idempotent() {
    let (ports, application) = application();
    let request = raw(
        INIT_ENTRYPOINT,
        include_str!("../contracts/init-request.json"),
    );

    let first = route(&request, &Config::default(), &application);
    let replay = route(&request, &Config::default(), &application);

    assert_eq!(first.0, "200 OK", "{}", first.1);
    assert_eq!(replay, first);
    let json: JsonValue = serde_json::from_str(&first.1).unwrap();
    assert_eq!(json["code"], 0);
    let resp_key = json["data"]["defRespKey"].as_str().unwrap();
    assert_eq!(json["data"]["respData"][resp_key]["total"], 1);
    assert_eq!(
        json["data"]["respData"][resp_key]["data"][0]["custField59625"],
        "2026-07-30"
    );
    assert_eq!(ports.init_records(&context()).len(), 1);
    assert_eq!(ports.init_outbox(&context()).len(), 1);
}

#[test]
fn field_schema_route_uses_put_and_resumes_without_duplicate_ddl() {
    let (ports, application) = application();
    let request = raw_method(
        "PUT",
        FIELD_SCHEMA_UPDATE_ENTRYPOINT,
        include_str!("../contracts/field-schema-update-request.json"),
    );

    let first = route(&request, &Config::default(), &application);
    let replay = route(&request, &Config::default(), &application);

    assert_eq!(first.0, "200 OK", "{}", first.1);
    assert_eq!(replay, first);
    let json: JsonValue = serde_json::from_str(&first.1).unwrap();
    assert_eq!(json["code"], 0);
    assert_eq!(json["data"]["panelId"].as_u64(), Some(PANEL_ID));
    assert_eq!(json["data"]["usePageId"].as_u64(), Some(USE_PAGE_ID));
    assert_eq!(json["data"]["name"], "文本字段");
    assert_eq!(
        ports.field_ddl_execution_count(&context(), "calendar-request"),
        1
    );

    let wrong_method = route(
        &raw(
            FIELD_SCHEMA_UPDATE_ENTRYPOINT,
            include_str!("../contracts/field-schema-update-request.json"),
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(wrong_method.0, "404 Not Found");
}

#[test]
fn field_schema_edit_and_delete_use_existing_server_column_without_ddl() {
    let (ports, application) = application();
    let field_id = 2_082_674_387_292_954_625;
    ports.insert_field_schema(
        &context(),
        PANEL_ID,
        USE_PAGE_ID,
        FieldSchemaCommit {
            field_id,
            field: "custField66566".to_owned(),
            table_script_field: "cust_field_66566".to_owned(),
            replayed: false,
        },
    );
    let request = raw_method(
        "PUT",
        FIELD_SCHEMA_UPDATE_ENTRYPOINT,
        include_str!("../contracts/field-schema-edit-request.json"),
    );

    let first = route(&request, &Config::default(), &application);
    let replay = route(&request, &Config::default(), &application);

    assert_eq!(first.0, "200 OK", "{}", first.1);
    assert_eq!(replay, first);
    let json: JsonValue = serde_json::from_str(&first.1).unwrap();
    assert_eq!(json["data"]["id"].as_u64(), Some(field_id));
    assert_eq!(json["data"]["name"], "文本字段1");
    assert_eq!(json["data"]["field"], "custField66566");
    assert_eq!(json["data"]["tableScriptField"], "cust_field_66566");
    assert_eq!(
        ports.field_ddl_execution_count(&context(), "calendar-request"),
        0
    );
    assert_eq!(ports.field_schema_records(&context()).len(), 1);

    let detail = route(
        &raw_method_request_id(
            "GET",
            &format!("{FIELD_DETAIL_ENTRYPOINT}?id={field_id}"),
            "",
            "field-detail-exact-id",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(detail.0, "200 OK", "{}", detail.1);
    let detail_json: JsonValue = serde_json::from_str(&detail.1).unwrap();
    assert_eq!(detail_json["data"]["id"].as_u64(), Some(field_id));
    assert_eq!(detail_json["data"]["name"], "文本字段1");
    assert_eq!(detail_json["data"]["field"], "custField66566");
    assert_eq!(detail_json["data"]["fieldTagCss"], "#606266");
    assert_eq!(detail_json["data"]["fieldBackgroundColor"], "#fff");

    let delete = route(
        &raw_method_request_id(
            "DELETE",
            &format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id={field_id}"),
            "",
            "field-delete-exact-id",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(delete.0, "200 OK", "{}", delete.1);
    let delete_json: JsonValue = serde_json::from_str(&delete.1).unwrap();
    assert_eq!(delete_json["code"], 0);
    assert_eq!(delete_json["data"], true);
    assert_eq!(ports.field_delete_outbox(&context()).len(), 1);

    let missing_detail = route(
        &raw_method_request_id(
            "GET",
            &format!("{FIELD_DETAIL_ENTRYPOINT}?id={field_id}"),
            "",
            "field-detail-after-delete",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(missing_detail.0, "200 OK", "{}", missing_detail.1);
    let missing_json: JsonValue = serde_json::from_str(&missing_detail.1).unwrap();
    assert!(missing_json["data"].is_null());
}

#[test]
fn ledger_query_add_and_edit_share_one_field_catalog() {
    let (ports, application) = application();

    let empty_query = route(
        &raw_method_request_id(
            "POST",
            QUERY_ENTRYPOINT,
            include_str!("../contracts/ledger-fields-query-request.json"),
            "ledger-query-empty",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(empty_query.0, "200 OK", "{}", empty_query.1);
    let empty_json: JsonValue = serde_json::from_str(&empty_query.1).unwrap();
    assert!(empty_json["data"]["viewId"].is_null());
    assert_eq!(
        empty_json["data"]["panelRespKeyList"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let add = route(
        &raw_method_request_id(
            "PUT",
            FIELD_SCHEMA_UPDATE_ENTRYPOINT,
            include_str!("../contracts/field-schema-update-request.json"),
            "ledger-field-add",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(add.0, "200 OK", "{}", add.1);
    let add_json: JsonValue = serde_json::from_str(&add.1).unwrap();
    let field_id = add_json["data"]["id"].as_u64().unwrap();
    let physical_field = add_json["data"]["field"].as_str().unwrap().to_owned();

    let query_after_add = route(
        &raw_method_request_id(
            "POST",
            QUERY_ENTRYPOINT,
            include_str!("../contracts/ledger-fields-query-request.json"),
            "ledger-query-after-add",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(query_after_add.0, "200 OK", "{}", query_after_add.1);
    let query_json: JsonValue = serde_json::from_str(&query_after_add.1).unwrap();
    let panel_key = query_json["data"]["panelRespKeyList"][0].as_str().unwrap();
    let fields = query_json["data"]["data"][panel_key]["viewDynamicFieldDataDOList"]
        .as_array()
        .unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0]["id"].as_u64(), Some(field_id));
    assert_eq!(fields[0]["name"], "文本字段");
    assert_eq!(fields[0]["field"], physical_field);

    let mut edit_body: JsonValue =
        serde_json::from_str(include_str!("../contracts/field-schema-edit-request.json")).unwrap();
    edit_body["id"] = JsonValue::String(field_id.to_string());
    let edit = route(
        &raw_method_request_id(
            "PUT",
            FIELD_SCHEMA_UPDATE_ENTRYPOINT,
            &edit_body.to_string(),
            "ledger-field-edit",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(edit.0, "200 OK", "{}", edit.1);

    let query_after_edit = route(
        &raw_method_request_id(
            "POST",
            QUERY_ENTRYPOINT,
            include_str!("../contracts/ledger-fields-query-request.json"),
            "ledger-query-after-edit",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(query_after_edit.0, "200 OK", "{}", query_after_edit.1);
    let edited_json: JsonValue = serde_json::from_str(&query_after_edit.1).unwrap();
    let panel_key = edited_json["data"]["panelRespKeyList"][0].as_str().unwrap();
    let edited_field = &edited_json["data"]["data"][panel_key]["viewDynamicFieldDataDOList"][0];
    assert_eq!(edited_field["id"].as_u64(), Some(field_id));
    assert_eq!(edited_field["name"], "文本字段1");
    assert_eq!(edited_field["field"], physical_field);
    assert_eq!(
        ports.field_ddl_execution_count(&context(), "ledger-field-add"),
        1
    );
    assert_eq!(
        ports.field_ddl_execution_count(&context(), "ledger-field-edit"),
        0
    );

    let delete = route(
        &raw_method_request_id(
            "DELETE",
            &format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id={field_id}"),
            "",
            "ledger-field-delete",
        ),
        &Config::default(),
        &application,
    );
    let delete_replay = route(
        &raw_method_request_id(
            "DELETE",
            &format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id={field_id}"),
            "",
            "ledger-field-delete",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(delete.0, "200 OK", "{}", delete.1);
    assert_eq!(delete_replay, delete);
    let delete_json: JsonValue = serde_json::from_str(&delete.1).unwrap();
    assert_eq!(delete_json["data"], true);

    let query_after_delete = route(
        &raw_method_request_id(
            "POST",
            QUERY_ENTRYPOINT,
            include_str!("../contracts/ledger-fields-query-request.json"),
            "ledger-query-after-delete",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(query_after_delete.0, "200 OK", "{}", query_after_delete.1);
    let deleted_json: JsonValue = serde_json::from_str(&query_after_delete.1).unwrap();
    assert!(
        deleted_json["data"]["panelRespKeyList"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(ports.field_delete_outbox(&context()).len(), 1);
}

#[test]
fn field_delete_route_rejects_missing_duplicate_and_wrong_method() {
    let (_, application) = application();
    for target in [
        FIELD_SCHEMA_DELETE_ENTRYPOINT.to_owned(),
        format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id=1&id=2"),
        format!("{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id=0"),
    ] {
        let response = route(
            &raw_method_request_id("DELETE", &target, "", "invalid-delete"),
            &Config::default(),
            &application,
        );
        assert_eq!(response.0, "400 Bad Request", "{}", response.1);
    }

    let wrong_method = route(
        &raw_method_request_id(
            "POST",
            &format!(
                "{FIELD_SCHEMA_DELETE_ENTRYPOINT}?id={}",
                2_082_674_387_292_954_625_u64
            ),
            "",
            "wrong-delete-method",
        ),
        &Config::default(),
        &application,
    );
    assert_eq!(wrong_method.0, "404 Not Found");

    for target in [
        FIELD_DETAIL_ENTRYPOINT.to_owned(),
        format!("{FIELD_DETAIL_ENTRYPOINT}?id=1&id=2"),
        format!("{FIELD_DETAIL_ENTRYPOINT}?id=0"),
    ] {
        let response = route(
            &raw_method_request_id("GET", &target, "", "invalid-detail"),
            &Config::default(),
            &application,
        );
        assert_eq!(response.0, "400 Bad Request", "{}", response.1);
    }
}
