#![cfg(all(feature = "mysql", feature = "redis"))]

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Barrier, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Deserialize;
use zboss_dynamic_engine::{
    adapters::{
        memory::{FaultPoint, MemoryAdapters},
        mysql::{
            MysqlCellStatement, MysqlKeyPageResult, MysqlPageQueryAdapter, MysqlPageResult,
            MysqlPageStatements, MysqlStatementExecutor,
        },
        redis::{RedisLeaseAdapter, RedisLeaseClaim, RedisLeaseExecutor},
    },
    application::data::page::PageApplication,
    domain::{
        context::RequestContext,
        model::{FieldMetadata, PageMetadata, Row, Value},
        query::{Identifier, QueryPlan},
    },
    http::{
        dto::PageRequest,
        error::{ApiError, ErrorLayer},
        handler::handle_page,
    },
    ports::{
        evidence::EvidencePort,
        lease::{Lease, LeaseLockPort, LeasePriority},
        query::PageQueryPort,
        refresh::{RefreshPort, RefreshTarget},
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Matrix {
    schema_version: u32,
    stage: String,
    cases: Vec<MatrixCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatrixCase {
    case_id: String,
    category: String,
    requirement: String,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("prp11")
}

fn matrix() -> Matrix {
    serde_json::from_str(
        &fs::read_to_string(fixture_root().join("matrix.json")).expect("PRP-11 matrix"),
    )
    .expect("valid PRP-11 matrix")
}

fn ensure_matrix_case(case_id: &str) {
    let case = matrix()
        .cases
        .into_iter()
        .find(|case| case.case_id == case_id)
        .unwrap_or_else(|| panic!("missing PRP-11 matrix case: {case_id}"));
    assert!(!case.category.trim().is_empty());
    assert!(!case.requirement.trim().is_empty());
}

fn context(tenant_id: u64) -> RequestContext {
    RequestContext {
        tenant_id,
        user_id: 22,
        device_id: "prp11-device".to_owned(),
        request_id: format!("prp11-request-{tenant_id}"),
        trace_id: format!("prp11-trace-{tenant_id}"),
        datasource: "primary".to_owned(),
        snapshot_id: "snapshot-prp11".to_owned(),
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
        ],
    }
}

fn request(operator: Option<&str>) -> PageRequest {
    PageRequest {
        req_id: "prp11".to_owned(),
        operator: operator.map(str::to_owned),
        use_page_id: Some(7),
        page_no: Some(1),
        page_size: Some(20),
        skip_save_page_size: Some(true),
        ..PageRequest::default()
    }
}

fn application() -> (Arc<MemoryAdapters>, PageApplication<MemoryAdapters>) {
    let ports = Arc::new(MemoryAdapters::with_time(100));
    ports.insert_metadata(&context(1), metadata());
    ports.insert_rows(
        &context(1),
        "orders",
        vec![BTreeMap::from([
            ("customer".to_owned(), Value::Text("a".to_owned())),
            ("status".to_owned(), Value::Text("open".to_owned())),
        ])],
    );
    let application = PageApplication::new(Arc::clone(&ports));
    (ports, application)
}

fn plan() -> QueryPlan {
    QueryPlan {
        table: Identifier::parse("orders").expect("table identifier"),
        fields: vec![Identifier::parse("customer").expect("field identifier")],
        where_predicates: vec![],
        having_predicates: vec![],
        group_by: vec![],
        order_by: vec![],
        aggregates: vec![],
        page_no: 1,
        page_size: 20,
    }
}

fn run_application_fault(point: FaultPoint) {
    let (ports, application) = application();
    ports.inject_fault(point);
    let (status, envelope) = handle_page(&application, &context(1), request(None));
    assert_eq!(status, 503);
    assert_eq!(envelope.code, 503_001);
    assert!(envelope.data.is_none());
    assert!(ports.query_evidence().is_empty());
    assert!(ports.events().is_empty());
}

fn run_refresh_fault(point: FaultPoint, expected_events: &[&str]) {
    let (ports, application) = application();
    ports.inject_fault(point);
    let (status, envelope) = handle_page(&application, &context(1), request(Some("REFRESH")));
    assert_eq!(status, 503);
    assert_eq!(envelope.code, 503_001);
    assert_eq!(
        ports
            .events()
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        expected_events
    );
    ports.clear_faults();
    assert!(
        ports
            .acquire(
                &context(1),
                "tenant:1:page:7:panel:8:column:none",
                "recovery",
                LeasePriority::Manual,
                50,
            )
            .expect("recovery acquisition")
            .is_some(),
        "refresh failure must release its lease"
    );
}

#[derive(Debug)]
struct FailingMysqlExecutor {
    error: ApiError,
}

impl MysqlStatementExecutor for FailingMysqlExecutor {
    fn execute_flat_page(
        &self,
        _context: &RequestContext,
        _statements: &MysqlPageStatements,
    ) -> Result<MysqlPageResult, ApiError> {
        Err(self.error.clone())
    }

    fn execute_key_page(
        &self,
        _context: &RequestContext,
        _statements: &MysqlPageStatements,
    ) -> Result<MysqlKeyPageResult, ApiError> {
        Err(self.error.clone())
    }

    fn execute_cells(
        &self,
        _context: &RequestContext,
        _statement: &MysqlCellStatement,
    ) -> Result<Vec<Row>, ApiError> {
        Err(self.error.clone())
    }
}

fn run_sql_failure(message: &str) {
    let adapter = MysqlPageQueryAdapter::new(FailingMysqlExecutor {
        error: ApiError::query(message, true),
    });
    let error = adapter.query(&context(1), &plan()).unwrap_err();
    assert_eq!(error.layer, ErrorLayer::Query);
    assert_eq!(error.http_status, 503);
    assert!(error.retryable);
    assert_eq!(error.message, message);
}

#[derive(Debug, Default)]
struct RedisState {
    now_millis: u64,
    fencing_token: u64,
    lease: Option<Lease>,
}

#[derive(Debug, Clone, Default)]
struct RedisHarness {
    state: Arc<Mutex<RedisState>>,
    fail_acquire: Arc<AtomicBool>,
    fail_release: Arc<AtomicBool>,
}

impl RedisHarness {
    fn set_time(&self, now_millis: u64) {
        self.state.lock().expect("Redis state").now_millis = now_millis;
    }

    fn fail_acquire(&self) {
        self.fail_acquire.store(true, Ordering::SeqCst);
    }

    fn fail_release(&self) {
        self.fail_release.store(true, Ordering::SeqCst);
    }
}

impl RedisLeaseExecutor for RedisHarness {
    fn acquire_atomic(
        &self,
        _context: &RequestContext,
        claim: &RedisLeaseClaim,
    ) -> Result<Option<Lease>, ApiError> {
        if self.fail_acquire.load(Ordering::SeqCst) {
            return Err(ApiError::refresh("Redis acquire unavailable", true));
        }
        let mut state = self.state.lock().expect("Redis state");
        if state
            .lease
            .as_ref()
            .is_some_and(|lease| lease.expires_at_millis > state.now_millis)
        {
            return Ok(None);
        }
        state.fencing_token += 1;
        let lease = Lease {
            key: claim.key.clone(),
            owner_token: claim.owner_token.clone(),
            fencing_token: state.fencing_token,
            expires_at_millis: state.now_millis.saturating_add(claim.ttl_millis),
            priority: claim.priority,
        };
        state.lease = Some(lease.clone());
        Ok(Some(lease))
    }

    fn release_if_owner_and_fence(
        &self,
        _context: &RequestContext,
        lease: &Lease,
    ) -> Result<bool, ApiError> {
        if self.fail_release.load(Ordering::SeqCst) {
            return Err(ApiError::refresh("Redis release unavailable", true));
        }
        let mut state = self.state.lock().expect("Redis state");
        if state.lease.as_ref().is_some_and(|current| {
            current.key == lease.key
                && current.owner_token == lease.owner_token
                && current.fencing_token == lease.fencing_token
        }) {
            state.lease = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

fn redis_key(tenant_id: u64, column_id: u64) -> String {
    format!("tenant:{tenant_id}:page:7:panel:8:column:{column_id}")
}

fn run_redis_expiry(assert_stale_release: bool) {
    let executor = RedisHarness::default();
    executor.set_time(100);
    let adapter = RedisLeaseAdapter::new(executor.clone());
    let key = redis_key(1, 9);
    let first = adapter
        .acquire(&context(1), &key, "first", LeasePriority::Automatic, 50)
        .expect("first Redis acquisition")
        .expect("first Redis lease");
    assert!(
        adapter
            .acquire(&context(1), &key, "blocked", LeasePriority::Automatic, 50,)
            .expect("blocked Redis acquisition")
            .is_none()
    );
    executor.set_time(151);
    let second = adapter
        .acquire(&context(1), &key, "second", LeasePriority::Automatic, 50)
        .expect("second Redis acquisition")
        .expect("second Redis lease");
    assert!(second.fencing_token > first.fencing_token);
    if assert_stale_release {
        assert!(!adapter.release(&context(1), &first).expect("stale release"));
    }
    assert!(
        adapter
            .release(&context(1), &second)
            .expect("owner release")
    );
}

fn run_interruption(stage: &str) {
    let ports = MemoryAdapters::with_time(100);
    let key = "tenant:1:page:7:panel:8:column:9";
    let context = context(1);
    ports.insert_rows(&context, "orders", vec![Row::new()]);
    let lease = ports
        .acquire(&context, key, "interrupted", LeasePriority::Manual, 50)
        .expect("interrupted acquisition")
        .expect("interrupted lease");
    ports
        .append(&context, "refresh.acquire")
        .expect("acquire evidence");
    let target = RefreshTarget {
        page_id: 7,
        panel_id: 8,
        column_id: Some(9),
    };
    let mut expected = vec!["refresh.acquire"];
    if matches!(stage, "sync" | "query" | "release") {
        ports.sync(&context, &target, &lease).expect("sync");
        expected.push("refresh.sync");
    }
    if matches!(stage, "query" | "release") {
        ports
            .update_timestamp(&context, &target, &lease)
            .expect("timestamp");
        ports
            .clear_undo(&context, &target, &lease)
            .expect("undo clear");
        ports
            .reconcile(&context, &target, &lease)
            .expect("reconcile");
        ports.query(&context, &plan()).expect("query");
        ports
            .append(&context, "refresh.query")
            .expect("query evidence");
        expected.extend([
            "refresh.timestamp",
            "refresh.undo-clear",
            "refresh.reconcile",
            "refresh.query",
        ]);
    }
    if stage == "release" {
        ports.inject_fault(FaultPoint::LeaseRelease);
        assert!(ports.release(&context, &lease).is_err());
        ports.clear_faults();
    }
    assert_eq!(
        ports
            .events()
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        expected
    );
    assert!(
        ports
            .acquire(&context, key, "before-expiry", LeasePriority::Manual, 50,)
            .expect("pre-expiry acquisition")
            .is_none()
    );
    ports.set_time(151);
    let recovered = ports
        .acquire(&context, key, "recovered", LeasePriority::Manual, 50)
        .expect("post-expiry acquisition")
        .expect("recovered owner");
    assert!(recovered.fencing_token > lease.fencing_token);
    assert!(
        !ports
            .release(&context, &lease)
            .expect("stale owner release")
    );
    assert!(
        ports
            .release(&context, &recovered)
            .expect("recovered owner release")
    );
}

fn run_case(case_id: &str) {
    ensure_matrix_case(case_id);
    match case_id {
        "fault-metadata" => run_application_fault(FaultPoint::Metadata),
        "fault-permission" => run_application_fault(FaultPoint::Permission),
        "fault-query" => run_application_fault(FaultPoint::Query),
        "fault-sql-timeout" => run_sql_failure("MySQL statement timeout"),
        "fault-sql-deadlock" => run_sql_failure("MySQL deadlock victim"),
        "fault-invalid-identifier" => {
            let ports = Arc::new(MemoryAdapters::default());
            let mut unsafe_metadata = metadata();
            unsafe_metadata.table = "orders; DROP TABLE users".to_owned();
            ports.insert_metadata(&context(1), unsafe_metadata);
            let application = PageApplication::new(ports);
            let (status, envelope) = handle_page(&application, &context(1), request(None));
            assert_eq!(status, 400);
            assert_eq!(envelope.code, 400_001);
            assert!(envelope.msg.contains("InvalidIdentifier"));
        }
        "fault-redis-acquire" => {
            let executor = RedisHarness::default();
            executor.fail_acquire();
            let adapter = RedisLeaseAdapter::new(executor);
            let error = adapter
                .acquire(
                    &context(1),
                    &redis_key(1, 9),
                    "owner",
                    LeasePriority::Automatic,
                    50,
                )
                .unwrap_err();
            assert_eq!(error.layer, ErrorLayer::Refresh);
            assert!(error.retryable);
        }
        "fault-redis-release" => {
            let executor = RedisHarness::default();
            let adapter = RedisLeaseAdapter::new(executor.clone());
            let lease = adapter
                .acquire(
                    &context(1),
                    &redis_key(1, 9),
                    "owner",
                    LeasePriority::Manual,
                    50,
                )
                .expect("Redis acquisition")
                .expect("Redis lease");
            executor.fail_release();
            let error = adapter.release(&context(1), &lease).unwrap_err();
            assert_eq!(error.layer, ErrorLayer::Refresh);
            assert!(error.retryable);
        }
        "fault-redis-lease-expiry" => run_redis_expiry(false),
        "fault-refresh-sync" => run_refresh_fault(
            FaultPoint::RefreshSync,
            &["refresh.acquire", "refresh.unlock"],
        ),
        "fault-refresh-timestamp" => run_refresh_fault(
            FaultPoint::RefreshTimestamp,
            &["refresh.acquire", "refresh.sync", "refresh.unlock"],
        ),
        "fault-refresh-undo" => run_refresh_fault(
            FaultPoint::RefreshUndoClear,
            &[
                "refresh.acquire",
                "refresh.sync",
                "refresh.timestamp",
                "refresh.unlock",
            ],
        ),
        "fault-refresh-reconcile" => run_refresh_fault(
            FaultPoint::RefreshReconcile,
            &[
                "refresh.acquire",
                "refresh.sync",
                "refresh.timestamp",
                "refresh.undo-clear",
                "refresh.unlock",
            ],
        ),
        "fault-refresh-query" => run_refresh_fault(
            FaultPoint::Query,
            &[
                "refresh.acquire",
                "refresh.sync",
                "refresh.timestamp",
                "refresh.undo-clear",
                "refresh.reconcile",
                "refresh.unlock",
            ],
        ),
        "interrupt-acquire" => run_interruption("acquire"),
        "interrupt-sync" => run_interruption("sync"),
        "interrupt-query" => run_interruption("query"),
        "interrupt-release" => run_interruption("release"),
        "concurrent-same-scope" => {
            let ports = Arc::new(MemoryAdapters::with_time(100));
            let barrier = Arc::new(Barrier::new(12));
            let owners = (0..12)
                .map(|index| {
                    let ports = Arc::clone(&ports);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        ports
                            .acquire(
                                &context(1),
                                &redis_key(1, 9),
                                &format!("owner-{index}"),
                                LeasePriority::Automatic,
                                500,
                            )
                            .expect("concurrent acquisition")
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|handle| handle.join().expect("owner thread"))
                .collect::<Vec<_>>();
            assert_eq!(owners.len(), 1);
        }
        "concurrent-tenant-isolation" => {
            let ports = Arc::new(MemoryAdapters::with_time(100));
            let barrier = Arc::new(Barrier::new(2));
            let leases = [1_u64, 2]
                .into_iter()
                .map(|tenant_id| {
                    let ports = Arc::clone(&ports);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        ports
                            .acquire(
                                &context(tenant_id),
                                &redis_key(tenant_id, 9),
                                &format!("owner-{tenant_id}"),
                                LeasePriority::Automatic,
                                500,
                            )
                            .expect("tenant acquisition")
                            .expect("tenant owner")
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().expect("tenant thread"))
                .collect::<Vec<_>>();
            assert_eq!(leases.len(), 2);
            assert_ne!(leases[0].key, leases[1].key);
        }
        "concurrent-column-granularity" => {
            let ports = MemoryAdapters::with_time(100);
            let first = ports
                .acquire(
                    &context(1),
                    &redis_key(1, 9),
                    "first",
                    LeasePriority::Automatic,
                    500,
                )
                .expect("first column")
                .expect("first owner");
            assert!(
                ports
                    .acquire(
                        &context(1),
                        &redis_key(1, 9),
                        "duplicate",
                        LeasePriority::Automatic,
                        500,
                    )
                    .expect("duplicate column")
                    .is_none()
            );
            let other = ports
                .acquire(
                    &context(1),
                    &redis_key(1, 10),
                    "other",
                    LeasePriority::Automatic,
                    500,
                )
                .expect("other column")
                .expect("other owner");
            assert_ne!(first.key, other.key);
        }
        "concurrent-expired-new-owner" => {
            let ports = MemoryAdapters::with_time(100);
            let first = ports
                .acquire(
                    &context(1),
                    &redis_key(1, 9),
                    "first",
                    LeasePriority::Automatic,
                    50,
                )
                .expect("first acquisition")
                .expect("first lease");
            ports.set_time(151);
            let second = ports
                .acquire(
                    &context(1),
                    &redis_key(1, 9),
                    "second",
                    LeasePriority::Automatic,
                    50,
                )
                .expect("second acquisition")
                .expect("second lease");
            assert!(second.fencing_token > first.fencing_token);
        }
        "concurrent-stale-owner-release" => run_redis_expiry(true),
        value => panic!("unsupported PRP-11 matrix case: {value}"),
    }
}

#[test]
fn matrix_is_complete_unique_and_ordered() {
    let matrix = matrix();
    assert_eq!(matrix.schema_version, 1);
    assert_eq!(matrix.stage, "PRP-11");
    assert_eq!(matrix.cases.len(), 23);
    assert_eq!(
        matrix
            .cases
            .iter()
            .map(|case| &case.case_id)
            .collect::<BTreeSet<_>>()
            .len(),
        23
    );
    assert_eq!(
        matrix
            .cases
            .iter()
            .filter(|case| case.category == "fault")
            .count(),
        14
    );
    assert_eq!(
        matrix
            .cases
            .iter()
            .filter(|case| case.category == "interruption")
            .count(),
        4
    );
    assert_eq!(
        matrix
            .cases
            .iter()
            .filter(|case| case.category == "concurrency")
            .count(),
        5
    );
}

macro_rules! matrix_test {
    ($name:ident, $case_id:literal) => {
        #[test]
        fn $name() {
            run_case($case_id);
        }
    };
}

matrix_test!(fault_metadata, "fault-metadata");
matrix_test!(fault_permission, "fault-permission");
matrix_test!(fault_query, "fault-query");
matrix_test!(fault_sql_timeout, "fault-sql-timeout");
matrix_test!(fault_sql_deadlock, "fault-sql-deadlock");
matrix_test!(fault_invalid_identifier, "fault-invalid-identifier");
matrix_test!(fault_redis_acquire, "fault-redis-acquire");
matrix_test!(fault_redis_release, "fault-redis-release");
matrix_test!(fault_redis_lease_expiry, "fault-redis-lease-expiry");
matrix_test!(fault_refresh_sync, "fault-refresh-sync");
matrix_test!(fault_refresh_timestamp, "fault-refresh-timestamp");
matrix_test!(fault_refresh_undo, "fault-refresh-undo");
matrix_test!(fault_refresh_reconcile, "fault-refresh-reconcile");
matrix_test!(fault_refresh_query, "fault-refresh-query");
matrix_test!(interrupt_acquire, "interrupt-acquire");
matrix_test!(interrupt_sync, "interrupt-sync");
matrix_test!(interrupt_query, "interrupt-query");
matrix_test!(interrupt_release, "interrupt-release");
matrix_test!(concurrent_same_scope, "concurrent-same-scope");
matrix_test!(concurrent_tenant_isolation, "concurrent-tenant-isolation");
matrix_test!(
    concurrent_column_granularity,
    "concurrent-column-granularity"
);
matrix_test!(concurrent_expired_new_owner, "concurrent-expired-new-owner");
matrix_test!(
    concurrent_stale_owner_release,
    "concurrent-stale-owner-release"
);
