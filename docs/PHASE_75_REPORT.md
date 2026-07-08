# Phase 75 Report: Large Refactor Readiness Gate

生成日期：2026-07-08

## Goal

在继续真实 `md.git` 重构前，先补齐“大批量/一次性重构是否可进入”的机器可审查准入条件。Phase 75 不扩大真实项目变更面，只增加只读评估、报告和测试，让 operator 能先看到明确的 `go` / `hold`。

## Delivered

- 新增 `readiness` CLI：

```bash
node dist/cli.js readiness --run <run-id> --min-proposals 3 --min-batch-size 3 --strict
```

- 新增 large-batch refactor readiness artifact：
  - `reports/refactor-readiness.json`
  - `reports/refactor-readiness.md`
- run report 新增 `Refactor Readiness` 区块。
- README quick path 和 `docs/MD_OPERATOR_RUNBOOK.md` 增加 readiness gate。
- 新增 `src/core/refactorReadiness.test.ts`，覆盖 `hold` 和 `go` 两条路径。

## Readiness Criteria

默认准入门槛：

- target repository clean。
- task graph valid。
- run 已推进到 action plan 阶段。
- action plan 存在且 action check readiness 无 no-op-risk / unknown / missing。
- 至少 3 个 candidate proposal。
- `md-monorepo` 覆盖 `ts-structural-probe`、`renderer-probe`、`api-contract-probe`。
- 至少一个 passing batch，且 executed proposal 数量不少于 3。
- 不存在 unresolved failed/applied proposal state。
- confidence 不能为 low；medium 会保留 warning。

## Real `md.git` Evidence

Target repository:

```text
https://github.com/perly6185-lab/md.git
```

Local target:

```text
D:/learn/migration-guard-targets/md
```

Run id:

```text
run-2026-07-08T04-10-31-670Z-btbcxw
```

Command:

```bash
node dist/cli.js readiness --config configs/md-fast.migration-guard.json --run run-2026-07-08T04-10-31-670Z-btbcxw
```

Current result:

```text
Status: hold
Target clean: yes
Blockers: 6
Warnings: 1
Actions: 0
Proposals: 0
Batches: 0
Latest passing batch: none
```

Current blockers:

- run still planned and action evidence is missing。
- no action plan with actions exists。
- action check readiness cannot be evaluated without an action plan。
- 0/3 candidate proposals are ready。
- missing required templates: `ts-structural-probe`, `renderer-probe`, `api-contract-probe`。
- no passing batch with at least 3 executed proposals。

Generated artifacts:

- `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T04-10-31-670Z-btbcxw/reports/refactor-readiness.json`
- `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T04-10-31-670Z-btbcxw/reports/refactor-readiness.md`
- `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T04-10-31-670Z-btbcxw/reports/latest-report.md`

## Verification

```text
npm test: 44 passed
```

The real `md.git` target remained clean after the readiness assessment.

## Next

Continue the real project validation lane:

```bash
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-08T04-10-31-670Z-btbcxw --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run run-2026-07-08T04-10-31-670Z-btbcxw
node dist/cli.js readiness --config configs/md-fast.migration-guard.json --run run-2026-07-08T04-10-31-670Z-btbcxw
```

Only consider a scoped real refactor trial after `readiness --strict` returns `go`.
