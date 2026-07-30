# zboss batch-update Rust reimplementation

The combined deployment entry now lives at `../Cargo.toml` and registers this
crate's HTTP path. Because this crate does not yet contain concrete network
persistence, the combined runtime keeps that write route fail-closed. This
standalone package remains the batch-update contract and test boundary.

Independent Rust reimplementation target for the read-only Java reference method
`ViewMetaBatchUpdateApplicationServiceImpl.batchUpdate/doBatchUpdate`.

This project does not modify or call from `zboss-cloud`.

The schema-transition boundary uses structured create-table/add-column
operations, an owner-token tenant/panel lease, and a durable request-hash
ledger. Batch row processing may resume only after the transition ledger is
durably successful; DDL failures remain retryable and observable.

## Local checks

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The aggregate L3 gate also checks the TypeScript planner, deep static
analysis, the 19-scenario runtime contract, Rust strict checks, offline
readiness and the read-only reference snapshot:

```powershell
npm run batch-rust:l3-gate
```

## Integration environment

```powershell
docker compose -f docker-compose.integration.yml up -d
docker compose -f docker-compose.integration.yml ps
```

MySQL listens on `127.0.0.1:13306`; Redis listens on `127.0.0.1:16379`.
Generated comparison evidence belongs under `.migration-guard/vmp-batch-rust`, not in `zboss-cloud`.

Run the production-boundary container gate with:

```powershell
npm run batch-rust:container-gate
```

This gate is an **L4-A dependency-protocol probe**. It exercises MySQL SQL
and Redis Lua directly and therefore does not attest a deployable Rust HTTP
service or concrete Rust database/Redis clients. L4-B additionally requires
the configured production-path attestation to find the real route and
non-test implementations of every required adapter trait.
