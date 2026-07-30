# Unified ZBoss Rust service

This package is the single deployment entry for:

- all `zboss-dynamic-engine-runtime` data and schema routes;
- `POST .../batchDelete`;
- `POST .../batchUpdateWithProgress`.

Physical project layout:

```text
zboss-rust/
├── src/
│   ├── data/                 # public data::{page,horizontal,init,update,delete}
│   └── schema/               # public schema::{query,get,update,delete}
├── internal/
│   └── dynamic-engine-runtime/ # page/update/delete runtime and schema capabilities
├── Cargo.toml
└── Cargo.lock
```

There is no `components` directory and no second top-level `data` namespace.
`src/data` and `src/schema` are the stable business API; the `internal/*`
packages are compile and runtime boundaries inside the same deployable project.

The former page, batch-update and batch-delete services are integrated in
`internal/dynamic-engine-runtime`. The delete compensation worker retains an
explicit lifecycle handle, so it is enabled only by configuration without
creating a separate crate or listener. Both packages share the root
`Cargo.lock`, release profile, dependency resolution and unified gate.
Compatibility binaries remain available; the deployment executable is `zboss`.

By default the dynamic-engine capability uses its memory profile. Batch delete
is registered but disabled, and batch update is registered in contract-only
fail-closed mode. This prevents an incomplete write adapter from mutating
production data.

Configuration:

- `ZBOSS_UNIFIED_BIND`, default `127.0.0.1:18080`;
- `ZBOSS_UNIFIED_PROXY_SHARED_SECRET`; required whenever
  `ZBOSS_UNIFIED_BIND` is not loopback. The trusted gateway must remove any
  client-supplied `X-ZBoss-Proxy-Secret` header and inject the configured value
  after authentication;
- existing `ZBOSS_PAGE_*` variables, retained as deployment-compatible
  dynamic-engine configuration keys;
- `ZBOSS_UNIFIED_BATCH_DELETE_MODE=disabled|production`;
- existing `ZBOSS_BATCH_DELETE_*` variables when delete mode is `production`.

Run from `rust/zboss-rust`:

```text
cargo run --bin zboss
```

Strict checks:

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
```

`GET /internal/capabilities` reports which implementation mode is active for
each capability. `GET /internal/ready` aggregates the enabled Dynamic Engine
and Batch Delete runtimes. Three consecutive compensation-worker poll failures
make Batch Delete and the unified readiness probe unavailable until a
successful poll recovers it. Health, readiness and capability probes do not
require the proxy secret; business routes do. Batch-update production
activation remains blocked until its network MySQL/Redis persistence
implementation is completed.

## Route ownership

The public Rust API groups routes by business meaning instead of the legacy
service name:

| Business facade | ZBoss operation | Owning capability |
| --- | --- | --- |
| `data::page` | page and calendar row query | dynamic-engine |
| `data::horizontal` | horizontal row query | dynamic-engine |
| `data::init` | create row data | dynamic-engine |
| `data::update` | batch update row data | dynamic-engine |
| `data::delete` | batch delete row data | dynamic-engine |
| `schema::query` | query page/view/field configuration | dynamic-engine |
| `schema::get` | get one field definition | dynamic-engine |
| `schema::update` | add or edit a field definition | dynamic-engine |
| `schema::delete` | delete a field definition | dynamic-engine |

Batch delete uses its production router and compensation worker when enabled.
Batch update keeps its exact route but returns 503 until network persistence is
implemented.

The former standalone binaries remain usable as compatibility targets inside
the Dynamic Engine package. Downstream Rust code should use the root project
business facades `zboss_rust::data::*` and `zboss_rust::schema::*`; the internal
capability crate is not part of the public integration surface.
