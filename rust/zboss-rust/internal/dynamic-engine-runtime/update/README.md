# zboss batch-update Rust reimplementation

The combined deployment entry lives at `../Cargo.toml`. Set
`ZBOSS_UNIFIED_BATCH_UPDATE_MODE=production` together with the
`ZBOSS_BATCH_UPDATE_*` settings from `.env.example` to register the real
HTTP -> Redis lease -> MySQL transaction path in the unified process. Disabled
mode remains fail-closed.

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

The isolated SH-3C target stack additionally runs the production Rust HTTP
service and creates only the disposable `zz_boss_test.cust_table7272`
projection:

```powershell
$env:ZBOSS_L4C_MYSQL_PASSWORD = "<url-safe-disposable-password>"
$env:ZBOSS_L4C_MYSQL_ROOT_PASSWORD = "<disposable-root-password>"
docker compose -p zboss-batch-update-l4c -f docker-compose.l4c.yml up -d --build
docker compose -p zboss-batch-update-l4c -f docker-compose.l4c.yml ps
```

All published ports bind to loopback. The default target endpoint is
`http://127.0.0.1:18089`; its L4-C readiness alias is `/internal/ready`.
Use a URL-safe disposable MySQL password because it is embedded in the
container-local connection URL. Stop the stack with `docker compose -p
zboss-batch-update-l4c -f docker-compose.l4c.yml down`; add `--volumes` only
when the disposable target database should also be erased. Compose v1 hosts
can use the equivalent `docker-compose -p zboss-batch-update-l4c ...` form.
The build defaults to `docker.m.daocloud.io/library` for pinned Rust and Debian
base images; override `ZBOSS_L4C_IMAGE_REGISTRY` when an approved internal
registry mirror is available.

Run the production-boundary container gate with:

```powershell
npm run batch-rust:container-gate
```

This gate is an **L4-A dependency-protocol probe**. It exercises MySQL SQL
and Redis Lua directly and therefore does not attest a deployable Rust HTTP
service or concrete Rust database/Redis clients. L4-B additionally requires
the configured production-path attestation to find the real route and
non-test implementations of every required adapter trait.

The standalone production service is:

```powershell
cargo run --bin zboss-batch-update
```

It fails startup unless the MySQL URL, Redis URL and a
`cust_table<digits>` projection table are configured. Readiness checks MySQL,
Redis and the durable outbox worker.

## L4-C real dual replay

L4-C requires source Java and target Rust to execute the complete runtime
scenario contract against the same disposable seed. Start from
`cases/zboss-batch-update-with-progress/evidence/runtime/l4c/replay-plan.template.json`.
The state/fault boundary and rollout slices are defined in
`cases/zboss-batch-update-with-progress/evidence/runtime/l4c/STATE_HOOK_DESIGN.md`.
Copy it to `replay-plan.json`, replace every placeholder, configure direct
repo-local state hooks, and obtain a write approval that expires in at most
24 hours. The replay plan already invokes the project-local
`l4c-operation-driver.mjs`; copy `bindings.template.json` to `bindings.json`
to bind scenario requests and state hooks.

The operation driver performs HTTP health and invoke calls itself. Seed,
snapshot, collect, fault injection and cleanup use direct argv-based state
hooks from the binding document. Neither layer invokes a command shell.

Fault scenarios use a separate
`migration-guard.batch-update-l4c-fault-controller/v1` controller. The driver
requires `apply -> verify-active` before invoke and
`revert -> verify-inactive` during cleanup. Cleanup cannot pass unless the
`faultArtifacts` counter is zero. Collected observations must contain
meaningful canonical HTTP, context, decision, effect, state, event and failure
dimensions; `scale-boundary` also requires bounded performance evidence.

The target Rust binding uses the repository-owned
`zboss-l4c-state-hook` binary for MySQL/Redis doctor, empty-marker seed,
snapshot, collection, marker-bound cleanup and zero-residue verification. It
accepts only a disposable database name, numeric tenant/panel IDs and a
`cust_table<digits>` projection. Redis cleanup deletes the exact progress key
and only lease owner fields containing the run marker. Source Java resource
mappings and fault controllers remain environment-owned inputs because their
deployed schema and failure controls require review.

The source Java binding uses `zboss-l4c-java-state-hook` with an approved
`java-state-profile.json`. Start from
`java-state-profile.template.json`; replace every resource placeholder using
reviewed deployment metadata and set
`MG_L4C_JAVA_STATE_PROFILE`. The profile declares semantic table/column roles
and exact Redis key templates—there is no raw SQL field. Its SHA-256 must remain
identical across every source state operation, match
`targets.source.stateProfileSha256` in `bindings.json`, and is enforced by
preflight, the operation driver and the report gate.

Java state semantics are explicit: physical MySQL/Redis resources, volatile
WebSocket progress and absent source capabilities cannot be silently
substituted for one another. Scenario Seed files use
`migration-guard.batch-update-l4c-java-seed/v1`, reference only reviewed
projection resource IDs and aliases, and are bound per scenario through
`seedProfiles.source.path` plus `seedProfiles.source.sha256`. The driver passes
the selected file only to `seed`; the hook verifies its state-profile hash,
scenario identity, row budget and marker ownership before a transactional
insert.

Prepare and verify the SH-3C first-wave review packages with:

```powershell
npm run batch-rust:sh3c-prepare
npm run batch-rust:sh3c-gate
```

The generated manifest lives under
`evidence/runtime/l4c/scenario-promotion`. These packages are deliberately
`review-required` and `realEvidenceEligible=false`; the gate rejects stale
source hashes, package tampering, premature real eligibility and removal of
review blockers.

The structural preflight never executes lifecycle commands:

```powershell
npm run batch-rust:l4c-preflight -- --plan cases/zboss-batch-update-with-progress/evidence/runtime/l4c/replay-plan.json
```

After setting the environment variables, validate the approved binding and URL
scope. Add `--connect` to perform read-only HTTP health plus MySQL/Redis doctor
probes:

```powershell
npm run batch-rust:l4c-environment-preflight -- --plan cases/zboss-batch-update-with-progress/evidence/runtime/l4c/replay-plan.json
npm run batch-rust:l4c-environment-preflight -- --plan cases/zboss-batch-update-with-progress/evidence/runtime/l4c/replay-plan.json --connect
```

During staged SH-3C promotion, add `--scenario primary-success` to validate
only the promoted binding. The current `batch-update-contract-v1`
normalization profile is explicitly bounded to `primary-success`; preflight
fails closed if it is applied to any other scenario. Later scenarios require
their own reviewed row-level failure and undo semantics. A partial run does
not become L4-C eligible.

Real execution is fail-closed and additionally requires two process-local
approval values:

```powershell
$env:MG_L4C_REAL_WRITE_APPROVED = "zboss-batch-update-with-progress:disposable-write"
$env:MG_L4C_APPROVAL_NONCE = "<value whose SHA-256 is recorded in the plan>"
npm run batch-rust:l4c-run -- --plan cases/zboss-batch-update-with-progress/evidence/runtime/l4c/replay-plan.json
```

Commands are spawned directly without a shell. Every operation must return one
JSON document using `migration-guard.batch-update-l4c-operation/v1`. Scenario
operations must echo the approved marker, tenant, panel, table, database and row
count. Cleanup verification must report zero fixture, undo, outbox, commit,
Redis, lease and schema artifacts.

Each operation also updates an atomic
`artifacts/batch-update-rust/l4c-runs/<run-id>/checkpoint.json`. A scope lock
prevents concurrent runs for the same environment/database/tenant/panel/table.
Failed comparisons include bounded, redacted JSON-path differences in addition
to source and target semantic hashes.

After execution, an independent reviewer copies `review.template.json` to
`review.json`, binds it to the replay report hash, and approves it. Then run:

```powershell
npm run batch-rust:l4c-gate
node scripts/ci/zboss-completion-sync.mjs --project zboss-batch-update-with-progress
```

If execution is interrupted, use the recorded run ID to retry marker-bound
cleanup:

```powershell
node update/scripts/l4c-real-replay.mjs --plan <plan> --cleanup-only --run-id <run-id> --execute
node update/scripts/l4c-real-replay.mjs --plan <plan> --cleanup-only --latest-incomplete --execute
```

The local self-test uses injected synthetic operations and can never produce
real-eligible evidence:

```powershell
npm run batch-rust:l4c-self-test
npm run batch-rust:l4c-process-self-test
npm run batch-rust:l4c-environment-self-test
```
