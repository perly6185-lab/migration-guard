# zboss-batch-delete

The owning package is `../Cargo.toml`. The implementation lives under
`../src/application/data/delete`. In production mode the unified process embeds
this router and compensation worker into the shared listener; the standalone
binary remains available for compatibility and focused gates.

L4-B deployable network/runtime implementation for:

`POST /zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchDelete`

Implemented and tested:

- 1..10000 distinct row validation and stable request normalization.
- Exact active-row precondition and reference-blocked `skippedRowIds`.
- Atomic snapshots, set-based soft delete, undo anchors and compensation outbox.
- Request-key/hash replay and hash-conflict rejection.
- Tenant-panel mutation gating for delete/delete and update/delete conflicts.
- Ordered, durable, observable and resumable nine-step compensation.
- `RUNNING -> MAIN_COMMITTED -> SUCCESS|COMPENSATION_FAILED` progress.
- Frozen Java semantic stub versus Rust memory dual replay with fail-closed drift classification.
- Concrete MySQL/Redis protocol wrappers for store, outbox and progress ports.
- MySQL 8.4 / Redis 7.4 container probes for atomicity, replay, locking,
  compensation recovery and progress terminal semantics.
- SQLx MySQL and async Redis network execution over TCP.
- Axum production route with liveness, readiness and progress endpoints.
- Durable nine-step compensation worker and graceful shutdown wiring.
- Failure-terminal publication with transaction-residue checks.

Run the complete offline gate from the repository root:

```text
npm run batch-delete-rust:l3-gate
npm run batch-delete-rust:l4a-gate
npm run batch-delete-rust:l4b-gate
```

The service is configured with:

- `ZBOSS_BATCH_DELETE_MYSQL_URL`
- `ZBOSS_BATCH_DELETE_REDIS_URL`
- `ZBOSS_BATCH_DELETE_BIND_ADDR`
- `ZBOSS_BATCH_DELETE_TABLE` (`cust_table<digits>` only)

L4-B proves a deployable route against disposable MySQL/Redis fixtures. It does
not execute the supplied business delete request. Real Java/Rust dual replay and
the nine external business integrations remain L4-C evidence scope.
