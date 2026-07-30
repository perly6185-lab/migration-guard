#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenarioContract {
    pub id: &'static str,
    pub decisions: &'static [&'static str],
}

pub const SCENARIOS: [ScenarioContract; 19] = [
    ScenarioContract {
        id: "batch-partial-failure",
        decisions: &[
            "BUP-DEC-PARTIAL-COMMIT",
            "BUP-DEC-PROGRESS-TERMINAL",
            "BUP-DEC-UNDO-DURABILITY",
        ],
    },
    ScenarioContract {
        id: "batch-row-limit-rejected",
        decisions: &["BUP-DEC-ROW-LIMIT"],
    },
    ScenarioContract {
        id: "batch-update-success",
        decisions: &["BUP-DEC-PROGRESS-TERMINAL", "BUP-DEC-UNDO-DURABILITY"],
    },
    ScenarioContract {
        id: "branch-coverage",
        decisions: &[],
    },
    ScenarioContract {
        id: "chunked-paste-progress",
        decisions: &["BUP-DEC-CHUNK-IDEMPOTENCY", "BUP-DEC-PROGRESS-TERMINAL"],
    },
    ScenarioContract {
        id: "concurrent-write",
        decisions: &["BUP-DEC-BATCH-REFRESH-LEASE"],
    },
    ScenarioContract {
        id: "context-isolation",
        decisions: &[],
    },
    ScenarioContract {
        id: "dependency-failure",
        decisions: &["BUP-DEC-PROGRESS-TERMINAL"],
    },
    ScenarioContract {
        id: "entrypoint-parity",
        decisions: &[],
    },
    ScenarioContract {
        id: "horizontal-batch-upsert",
        decisions: &[],
    },
    ScenarioContract {
        id: "post-commit-effect-failure",
        decisions: &["BUP-DEC-UNDO-DURABILITY"],
    },
    ScenarioContract {
        id: "primary-success",
        decisions: &[],
    },
    ScenarioContract {
        id: "progress-event-shape",
        decisions: &["BUP-DEC-PROGRESS-TERMINAL"],
    },
    ScenarioContract {
        id: "scale-boundary",
        decisions: &[],
    },
    ScenarioContract {
        id: "schema-transition-failure",
        decisions: &["BUP-DEC-SCHEMA-TRANSITION"],
    },
    ScenarioContract {
        id: "transaction-failure",
        decisions: &[
            "BUP-DEC-PARTIAL-COMMIT",
            "BUP-DEC-PROGRESS-TERMINAL",
            "BUP-DEC-UNDO-DURABILITY",
        ],
    },
    ScenarioContract {
        id: "undo-excludes-failed-rows",
        decisions: &["BUP-DEC-PARTIAL-COMMIT", "BUP-DEC-UNDO-DURABILITY"],
    },
    ScenarioContract {
        id: "validation-failure",
        decisions: &["BUP-DEC-PARTIAL-COMMIT"],
    },
    ScenarioContract {
        id: "web-rpc-entrypoint-parity",
        decisions: &[],
    },
];
