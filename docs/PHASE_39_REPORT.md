# Phase 39: Behavior Diff Decision Ledger

生成日期：2026-07-07

## 1. 阶段目标

Phase 39 为 behavior drift / proposal-scoped behavior diff 增加本地决策账本。迁移操作者可以把 compare difference 分类为 `intentional`、`accidental` 或 `unknown`，并记录原因、批准来源、run/proposal 关联。

## 2. 新增能力

- `diff list`
- `diff decide`
- run-scoped `diff-decisions/decisions.json`
- compare Markdown decision/reason 列
- run report `behavior-decisions` coverage 摘要
- pending risk behavior diff 进入 `status` / `report` 下一步动作
- replan brief 的 Behavior Drift 增加 `[pending]` / `[intentional]` 等标签

## 3. Artifacts

```text
.migration-guard/diff-decisions/decisions.json
.migration-guard/migration-runs/<run-id>/diff-decisions/decisions.json
```

`diff decide` 也会刷新对应 compare Markdown，使人工审阅时能直接看到 decision 和 reason。

## 4. Safety Boundary

本阶段不改变 compare 算法，不把 intentional diff 自动视为通过，也不修改 probe/check 结果。decision ledger 只是附加证据层，后续 allowlist / policy gate 可以在此基础上扩展。

## 5. Verification

覆盖点：

- diff decision 持久化
- compare difference fingerprint 匹配
- coverage 统计 decided / pending / pending-risk
- compare Markdown 刷新展示 decision
- TypeScript build

验证命令：

```bash
npm test
```
