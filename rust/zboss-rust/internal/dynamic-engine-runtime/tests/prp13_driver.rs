use std::process::Command;

use serde_json::Value;

const CASES: [(&str, u64, usize); 8] = [
    ("standard-page", 200, 1),
    ("refresh-operator", 200, 1),
    ("child-form-page", 200, 1),
    ("horizontal-page", 200, 1),
    ("quality-text-filter", 200, 1),
    ("upload-preview-page", 200, 1),
    ("tenant-auth-context", 403, 0),
    ("entrypoint-parity", 200, 1),
];

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_prp13-memory-driver")
}

#[test]
fn memory_driver_executes_all_stable_replay_cases() {
    for (case_id, expected_status, expected_plans) in CASES {
        let output = Command::new(binary())
            .args(["--case", case_id])
            .output()
            .expect("run PRP-13 memory driver");
        assert!(
            output.status.success(),
            "{case_id}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let observation: Value =
            serde_json::from_slice(&output.stdout).expect("driver JSON observation");
        assert_eq!(observation["schemaVersion"], 1);
        assert_eq!(observation["driverId"], "rust-page-memory");
        assert_eq!(observation["caseId"], case_id);
        assert_eq!(observation["httpStatus"], expected_status);
        assert_eq!(
            observation["queryPlans"]
                .as_array()
                .expect("query plans")
                .len(),
            expected_plans
        );
        assert_eq!(observation["context"]["tenantId"], 11);
        assert_eq!(
            observation["inputEvidence"]["context"],
            observation["context"]
        );
        assert!(observation["inputEvidence"]["request"].is_object());
        assert_eq!(
            observation["inputEvidence"]["snapshot"]["metadata"]["pageId"],
            7
        );
        for plan in observation["queryPlans"].as_array().expect("query plans") {
            assert_eq!(plan["engine"], "typed-query-plan");
            assert_eq!(plan["lineageUnified"], true);
            let fingerprint = plan["queryFingerprint"]
                .as_str()
                .expect("query fingerprint");
            assert!(fingerprint.starts_with("sha256:"));
            assert_eq!(fingerprint.len(), 71);
        }
    }
}

#[test]
fn memory_driver_fails_closed_for_unknown_or_missing_case() {
    let unknown = Command::new(binary())
        .args(["--case", "unknown-case"])
        .output()
        .expect("run unknown PRP-13 case");
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("unknown replay case"));

    let missing = Command::new(binary())
        .output()
        .expect("run missing PRP-13 case");
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("usage:"));
}
