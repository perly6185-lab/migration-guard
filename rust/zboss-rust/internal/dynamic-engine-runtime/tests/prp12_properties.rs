use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use zboss_dynamic_engine::{
    adapters::memory::{FaultPoint, MemoryAdapters},
    application::data::page::PageApplication,
    domain::{
        context::RequestContext,
        horizontal::{aggregate_pivots, paginate_distinct_keys},
        model::{BusinessKey, FieldMetadata, PageMetadata, Row, Value},
        query::{
            Aggregate, AggregateProjection, Expression, Identifier, Operator, Predicate, QueryPlan,
        },
    },
    http::{dto::PageRequest, handler::handle_page},
    ports::{
        lease::{LeaseLockPort, LeasePriority},
        query::PageQueryPort,
    },
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PropertySuite {
    schema_version: u32,
    stage: String,
    generator: String,
    properties: Vec<PropertyConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PropertyConfig {
    property_id: String,
    seed: u64,
    iterations: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaySuite {
    schema_version: u32,
    stage: String,
    replays: Vec<ReplayConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayConfig {
    property_id: String,
    seed: u64,
    iteration: u32,
    observed_failure: String,
    resolution: String,
    status: String,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("prp12")
}

fn suite() -> PropertySuite {
    serde_json::from_str(
        &fs::read_to_string(fixture_root().join("property-config.json"))
            .expect("PRP-12 property configuration"),
    )
    .expect("valid PRP-12 property configuration")
}

fn property(property_id: &str) -> PropertyConfig {
    suite()
        .properties
        .into_iter()
        .find(|property| property.property_id == property_id)
        .unwrap_or_else(|| panic!("missing PRP-12 property: {property_id}"))
}

fn replay_suite() -> ReplaySuite {
    serde_json::from_str(
        &fs::read_to_string(fixture_root().join("replay-regressions.json"))
            .expect("PRP-12 replay regressions"),
    )
    .expect("valid PRP-12 replay regressions")
}

#[derive(Debug)]
struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    fn new(seed: u64) -> Self {
        assert_ne!(seed, 0, "LCG seed must be non-zero");
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.state
    }

    fn usize(&mut self, upper_exclusive: usize) -> usize {
        usize::try_from(self.next_u64() % upper_exclusive as u64).expect("bounded random value")
    }

    fn i64(&mut self, minimum: i64, maximum_inclusive: i64) -> i64 {
        let width = u64::try_from(maximum_inclusive - minimum + 1).expect("random range");
        minimum + i64::try_from(self.next_u64() % width).expect("bounded signed value")
    }

    fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
        self.next_u64() % denominator < numerator
    }

    fn shuffle<T>(&mut self, values: &mut [T]) {
        for index in (1..values.len()).rev() {
            values.swap(index, self.usize(index + 1));
        }
    }
}

fn property_failure(
    property: &PropertyConfig,
    iteration: u32,
    detail: impl std::fmt::Display,
) -> ! {
    panic!(
        "PROPERTY_FAILURE property={} seed={} iteration={iteration}: {detail}",
        property.property_id, property.seed
    )
}

fn property_assert(
    condition: bool,
    property: &PropertyConfig,
    iteration: u32,
    detail: impl std::fmt::Display,
) {
    if !condition {
        property_failure(property, iteration, detail);
    }
}

fn context() -> RequestContext {
    RequestContext {
        tenant_id: 1,
        user_id: 2,
        device_id: "prp12-device".to_owned(),
        request_id: "prp12-request".to_owned(),
        trace_id: "prp12-trace".to_owned(),
        datasource: "primary".to_owned(),
        snapshot_id: "snapshot-prp12".to_owned(),
    }
}

fn id(value: &str) -> Identifier {
    Identifier::parse(value).expect("trusted property identifier")
}

fn row(customer: &str, status: &str, amount: Value) -> Row {
    BTreeMap::from([
        ("amount".to_owned(), amount),
        ("customer".to_owned(), Value::Text(customer.to_owned())),
        ("status".to_owned(), Value::Text(status.to_owned())),
    ])
}

fn grouped_plan(page_no: u32, page_size: u32, threshold: i64) -> QueryPlan {
    QueryPlan {
        table: id("orders"),
        fields: vec![id("customer"), id("status"), id("amount")],
        where_predicates: vec![Predicate {
            expression: Expression {
                column: id("status"),
                aggregate: None,
            },
            operator: Operator::Equal,
            values: vec![Value::Text("open".to_owned())],
        }],
        having_predicates: vec![Predicate {
            expression: Expression {
                column: id("amount"),
                aggregate: Some(Aggregate::Sum),
            },
            operator: Operator::GreaterThan,
            values: vec![Value::Integer(threshold)],
        }],
        group_by: vec![id("customer")],
        order_by: vec![],
        aggregates: vec![AggregateProjection {
            output_key: "total".to_owned(),
            column: id("amount"),
            aggregate: Aggregate::Sum,
        }],
        page_no,
        page_size,
    }
}

fn horizontal_plan(page_no: u32, page_size: u32) -> QueryPlan {
    QueryPlan {
        table: id("orders"),
        fields: vec![id("customer"), id("amount")],
        where_predicates: vec![],
        having_predicates: vec![],
        group_by: vec![id("customer")],
        order_by: vec![],
        aggregates: vec![],
        page_no,
        page_size,
    }
}

fn generated_group_rows(rng: &mut DeterministicRng) -> (Vec<Row>, BTreeMap<String, i64>, i64) {
    let customer_count = 1 + rng.usize(12);
    let threshold = rng.i64(0, 160);
    let mut rows = Vec::new();
    let mut open_sums = BTreeMap::new();
    for customer_index in 0..customer_count {
        let customer = format!("customer-{customer_index:02}");
        let row_count = 1 + rng.usize(7);
        for _ in 0..row_count {
            let open = rng.chance(1, 2);
            let amount = rng.i64(1, 60);
            if open {
                *open_sums.entry(customer.clone()).or_insert(0) += amount;
            }
            rows.push(row(
                &customer,
                if open { "open" } else { "closed" },
                Value::Integer(amount),
            ));
        }
    }
    rng.shuffle(&mut rows);
    (rows, open_sums, threshold)
}

fn expected_survivors(open_sums: &BTreeMap<String, i64>, threshold: i64) -> BTreeSet<BusinessKey> {
    open_sums
        .iter()
        .filter(|(_, sum)| **sum > threshold)
        .map(|(customer, _)| BusinessKey(vec![Value::Text(customer.clone())]))
        .collect()
}

#[test]
fn property_configuration_is_frozen_complete_and_unique() {
    let suite = suite();
    assert_eq!(suite.schema_version, 1);
    assert_eq!(suite.stage, "PRP-12");
    assert_eq!(suite.generator, "lcg64-v1");
    assert_eq!(suite.properties.len(), 7);
    assert_eq!(
        suite
            .properties
            .iter()
            .map(|property| &property.property_id)
            .collect::<BTreeSet<_>>()
            .len(),
        7
    );
    assert!(suite.properties.iter().all(|property| property.seed != 0));
    assert_eq!(
        suite
            .properties
            .iter()
            .map(|property| property.iterations)
            .sum::<u32>(),
        928
    );
    let replays = replay_suite();
    assert_eq!(replays.schema_version, 1);
    assert_eq!(replays.stage, "PRP-12");
    assert_eq!(replays.replays.len(), 1);
    assert!(replays.replays.iter().all(|replay| {
        replay.property_id == "failure-path-eventual-unlock"
            && replay.seed != 0
            && !replay.observed_failure.trim().is_empty()
            && !replay.resolution.trim().is_empty()
            && replay.status == "replayed-pass"
    }));
}

#[test]
fn where_is_always_applied_before_having() {
    let property = property("where-before-having");
    let mut rng = DeterministicRng::new(property.seed);
    for iteration in 0..property.iterations {
        let (rows, open_sums, threshold) = generated_group_rows(&mut rng);
        let expected = expected_survivors(&open_sums, threshold);
        let adapter = MemoryAdapters::default();
        adapter.insert_rows(&context(), "orders", rows);
        let result = adapter
            .query(&context(), &grouped_plan(1, 100, threshold))
            .unwrap_or_else(|error| property_failure(&property, iteration, error.message));
        let actual = result.page_keys.iter().cloned().collect::<BTreeSet<_>>();
        property_assert(
            actual == expected,
            &property,
            iteration,
            "WHERE-filtered group sums diverged from HAVING survivors",
        );
        property_assert(
            result.rows.iter().all(|row| {
                row.get("status") == Some(&Value::Text("open".to_owned()))
                    && expected.contains(&BusinessKey(vec![
                        row.get("customer").cloned().unwrap_or(Value::Null),
                    ]))
            }),
            &property,
            iteration,
            "a pre-WHERE row leaked into a surviving HAVING group",
        );
    }
}

#[test]
fn horizontal_pages_never_duplicate_or_omit_keys() {
    let property = property("horizontal-pages-exact");
    let mut rng = DeterministicRng::new(property.seed);
    for iteration in 0..property.iterations {
        let key_count = 1 + rng.usize(40);
        let page_size = u32::try_from(1 + rng.usize(9)).expect("page size");
        let mut rows = Vec::new();
        let expected = (0..key_count)
            .map(|index| {
                let customer = format!("key-{index:02}");
                for cell in 0..(1 + rng.usize(5)) {
                    rows.push(row(
                        &customer,
                        "open",
                        Value::Integer(i64::try_from(cell).expect("cell")),
                    ));
                }
                BusinessKey(vec![Value::Text(customer)])
            })
            .collect::<BTreeSet<_>>();
        rng.shuffle(&mut rows);
        let adapter = MemoryAdapters::default();
        adapter.insert_rows(&context(), "orders", rows);
        let page_count = key_count.div_ceil(page_size as usize);
        let mut ordered = Vec::new();
        for page_index in 0..page_count {
            let result = adapter
                .query(
                    &context(),
                    &horizontal_plan(
                        u32::try_from(page_index + 1).expect("page number"),
                        page_size,
                    ),
                )
                .unwrap_or_else(|error| property_failure(&property, iteration, error.message));
            property_assert(
                result.total == key_count as u64,
                &property,
                iteration,
                "distinct total changed across pages",
            );
            ordered.extend(result.page_keys);
        }
        let actual = ordered.iter().cloned().collect::<BTreeSet<_>>();
        property_assert(
            ordered.len() == actual.len(),
            &property,
            iteration,
            "a business key appeared on more than one page",
        );
        property_assert(
            actual == expected,
            &property,
            iteration,
            "the page-key union omitted or introduced a business key",
        );
    }
}

#[test]
fn all_page_keys_equal_having_survivors() {
    let property = property("having-survivor-union");
    let mut rng = DeterministicRng::new(property.seed);
    for iteration in 0..property.iterations {
        let (rows, open_sums, threshold) = generated_group_rows(&mut rng);
        let expected = expected_survivors(&open_sums, threshold);
        let page_size = u32::try_from(1 + rng.usize(5)).expect("page size");
        let page_count = expected.len().div_ceil(page_size as usize).max(1);
        let adapter = MemoryAdapters::default();
        adapter.insert_rows(&context(), "orders", rows);
        let mut actual = BTreeSet::new();
        for page_index in 0..page_count {
            let result = adapter
                .query(
                    &context(),
                    &grouped_plan(
                        u32::try_from(page_index + 1).expect("page number"),
                        page_size,
                        threshold,
                    ),
                )
                .unwrap_or_else(|error| property_failure(&property, iteration, error.message));
            property_assert(
                result.total == expected.len() as u64,
                &property,
                iteration,
                "HAVING survivor total changed across pages",
            );
            for key in result.page_keys {
                property_assert(
                    actual.insert(key),
                    &property,
                    iteration,
                    "a HAVING survivor was repeated across pages",
                );
            }
        }
        property_assert(
            actual == expected,
            &property,
            iteration,
            "page-key union differs from HAVING survivors",
        );
    }
}

#[test]
fn average_always_retains_complete_sum_and_count() {
    let property = property("average-full-sum-count");
    let mut rng = DeterministicRng::new(property.seed);
    for iteration in 0..property.iterations {
        let row_count = 1 + rng.usize(192);
        let mut rows = Vec::with_capacity(row_count);
        let mut sum = 0_i64;
        let mut count = 0_u64;
        for index in 0..row_count {
            let value = if index != 0 && rng.chance(1, 5) {
                Value::Null
            } else {
                let amount = rng.i64(-10_000, 10_000);
                sum += amount;
                count += 1;
                Value::Integer(amount)
            };
            rows.push(row("one-group", "open", value));
        }
        let pivots = aggregate_pivots(
            &rows,
            &["customer".to_owned()],
            &[AggregateProjection {
                output_key: "average".to_owned(),
                column: id("amount"),
                aggregate: Aggregate::Average,
            }],
        )
        .unwrap_or_else(|error| property_failure(&property, iteration, format!("{error:?}")));
        let average = &pivots[0].values["average"];
        property_assert(
            average.sum == Some(sum),
            &property,
            iteration,
            "AVG sum accumulator is incomplete",
        );
        property_assert(
            average.count == Some(count),
            &property,
            iteration,
            "AVG count accumulator is incomplete",
        );
        property_assert(
            average.value == Value::Integer(sum / i64::try_from(count).expect("bounded count")),
            &property,
            iteration,
            "AVG value does not equal full sum/count",
        );
    }
}

#[test]
fn composite_business_keys_are_typed_and_collision_free() {
    let property = property("composite-key-collision-free");
    let mut rng = DeterministicRng::new(property.seed);
    for iteration in 0..property.iterations {
        let mut pairs = vec![
            (Value::Null, Value::Text("x".to_owned())),
            (Value::Text("null".to_owned()), Value::Text("x".to_owned())),
            (Value::Integer(1), Value::Text("x".to_owned())),
            (Value::Text("1".to_owned()), Value::Text("x".to_owned())),
            (Value::Text("a|b".to_owned()), Value::Text("c".to_owned())),
            (Value::Text("a".to_owned()), Value::Text("b|c".to_owned())),
        ];
        for generated in 0..(1 + rng.usize(20)) {
            let first = match rng.usize(4) {
                0 => Value::Null,
                1 => Value::Integer(rng.i64(-5, 5)),
                2 => Value::Text(format!("null|{generated}")),
                _ => Value::Text(format!("{}|{}", rng.usize(5), generated)),
            };
            let second = Value::Text(format!("segment|{}", rng.usize(9)));
            pairs.push((first, second));
        }
        let rows = pairs
            .iter()
            .map(|(first, second)| {
                BTreeMap::from([
                    ("first".to_owned(), first.clone()),
                    ("second".to_owned(), second.clone()),
                ])
            })
            .collect::<Vec<_>>();
        let expected = pairs
            .into_iter()
            .map(|(first, second)| BusinessKey(vec![first, second]))
            .collect::<BTreeSet<_>>();
        let page = paginate_distinct_keys(
            &rows,
            &["first".to_owned(), "second".to_owned()],
            1,
            u32::try_from(rows.len()).expect("row count"),
        );
        let actual = page.page_keys.into_iter().collect::<BTreeSet<_>>();
        let serialized = expected
            .iter()
            .map(|key| serde_json::to_string(key).expect("business key serialization"))
            .collect::<BTreeSet<_>>();
        property_assert(
            actual == expected,
            &property,
            iteration,
            "typed composite keys collided during pagination",
        );
        property_assert(
            serialized.len() == expected.len(),
            &property,
            iteration,
            "typed composite keys collided during serialization",
        );
    }
}

fn application() -> (Arc<MemoryAdapters>, PageApplication<MemoryAdapters>) {
    let ports = Arc::new(MemoryAdapters::with_time(100));
    ports.insert_metadata(
        &context(),
        PageMetadata {
            version: 1,
            page_id: 7,
            panel_id: 8,
            table: "orders".to_owned(),
            business_key: vec!["customer".to_owned()],
            fields: vec![FieldMetadata {
                key: "customer".to_owned(),
                column: "customer".to_owned(),
                aggregate: None,
            }],
        },
    );
    ports.insert_rows(
        &context(),
        "orders",
        vec![BTreeMap::from([(
            "customer".to_owned(),
            Value::Text("a".to_owned()),
        )])],
    );
    let application = PageApplication::new(Arc::clone(&ports));
    (ports, application)
}

fn refresh_request() -> PageRequest {
    PageRequest {
        req_id: "prp12-refresh".to_owned(),
        operator: Some("REFRESH".to_owned()),
        use_page_id: Some(7),
        page_no: Some(1),
        page_size: Some(20),
        ..PageRequest::default()
    }
}

#[test]
fn refresh_has_exactly_one_terminal_effect() {
    let property = property("terminal-effect-unique");
    let mut rng = DeterministicRng::new(property.seed);
    let faults = [
        None,
        Some(FaultPoint::RefreshSync),
        Some(FaultPoint::RefreshTimestamp),
        Some(FaultPoint::RefreshUndoClear),
        Some(FaultPoint::RefreshReconcile),
        Some(FaultPoint::Query),
    ];
    for iteration in 0..property.iterations {
        let (ports, application) = application();
        let fault = faults[rng.usize(faults.len())];
        if let Some(fault) = fault {
            ports.inject_fault(fault);
        }
        let (status, _) = handle_page(&application, &context(), refresh_request());
        property_assert(
            (fault.is_none() && status == 200) || (fault.is_some() && status == 503),
            &property,
            iteration,
            "refresh status does not match injected outcome",
        );
        let events = ports.events();
        let terminal_count = events
            .iter()
            .filter(|event| event.kind == "refresh.unlock")
            .count();
        property_assert(
            terminal_count == 1,
            &property,
            iteration,
            "refresh emitted zero or multiple terminal unlock effects",
        );
        property_assert(
            events
                .last()
                .is_some_and(|event| event.kind == "refresh.unlock"),
            &property,
            iteration,
            "an effect occurred after the terminal unlock",
        );
    }
}

#[test]
fn every_failure_path_eventually_has_no_owner_lock() {
    let property = property("failure-path-eventual-unlock");
    let mut rng = DeterministicRng::new(property.seed);
    let faults = [
        FaultPoint::Metadata,
        FaultPoint::Permission,
        FaultPoint::Query,
        FaultPoint::Preference,
        FaultPoint::LeaseAcquire,
        FaultPoint::LeaseRelease,
        FaultPoint::RefreshSync,
        FaultPoint::RefreshTimestamp,
        FaultPoint::RefreshUndoClear,
        FaultPoint::RefreshReconcile,
        FaultPoint::Event,
    ];
    for iteration in 0..property.iterations {
        let fault = faults[rng.usize(faults.len())];
        assert_failure_cleanup(&property, iteration, fault);
    }
    for replay in replay_suite().replays {
        let replay_property = PropertyConfig {
            property_id: replay.property_id,
            seed: replay.seed,
            iterations: 1,
        };
        assert_failure_cleanup(&replay_property, replay.iteration, FaultPoint::Preference);
    }
}

fn assert_failure_cleanup(property: &PropertyConfig, iteration: u32, fault: FaultPoint) {
    let (ports, application) = application();
    ports.inject_fault(fault);
    let (status, _) = handle_page(&application, &context(), refresh_request());
    property_assert(
        status != 200,
        property,
        iteration,
        "injected failure unexpectedly succeeded",
    );
    ports.clear_faults();
    let key = "tenant:1:page:7:panel:8:column:none";
    let immediate = ports
        .acquire(&context(), key, "recovery", LeasePriority::Manual, 50)
        .unwrap_or_else(|error| property_failure(property, iteration, error.message));
    let recovered = if fault == FaultPoint::LeaseRelease {
        property_assert(
            immediate.is_none(),
            property,
            iteration,
            "release failure unexpectedly discarded its active lease",
        );
        ports.set_time(30_101);
        ports
            .acquire(
                &context(),
                key,
                "recovery-after-expiry",
                LeasePriority::Manual,
                50,
            )
            .unwrap_or_else(|error| property_failure(property, iteration, error.message))
            .unwrap_or_else(|| {
                property_failure(property, iteration, "lease did not expire for recovery")
            })
    } else {
        immediate.unwrap_or_else(|| {
            property_failure(property, iteration, "failure path leaked an owner lease")
        })
    };
    property_assert(
        ports
            .release(&context(), &recovered)
            .unwrap_or_else(|error| property_failure(property, iteration, error.message)),
        property,
        iteration,
        "recovery owner could not release its lease",
    );
    property_assert(
        ports
            .acquire(&context(), key, "final-owner", LeasePriority::Manual, 50)
            .unwrap_or_else(|error| property_failure(property, iteration, error.message))
            .is_some(),
        property,
        iteration,
        "owner lock remained after recovery release",
    );
}
