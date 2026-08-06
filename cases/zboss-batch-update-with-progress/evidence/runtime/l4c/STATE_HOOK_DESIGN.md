# L4-C project state hook design

Status: approved design baseline
Project: `zboss-batch-update-with-progress`
Scope: disposable Java/Rust dual replay only

## 1. Decision

L4-C uses two separate environment-facing capabilities:

1. A **state hook** observes, seeds and cleans marker-scoped MySQL/Redis state.
2. A **fault controller** applies, verifies and reverts a scenario-specific
   failure.

The operation driver remains responsible for HTTP health and invoke calls.
The replay core remains responsible for sequencing, checkpointing, comparison,
scope locking and evidence eligibility.

```text
replay core
  -> operation driver
       -> HTTP health/invoke
       -> state hook -> MySQL/Redis
       -> fault controller -> approved test failpoint
  -> canonical semantic comparison
  -> cleanup and zero-residue gate
```

State collection must not silently inject faults. Fault control must not query
or mutate business rows except through its approved failpoint.

## 2. Goals and non-goals

Goals:

- Observe effects that are not visible in the HTTP response.
- Produce one runtime-neutral semantic model for Java/Rust comparison.
- Restrict every read and mutation to the approved
  environment/database/tenant/panel/table/marker scope.
- Make cleanup deterministic after interruption.
- Prove that fixture, idempotency, undo, outbox, commit, Redis, lease, schema
  and fault-controller residue is zero.

Non-goals:

- General-purpose SQL execution.
- Production data repair.
- Schema discovery by guessing table or key names.
- Storing credentials, raw authorization values or unrestricted database
  payloads in evidence.
- Treating synthetic or template output as real L4-C evidence.

## 3. Components

### 3.1 Replay core

Existing implementation:

- Creates one marker per run and scenario.
- Holds the scope lock.
- Stores an atomic checkpoint after every operation.
- Compares normalized source/target semantics by JSON path.
- Recovers incomplete cleanup only when plan and scope hashes still match.

### 3.2 Operation driver

Existing implementation:

- Executes HTTP health and invoke without a shell.
- Materializes only approved environment variables and placeholders.
- Invokes state/fault hooks directly with argv.
- Requires hook protocol, marker and row-count agreement.
- Persists only explicitly allowlisted response fields.

### 3.3 Rust state adapter

Existing adapter: `zboss-evidence-v1`.

It knows the target runtime resources:

| Role | MySQL table / Redis key |
|---|---|
| projection | approved `cust_table<digits>` |
| idempotency | `batch_idempotency` |
| commit | `batch_row_commit` |
| undo | `batch_undo_journal` |
| outbox | `batch_outbox` |
| schema transition | `schema_transition_ledger` |
| progress | `zboss:batch-progress:tenant:{tenantId}:batch:{marker}` |
| batch lease | `zboss:batch-lease:tenant:{tenantId}:panel:{panelId}` |
| schema lease | `zboss:schema-transition:tenant:{tenantId}:panel:{panelId}` |

The current `seed` mode proves that the marker scope is empty. Scenario-specific
pre-existing rows are a later additive seed profile; they must never be inferred
from a production table.

### 3.4 Java state adapter

Implemented adapter: `java-deployed-v1`.

It must be configured from reviewed deployment metadata. It may use a
declarative resource profile, but it must not accept arbitrary SQL from the
replay plan.

Each configured MySQL resource declares:

- semantic role;
- safe table identifier;
- tenant, panel and marker column mappings;
- exact or prefix marker matching;
- allowlisted result columns;
- JSON columns that require canonical decoding;
- cleanup order.

Each Redis resource declares:

- semantic role;
- exact key template;
- data type;
- whether the marker is in the key or hash field;
- allowlisted fields;
- exact-key or matching-field cleanup.

The Java adapter is approved only after its resource profile is reviewed
against the deployed schema. Missing mappings block preflight.

Read-only source inspection on 2026-07-31 established the following boundaries:

- `BatchUpdateProgressManager` stores batch progress, row/cell progress,
  session state and push sequence in process-local concurrent maps, then emits
  WebSocket messages. This source path does not establish a Redis-backed
  progress resource.
- `EngineUseBatchPageController` submits undo recording asynchronously.
  `UndoServiceImpl.recordDataBatchUpdate` persists to `boss_undo_data` and may
  shard large or mixed snapshots into `boss_undo_data_shard`.
- The inspected batch-update path did not establish dedicated idempotency,
  commit-marker, outbox or schema-ledger tables.

These source findings do not approve a deployment profile. The deployed
database schema, tenant columns, marker ownership and cleanup predicates must
still be reviewed. A semantic role that is absent or volatile in Java must be
resolved explicitly before profile approval; it must not be mapped to a
target-only table merely to satisfy the canonical shape.

## 4. State hook protocol

Protocol: `migration-guard.batch-update-l4c-state-hook/v1`.

Every successful hook document contains:

```json
{
  "schemaVersion": 1,
  "protocol": "migration-guard.batch-update-l4c-state-hook/v1",
  "status": "passed",
  "marker": "approved-run-marker",
  "rowCount": 0
}
```

Operation-specific fields:

| Operation | Required result |
|---|---|
| `doctor` | redacted connectivity and selected-scope diagnostic |
| `seed` | seed mode and affected fixture count |
| `snapshot` | canonical MySQL/Redis state |
| `collect` | required semantic dimensions |
| `cleanup` | cleanup-attempt summary |
| `verifyCleanup` | all cleanup counters |

The canonical `collect.observation.dimensions` model is:

- `http`: outer driver verification reference;
- `context`: tenant, panel, database, table and correlation identity;
- `decisions`: scenario decision outcomes;
- `effects`: committed, failed, undo and outbox sets/counts;
- `state`: normalized business projection and idempotency state;
- `events`: ordered progress/outbox events;
- `failures`: phase, retryability and terminal classification;
- `performance`: bounded elapsed/row metrics for `scale-boundary`.

Values must be semantic, not implementation-specific. Examples:

- Compare `committedRowIndexes`, not auto-increment commit IDs.
- Compare ordered progress sequence/state/counts, not Redis hashes verbatim.
- Compare outbox kind/state/attempts, not database primary keys or timestamps.
- Compare projection values after configured type/null normalization.

## 5. Cleanup contract

Cleanup runs in reverse dependency order:

1. Revert the scenario fault controller.
2. Delete outbox, undo and commit records for tenant + marker.
3. Delete idempotency records for tenant + panel + marker.
4. Delete schema ledger records for tenant + panel + marker.
5. Delete projection rows for tenant + panel + marker prefix.
6. Delete the exact progress key.
7. Remove only lease hash fields containing the marker.
8. Verify all residue counters.

Existing counters:

- `fixtureRows`
- `undoRows`
- `outboxRows`
- `commitRows`
- `redisKeys`
- `leaseKeys`
- `schemaArtifacts`
- `faultArtifacts`

SH-1 enforces `faultArtifacts`. A run cannot pass while a proxy rule,
failpoint, network policy or fault flag remains active.

Cleanup is idempotent. Repeating cleanup for the same marker must return
success and zero residue. A hook must refuse cleanup when the connected
database differs from the approved database or when the plan/scope checkpoint
binding does not match.

## 6. Fault controller contract

Fault controller lifecycle:

```text
apply(marker, scenario, scope)
  -> verify active
  -> invoke runtime
  -> revert(marker)
  -> verify inactive
```

Required result fields:

- protocol and schema version;
- scenario ID and marker;
- approved mechanism ID;
- state: `applied`, `active`, `reverted` or `inactive`;
- deterministic resource identity derived from marker;
- expiry/dead-man timeout when the mechanism supports it;
- `restoreRequired`;
- redacted diagnostic.

Allowed mechanisms:

- application test failpoint;
- disposable dependency proxy rule;
- marker-scoped MySQL failpoint supported by the test runtime;
- marker-scoped Redis failpoint supported by the test runtime;
- disposable DDL executor stub.

Forbidden mechanisms:

- host-wide firewall changes;
- stopping shared MySQL/Redis;
- deleting or renaming shared tables;
- unrestricted latency or packet-loss rules;
- fault controls without deterministic revert and inactive verification.

## 7. Scenario allocation

| Scenario group | State seed | Fault controller |
|---|---|---|
| success, validation, compatibility, context | empty or reviewed fixture rows | none |
| concurrency and horizontal update | reviewed existing rows where required | deterministic concurrent request driver |
| `dependency-failure` | empty marker scope | dependency-unavailable failpoint |
| `post-commit-effect-failure` | reviewed row | downstream/outbox delivery failpoint |
| `schema-transition-failure` | empty marker scope | disposable DDL executor failure |
| `transaction-failure` | reviewed rows | marker-scoped row transaction failure |
| `undo-excludes-failed-rows` | reviewed mixed-validity rows | undo delivery failure if runtime path requires it |
| `scale-boundary` | bounded reviewed dataset | none; performance dimension required |

Concurrency drivers are request orchestrators, not state-hook mutations. Their
barriers and participant results must be marker-bound and included in
observation evidence.

## 8. Safety invariants

- Test/sandbox/staging database name only; names containing `prod` are rejected.
- MySQL and Redis hosts must be listed in the approved plan.
- Tenant and panel identifiers are explicit and immutable during a run.
- Dynamic table must match `cust_table<digits>`.
- Mutation row count is capped by `maxRowsPerScenario`.
- SQL identifiers come only from a reviewed profile and match the identifier
  allowlist.
- All SQL values are bound parameters.
- No shell execution.
- Secrets remain environment-only and are redacted from errors.
- Snapshots have explicit columns/fields and a size cap.
- Cleanup never uses Redis `KEYS`, wildcard deletion or an unbound SQL delete.
- Schema mutation is forbidden unless a separately approved scenario enables
  it; this project plan currently sets `schemaChangesAllowed=false`.

## 9. Preflight

Static preflight verifies:

- plan and binding approval;
- complete binding for all 19 selected scenarios;
- no hook placeholders;
- required environment variables;
- URL scheme, host and database scope;
- source/target adapter availability;
- explicit fault controller for each fault scenario.

Read-only connectivity preflight adds:

- Java/Rust HTTP health;
- selected MySQL database identity;
- required table/column availability;
- Redis ping and required key-type capability;
- empty marker-scope doctor query.

Preflight performs no lifecycle command, fixture mutation or fault application.

## 10. Delivery slices

### SH-1 — Contract hardening

Status: completed.

- Add `faultArtifacts` to cleanup verification and report validation.
- Require the fault controller result protocol for fault scenarios.
- Add a canonical observation validator, including `performance`.

### SH-2 — Java declarative adapter

Status: code completed and gated; reviewed deployment profile pending.

- Implemented parameterized snapshot/collect/cleanup and read-only doctor.
- Added the machine schema, profile hash binding and fail-closed preflight.
- Added profile/query-planner, operation-protocol and subprocess self-tests.
- Pending: freeze a reviewed profile after resolving Java's volatile/absent
  semantic roles against the deployed schema.

### SH-3 — Scenario seeds

Status: SH-3A and SH-3B code completed; concrete scenario promotion pending.

- State semantics now classify every role as `mysql`, `redis`,
  `volatile-event` or `absent`; multiple physical resources may contribute to
  one semantic role.
- Java Seed profiles reference only reviewed projection resource IDs and column
  aliases. Table names and raw SQL are forbidden.
- Seed rows are marker/tenant/panel scoped, capped by `maxRowsPerScenario`,
  inserted in one transaction and covered by the existing exact cleanup.
- Each scenario binds the raw Seed file SHA-256. The operation driver,
  preflight and report gate reject missing or drifting hashes.
- SH-3C first wave is prepared as five deterministic `review-required`
  scenario packages: primary success, validation, partial failure, dependency
  failure and concurrency. Each package binds the runtime contract, source
  draft, collector drafts and state-profile template by SHA-256.
- The first wave has a machine-validated technical review that explicitly does
  not claim human approval. Request, Java/Rust Seed and WebSocket bindings are
  complete. The concurrency package binds the built-in two-writer barrier
  driver and requires distinct terminal evidence for both batch identities.
  Every package requires fresh expiring write-safety approval; dependency
  failure additionally retains its explicit fault-controller blocker.
- The remaining wave now has 14 deterministic `review-required` packages and a
  separate fault-mechanism matrix under
  `evidence/runtime/l4c/scenario-preparation/remaining-wave/`. Four remaining
  fault scenarios are explicitly marked `not-bound` and none is real eligible.
  Regenerate/check this static preparation with
  `npm run batch-rust:sh3c-remaining-prepare` and
  `npm run batch-rust:sh3c-remaining-check`.
- The remaining-wave component preparation emits 28 Seed candidates, 42
  collector candidates and one 14-scenario binding candidate. The candidates
  are deliberately `review-required`; they bind no live database, Redis,
  WebSocket or fault-control endpoint. The four fault controllers implement
  the common apply/active/revert/inactive protocol and call only an explicitly
  host-allowlisted target control URL. Their mock-admin self-test covers both
  target kinds, marker-bound resource identity and zero residue. Generate and
  check these candidates with `npm run batch-rust:sh3c-components-prepare` and
  `npm run batch-rust:sh3c-components-check`.
- The per-scenario human review packet is generated at
  `evidence/runtime/l4c/scenario-preparation/remaining-wave/human-review/`.
  It re-hashes the source draft, component, both Seed candidates, all three
  collector candidates, package and binding cross-references. A passing hash
  check is recorded separately from the pending semantic decision; it never
  marks a scenario approved. Use
  `npm run batch-rust:sh3c-human-review-check` to verify the packet.
- The approval intake template is generated beside the review packet as
  `approval-intake.template.json`. It records the 14 scenario IDs, Seed,
  collector, package and binding hashes, DB/Redis/WebSocket resource scopes,
  reviewer identity, expiring disposable-write authorization and the four
  fault-control endpoints. `npm run batch-rust:sh3c-approval-template-check`
  verifies that the template is current and still pending. Use
  `npm run batch-rust:sh3c-approval-draft` to create a protected
  `approval-intake.json` draft for manual completion. A completed
  `approval-intake.json` must pass
  `npm run batch-rust:sh3c-approval-intake-check` before
  `npm run batch-rust:sh3c-approval-record` can emit `approval-record.json`.
  The record remains static-promotion input only; it does not run replay or
  mutate fixtures by itself.
- Pending: resolve the recorded Seed, collector, request, state-profile,
  write-safety and fault-mechanism blockers, then invoke the existing
  `runtime-fixture-promote` command with a reviewer identity.

### SH-4 — Fault controllers

Status: `dependency-failure` mechanism code completed and gated; remaining
scenario mechanisms and approved environment binding pending.

- The `toxiproxy-reset-peer-v1` controller applies, verifies and reverts a
  marker-bound `reset_peer` toxic through the Toxiproxy admin API. Admin URLs
  are pinned to the approved plan hosts, toxic configuration drift is
  fail-closed, and the mock-admin self-test covers apply/verify/revert
  recovery plus zero-residue verification for both target kinds.
- The operation driver and the report gate pin `dependency-failure` evidence
  to that mechanism and to `toxiproxy:<target-kind>:` resource identity.
- The remaining four controllers are now implemented as fail-closed target
  control adapters: `fault-post-commit-effect-v1`,
  `fault-schema-transition-v1`, `fault-transaction-rollback-v1` and
  `fault-undo-delivery-v1`. Each requires a target-specific
  `MG_L4C_SOURCE/TARGET_FAULT_CONTROL_URL`, validates the returned
  marker-bound resource and enforces zero artifacts after revert.
- Pending: approve and bind the target control endpoints, then produce
  interrupted-run `faultArtifacts=0` proof on the real environment. Code and
  mock lifecycle coverage are not real fault evidence.

### SH-5 — Pilot and full replay

- Run `primary-success` and `dependency-failure` as the pilot.
- Review field-level differences and normalization.
- Run all 19 scenarios in one approval/evidence window.
- Obtain independent report review and execute the L4-C gate.

## 11. Definition of done

The state-hook phase is complete only when:

- both runtime adapters pass static and read-only connectivity preflight;
- all selected scenarios have approved request, seed and fault bindings;
- every required dimension contains meaningful canonical evidence;
- source/target semantic hashes match for all 19 scenarios;
- checkpoint recovery succeeds after forced interruption;
- all eight residue counters, including `faultArtifacts`, are zero;
- the independent reviewer approves the real report hash;
- the L4-C gate upgrades the trust decision without synthetic evidence.
