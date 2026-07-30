use std::{collections::BTreeMap, sync::Arc, time::Instant};

use serde_json::Value as JsonValue;
use zboss_dynamic_engine::{
    adapters::memory::{FaultPoint, MemoryAdapters},
    application::data::page::PageApplication,
    domain::{
        context::RequestContext,
        model::{FieldMetadata, PageMetadata, Row, Value, ViewMetadata},
    },
    http::{
        dto::{HorizontalListRequest, MetadataQueryRequest, PageRequest},
        handler::{HorizontalListUseCase, MetadataQueryUseCase, PageUseCase},
    },
};

const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;
const VIEW_ID: u64 = 2_064_662_147_688_243_201;
const OTHER_VIEW_ID: u64 = VIEW_ID + 1;
const PANEL_ID: u64 = 2_059_838_046_666_665_986;
const PAGE_ID: u64 = 2_059_838_046_687_637_506;
const INTER_ID: u64 = 2_059_838_045_928_468_482;
const HTTP_ID: u64 = 2_059_838_047_035_764_738;
const HORIZONTAL_ID: u64 = 2_069_983_536_167_243_777;

fn context() -> RequestContext {
    RequestContext {
        tenant_id: 177,
        user_id: 14,
        device_id: "compatibility-gate".to_owned(),
        request_id: "zboss-02".to_owned(),
        trace_id: "zboss-02-trace".to_owned(),
        datasource: "primary".to_owned(),
        snapshot_id: "offline-fixture".to_owned(),
    }
}

fn fields() -> Vec<FieldMetadata> {
    [
        "eventId",
        "start",
        "end",
        "allDay",
        "localDate",
        "dstBefore",
        "dstAfter",
    ]
    .into_iter()
    .map(|key| FieldMetadata {
        key: key.to_owned(),
        column: key.to_owned(),
        aggregate: None,
    })
    .collect()
}

fn calendar_row(index: usize) -> Row {
    Row::from([
        (
            "eventId".to_owned(),
            Value::Text(format!("event-{index:05}")),
        ),
        (
            "start".to_owned(),
            Value::Text("2026-07-30T00:00:00+08:00".to_owned()),
        ),
        ("end".to_owned(), Value::Null),
        ("allDay".to_owned(), Value::Boolean(true)),
        ("localDate".to_owned(), Value::Text("2026-07-30".to_owned())),
        (
            "dstBefore".to_owned(),
            Value::Text("2026-10-25T01:30:00+02:00".to_owned()),
        ),
        (
            "dstAfter".to_owned(),
            Value::Text("2026-10-25T01:30:00+01:00".to_owned()),
        ),
    ])
}

fn view(view_id: u64, view_type: &str, marker: &str) -> ViewMetadata {
    ViewMetadata {
        use_page_id: USE_PAGE_ID,
        view_id,
        page_id: PAGE_ID,
        panel_id: PANEL_ID,
        inter_id: INTER_ID,
        http_id: HTTP_ID,
        view_type: view_type.to_owned(),
        panel_resp_keys: vec!["calendar_records".to_owned()],
        data: BTreeMap::from([
            ("marker".to_owned(), JsonValue::String(marker.to_owned())),
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
    }
}

fn application(
    calendar_rows: Vec<Row>,
    horizontal_rows: Vec<Row>,
) -> (Arc<MemoryAdapters>, PageApplication<MemoryAdapters>) {
    let ports = Arc::new(MemoryAdapters::default());
    ports.insert_metadata(
        &context(),
        PageMetadata {
            version: 1,
            page_id: USE_PAGE_ID,
            panel_id: PANEL_ID,
            table: "calendar_records".to_owned(),
            business_key: vec!["eventId".to_owned()],
            fields: fields(),
        },
    );
    ports.insert_view_metadata(&context(), view(VIEW_ID, "calendar", "calendar"));
    ports.insert_view_metadata(&context(), view(OTHER_VIEW_ID, "table", "table"));
    ports.insert_rows(&context(), "calendar_records", calendar_rows);
    ports.insert_horizontal_rows(&context(), HORIZONTAL_ID, horizontal_rows);
    let application = PageApplication::new(Arc::clone(&ports));
    (ports, application)
}

fn metadata_request(view_id: u64) -> MetadataQueryRequest {
    MetadataQueryRequest {
        use_page_id: Some(USE_PAGE_ID),
        view_id: Some(view_id),
        ..MetadataQueryRequest::default()
    }
}

fn page_request(page_size: u32) -> PageRequest {
    PageRequest {
        use_page_id: Some(USE_PAGE_ID),
        page_id: Some(PAGE_ID),
        panel_id: Some(PANEL_ID),
        inter_id: Some(INTER_ID),
        http_id: Some(HTTP_ID),
        page_no: Some(1),
        page_size: Some(page_size),
        skip_save_page_size: Some(true),
        ..PageRequest::default()
    }
}

fn horizontal_rows(count: usize) -> Vec<Row> {
    (0..count)
        .map(|index| {
            Row::from([
                (
                    "custField59623".to_owned(),
                    Value::Text(format!("{index:05}")),
                ),
                ("custField60040_0".to_owned(), Value::Integer(index as i64)),
                (
                    "custField60040_0|custField59627".to_owned(),
                    Value::Text(format!("calculated-{index:05}")),
                ),
            ])
        })
        .collect()
}

fn horizontal_request() -> HorizontalListRequest {
    serde_json::from_str(include_str!("../contracts/horizontal-list-request.json")).unwrap()
}

#[test]
fn page_dec_calendar_view_type_source_uses_authoritative_metadata() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(1));

    let calendar = application
        .query_metadata(&context(), metadata_request(VIEW_ID))
        .unwrap();
    let table = application
        .query_metadata(&context(), metadata_request(OTHER_VIEW_ID))
        .unwrap();

    assert_eq!(calendar.view_type.as_deref(), Some("calendar"));
    assert_eq!(table.view_type.as_deref(), Some("table"));
    assert_eq!(calendar.data["marker"], "calendar");
    assert_eq!(table.data["marker"], "table");
}

#[test]
fn page_dec_calendar_query_page_binding_freezes_scoped_identity() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(1));
    let mut metadata = application
        .query_metadata(&context(), metadata_request(VIEW_ID))
        .unwrap();

    assert_eq!(metadata.use_page_id, USE_PAGE_ID);
    assert_eq!(metadata.view_id, Some(VIEW_ID));
    assert_eq!(metadata.page_id, Some(PAGE_ID));
    assert_eq!(metadata.data["panelId"], PANEL_ID.to_string());
    assert_eq!(metadata.data["interId"], INTER_ID.to_string());
    assert_eq!(metadata.data["httpId"], HTTP_ID.to_string());
    metadata
        .data
        .insert("requestLocal".to_owned(), JsonValue::Bool(true));
    assert!(
        !application
            .query_metadata(&context(), metadata_request(VIEW_ID))
            .unwrap()
            .data
            .contains_key("requestLocal")
    );

    let response = application
        .execute(&context(), page_request(10_000))
        .unwrap();
    assert_eq!(response.resp_data[0].total, 1);

    let mut wrong_panel = page_request(10_000);
    wrong_panel.panel_id = Some(PANEL_ID + 1);
    assert_eq!(
        application
            .execute(&context(), wrong_panel)
            .unwrap_err()
            .http_status,
        400
    );
}

#[test]
fn page_dec_calendar_page_size_10000_preserves_total_and_boundary() {
    let rows = (0..10_001).map(calendar_row).collect();
    let (_, application) = application(rows, horizontal_rows(1));

    let started = Instant::now();
    let response = application
        .execute(&context(), page_request(10_000))
        .unwrap();
    let elapsed_millis = started.elapsed().as_millis();
    let response_bytes = serde_json::to_vec(&response).unwrap().len();
    let page = &response.resp_data[0];

    assert_eq!(page.total, 10_001);
    assert_eq!(page.data.len(), 10_000);
    assert!(elapsed_millis < 10_000);
    assert!(response_bytes < 20_000_000);
    assert_eq!(
        page.data.first().unwrap()["eventId"],
        Value::Text("event-00000".to_owned())
    );
    assert_eq!(
        page.data.last().unwrap()["eventId"],
        Value::Text("event-09999".to_owned())
    );
    println!(
        "MG_COMPAT_METRIC {}",
        serde_json::json!({
            "decisionId": "PAGE-DEC-CALENDAR-PAGE-SIZE-10000",
            "elapsedMillis": elapsed_millis,
            "responseBytes": response_bytes,
            "returnedRows": page.data.len(),
            "total": page.total,
            "payloadMemoryBudgetBytes": 40_000_000
        })
    );
}

#[test]
fn page_dec_calendar_temporal_semantics_preserves_boundaries_nulls_and_offsets() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(1));

    let response = application.execute(&context(), page_request(1)).unwrap();
    let row = &response.resp_data[0].data[0];

    assert_eq!(
        row["start"],
        Value::Text("2026-07-30T00:00:00+08:00".to_owned())
    );
    assert_eq!(row["end"], Value::Null);
    assert_eq!(row["allDay"], Value::Boolean(true));
    assert_eq!(row["localDate"], Value::Text("2026-07-30".to_owned()));
    assert_eq!(
        row["dstBefore"],
        Value::Text("2026-10-25T01:30:00+02:00".to_owned())
    );
    assert_eq!(
        row["dstAfter"],
        Value::Text("2026-10-25T01:30:00+01:00".to_owned())
    );
}

#[test]
fn query_dec_calendar_view_binding_is_use_page_and_view_scoped() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(1));

    let response = application
        .query_metadata(&context(), metadata_request(VIEW_ID))
        .unwrap();
    assert_eq!(response.use_page_id, USE_PAGE_ID);
    assert_eq!(response.view_id, Some(VIEW_ID));
    assert_eq!(response.view_type.as_deref(), Some("calendar"));

    let mut missing_binding = metadata_request(VIEW_ID);
    missing_binding.use_page_id = Some(USE_PAGE_ID + 1);
    assert_eq!(
        application
            .query_metadata(&context(), missing_binding)
            .unwrap_err()
            .http_status,
        503
    );
}

#[test]
fn query_dec_calendar_cache_isolation_returns_defensive_owned_data() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(1));

    let mut first = application
        .query_metadata(&context(), metadata_request(VIEW_ID))
        .unwrap();
    first.data.insert(
        "requestStatus".to_owned(),
        JsonValue::String("dirty".to_owned()),
    );

    let second = application
        .query_metadata(&context(), metadata_request(VIEW_ID))
        .unwrap();
    let other_view = application
        .query_metadata(&context(), metadata_request(OTHER_VIEW_ID))
        .unwrap();

    assert!(!second.data.contains_key("requestStatus"));
    assert_eq!(second.data["marker"], "calendar");
    assert_eq!(other_view.data["marker"], "table");
}

#[test]
fn horizontal_list_dec_identity_rewrite_supports_supplied_and_derived_ids() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(2));
    let supplied = application
        .list_horizontal(&context(), horizontal_request())
        .unwrap();

    let mut derived = horizontal_request();
    derived.use_page_id = derived.horizontal_id.take();
    assert_eq!(derived.validate(), Ok(()));
    let derived = application.list_horizontal(&context(), derived).unwrap();

    assert_eq!(derived, supplied);
}

#[test]
fn horizontal_list_dec_unknown_show_archived_is_accepted_and_ignored() {
    let mut rows = horizontal_rows(2);
    rows[1].insert("locked".to_owned(), Value::Integer(1));
    let (_, application) = application(vec![calendar_row(0)], rows);

    let mut hidden = horizontal_request();
    hidden.show_archived = Some(false);
    let mut requested = hidden.clone();
    requested.show_archived = Some(true);
    let mut omitted = hidden.clone();
    omitted.show_archived = None;

    let hidden = application.list_horizontal(&context(), hidden).unwrap();
    let requested = application.list_horizontal(&context(), requested).unwrap();
    let omitted = application.list_horizontal(&context(), omitted).unwrap();

    assert_eq!(requested, hidden);
    assert_eq!(omitted, hidden);
}

#[test]
fn horizontal_list_dec_page_size_10000_preserves_total_and_boundary() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(10_001));

    let started = Instant::now();
    let response = application
        .list_horizontal(&context(), horizontal_request())
        .unwrap();
    let elapsed_millis = started.elapsed().as_millis();
    let response_bytes = serde_json::to_vec(&response).unwrap().len();

    assert_eq!(response.total, 10_001);
    assert_eq!(response.resp_data.len(), 10_000);
    assert!(elapsed_millis < 10_000);
    assert!(response_bytes < 20_000_000);
    assert_eq!(
        response.resp_data.first().unwrap()["custField59623"],
        Value::Text("00000".to_owned())
    );
    assert_eq!(
        response.resp_data.last().unwrap()["custField59623"],
        Value::Text("09999".to_owned())
    );
    println!(
        "MG_COMPAT_METRIC {}",
        serde_json::json!({
            "decisionId": "HORIZONTAL-LIST-DEC-PAGE-SIZE-10000",
            "elapsedMillis": elapsed_millis,
            "responseBytes": response_bytes,
            "returnedRows": response.resp_data.len(),
            "total": response.total,
            "payloadMemoryBudgetBytes": 40_000_000
        })
    );
}

#[test]
fn horizontal_list_dec_composite_select_key_preserves_projection_and_order() {
    let (_, application) = application(vec![calendar_row(0)], horizontal_rows(3));

    let mut response = application
        .list_horizontal(&context(), horizontal_request())
        .unwrap();

    assert_eq!(
        response.resp_data[0]["custField59623"],
        Value::Text("00000".to_owned())
    );
    assert_eq!(
        response.resp_data[0]["custField60040_0|custField59627"],
        Value::Text("calculated-00000".to_owned())
    );
    assert_eq!(response.resp_data[0].len(), 3);

    response.resp_data[0].insert(
        "custField60040_0|custField59627".to_owned(),
        Value::Text("request-local-mutation".to_owned()),
    );
    let replay = application
        .list_horizontal(&context(), horizontal_request())
        .unwrap();
    assert_eq!(
        replay.resp_data[0]["custField60040_0|custField59627"],
        Value::Text("calculated-00000".to_owned())
    );
}

#[test]
fn horizontal_list_dec_refresh_effect_order_syncs_before_query_and_fails_closed() {
    let (ports, application) = application(vec![calendar_row(0)], horizontal_rows(1));
    let mut refresh = horizontal_request();
    refresh.operator = Some("REFRESH".to_owned());

    let response = application
        .list_horizontal(&context(), refresh.clone())
        .unwrap();
    assert_eq!(response.total, 1);
    assert_eq!(
        ports
            .events()
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["horizontal.refresh.sync"]
    );

    ports.inject_fault(FaultPoint::RefreshSync);
    let error = application
        .list_horizontal(&context(), refresh)
        .unwrap_err();
    assert_eq!(error.http_status, 503);
    assert!(error.message.contains("RefreshSync"));
    assert_eq!(ports.events().len(), 1);
}
