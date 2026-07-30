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

Status: generic collectors, templates, all 18 redacted authoring drafts,
environment contract and coverage matrix completed; project-local read-only
queries/probes, reviewed promotion and real service evidence remain pending.

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

1. Replace the marked request values in the generated 18 `draft-runtime`
   fixtures.
2. Replace the marked MySQL/Redis probes, dry-run each collector spec, set it to
   `ready`, and promote each fixture with a reviewer identity.
3. Start the reference services only when available and generate real evidence.
4. Run Java runtime baseline gate; keep any target-language work out of scope.
