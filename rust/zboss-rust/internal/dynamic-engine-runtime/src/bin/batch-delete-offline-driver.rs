use serde::Serialize;
use std::env;
use zboss_dynamic_engine::application::data::delete::{
    DeleteErrorCode, DeleteRequest, Fault, MemoryStore, ProgressState, Row, StepState,
};

const IDS: [u64; 3] = [
    2_082_397_610_825_953_281,
    2_082_397_610_809_176_066,
    2_082_397_610_804_981_762,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    schema_version: u32,
    driver_id: &'static str,
    case_id: String,
    http_status: u16,
    code: String,
    deleted_row_ids: Vec<u64>,
    skipped_row_ids: Vec<u64>,
    active_row_ids: Vec<u64>,
    snapshot_count: usize,
    undo_count: usize,
    outbox_state: String,
    progress_terminal: String,
    replayed: bool,
}

fn main() {
    let args = env::args().collect::<Vec<_>>();
    let case_id = args
        .windows(2)
        .find(|pair| pair[0] == "--case")
        .map(|pair| pair[1].as_str())
        .unwrap_or_else(|| fail("usage: batch-delete-offline-driver --case <case-id>"));
    let observation =
        run(case_id).unwrap_or_else(|| fail(&format!("unknown replay case: {case_id}")));
    println!(
        "{}",
        serde_json::to_string(&observation).expect("serialize observation")
    );
}

fn run(case_id: &str) -> Option<Observation> {
    let mut store = MemoryStore::default();
    store.seed_rows(IDS.into_iter().map(Row::active));
    let request = request();
    let fault = match case_id {
        "success" | "duplicate-replay" => Fault::None,
        "partial-reference-skip" | "all-reference-skip" | "missing-active-row" => Fault::None,
        "snapshot-failure" => Fault::Snapshot,
        "undo-failure" => Fault::Undo,
        "compensation-failure" => Fault::CompensationStep(5),
        _ => return None,
    };
    match case_id {
        "partial-reference-skip" => store.rows.get_mut(&IDS[1]).unwrap().referenced = true,
        "all-reference-skip" => {
            for row in store.rows.values_mut() {
                row.referenced = true;
            }
        }
        "missing-active-row" => store.rows.get_mut(&IDS[2]).unwrap().active = false,
        _ => {}
    }
    let result = if case_id == "duplicate-replay" {
        store.execute(&request, Fault::None).expect("first delete");
        store.execute(&request, Fault::None)
    } else {
        store.execute(&request, fault)
    };
    let (http_status, code, deleted, skipped, replayed, progress_terminal) = match result {
        Ok(response) => (
            response.http_status,
            response.code,
            response.deleted_row_ids,
            response.skipped_row_ids,
            response.replayed,
            state_name(response.progress_state),
        ),
        Err(error) => (
            match error.code {
                DeleteErrorCode::MissingActiveRow => 409,
                _ => 500,
            },
            format!("{:?}", error.code).to_ascii_uppercase(),
            Vec::new(),
            Vec::new(),
            false,
            "FAILED".into(),
        ),
    };
    let active_row_ids = store
        .rows
        .values()
        .filter(|row| row.active)
        .map(|row| row.id)
        .collect();
    let outbox_state = store
        .compensation_tasks
        .first()
        .map(|task| {
            if task
                .steps
                .iter()
                .all(|step| step.state == StepState::Completed)
            {
                "COMPLETED"
            } else if task
                .steps
                .iter()
                .any(|step| step.state == StepState::Failed)
            {
                "FAILED"
            } else {
                "PENDING"
            }
        })
        .unwrap_or("NONE")
        .into();
    Some(Observation {
        schema_version: 1,
        driver_id: "rust-batch-delete-memory",
        case_id: case_id.into(),
        http_status,
        code,
        deleted_row_ids: deleted,
        skipped_row_ids: skipped,
        active_row_ids,
        snapshot_count: store.snapshots.len(),
        undo_count: store.undo_anchors.len(),
        outbox_state,
        progress_terminal,
        replayed,
    })
}

fn request() -> DeleteRequest {
    DeleteRequest {
        tenant_id: 2_059_823_220_968_001_539,
        user_id: 1,
        request_id: "real-ledger-delete-001".into(),
        idempotency_key: "real-ledger-delete-001".into(),
        inter_id: 2_082_276_810_223_452_163,
        http_id: 2_082_276_811_863_425_027,
        use_page_id: 2_082_276_811_842_453_506,
        panel_id: 2_082_276_811_427_217_409,
        row_ids: IDS.to_vec(),
        operation_kind: "ROW_DELETE".into(),
        operation_label: "3 行".into(),
    }
}

fn state_name(state: ProgressState) -> String {
    format!("{state:?}")
        .chars()
        .flat_map(|character| {
            if character.is_ascii_uppercase() {
                vec!['_', character]
            } else {
                vec![character.to_ascii_uppercase()]
            }
        })
        .skip_while(|character| *character == '_')
        .collect()
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}
