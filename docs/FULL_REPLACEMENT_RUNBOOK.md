# Java-to-Rust Full Replacement Runbook

The `full-replacement` lane is independent of CL1-CL5 HTTP planning. It fails
closed until the target route owns the complete behavior and a source-off run
proves that the migrated Java endpoint is unavailable.

## Evidence flow

1. Generate the Java endpoint analysis and Rust inventory.
2. Build a closure manifest with reviewed Rust symbol evidence, infrastructure
   ports, and narrowly-scoped exclusions.
3. Upgrade the endpoint golden plan to model version 2.
4. Run the same cases through command-based source and target drivers.
5. Compare HTTP, context, decisions, effects, state, events, concurrency, and
   failures.
6. Evaluate RP1-RP6 and then endpoint pilot evidence.

## Generic endpoint replacement workflow

The primary workflow is endpoint-neutral. Route names and business method names
are evidence only; the planner derives its workload, contracts, boundaries,
scenarios, and implementation waves from the reachable behavior graph.

```text
endpoint discovery -> behavior graph -> context/state/effect contracts
  -> replacement boundaries -> implementation waves -> scenarios
  -> runtime driver -> RP1-RP6 readiness -> source-off pilot
```

```bash
migration-guard java-endpoint analyze --root ../java-service --method POST --path /api/example --max-depth 16 --max-total-edges 5000 --apply
migration-guard full-replacement plan --java-analysis java-analysis.json --apply
migration-guard full-replacement endpoint-driver --config source-driver.json --scenario scenario.json --apply
migration-guard full-replacement endpoint-driver --config target-driver.json --scenario scenario.json --apply
migration-guard full-replacement rp-readiness --evidence rp-evidence.json --apply
migration-guard full-replacement endpoint-pilot --plan endpoint-replacement-plan.json --source-root ../java-service --target-root ../target-service --apply
```

For repository-wide Controller assessment, build the Java project model once
and evaluate every normalized route:

```bash
migration-guard java-endpoint assess-controllers --root ../java-service --max-depth 8 --max-edges 1200 --apply
migration-guard java-endpoint assess-services --root ../java-service --max-depth 8 --max-edges 1200 --apply
```

The batch command is fail-closed and exits nonzero when any method is blocked.
See [CONTROLLER_RUST_ASSESSMENT.md](CONTROLLER_RUST_ASSESSMENT.md) for the
capability boundary and real zboss evidence.
Service methods, including implementations not reachable from a Controller, are
covered in [SERVICE_RUST_ASSESSMENT.md](SERVICE_RUST_ASSESSMENT.md).

The driver protocol is `setup`, `start`, `health`, `seed`, `invoke`, optional
`inject-fault`, `snapshot`, `collect`, `cleanup`, and `stop`. Scenario and fault
identifiers are validated before command execution. Cleanup and stop run on both
success and failure.

Readiness is sequential: RP1 complete graph, RP2 explicit contracts, RP3 target
ownership, RP4 source/target replay, RP5 concurrency/fault/performance evidence,
and RP6 source-off/freshness/rollback evidence. Missing target evidence is a
blocker and is never converted into an implicit pass.

```sh
migration-guard full-replacement closure --java-analysis java-analysis.json --rust-root ../rust-service --evidence closure-evidence.json --apply
migration-guard full-replacement golden --java-analysis java-analysis.json --apply
migration-guard full-replacement driver --config java-driver.json --case manual-refresh-success --apply
migration-guard full-replacement compare --source-observation java.json --target-observation rust.json --apply
migration-guard full-replacement readiness --evidence fr-evidence.json --apply
migration-guard full-replacement pilot --java-root ../zboss --rust-root ../zboss-rust --evidence pilot-evidence.json --apply
```

Blocked closure, driver, comparison, readiness, and pilot commands exit nonzero.
Production routing is never changed by these commands.

## Stable findings

- `FR-CLOSURE-*`: Java tails, unresolved calls/routes, truncation, invalid ports,
  or unsafe exclusions.
- `FR-CONTEXT-*`: missing required fields, provenance, or ambient context.
- `FR-EFFECT-*`: incomplete, unbounded, unknown, unordered, or malformed traces.
- `FR-DRIVER-*`: unsafe commands, timeout/failure, malformed output, or cleanup.
- `FR-REPLAY-*`: drift in a required observation dimension.
- `FR1-*` through `FR5-*`: readiness blockers with one local issue-plan item per
  failed gate.

The refreshSync pilot targets
`POST /zboss/data/view/dynamic/engine/use/engine-use-page/refreshSync`. It remains
blocked unless real Java and Rust roots exist and fresh evidence covers all
required cases, schedules, faults, performance limits, rollback, and source-off
execution.

## Current refreshSync evidence

`full-replacement pilot` and the refreshSync-specific model remain compatibility
entry points for existing artifacts. New endpoint work must use `plan`,
`endpoint-driver`, `rp-readiness`, and `endpoint-pilot`.

## Generic planner validation

Validation on 2026-07-21 used three real endpoints from the supplied zboss Java
root without endpoint-specific planner branches:

| Endpoint suffix | Workload | Graph | Scenarios | Status |
| --- | --- | ---: | ---: | --- |
| `/init` | command | 441 nodes / 1914 edges | 15 | plan ready |
| `/refreshSync` | sync | 151 nodes / 738 edges | 17 | plan ready |
| `/page` | query-with-effects | 408 nodes / 1619 edges | 16 | plan ready |

All graphs were untruncated with zero unresolved calls. No Rust `Cargo.toml` or
target root is available under the supplied repository or `D:\\gitlab\\ia`, so
real target replay, performance, source-off, and rollback evidence remain
blocked. This is the expected fail-closed result, not completion of RP4-RP6.

The Java source root has been analyzed at:

`D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data`

The exact endpoint produced one route match, a non-truncated 151-node/738-edge
call graph and 10 sync-command source golden cases. Golden model v2 generation
also passed. No `Cargo.toml` exists under the supplied source tree or the searched
`D:/gitlab/ia` roots, so closure, target replay, performance parity and source-off
verification remain blocked until the real Rust root is supplied. The CLI reports
this condition as `MG201-RUST-ROOT-MISSING` and exits nonzero.
