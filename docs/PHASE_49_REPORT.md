# Phase 49: Run Report Check Readiness Rollup

生成日期：2026-07-07

## 1. 阶段目标

Phase 49 把 action check readiness 从 `actions` 详情页推进到 run status/report。用户不需要单独打开 action plan，也能在迁移运行摘要里看到 recommended checks 是否存在 no-op 风险。

## 2. 新增能力

- `status` 输出 action check readiness 汇总。
- `report` 新增 `Action Check Readiness` 章节。
- `resolveRunNextAction` 在没有更强 proposal/behavior blocker 时，优先提示修复 `no-op-risk` checks。
- readiness 汇总包含 action 数、recommended check 数、tracked check 数、ready/no-op-risk/unknown 计数。
- 单测覆盖 status/report/next-action 对 no-op-risk 的展示。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 30 tests passed

真实 MD run 回放：

```bash
node dist/cli.js status --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z
node dist/cli.js report --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z
```

结果：

- status: `Action check readiness: actions:9 checks:14 tracked:14 ready:14 no-op-risk:0 unknown:0`
- report: 新增 `## Action Check Readiness`
- target `md` git status: clean

Unit coverage:

- no-op-risk readiness 会成为推荐 next action。
- `renderRunStatus` 展示 readiness 汇总和首个风险。
- `renderRunReport` 展示 readiness 章节、计数、no-op-risk 和 unknown 条目。

## 4. Safety Boundary

Phase 49 不改变 proposal gate 或 `action propose` gate 行为。它只读取已有 action plan artifact 并把风险暴露到 status/report；运行时 no-op 输出仍由 proposal gate 阻断。
