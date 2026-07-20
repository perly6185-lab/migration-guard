# MG-191: Full Java-to-Rust Endpoint Replacement

Status: planned; remote issues are open.

Priority: P0

Remote tracking:

- Epic: [#63](https://github.com/perly6185-lab/migration-guard/issues/63)
- MG-192: [#64](https://github.com/perly6185-lab/migration-guard/issues/64)
- MG-193: [#65](https://github.com/perly6185-lab/migration-guard/issues/65)
- MG-194: [#66](https://github.com/perly6185-lab/migration-guard/issues/66)
- MG-195: [#67](https://github.com/perly6185-lab/migration-guard/issues/67)
- MG-196: [#68](https://github.com/perly6185-lab/migration-guard/issues/68)
- MG-197: [#69](https://github.com/perly6185-lab/migration-guard/issues/69)
- MG-198: [#70](https://github.com/perly6185-lab/migration-guard/issues/70)
- MG-199: [#71](https://github.com/perly6185-lab/migration-guard/issues/71)
- MG-200: [#72](https://github.com/perly6185-lab/migration-guard/issues/72)
- MG-201: [#73](https://github.com/perly6185-lab/migration-guard/issues/73)

Target outcome: Migration Guard can prove that a selected Java endpoint has been
fully replaced by a production-usable Rust endpoint. The normal request path must
not call the migrated Java controller, application method, or Java-owned post-step.
Java may run only as a reference implementation during capture, comparison, and
rollback drills.

## Problem

The current cross-language lane inventories routes and compares HTTP status and
response bodies. The Java endpoint analyzer identifies context and side-effect
signals, but its recommendations still assume that orchestration, progress,
concurrency coordination, timestamps, undo, and reconciliation remain in Java.

That boundary is insufficient for full replacement. A Rust endpoint is not ready
while any required business behavior is still owned by the migrated Java request
path.

## Safety Boundary

- Existing CL1-CL5 HTTP planning remains backward compatible.
- Full replacement uses a separate FR1-FR5 readiness profile.
- FR5 requires direct target routing and a source-off verification run.
- Declared infrastructure such as databases, Redis, and message brokers is allowed.
- Calls back into the migrated Java endpoint/module are not allowed at FR5.
- Stateful dual-run must use isolated fixtures, rollback transactions, or dry-run
  effect planning. It must never dual-write production data.
- Production routing changes remain manual; further remote issue mutation requires explicit review.

## Dependency Order

```text
MG-192 Rust support
   -> MG-193 replacement closure
      -> MG-194 context contract
      -> MG-195 effect contract
         -> MG-196 full-replacement golden model

MG-192 + MG-194 + MG-195
   -> MG-197 runtime driver protocol

MG-196 + MG-197
   -> MG-198 stateful replay and comparison
      -> MG-199 concurrency and fault replay
         -> MG-200 FR1-FR5 readiness and source-off gate
            -> MG-201 zboss refreshSync pilot
```

## Development Issues

### MG-192: Add Rust Inventory and Java-to-Rust Recipe

- Priority: P0
- Risk: medium
- Owner: engine
- Depends on: none

Outcome: Rust becomes a first-class target in the cross-language adapter.

Scope:

- Add `rust` to the language model and detect `.rs`, `Cargo.toml`, and workspace manifests.
- Detect Axum, Actix Web, and Rocket framework signals and common route declarations.
- Recommend `cargo check --all-targets` and `cargo test --all-targets`.
- Add an explicit `java-to-rust` recipe covering Spring routes, DTO validation,
  error envelopes, context middleware, async execution, and infrastructure ports.

Acceptance:

- A Spring source and Axum target fixture is detected as `java-to-rust` with high confidence.
- Matching and missing Rust routes appear in the route matrix.
- Cargo checks are emitted as target checks.
- Unsupported Rust route syntax is reported as unresolved instead of silently ignored.
- Existing language-pair tests remain unchanged.

Suggested PR boundary: inventory, recipe, route fixtures, and documentation only.

### MG-193: Generate a Full Replacement Closure Manifest

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-192

Outcome: the tool can answer which dependencies prevent a Java endpoint from
running independently in Rust.

Scope:

- Consume Java endpoint analysis and target Rust inventory.
- Classify every reachable behavior as `rust-owned`, `infrastructure-port`,
  `source-java-owned`, `unresolved`, or `reviewed-exclusion`.
- Record target implementation evidence for handlers, branches, ports, and side effects.
- Treat depth/edge truncation and unexpanded boundary nodes as incomplete closure.
- Write `full-replacement-closure.json|md` with stable finding codes.

Acceptance:

- Closure fails when any required node is Java-owned or unresolved.
- Closure fails when the source call graph is truncated without a reviewed expansion.
- Infrastructure ports declare protocol, resource, operation, and target adapter.
- Reviewed exclusions require a reason and cannot hide writes, locks, context, or events.
- Identical inputs produce stable classification and manifest hashes.

Suggested PR boundary: read-only model and report; no source generation or cutover.

### MG-194: Define and Compare the Runtime Context Envelope

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-193

Outcome: ThreadLocal and framework context become explicit, replayable inputs.

Scope:

- Define typed fields for tenant, user, request, trace, datasource, device,
  locale/timezone, authorization claims, and compatibility flags.
- Map each Java context read to envelope field, provenance, requiredness, and default behavior.
- Define gateway-to-Rust propagation and target consumption evidence.
- Redact tokens, cookies, and secrets before artifact persistence.

Acceptance:

- Missing required context blocks full-replacement readiness.
- Source and target context values can be compared per golden case.
- Tenant/user/datasource isolation has positive and negative fixtures.
- Secrets never appear in JSON, Markdown, logs, or fixture hashes.
- No target handler relies on an unclassified ambient context source.

Suggested PR boundary: schema, Java mapping, redaction, fixtures, and report rendering.

### MG-195: Add an Ordered Execution Effect Contract

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-193

Outcome: observable behavior includes ordered side effects, not only HTTP output.

Scope:

- Model database/cache writes, coordination state, progress events, undo changes,
  reconcile operations, clock reads, and external calls.
- Record phase, sequence, resource key, operation, before/after hash, outcome,
  error policy, transaction group, idempotency key, and logical timestamp.
- Provide a producer-neutral JSON trace import format for Java and Rust probes.
- Distinguish expected no-effect/skipped paths from missing evidence.

Acceptance:

- The refresh sequence can represent sync, timestamp update, undo clear, and reconcile in order.
- `reconcile` failure can be marked ignored while `clearUndo` failure remains result-affecting.
- Transactional and partially committed outcomes are distinguishable.
- Unknown effect kinds fail closed under strict comparison.
- Trace artifacts are bounded, normalized, redacted, and hash-bound to their fixture.

Suggested PR boundary: trace schema, validators, import/render support, and fixtures.

### MG-196: Upgrade Golden Cases to Full Replacement Models

- Priority: P0
- Risk: medium
- Owner: ai
- Depends on: MG-194, MG-195

Outcome: generated golden plans require target ownership of all endpoint semantics.

Scope:

- Remove recommendations that progress, context, undo, reconcile, or routing stay in Java.
- Add typed observation requirements for HTTP, context, decisions, effects,
  state snapshots, events, concurrency schedules, and failure outcomes.
- Upgrade `sync-command`, `batch-command`, and `page-query` without breaking their case ids.
- Add refresh failure cases for progress, sync, timestamp update, undo clear, and reconcile.

Acceptance:

- Every required observation has a source capture and target replay status.
- `sync-command` covers manual/auto branching, id resolution, batch skip,
  asymmetric de-duplication, timestamp boundaries, progress, undo, and reconcile.
- Golden wording says `target-owned` or `infrastructure-port`; it never prescribes a Java tail.
- Missing state/effect evidence blocks strict readiness even when HTTP output matches.
- Existing page and batch case identifiers remain compatible.

Suggested PR boundary: model versioning, endpoint plan generation, and focused tests.

### MG-197: Introduce a Source/Target Runtime Driver Protocol

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-192, MG-194, MG-195

Outcome: Migration Guard can run Java reference capture and Rust target replay
through one bounded, provider-neutral protocol.

Scope:

- Define driver operations for start, health, reset fixture, invoke, snapshot,
  collect events/effects, inject fault, and stop.
- Support command-based drivers first; do not hard-code Spring or Axum process control.
- Persist process identity, command hashes, timeouts, ports, and artifact lineage.
- Guarantee cleanup and fixture restoration after success, failure, or timeout.

Acceptance:

- Java and Rust fixture drivers execute the same golden case contract.
- Driver output is schema-validated before comparison.
- Timeout or malformed output is a blocked run, never an implicit pass.
- Processes and temporary state are cleaned up on all terminal paths.
- Driver commands cannot expose secrets or escape configured roots.

Suggested PR boundary: protocol and deterministic fixture drivers; no production deployment logic.

### MG-198: Compare Stateful Golden Replays

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-196, MG-197

Outcome: Java and Rust are compared across HTTP, state, effects, events, and decisions.

Scope:

- Extend comparison beyond response status/body.
- Compare normalized context use, branch decisions, ordered effects, state snapshots,
  progress streams, and partial failure outcomes.
- Require explicit normalization rules for generated ids and timestamps.
- Classify drift as intentional, accidental, or unresolved with evidence.

Acceptance:

- Matching HTTP with a missing undo clear or extra progress event fails comparison.
- Event order and terminal-event cardinality are checked.
- State snapshots identify changed resource keys without persisting sensitive values.
- Normalization cannot silently ignore an entire observation dimension.
- Stateful replay uses isolated fixtures and proves cleanup after each case.

Suggested PR boundary: comparator, difference model, report, and deterministic integration fixture.

### MG-199: Add Deterministic Concurrency and Fault Replay

- Priority: P0
- Risk: high
- Owner: engine
- Depends on: MG-198

Outcome: race and failure semantics are verified rather than inferred from code.

Scope:

- Define barrier-driven schedules for manual/manual, auto/auto,
  manual-before-auto, auto-before-manual, and batch-inflight refresh.
- Model shared coordination leases, heartbeat, expiry, fencing, and crash cleanup.
- Inject faults at progress publish, sync, timestamp update, undo clear, and reconcile.
- Compare return value, persisted partial state, event count, and retry behavior.

Acceptance:

- Tests reproduce the existing asymmetric manual/auto priority semantics.
- Duplicate requests prove one execution/one event stream where required.
- Batch-inflight skip proves no sync, timestamp, undo, reconcile, or progress effects.
- Lease expiry and process crash do not leave a permanent block.
- Repeated schedules are deterministic and do not depend on wall-clock sleeps.

Suggested PR boundary: schedule model, fake coordinator, fault injector, and integration tests.

### MG-200: Add FR1-FR5 Readiness and Source-Off Cutover Gate

- Priority: P0
- Risk: high
- Owner: human
- Depends on: MG-199

Outcome: the tool cannot report full replacement ready until Java is absent from
the target request path.

Scope:

- Add FR1 target route, FR2 closure/context, FR3 state/effect parity,
  FR4 concurrency/fault parity, and FR5 source-off/cutover readiness.
- Add strict exit behavior and local issue generation for every failed gate.
- Verify direct gateway/route ownership, target health, performance budget,
  rollback plan, and source endpoint unavailability.
- Keep production cutover as a reviewed plan, never an automatic mutation.

Acceptance:

- Existing CL5 can remain ready while FR readiness correctly remains blocked.
- FR5 requires a passing run with the migrated Java endpoint disabled or unreachable.
- Any call back into the migrated Java module fails source-independence.
- Rollback target, trigger thresholds, and evidence freshness are mandatory.
- Reports provide one next action for the first blocking FR gate.

Suggested PR boundary: readiness policy, CLI/report integration, issue generation, and source-off fixture.

### MG-201: Validate the Model on zboss refreshSync

- Priority: P0
- Risk: high
- Owner: human
- Depends on: MG-200

Target endpoint:

`POST /zboss/data/view/dynamic/engine/use/engine-use-page/refreshSync`

Outcome: prove the full-replacement lane against the real Java call chain and a
real Rust target implementation.

Scope:

- Capture manual, automatic, missing-id, batch-inflight, duplicate refresh,
  progress, timestamp-boundary, undo, reconcile, and context golden cases.
- Exercise concurrency ordering and fault injection.
- Run source/target stateful parity and performance comparison.
- Execute source-off verification with direct Rust routing.

Acceptance:

- The closure manifest has no unreviewed truncation, Java-owned behavior, or unresolved effect.
- Required golden cases pass HTTP, state, effect, event, context, concurrency, and failure comparison.
- Rust publishes the expected progress protocol and preserves timestamp/undo/reconcile semantics.
- The source-off run passes without invoking the Java controller or refresh application service.
- Performance evidence records throughput, p95/p99 latency, memory, and error rate against an approved budget.
- Cutover and rollback remain reviewed operations with fresh evidence.

Suggested PR boundary: pilot fixtures and evidence only; product gaps found by the
pilot become separate issues rather than ad hoc pilot-only branches.

## Epic Acceptance

- `java-to-rust` is a supported, tested language pair.
- Full replacement closure is explicit and fails closed.
- Context, ordered effects, state, events, concurrency, and failures are replayable.
- FR1-FR5 are independent of the existing CL1-CL5 HTTP readiness levels.
- FR5 proves direct Rust routing and source-off operation.
- The zboss `refreshSync` pilot passes without a Java business tail.
- No production data, route, GitHub issue, package, or release is mutated automatically.

## Recommended Delivery Slices

1. PR 1: MG-192.
2. PR 2: MG-193.
3. PR 3: MG-194 and MG-195 schemas, without runtime execution.
4. PR 4: MG-196.
5. PR 5: MG-197.
6. PR 6: MG-198.
7. PR 7: MG-199.
8. PR 8: MG-200.
9. Pilot workstream: MG-201 after the product gates are merged.

Each PR requires focused tests and `npm run build`. MG-198 onward additionally
requires the full suite, package smoke, and a filesystem/process integration test.
