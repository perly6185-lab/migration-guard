# Phase 55: MD Multi-Domain Proposal Batch

生成日期：2026-07-07

## 1. 阶段目标

Phase 55 不再只验证单个 action proposal，而是在真实 `md` monorepo 上跑一次多 domain proposal batch。目标是证明 Migration Guard 可以从 action plan 生成多个 proposal，按 batch gate 顺序真实 apply，运行推荐 checks，并在验证后 rollback 保持 target repository 干净。

## 2. 真实运行

Fresh MD run:

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 55 MD multi-domain proposal batch" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-07T10-58-36-339Z-k48bw4 --auto
```

结果：

- Run ID: `run-2026-07-07T10-58-36-339Z-k48bw4`
- Tasks done: 7
- Issues: 27
- Action check readiness: `actions:9`, `checks:14`, `ready:14`, `no-op-risk:0`, `unknown:0`
- Handoff artifact: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-07T10-58-36-339Z-k48bw4/reports/action-check-readiness-handoff.md`

## 3. Batch Result

Passing batch:

```bash
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run run-2026-07-07T10-58-36-339Z-k48bw4 --limit 3 --gate-policy fail-fast
```

Batch report:

- `proposal-batch-report-2026-07-07T11-08-02-379Z-lamclw`
- Plan: `proposal-batch-2026-07-07T11-07-47-417Z-ord94b`
- Passed: yes
- Executed: 3
- Skipped: 0

Executed proposals:

- `patch-2026-07-07T11-07-29-664Z-udb9qn`: `action-md-mcp-render`
- `patch-2026-07-07T11-02-06-660Z-pgnto5`: `action-md-api-contracts`
- `patch-2026-07-07T11-06-22-797Z-0ni93m`: `action-md-core-renderer`

Rollback after verification:

- MCP render rollback: passed
- API contracts rollback: passed
- Core renderer rollback: passed
- target `md` git status after rollback: clean

## 4. Findings Preserved as Evidence

The real batch attempt also exposed two useful readiness gaps:

- `action-md-shared-contracts` used `ui-smoke-probe` against TS-only shared directories. The generated probe required `<template>` and `<script>`, so it failed on `packages/shared/src/configs`, `types`, `editor`, and `utils`.
- The first MCP render proposal failed once with `flake-suspected` because the renderer attempted to fetch remote code-block CSS from `cdn-doocs.oss-cn-shenzhen.aliyuncs.com` and hit `ECONNRESET`. The same command passed when rerun in isolation, and the regenerated MCP proposal passed in the final batch.

These are not blocking for Phase 55 completion, but they are good inputs for the next repair/planning stage:

- map shared TS package actions to a non-UI structural probe;
- make MCP render smoke avoid remote CSS fetches or cache/stub that dependency;
- tighten adapter fixture probes so proposed-only patches do not need rollback for exclusion.

## 5. Safety Boundary

Phase 55 only committed documentation. Runtime artifacts remain under `.migration-guard/` and are not repository source. The MD target repository was modified during proposal apply, then returned to clean state through proposal rollback.

## 6. Verification

Migration Guard self-check:

```bash
npm test
git diff --check
```

Results:

- 30 tests passed
- `git diff --check` passed; Windows line-ending warnings only
