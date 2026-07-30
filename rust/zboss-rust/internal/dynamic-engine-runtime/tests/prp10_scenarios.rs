use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zboss_dynamic_engine::{
    ENTRYPOINT,
    adapters::memory::MemoryAdapters,
    application::data::page::PageApplication,
    config::Config,
    domain::{
        context::RequestContext,
        model::{FieldMetadata, PageMetadata, Row, Value},
    },
    http::{
        dto::{PageRequest, PageResponse},
        envelope::Envelope,
        handler::handle_page,
        server::route,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScenarioIndex {
    schema_version: u32,
    stage: String,
    scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario {
    case_id: String,
    runtime_case_id: String,
    kind: String,
    transport: String,
    request_file: String,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    http_status: u16,
    code: i32,
    total: Option<u64>,
    data: Vec<Row>,
    events: Vec<String>,
    query_plan: ExpectedQueryPlan,
    upload_tmp_table_name: Option<String>,
    fingerprint: String,
    data_snapshot_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedQueryPlan {
    count: usize,
    table: Option<String>,
    where_predicates: usize,
    having_predicates: usize,
    group_by: usize,
    aggregates: usize,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("scenarios")
}

fn index() -> ScenarioIndex {
    serde_json::from_str(
        &fs::read_to_string(fixture_root().join("index.json")).expect("scenario index"),
    )
    .expect("valid scenario index")
}

fn scenario(case_id: &str) -> Scenario {
    index()
        .scenarios
        .into_iter()
        .find(|scenario| scenario.case_id == case_id)
        .unwrap_or_else(|| panic!("missing PRP-10 scenario: {case_id}"))
}

fn context() -> RequestContext {
    RequestContext {
        tenant_id: 11,
        user_id: 22,
        device_id: "prp10-device".to_owned(),
        request_id: "prp10-request".to_owned(),
        trace_id: "prp10-trace".to_owned(),
        datasource: "primary".to_owned(),
        snapshot_id: "snapshot-prp10".to_owned(),
    }
}

fn metadata() -> PageMetadata {
    PageMetadata {
        version: 1,
        page_id: 7,
        panel_id: 8,
        table: "orders".to_owned(),
        business_key: vec!["customer".to_owned()],
        fields: vec![
            FieldMetadata {
                key: "customer".to_owned(),
                column: "customer".to_owned(),
                aggregate: None,
            },
            FieldMetadata {
                key: "status".to_owned(),
                column: "status".to_owned(),
                aggregate: None,
            },
            FieldMetadata {
                key: "total".to_owned(),
                column: "amount".to_owned(),
                aggregate: Some("SUM".to_owned()),
            },
        ],
    }
}

fn row(customer: &str, status: &str, amount: i64) -> Row {
    BTreeMap::from([
        ("amount".to_owned(), Value::Integer(amount)),
        ("customer".to_owned(), Value::Text(customer.to_owned())),
        ("status".to_owned(), Value::Text(status.to_owned())),
    ])
}

fn setup(case_id: &str) -> (Arc<MemoryAdapters>, PageApplication<MemoryAdapters>) {
    let context = context();
    let ports = Arc::new(MemoryAdapters::with_time(1_000));
    ports.insert_metadata(&context, metadata());
    let rows = match case_id {
        "standard-page" => vec![row("b", "closed", 20), row("a", "open", 10)],
        "refresh-operator" => vec![row("r1", "open", 30)],
        "child-form-page" => vec![row("c-closed", "closed", 41), row("c-open", "open", 40)],
        "horizontal-page" => vec![
            row("b", "open", 5),
            row("a", "open", 40),
            row("a", "closed", 60),
        ],
        "quality-text-filter" => vec![row("q-closed", "closed", 51), row("q-open", "open", 50)],
        "upload-preview-page" | "tenant-auth-context" => vec![],
        "entrypoint-parity" => vec![row("e1", "open", 70)],
        value => panic!("unsupported scenario setup: {value}"),
    };
    ports.insert_rows(&context, "orders", rows);
    match case_id {
        "child-form-page" => ports.insert_child_headers(
            context.tenant_id,
            99,
            BTreeMap::from([("status".to_owned(), Value::Text("open".to_owned()))]),
        ),
        "upload-preview-page" => ports.insert_rows(
            &context,
            "tmp_orders_1",
            vec![row("t2", "preview", 92), row("t1", "preview", 91)],
        ),
        "tenant-auth-context" => ports.deny_page(context.tenant_id, 7),
        _ => {}
    }
    let application = PageApplication::new(Arc::clone(&ports));
    (ports, application)
}

fn request(scenario: &Scenario) -> PageRequest {
    serde_json::from_str(
        &fs::read_to_string(fixture_root().join(&scenario.request_file))
            .expect("scenario request fixture"),
    )
    .expect("valid scenario request")
}

fn execute(
    scenario: &Scenario,
    request: PageRequest,
    application: &PageApplication<MemoryAdapters>,
) -> (u16, Envelope<PageResponse>) {
    match scenario.transport.as_str() {
        "application" => handle_page(application, &context(), request),
        "http" => {
            let body = serde_json::to_string(&request).expect("request serialization");
            let raw = format!(
                "POST {ENTRYPOINT} HTTP/1.1\r\n\
                 X-Tenant-Id: 11\r\n\
                 X-User-Id: 22\r\n\
                 X-Device-Id: prp10-device\r\n\
                 X-Request-Id: prp10-request\r\n\
                 X-Trace-Id: prp10-trace\r\n\
                 X-Datasource: primary\r\n\
                 X-Snapshot-Id: snapshot-prp10\r\n\r\n{body}"
            );
            let (status_line, body) = route(&raw, &Config::default(), application);
            let status = status_line
                .split_whitespace()
                .next()
                .expect("HTTP status")
                .parse()
                .expect("numeric HTTP status");
            let envelope = serde_json::from_str(&body).expect("HTTP response envelope");

            let (_, direct_application) = setup(&scenario.case_id);
            let direct = handle_page(&direct_application, &context(), request);
            assert_eq!(
                (status, &envelope),
                (direct.0, &direct.1),
                "{} HTTP and application envelopes diverged",
                scenario.case_id
            );
            (status, envelope)
        }
        value => panic!("unsupported transport: {value}"),
    }
}

fn sha256_json<T: serde::Serialize>(value: &T) -> String {
    Sha256::digest(serde_json::to_vec(value).expect("snapshot serialization"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn run_case(case_id: &str) {
    let scenario = scenario(case_id);
    let request = request(&scenario);
    let expected_request_id = request.req_id.clone();
    let (ports, application) = setup(case_id);
    let (status, envelope) = execute(&scenario, request, &application);

    assert_eq!(status, scenario.expected.http_status, "{case_id} status");
    assert_eq!(envelope.code, scenario.expected.code, "{case_id} code");
    assert!(!envelope.msg.is_empty(), "{case_id} message");
    let actual_data = if let Some(response) = &envelope.data {
        assert_eq!(response.req_id, expected_request_id, "{case_id} reqId");
        assert_eq!(response.resp_data.len(), 1, "{case_id} response item");
        assert_eq!(
            response.resp_data[0].total,
            scenario.expected.total.expect("successful scenario total"),
            "{case_id} total"
        );
        assert_eq!(
            response.upload_tmp_table_name, scenario.expected.upload_tmp_table_name,
            "{case_id} upload table"
        );
        response.resp_data[0].data.clone()
    } else {
        assert!(scenario.expected.total.is_none(), "{case_id} missing total");
        assert!(
            scenario.expected.upload_tmp_table_name.is_none(),
            "{case_id} missing upload table"
        );
        vec![]
    };
    assert_eq!(
        actual_data, scenario.expected.data,
        "{case_id} data snapshot"
    );
    assert_eq!(
        sha256_json(&actual_data),
        scenario.expected.data_snapshot_sha256,
        "{case_id} data snapshot fingerprint"
    );

    let events = ports.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.clone())
            .collect::<Vec<_>>(),
        scenario.expected.events,
        "{case_id} event trace"
    );
    for (index, event) in events.iter().enumerate() {
        assert_eq!(
            event.trace_id,
            context().trace_id,
            "{case_id} trace lineage"
        );
        assert_eq!(
            event.sequence,
            u64::try_from(index).expect("event index") + 1,
            "{case_id} event ordering"
        );
    }

    let evidence = ports.query_evidence();
    assert_eq!(
        evidence.len(),
        scenario.expected.query_plan.count,
        "{case_id} query count"
    );
    if let Some(evidence) = evidence.first() {
        let expected = &scenario.expected.query_plan;
        assert_eq!(
            evidence.plan.table.as_str(),
            expected.table.as_deref().expect("query table"),
            "{case_id} query table"
        );
        assert_eq!(
            evidence.plan.where_predicates.len(),
            expected.where_predicates,
            "{case_id} WHERE plan"
        );
        assert_eq!(
            evidence.plan.having_predicates.len(),
            expected.having_predicates,
            "{case_id} HAVING plan"
        );
        assert_eq!(
            evidence.plan.group_by.len(),
            expected.group_by,
            "{case_id} GROUP BY plan"
        );
        assert_eq!(
            evidence.plan.aggregates.len(),
            expected.aggregates,
            "{case_id} aggregate plan"
        );
        let rendered = evidence.plan.render().expect("rendered query evidence");
        assert_eq!(
            evidence.result.query_fingerprint, rendered.fingerprint,
            "{case_id} plan/result fingerprint"
        );
        assert!(
            evidence.result.lineage.is_unified(),
            "{case_id} unified result lineage"
        );
        assert_eq!(
            evidence.result.lineage.total, evidence.result.query_fingerprint,
            "{case_id} lineage fingerprint"
        );
        assert_eq!(
            scenario.expected.fingerprint, "sha256",
            "{case_id} fingerprint expectation"
        );
        assert!(
            rendered.fingerprint.starts_with("sha256:") && rendered.fingerprint.len() == 71,
            "{case_id} SHA-256 query fingerprint"
        );
        assert_eq!(
            evidence.context,
            context(),
            "{case_id} query context lineage"
        );
    } else {
        assert_eq!(
            scenario.expected.fingerprint, "absent-before-query",
            "{case_id} pre-query rejection fingerprint"
        );
        assert!(
            scenario.expected.query_plan.table.is_none(),
            "{case_id} absent query plan"
        );
    }
}

#[test]
fn scenario_index_is_complete_ordered_and_uniquely_mapped() {
    let index = index();
    assert_eq!(index.schema_version, 1);
    assert_eq!(index.stage, "PRP-10");
    assert_eq!(index.scenarios.len(), 8);
    let mapping = index
        .scenarios
        .iter()
        .map(|scenario| {
            (
                scenario.case_id.as_str(),
                scenario.runtime_case_id.as_str(),
                scenario.kind.as_str(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        mapping,
        vec![
            ("standard-page", "standard-page", "runtime"),
            ("refresh-operator", "refresh", "runtime"),
            ("child-form-page", "child-table", "runtime"),
            ("horizontal-page", "horizontal-table", "runtime"),
            ("quality-text-filter", "quality-filter", "runtime"),
            ("upload-preview-page", "temporary-table", "runtime"),
            ("tenant-auth-context", "tenant-permission", "runtime"),
            ("entrypoint-parity", "entrypoint-parity", "offline-extra"),
        ]
    );
    assert_eq!(
        index
            .scenarios
            .iter()
            .map(|scenario| &scenario.case_id)
            .collect::<BTreeSet<_>>()
            .len(),
        8
    );
    for scenario in &index.scenarios {
        let fixture = fixture_root().join(&scenario.request_file);
        assert!(fixture.is_file(), "{} request fixture", scenario.case_id);
        let request: PageRequest =
            serde_json::from_str(&fs::read_to_string(fixture).expect("scenario request"))
                .expect("valid scenario request");
        assert!(
            request.validate().is_ok(),
            "{} request contract",
            scenario.case_id
        );
    }
}

#[test]
fn standard_page() {
    run_case("standard-page");
}

#[test]
fn refresh_operator() {
    run_case("refresh-operator");
}

#[test]
fn child_form_page() {
    run_case("child-form-page");
}

#[test]
fn horizontal_page() {
    run_case("horizontal-page");
}

#[test]
fn quality_text_filter() {
    run_case("quality-text-filter");
}

#[test]
fn upload_preview_page() {
    run_case("upload-preview-page");
}

#[test]
fn tenant_auth_context() {
    run_case("tenant-auth-context");
}

#[test]
fn entrypoint_parity() {
    run_case("entrypoint-parity");
}
