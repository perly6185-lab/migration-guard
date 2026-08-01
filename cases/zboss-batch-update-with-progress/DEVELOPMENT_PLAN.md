# batchUpdateWithProgress migration-guard development plan

## Scope invariant

`zboss-cloud` is a read-only reference case. No Java business source, configuration,
database schema or deployment artifact is modified. All models, fixtures, drivers,
collectors and evidence gates are implemented in `migration-guard`.

## Objective

Turn the observed endpoint risks into reusable batch-command contracts. Core code
must depend on generic behavior and evidence types; zboss symbols remain confined
to this project semantic package.

## Work packages

### WP1 — Project semantics and decisions

Status: completed.

- Classify progress, compensation, coordination, cascade and async boundaries.
- Record the reviewed row-limit, partial-commit, idempotency, distributed lease,
  durable undo and logical progress-terminal contracts.
- Bind every approved decision to offline and real-runtime evidence.

### WP2 — Deterministic offline model

Status: completed and connected to the Java runtime evidence gate.

- Plan requested, valid, failed, insert and update row sets.
- Enforce post/header collection limits.
- Model chunk acceptance as accepted, replayed, conflict or out-of-order.
- Validate progress monotonicity, conservation and terminal uniqueness.
- Model tenant/panel lease ownership and release.
- Require undo rows to equal committed valid rows.

### WP3 — Evidence generation

Status: generic collectors, templates, all 19 redacted authoring drafts,
environment contract, coverage matrix, fail-closed L4-C dual-replay
orchestrator, concrete HTTP/operation driver, checkpoint recovery and
field-level comparison are completed. The Rust target now has a project-owned,
marker-scoped MySQL/Redis state hook plus static and read-only connectivity
preflight. SH-1 contract hardening is complete: fault-controller
apply/verify/revert evidence, `faultArtifacts` cleanup enforcement and
canonical observation validation are fail-closed. SH-2 now provides the
`java-deployed-v1` declarative MySQL/Redis adapter, machine schema, profile hash
binding and static validation. Read-only source inspection confirms
process-local/WebSocket progress plus `boss_undo_data` and
`boss_undo_data_shard` undo persistence, but does not establish batch-specific
Redis progress, idempotency, commit-marker, outbox or schema-ledger resources.
The reviewed deployment profile and explicit resolution of those semantic gaps,
scenario-specific fault injectors, reviewed fixture promotion and real service
evidence remain pending.

SH-3A/SH-3B are implemented: semantic roles can now be classified as physical,
volatile-event or absent, and scenario-specific declarative Seed files are
transactional, marker-scoped and SHA-256-bound. SH-3C concrete promotion of the
19 scenario fixtures is in progress. The first five scenarios now have
deterministic, hash-bound `review-required` packages; none is marked real
eligible while deployment values, Seed adapters, WebSocket capture or fault
controls remain unresolved.

The approved state/fault boundary, canonical observation model, cleanup order,
scenario allocation and delivery slices are defined in
`evidence/runtime/l4c/STATE_HOOK_DESIGN.md`.

The read-only deployment discovery is also complete:

- Java baseline: `zboss-global-data-server` on `10.10.10.177:22882`, profile
  `test`, health/MySQL/Redis/discovery all `UP`.
- Infrastructure: MySQL `zz_boss_test` and Redis database `1` on
  `10.10.10.14`; Nacos namespace `test`.
- The deployed JAR is bound by SHA-256 in
  `evidence/runtime/java/deployment-observation.json`.
- No reusable structured batch/progress JSONL was found. The runtime driver must
  create scenario-correlated event JSONL during replay.

- Use the generic runtime lifecycle: setup, start, health, seed, invoke,
  inject-fault, snapshot, collect, cleanup and stop.
- Use the batch-update L4-C orchestrator for source/target sequencing, explicit
  disposable-write approval, marker-bound cleanup and semantic comparison.
- Collect redacted request/response, context, decision trace, database before/after
  snapshots, committed row set, failed rows, undo rows, progress events and lock
  records.
- Bind all evidence to project hash, source revision/dirty fingerprint, analysis
  hash, plan hash, fixture hash and observation hash.
- MySQL collection is read-only and credential-safe; Redis collection permits
  only read commands; event collection filters structured JSONL by correlation.

### WP4 — Fail-closed gates

Status: structural and batch semantic gates implemented; endpoint evidence pending.

- Synthetic evidence can validate structure only and is never real-eligible.
- Offline gate requires reviewed decisions and offline fixtures.
- Java runtime baseline requires driver-origin evidence for every scenario.
- Missing state, event, transaction, lock, undo or idempotency dimensions block.
- Fixture kinds are explicit; unclassified JSON cannot satisfy offline or runtime
  readiness.

## Delivery order

1. Review the deployed Java resource metadata and approve the now-explicit
   physical/volatile/absent classifications in `java-state-profile.json`.
2. Resolve the first-wave SH-3C package blockers, formally promote those five
   request/Seed profiles, then repeat for the remaining 14 scenarios.
3. Pass structural and read-only connectivity preflight, then pilot
   `primary-success` and `dependency-failure`.
4. Obtain an expiring disposable-write approval and run the complete source and
   target replay inside one 24-hour evidence window.
5. Independently review the report hash, run the L4-C gate and synchronize the
   completion controls.
