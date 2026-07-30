# ZBoss dynamic-engine Rust runtime

The combined deployment entry lives at `../../Cargo.toml` and reuses this
crate as the internal dynamic-engine runtime. The `zboss-page` binary and
`ZBOSS_PAGE_*` configuration keys remain available for deployment
compatibility.

Independent Rust target for:

- `POST /zboss/data/view/dynamic/engine/use/engine-use-page/query`
- `POST /zboss/data/view/dynamic/engine/use/engine-use-page/page`
- `POST /zboss/data/view/dynamic/engine/use/engine-use-horizontal/list`
- `POST /zboss/data/view/dynamic/engine/use/engine-use-page/init`
- `PUT /zboss/data/view-dynamic-field-data/update`
- `DELETE /zboss/data/view-dynamic-field-data/delete?id={fieldId}`
- `GET /zboss/data/view-dynamic-field-data/get?id={fieldId}`

The Java zboss project is a read-only reference. This crate owns new code and
offline evidence only.

Application code is grouped by business meaning:

```text
src/application/
├── data/
│   ├── page.rs
│   ├── horizontal.rs
│   └── init.rs
└── schema/
    ├── query.rs
    ├── get.rs
    ├── update.rs
    └── delete.rs
```

`data` reads or mutates row values. `schema` reads or mutates page, view and
field configuration. The source-compatible HTTP paths remain unchanged.

PRP-01 through PRP-15 are implemented for the independent memory profile and
their individual gates pass. The service exposes `/health`, `/ready`, and the
seven source-compatible route entries, provides
tenant/datasource/snapshot-isolated state, interprets the same safe query plan
that the MySQL adapter consumes as data/count bound statements, and supports
deterministic clock, lease fencing, refresh orchestration, evidence events, and
fault injection.

The process starts with an empty memory store, so an unseeded page request fails
closed with a metadata error. The production profile binds the real SQLx MySQL
page/horizontal executors and validates Redis connectivity configuration. It
requires `mysql` and `redis` features plus:

- `ZBOSS_PAGE_MYSQL_URL`
- `ZBOSS_PAGE_REDIS_URL`
- `ZBOSS_PAGE_CATALOG_FILE`

The catalog is a reviewed, tenant/datasource/snapshot-scoped mapping from ZBoss
logical IDs to physical tables and columns. Start from
`config/production-catalog.example.json`; never place credentials in it.
Production startup fails instead of serving a permanently unavailable runtime
when any required binding is missing or invalid.

Contract version 8 distinguishes the add and edit modes of the field-schema
update entry, keeps a recoverable DDL-transition boundary for ADD, and accepts
the ledger field-catalog query with only `usePageId`. It also adds the
single-field DELETE and GET-detail query-parameter contracts.
JavaScript-sized identifiers may arrive as JSON strings or
integers; Rust converts both forms to checked `u64` values. Missing `reqId`
uses the explicit request-context ID, `usePageId` and `pageId` remain distinct
identities, and the compatibility ceiling is 10000 rows.

The new entries remain fail-closed where compatibility is unresolved:

- `query` with `viewId` keeps the explicit calendar/view lookup. Without
  `viewId`, it returns the use-page field catalog grouped under panel responses,
  using the same metadata state changed by field ADD/EDIT. Production now
  serves this read-only branch from the reviewed `fields` catalog, validates
  use-page/panel bindings, logical and physical field uniqueness, safe
  identifiers, and exact `panelRespKey` ownership before startup;
- `init` is a real CREATE operation, not a read-only form initializer. The
  memory profile verifies request compatibility, tenant/panel authorization,
  idempotency, generated identity/row number, rollback and durable outbox
  atomicity. Production rejects it until the allowlisted field metadata,
  SQL transaction/idempotency/undo schema and cascade outbox are configured;
- field `update` selects ADD when `id` is absent and EDIT when `id` is present.
  ADD uses the resumable `planned -> ddl-applied -> succeeded` transition.
  EDIT must resolve the existing field and physical column from server metadata,
  preserves that physical identity and never executes `ADD COLUMN`. Production
  rejects both modes until metadata transactions, a DDL allowlist for ADD,
  durable transition/lease, orphan repair and post-commit jobs are configured;
- field `delete` removes custom-field metadata from the scoped catalog and
  writes one durable delete event. It deliberately does not execute
  `DROP COLUMN`, matching Java's metadata-oriented delete path and avoiding
  irreversible data loss. Protected fields use logical hide semantics and each
  successful delete records one undo snapshot in the offline adapter.
  Production mutation remains rejected until reference verification,
  transactional related-config cleanup, durable undo storage and post-commit
  work are bound;
- field `get` returns the same scoped catalog record enriched with safe
  configuration values captured by ADD/EDIT. Missing or deleted fields return
  `data: null`, matching Java. Production now serves reviewed common and
  type-specific values from the flattened `fields` catalog. Dynamic Java joins
  and complete per-field-type projection still require runtime replay before
  cutover;
- metadata query reads an already materialized calendar view and does not
  reproduce Java query-time self-healing writes;
- horizontal `operator` values are rejected until a concrete
  `HorizontalRefreshCoordinator` is bound;
- page-size preference writes require a separately reviewed persistence
  adapter, so production callers must send `skipSavePageSize=true`;
- real source/target replay is still required before cutover.

See `INIT_MIGRATION_ASSESSMENT.md` for the Java behavior inventory and the
remaining production cutover blockers.
See `FIELD_SCHEMA_MIGRATION_ASSESSMENT.md` for the unified field query/add/edit
assessment.

Production build:

```text
cargo build --release --no-default-features --features mysql,redis
```

```text
cargo fmt --check
cargo test --all-features --offline
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release --all-features --offline
cargo run
```

Default bind: `127.0.0.1:18081`.

Batch 2 aggregate gate (run from the repository root):

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/batch2-gate.mjs
```

It overwrites `artifacts/page-rust/batch2-gate.json` and
`artifacts/page-rust/batch2-acceptance.md`; a failed run cannot retain an older
PASS report.

PRP-10 eight-scenario gate:

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/prp10-gate.mjs
```

The stable scenario index lives under `fixtures/scenarios`. Each scenario
asserts its response, query plan, data snapshot, event trace, and SHA-256 query
fingerprint. `entrypoint-parity` passes through the reusable HTTP route.

PRP-11 fault and concurrency matrix gate:

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/prp11-gate.mjs
```

The matrix contains 14 fault cases, 4 process-interruption recovery cases, and
5 concurrency cases. MySQL and Redis behaviors use deterministic boundary
harnesses; no network service is required.

PRP-12 fixed-seed property gate:

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/prp12-gate.mjs
```

Seven properties use the versioned `lcg64-v1` generator. A failure
prints `property`, `seed`, and `iteration`; the gate preserves that replay tuple
in its failure report.

PRP-13 offline dual-path replay gate:

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/prp13-gate.mjs
```

`java-reference-stub` is frozen synthetic provenance, while
`rust-page-memory` executes the real Rust HTTP/application/domain path. The
comparator verifies input hashes, responses, semantic query plans, and event
traces, applies approved compatibility decisions, and rejects every
unclassified difference.

PRP-14 reproducible evidence gate:

```text
node rust/zboss-rust/internal/dynamic-engine-runtime/scripts/prp14-gate.mjs
```

The gate builds the release binary, regenerates the six offline artifacts
twice, compares their byte hashes, recomputes every source and cross-artifact
link, and proves that a copied-and-mutated artifact fails verification.
The resulting readiness is `CANDIDATE` until the PRP-15 unified gate runs.

PRP-15 unified gate and final offline decision:

```text
npm run page-rust:gate
```

The command invalidates any stale final PASS before it runs, executes the
TypeScript/VMP and all page-service stage gates in order, checks static closure
and schema compatibility, rejects tampered or missing evidence, and writes a
separate `offline-ready` attestation. `OFFLINE-READY` covers offline
implementation and evidence only; real same-snapshot acceptance remains a
separate phase.
