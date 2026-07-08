# Phase 58: Real MD Small-Batch Regression

生成日期：2026-07-08

## 1. 阶段目标

Phase 58 在真实 `md` target 仓库上复跑一个 `md-fast` 小批量回归，验证 Phase 57 修复不只覆盖单测，也能修复真实 batch 流程中的三个问题：

- shared TS package action 生成 `ts-structural-probe`，不再误用 UI probe。
- MCP render runtime smoke 不再触发远程 CSS fetch。
- `ignored` proposed-only proposal 不进入 batch plan。

## 2. Run Evidence

- run: `run-2026-07-08T00-19-52-742Z-85tia7`
- target: `D:\learn\migration-guard-targets\md`
- config: `configs/md-fast.migration-guard.json`
- action readiness: 9 actions, 14 recommended checks, 14 ready, 0 no-op-risk, 0 unknown
- run report: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T00-19-52-742Z-85tia7/reports/latest-report.md`

执行命令：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 58 real MD small-batch regression" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-19-52-742Z-85tia7 --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-19-52-742Z-85tia7
```

## 3. Proposal Coverage

Generated proposals:

- `patch-2026-07-08T00-25-52-698Z-t1z95w`: MCP render, `renderer-probe`
- `patch-2026-07-08T00-25-52-784Z-rzmik7`: shared contracts, `ts-structural-probe`
- `patch-2026-07-08T00-25-52-784Z-dn0vm8`: API contracts, `api-contract-probe`
- `patch-2026-07-08T00-25-52-703Z-ilv1vz`: CLI package, intentionally marked `ignored`

Shared TS evidence:

- patch path: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T00-19-52-742Z-85tia7/proposals/patch-2026-07-08T00-25-52-784Z-rzmik7/patch.diff`
- patch contains `"template": "ts-structural-probe"`
- verification passed `has-typescript-module-signal` and `has-typescript-structure-signal`
- no Vue `<template>` / `<script>` UI check was used for shared TS

MCP render evidence:

- proposal: `patch-2026-07-08T00-25-52-698Z-t1z95w`
- recommended check calls `buildRenderedOutput({ markdown: '# Hi', codeBlockTheme: '' })`
- verification stdout included `{"hasHeading":true,"words":2,"remoteCssFetch":false}`
- no `ECONNRESET`, CDN, or remote CSS fetch failure occurred

Proposal exclusion evidence:

```bash
node dist/cli.js proposal ignore --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-19-52-742Z-85tia7 --proposal patch-2026-07-08T00-25-52-703Z-ilv1vz --reason "Phase 58 proposed-only exclusion smoke"
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-19-52-742Z-85tia7 --limit 3 --json
```

Batch plan selected MCP render, shared contracts, and API contracts. The ignored CLI proposal did not appear in the selected batch.

## 4. Batch Result

Batch apply command:

```bash
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-19-52-742Z-85tia7 --limit 3 --gate-policy fail-fast --json
```

Batch report:

- id: `proposal-batch-report-2026-07-08T00-27-00-976Z-omk6wk`
- path: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T00-19-52-742Z-85tia7/proposal-batches/proposal-batch-2026-07-08T00-26-33-340Z-okvoua/proposal-batch-report-2026-07-08T00-27-00-976Z-omk6wk.json`
- passed: true
- executed: 3
- skipped: 0
- gate policy: fail-fast

Executed proposals:

- `patch-2026-07-08T00-25-52-698Z-t1z95w`: passed, state `applied`
- `patch-2026-07-08T00-25-52-784Z-rzmik7`: passed, state `applied`
- `patch-2026-07-08T00-25-52-784Z-dn0vm8`: passed, state `applied`

## 5. Rollback And Clean State

Rollback reports:

- `patch-2026-07-08T00-25-52-698Z-t1z95w`: `proposal-rollback-2026-07-08T00-27-13-393Z-oyiu5v`, passed
- `patch-2026-07-08T00-25-52-784Z-rzmik7`: `proposal-rollback-2026-07-08T00-27-13-385Z-j4w30g`, passed
- `patch-2026-07-08T00-25-52-784Z-dn0vm8`: `proposal-rollback-2026-07-08T00-27-13-417Z-48cqwu`, passed

Final target status:

```bash
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Result:

```text
## main...origin/main
```

The target `md` repository ended clean after rollback.

## 6. Verification

Migration Guard self-checks:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 32 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

## 7. Exit Criteria

- At least 3 proposals entered batch: passed
- Batch included shared TS proposal: passed
- Shared TS proposal used `ts-structural-probe`: passed
- MCP render proposal avoided remote CSS fetch: passed
- Proposed-only ignored proposal was excluded from batch plan: passed
- Batch report recorded executed/skipped state: passed
- Applied proposals rolled back successfully: passed
- Target `md` repository ended clean: passed
- No CDN flake occurred: passed

