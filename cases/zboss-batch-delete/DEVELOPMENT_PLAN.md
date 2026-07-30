# `batchDelete` migration plan

## Completed: offline L3

- [x] Independent migration case and read-only source profile.
- [x] Deep Java endpoint analysis with no unresolved findings.
- [x] Real three-row ledger request preserved as a non-executed candidate.
- [x] Success, reference skip, all-skip and missing-row contracts.
- [x] Snapshot, soft-delete, undo and outbox rollback fault contracts.
- [x] Duplicate replay and idempotency hash-conflict contracts.
- [x] Delete/delete and update/delete tenant-panel concurrency gate.
- [x] Durable ordered compensation and retry contract.
- [x] Java semantic stub/Rust memory dual replay.
- [x] Fail-closed unclassified-drift tamper self-test.
- [x] Reference source before/after snapshot guard.

## Completed: L4-A

- [x] Add MySQL schemas for idempotency decisions and compensation outbox.
- [x] Define and attest the dynamic-table MySQL transaction adapter boundary.
- [x] Implement Redis owner-token and progress protocol adapters.
- [x] Define ordered outbox claim, retry and terminal-failure transitions.
- [x] Pass MySQL 8.4 / Redis 7.4 container dependency-protocol tests.

## Completed: L4-B

- [x] Implement concrete SQLx MySQL and async Redis network executors.
- [x] Add an Axum HTTP runtime and bind the production route.
- [x] Bind the durable compensation worker and Redis progress transport.
- [x] Add health, readiness, graceful shutdown and configuration validation.
- [x] Attest the complete production execution path with 40/40 checks.

## Next: L4-C

- [ ] Bind and attest the nine actual external business-side-effect handlers.
- [ ] Approve a disposable real-write fixture and marker-bound cleanup.
- [ ] Capture fresh Java HTTP/MySQL/Redis/compensation evidence.
- [ ] Run source/target real dual replay.
- [ ] Pass unified real gate and cutover-preflight checks.
