# `batchDelete` migration assessment

Status: **L4-B deployable network/runtime accepted**

The Java source analysis is `ready` with no unresolved findings. The Rust target
passes the offline contract and exposes concrete `BatchDeleteStore`,
`CompensationOutbox` and `ProgressSink` protocol adapters. The SQLx MySQL,
async Redis, Axum HTTP and durable compensation-worker paths pass end-to-end
network execution against disposable MySQL 8.4 and Redis 7.4 containers. This
does not yet constitute real Java/Rust runtime evidence.

## Accepted contract

- Validate `ROW_DELETE` and 1..10000 distinct row IDs before effects.
- Require every requested row to be active on first execution.
- Skip reference-blocked rows and atomically delete the remaining subset.
- Persist snapshots, soft deletes, undo anchors and a compensation outbox in one
  main transaction.
- Replay an identical idempotency-key/hash decision without repeating effects;
  reject key/hash conflicts.
- Serialize same-tenant/same-panel mutations.
- Run nine compensation steps in source order with durable status and resumable
  failure.
- Distinguish main commit from fully compensated terminal success.

## Evidence

- Source analysis: `evidence/analysis/index.json`
- Real request candidate:
  `fixtures/real-runtime-candidates/ledger-three-row-delete.json`
- Risk matrix: `fixtures/offline-contract/batch-delete-risk-cases.json`
- Rust gate: `../../artifacts/batch-delete-rust/l3-gate.json`
- Dual replay: `../../artifacts/batch-delete-rust/offline-replay.json`

## L4-B runtime evidence

- Atomic idempotency + snapshot + soft-delete + undo + outbox transaction.
- Reference-blocked subset classification.
- Injected transaction rollback with no residual state.
- Durable replay, hash conflict and stable side-effect counts.
- Ordered compensation owner claim, failure, retry and completion.
- Redis delete/update mutual exclusion with owner-token expiry.
- Monotonic progress, replay, counter conservation and unique terminal state.
- Exact production HTTP route, liveness, readiness and progress endpoints.
- Real TCP execution through SQLx MySQL and async Redis clients.
- Nine-step worker completion with nine durable protocol-bound effect records.
- Identical HTTP replay, hash conflict, partial reference skip and missing-row
  rollback with terminal failure progress.

## Level decision

- Achieved: **L4-B**
- Next: **L4-C real evidence and source/target dual replay**
- Not claimed: real business write replay, external business-side-effect
  integration evidence, production traffic routing or cutover.

## L4-C blockers

1. Bind the nine compensation ports to the actual external business
   integrations and capture their evidence.
2. Run the supplied request only in an approved disposable fixture scope.
3. Collect source HTTP, MySQL, progress and compensation evidence and compare it
   against the target service.

The reference Java project is guarded as read-only. Accepted source snapshot:
`a95e4cb51ceb62cc07602fe02c3cbb3e45f271ee+dirty:bffb6682d768`,
tree hash:
`1413c76262063196301f42318ecf8ca8baae5ec4d2b2d1be26d44a713a05a78f`.
