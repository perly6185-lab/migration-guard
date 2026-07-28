# Project-based migration workflow

`migration-guard migrate` turns the existing Java endpoint analyzer, behavior
graph, replacement planner and RP gates into a project-oriented workflow.

## Case package

```text
cases/<project-id>/
├── profile.json
├── semantic-rules.json
├── compatibility-decisions.json
├── fixtures/
└── evidence/
```

- `profile.json` declares source and target roots, language/framework adapters,
  database dialect, entrypoints, runtime contexts and infrastructure boundaries.
- `semantic-rules.json` contains project-owned behavior classification and
  reviewed ownership rules. Class names do not need to be added to the generic
  replacement planner.
- `compatibility-decisions.json` records approved, rejected or pending
  intentional behavior changes.
- `fixtures/` contains offline behavior cases.
- `evidence/` contains generated analysis, plans and gate reports.

## Commands

```bash
migration-guard migrate init --project <id> --source <java-root> --endpoint <route> --method POST --target-root <rust-root>
migration-guard migrate analyze --project <id> [--strict]
migration-guard migrate runtime-prepare --project <id>
migration-guard migrate runtime-authoring-prepare --project <id>
migration-guard migrate runtime-preflight --project <id>
migration-guard migrate runtime-self-test --project <id>
migration-guard migrate runtime-collector-dry-run --project <id> --spec <collector.draft.json>
migration-guard migrate runtime-fixture-promote --project <id> --entrypoint <id> --scenario <id> --reviewed-by <identity>
migration-guard migrate runtime-collect --project <id> --spec <collector.json> [--output <evidence.json>]
migration-guard migrate runtime-run --project <id>
migration-guard migrate runtime-assemble --project <id> --input <driver-results.json>
migration-guard migrate runtime-gate --project <id> [--evidence <java-runtime-evidence.json>]
migration-guard migrate scaffold --project <id> --target rust
migration-guard migrate offline-gate --project <id>
migration-guard migrate real-gate --project <id> [--evidence <rp-evidence.json>]
```

`analyze` resolves the configured source adapter and writes, per entrypoint:

```text
evidence/analysis/<entrypoint-id>/
├── java-analysis.json
├── behavior-graph.json
└── endpoint-replacement-plan.json
```

The offline gate fails when fixtures, graphs or plans are missing, when a plan is
blocked, when entrypoint identity drifts, or when strict compatibility decisions
remain pending.

The real gate additionally requires existing source and target roots plus fresh
RP1-RP6 evidence covering graph closure, contracts, ownership, replay,
concurrency, fault handling, performance, source-off and rollback.
Both analysis and real evidence are bound to a hash of the profile, semantic
rules and compatibility decisions. Editing any of them invalidates stale
evidence until analysis and replay are rerun.

## Java runtime evidence before services are available

`runtime-prepare` is service-independent. It consumes the latest analysis and
writes:

```text
evidence/runtime/java/
├── runtime-contract.json
├── driver.template.json
├── runtime-evidence.schema.json
├── collectors/
│   ├── mysql.template.json
│   ├── redis.template.json
│   └── events.template.json
└── fixtures/<entrypoint-id>/<scenario-id>.template.json
```

The service-independent authoring step additionally writes:

```text
evidence/runtime/java/
├── environment-contract.json
├── .env.example
└── authoring-report.json
fixtures/java-runtime-drafts/<entrypoint-id>/<scenario-id>/
├── fixture.draft.json
└── collectors/
    ├── mysql.draft.json
    ├── redis.draft.json
    └── events.draft.json
```

`authoring-report.json` is the fixture coverage matrix. It distinguishes
successful artifact generation (`authoringReady`) from promotion readiness and
lists every remaining request or collector placeholder. Collector dry-run is
read-only and does not require a running database, Redis or event stream.

If a redacted
`evidence/runtime/java/deployment-observation.json` using protocol
`migration-guard.runtime-environment-observation/v1` is present, authoring binds
its content hash into the report. Sensitive keys or a missing redaction
declaration block `authoringReady`; credentials stay in process environment or a
secret manager.

The contract is bound to the full Git revision and dirty fingerprint, project
package hash, analysis reports and replacement plans. Changing tracked or
untracked Java source invalidates offline, preflight and runtime evidence.

Real redacted fixtures belong at:

```text
fixtures/java-runtime/<entrypoint-id>/<scenario-id>.json
```

Fixtures are typed as `template`, `specification`, `synthetic`, `draft-runtime`
or `real-runtime`. Offline gates count only valid specification fixtures. Runtime
preflight accepts only `real-runtime` fixtures with `status: ready`,
`realEvidenceEligible: true`, complete lineage and reviewed expectations.
Legacy or unclassified JSON is fail-closed.

Tokens, authorization headers, cookies, passwords, phone numbers and API keys
must not be persisted in these fixtures. They are supplied through environment
variables when the driver runs.

`runtime-preflight` verifies:

- project, contract, source and generated-artifact hashes;
- one real redacted fixture for every generated scenario;
- base URL, context, database and Redis environment variables inferred from the
  behavior contracts;
- lifecycle command variables for setup, start, health, seed, invoke, snapshot,
  collect, cleanup and stop, plus fault injection when required.

It performs no mutation and does not claim connectivity. Before the environment
exists, the expected state is `staticReady: true`, `authoringReady: true`,
`executionReady: false` and `evidenceReady: false`. `executionReady` requires all
promoted fixtures and runtime variables; `evidenceReady` requires a validated
real bundle. This preserves fail-closed execution while making pre-service
progress explicit.

`runtime-self-test` generates structurally complete synthetic observations using
the same evidence assembler and hash validator. Synthetic observations are
marked at bundle and scenario level. Relabeling the bundle does not work:
`runtime-gate` requires endpoint-driver provenance, real fixture hashes and no
synthetic markers.

When the environment becomes available, `runtime-run` resolves the prepared
driver command variables and executes:

```text
setup → start → health → seed → invoke → [inject-fault]
      → snapshot → collect → cleanup → stop
```

Cleanup and stop run after failures. `collect` must return the endpoint runtime
observation protocol, dimensions and collector evidence declared by each
scenario. MySQL collection permits only read-only queries and passes credentials
through environment variables; Redis permits only read commands and keeps auth
out of process arguments; the event collector filters JSONL by scenario or
correlation id and persists only approved fields.

For batch workloads, `runtime-gate` additionally evaluates the structured batch
semantics embedded in the observation: planned/valid/failed/committed/undo row
sets, progress monotonicity and conservation, exactly-one terminal, matching
lock owner acquire/release, chunk acceptance, and optional transaction
commit-before-success-terminal ordering. Merely supplying non-empty dimensions
does not pass.

`runtime-gate` proves the
Java baseline only; it does not claim cross-language replay, source-off or final
migration readiness. Those remain under `real-gate`.

## Current adapter boundary

The built-in `java-spring` adapter supports HTTP-route entrypoints and delegates
to the existing Spring/MyBatis-aware Java analyzer. Quarkus, Micronaut,
service-method entrypoints and non-Java sources must register another
`MigrationSourceAdapter`.

The Rust scaffold contains a compileable dependency-free crate and a frozen
`migration-contract.json`. It does not generate business behavior or claim
runtime equivalence.
