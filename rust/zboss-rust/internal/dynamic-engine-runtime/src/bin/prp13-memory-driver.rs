use std::{collections::BTreeMap, fs, path::Path, sync::Arc};

use serde::{Deserialize, Serialize};
use zboss_dynamic_engine::{
    ENTRYPOINT,
    adapters::memory::MemoryAdapters,
    application::data::page::DynamicEngineApplication,
    config::Config,
    domain::{
        context::RequestContext,
        model::{EvidenceEvent, PageMetadata, Row, Value},
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
struct ReplayInputs {
    schema_version: u32,
    stage: String,
    context: RequestContext,
    metadata: PageMetadata,
    cases: Vec<ReplayCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayCase {
    case_id: String,
    request_file: String,
    transport: String,
    snapshot: ReplaySnapshot,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaySnapshot {
    tables: BTreeMap<String, Vec<Row>>,
    deny_page: bool,
    child_form_field_id: Option<u64>,
    child_headers: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverObservation {
    schema_version: u32,
    driver_id: &'static str,
    provenance: &'static str,
    case_id: String,
    transport: String,
    context: RequestContext,
    input_evidence: DriverInputEvidence,
    http_status: u16,
    response: Envelope<PageResponse>,
    query_plans: Vec<QueryObservation>,
    events: Vec<EvidenceEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverInputEvidence {
    request: serde_json::Value,
    snapshot: serde_json::Value,
    context: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryObservation {
    engine: &'static str,
    table: String,
    where_predicates: usize,
    having_predicates: usize,
    group_by: usize,
    aggregates: usize,
    query_fingerprint: String,
    lineage_unified: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let case_id = parse_case_id()?;
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("prp13");
    let inputs: ReplayInputs = serde_json::from_str(
        &fs::read_to_string(fixture_root.join("replay-inputs.json"))
            .map_err(|error| format!("read replay inputs: {error}"))?,
    )
    .map_err(|error| format!("parse replay inputs: {error}"))?;
    if inputs.schema_version != 1 || inputs.stage != "PRP-13" {
        return Err("unsupported replay input contract".to_owned());
    }
    let case = inputs
        .cases
        .into_iter()
        .find(|case| case.case_id == case_id)
        .ok_or_else(|| format!("unknown replay case: {case_id}"))?;
    let request_value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(fixture_root.join(&case.request_file))
            .map_err(|error| format!("read replay request: {error}"))?,
    )
    .map_err(|error| format!("parse replay request JSON: {error}"))?;
    let request: PageRequest = serde_json::from_value(request_value.clone())
        .map_err(|error| format!("parse replay request contract: {error}"))?;
    let input_evidence = DriverInputEvidence {
        request: request_value,
        snapshot: serde_json::json!({
            "metadata": &inputs.metadata,
            "snapshot": &case.snapshot,
        }),
        context: serde_json::to_value(&inputs.context)
            .map_err(|error| format!("serialize replay context evidence: {error}"))?,
    };

    let ports = Arc::new(MemoryAdapters::with_time(1_000));
    ports.insert_metadata(&inputs.context, inputs.metadata.clone());
    for (table, rows) in case.snapshot.tables {
        ports.insert_rows(&inputs.context, table, rows);
    }
    if case.snapshot.deny_page {
        ports.deny_page(inputs.context.tenant_id, inputs.metadata.page_id);
    }
    if let Some(field_id) = case.snapshot.child_form_field_id {
        ports.insert_child_headers(
            inputs.context.tenant_id,
            field_id,
            case.snapshot.child_headers,
        );
    } else if !case.snapshot.child_headers.is_empty() {
        return Err("child headers require childFormFieldId".to_owned());
    }
    let application = DynamicEngineApplication::new(Arc::clone(&ports));
    let (http_status, response) = match case.transport.as_str() {
        "application" => handle_page(&application, &inputs.context, request),
        "http" => execute_http(&application, &inputs.context, &request)?,
        value => return Err(format!("unsupported replay transport: {value}")),
    };
    let query_plans = ports
        .query_evidence()
        .into_iter()
        .map(|evidence| QueryObservation {
            engine: "typed-query-plan",
            table: evidence.plan.table.as_str().to_owned(),
            where_predicates: evidence.plan.where_predicates.len(),
            having_predicates: evidence.plan.having_predicates.len(),
            group_by: evidence.plan.group_by.len(),
            aggregates: evidence.plan.aggregates.len(),
            query_fingerprint: evidence.result.query_fingerprint,
            lineage_unified: evidence.result.lineage.is_unified(),
        })
        .collect();
    let observation = DriverObservation {
        schema_version: 1,
        driver_id: "rust-page-memory",
        provenance: "synthetic-offline-memory-execution",
        case_id: case.case_id,
        transport: case.transport,
        context: inputs.context,
        input_evidence,
        http_status,
        response,
        query_plans,
        events: ports.events(),
    };
    println!(
        "{}",
        serde_json::to_string(&observation)
            .map_err(|error| format!("serialize replay observation: {error}"))?
    );
    Ok(())
}

fn parse_case_id() -> Result<String, String> {
    let mut arguments = std::env::args().skip(1);
    match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some("--case"), Some(case_id), None) if !case_id.trim().is_empty() => Ok(case_id),
        _ => Err("usage: prp13-memory-driver --case <case-id>".to_owned()),
    }
}

fn execute_http(
    application: &DynamicEngineApplication<MemoryAdapters>,
    context: &RequestContext,
    request: &PageRequest,
) -> Result<(u16, Envelope<PageResponse>), String> {
    let body = serde_json::to_string(request)
        .map_err(|error| format!("serialize HTTP replay request: {error}"))?;
    let raw = format!(
        "POST {ENTRYPOINT} HTTP/1.1\r\n\
         X-Tenant-Id: {}\r\n\
         X-User-Id: {}\r\n\
         X-Device-Id: {}\r\n\
         X-Request-Id: {}\r\n\
         X-Trace-Id: {}\r\n\
         X-Datasource: {}\r\n\
         X-Snapshot-Id: {}\r\n\r\n{body}",
        context.tenant_id,
        context.user_id,
        context.device_id,
        context.request_id,
        context.trace_id,
        context.datasource,
        context.snapshot_id,
    );
    let (status_line, body) = route(&raw, &Config::default(), application);
    let status = status_line
        .split_whitespace()
        .next()
        .ok_or_else(|| "missing HTTP replay status".to_owned())?
        .parse()
        .map_err(|error| format!("invalid HTTP replay status: {error}"))?;
    let response = serde_json::from_str(&body)
        .map_err(|error| format!("parse HTTP replay response: {error}"))?;
    Ok((status, response))
}
