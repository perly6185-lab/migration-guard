use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContractSuite {
    schema_version: u32,
    stage: String,
    contract_kind: String,
    live_destructive_fault_injection_performed: bool,
    source_semantics: SourceSemantics,
    cases: Vec<ContractCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSemantics {
    confirm_idempotency_key_present: bool,
    ordinary_failure_cleanup_policy: String,
    cancel_cleanup_policy: String,
    cleanup_registry_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContractCase {
    case_id: String,
    category: String,
    scenario: String,
    requirement: String,
    expected: ExpectedObservation,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedObservation {
    batch_statuses: Vec<String>,
    confirm_attempts: usize,
    confirm_invocations: usize,
    resource_count: usize,
    registration_count: usize,
    cleanup_attempts: usize,
    cleanup_successes: usize,
    registry_clear_calls: usize,
    residual_resources: Vec<String>,
    events: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchStatus {
    Pending,
    Success,
    Failed,
    Cancelled,
}

impl BatchStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Success => "SUCCESS",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ConfirmFingerprint {
    tenant_id: u64,
    file_id: u64,
    menu_id: u64,
    sheet_name: String,
}

#[derive(Debug)]
struct Batch {
    id: u64,
    fingerprint: ConfirmFingerprint,
    status: BatchStatus,
}

#[derive(Debug)]
enum Outcome {
    SubmitFailure,
    OrdinaryFailureAfterPage(String),
    CancelAfterPages {
        resources: Vec<String>,
        cleanup_failures: BTreeSet<String>,
    },
    Success(String),
}

#[derive(Debug, Default)]
struct ConfirmHarness {
    next_batch_id: u64,
    batches: Vec<Batch>,
    resources: BTreeSet<String>,
    registrations: BTreeMap<u64, Vec<String>>,
    confirm_attempts: usize,
    confirm_invocations: usize,
    cleanup_attempts: usize,
    cleanup_successes: usize,
    registry_clear_calls: usize,
    events: Vec<String>,
}

impl ConfirmHarness {
    fn invoke(&mut self, fingerprint: ConfirmFingerprint, guarded: bool, outcome: Outcome) {
        self.confirm_attempts += 1;
        if guarded
            && self.batches.iter().any(|batch| {
                batch.fingerprint == fingerprint && batch.status == BatchStatus::Success
            })
        {
            self.events
                .push("guard.duplicate-success-detected".to_owned());
            return;
        }

        self.confirm_invocations += 1;
        self.next_batch_id += 1;
        let batch_id = self.next_batch_id;
        self.batches.push(Batch {
            id: batch_id,
            fingerprint,
            status: BatchStatus::Pending,
        });
        self.events.push("batch.create".to_owned());

        match outcome {
            Outcome::SubmitFailure => {
                self.events.push("job.submit-failed".to_owned());
                self.mark(batch_id, BatchStatus::Failed, "batch.mark-failed");
            }
            Outcome::OrdinaryFailureAfterPage(resource) => {
                self.create_and_register(batch_id, &resource);
                self.events.push("batch.execution-failed".to_owned());
                self.mark(batch_id, BatchStatus::Failed, "batch.mark-failed");
            }
            Outcome::CancelAfterPages {
                resources,
                cleanup_failures,
            } => {
                for resource in resources {
                    self.create_and_register(batch_id, &resource);
                }
                self.events.push("cancel.observed".to_owned());
                self.cleanup(batch_id, &cleanup_failures);
                self.mark(batch_id, BatchStatus::Cancelled, "batch.mark-cancelled");
            }
            Outcome::Success(resource) => {
                self.create_and_register(batch_id, &resource);
                self.mark(batch_id, BatchStatus::Success, "batch.mark-success");
            }
        }
    }

    fn create_and_register(&mut self, batch_id: u64, resource: &str) {
        self.resources.insert(resource.to_owned());
        self.events.push(format!("page.create:{resource}"));
        self.registrations
            .entry(batch_id)
            .or_default()
            .push(resource.to_owned());
        self.events.push(format!("page.register:{resource}"));
    }

    fn cleanup(&mut self, batch_id: u64, cleanup_failures: &BTreeSet<String>) {
        let registered = self
            .registrations
            .get(&batch_id)
            .cloned()
            .unwrap_or_default();
        if registered.is_empty() {
            return;
        }
        for resource in registered {
            self.cleanup_attempts += 1;
            self.events.push(format!("cleanup.attempt:{resource}"));
            if cleanup_failures.contains(&resource) {
                self.events.push(format!("cleanup.failed:{resource}"));
                continue;
            }
            self.resources.remove(&resource);
            self.cleanup_successes += 1;
            self.events.push(format!("cleanup.success:{resource}"));
        }
        self.registrations.remove(&batch_id);
        self.registry_clear_calls += 1;
        self.events.push("cleanup.registry-clear".to_owned());
    }

    fn mark(&mut self, batch_id: u64, status: BatchStatus, event: &str) {
        self.batches
            .iter_mut()
            .find(|batch| batch.id == batch_id)
            .expect("batch exists")
            .status = status;
        self.events.push(event.to_owned());
    }

    fn observation(&self) -> ExpectedObservation {
        let mut residual_resources = self.resources.iter().cloned().collect::<Vec<_>>();
        residual_resources.sort();
        ExpectedObservation {
            batch_statuses: self
                .batches
                .iter()
                .map(|batch| batch.status.as_str().to_owned())
                .collect(),
            confirm_attempts: self.confirm_attempts,
            confirm_invocations: self.confirm_invocations,
            resource_count: self.resources.len(),
            registration_count: self.registrations.values().map(Vec::len).sum(),
            cleanup_attempts: self.cleanup_attempts,
            cleanup_successes: self.cleanup_successes,
            registry_clear_calls: self.registry_clear_calls,
            residual_resources,
            events: self.events.clone(),
        }
    }
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("rb04")
        .join("create-ledger-confirm-contracts.json")
}

fn suite() -> ContractSuite {
    serde_json::from_str(&fs::read_to_string(fixture_path()).expect("RB-04 fixture"))
        .expect("valid RB-04 fixture")
}

fn fingerprint() -> ConfirmFingerprint {
    ConfirmFingerprint {
        tenant_id: 1,
        file_id: 2,
        menu_id: 3,
        sheet_name: "sheet-a".to_owned(),
    }
}

fn execute_scenario(scenario: &str) -> ExpectedObservation {
    let mut harness = ConfirmHarness::default();
    match scenario {
        "submitFailure" => {
            harness.invoke(fingerprint(), false, Outcome::SubmitFailure);
        }
        "ordinaryFailureAfterPage" => {
            harness.invoke(
                fingerprint(),
                false,
                Outcome::OrdinaryFailureAfterPage("page-a".to_owned()),
            );
        }
        "cancelAfterPage" => {
            harness.invoke(
                fingerprint(),
                false,
                Outcome::CancelAfterPages {
                    resources: vec!["page-a".to_owned()],
                    cleanup_failures: BTreeSet::new(),
                },
            );
        }
        "cancelCleanupPartialFailure" => {
            harness.invoke(
                fingerprint(),
                false,
                Outcome::CancelAfterPages {
                    resources: vec!["page-a".to_owned(), "page-b".to_owned()],
                    cleanup_failures: BTreeSet::from(["page-a".to_owned()]),
                },
            );
        }
        "legacyDuplicate" => {
            harness.invoke(fingerprint(), false, Outcome::Success("page-a".to_owned()));
            harness.invoke(fingerprint(), false, Outcome::Success("page-b".to_owned()));
        }
        "guardedDuplicate" => {
            harness.invoke(fingerprint(), true, Outcome::Success("page-a".to_owned()));
            harness.invoke(fingerprint(), true, Outcome::Success("page-b".to_owned()));
        }
        value => panic!("unsupported RB-04 scenario: {value}"),
    }
    harness.observation()
}

fn assert_case(case_id: &str) {
    let case = suite()
        .cases
        .into_iter()
        .find(|case| case.case_id == case_id)
        .unwrap_or_else(|| panic!("missing RB-04 case: {case_id}"));
    assert!(!case.category.trim().is_empty());
    assert!(!case.requirement.trim().is_empty());
    assert_eq!(execute_scenario(&case.scenario), case.expected);
}

#[test]
fn contract_fixture_is_complete_and_explicitly_offline() {
    let suite = suite();
    assert_eq!(suite.schema_version, 1);
    assert_eq!(suite.stage, "RB-04");
    assert_eq!(
        suite.contract_kind,
        "offline-source-derived-create-ledger-confirm"
    );
    assert!(!suite.live_destructive_fault_injection_performed);
    assert!(!suite.source_semantics.confirm_idempotency_key_present);
    assert_eq!(
        suite.source_semantics.ordinary_failure_cleanup_policy,
        "mark-failed-without-created-page-cleanup"
    );
    assert_eq!(
        suite.source_semantics.cancel_cleanup_policy,
        "best-effort-cleanup-before-mark-cancelled"
    );
    assert_eq!(
        suite.source_semantics.cleanup_registry_policy,
        "clear-all-registrations-after-best-effort-loop"
    );
    assert_eq!(suite.cases.len(), 6);
    assert_eq!(
        suite
            .cases
            .iter()
            .map(|case| case.case_id.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        6
    );
    assert_eq!(
        suite
            .cases
            .iter()
            .filter(|case| case.category == "failure-residue")
            .count(),
        2
    );
    assert_eq!(
        suite
            .cases
            .iter()
            .filter(|case| case.category == "compensation")
            .count(),
        2
    );
    assert_eq!(
        suite
            .cases
            .iter()
            .filter(|case| case.category == "duplicate-submit")
            .count(),
        2
    );
}

#[test]
fn submit_failure_before_resource() {
    assert_case("submit-failure-before-resource");
}

#[test]
fn ordinary_failure_after_page_registration() {
    assert_case("ordinary-failure-after-page-registration");
}

#[test]
fn cancel_after_page_registration() {
    assert_case("cancel-after-page-registration");
}

#[test]
fn cancel_cleanup_partial_failure() {
    assert_case("cancel-cleanup-partial-failure");
}

#[test]
fn legacy_duplicate_confirm() {
    assert_case("legacy-duplicate-confirm");
}

#[test]
fn guarded_duplicate_confirm() {
    assert_case("guarded-duplicate-confirm");
}
