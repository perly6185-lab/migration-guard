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
6. Evaluate FR1-FR5 and then the refreshSync pilot evidence.

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

The Java source root has been analyzed at:

`D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data`

The exact endpoint produced one route match, a non-truncated 151-node/738-edge
call graph and 10 sync-command source golden cases. Golden model v2 generation
also passed. No `Cargo.toml` exists under the supplied source tree or the searched
`D:/gitlab/ia` roots, so closure, target replay, performance parity and source-off
verification remain blocked until the real Rust root is supplied. The CLI reports
this condition as `MG201-RUST-ROOT-MISSING` and exits nonzero.
