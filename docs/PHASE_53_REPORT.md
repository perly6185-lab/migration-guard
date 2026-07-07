# Phase 53: Readiness Handoff Replan Tasks

生成日期：2026-07-07

## 1. 阶段目标

Phase 53 把 action check readiness handoff 从“可交接 artifact”推进到“可进入迁移任务图”。当 handoff 有 no-op-risk、unknown 或 missing metadata attention items 时，用户可以显式生成对应 issue 和 replan task。

## 2. 新增能力

- `actions handoff --create-replans` 显式生成 readiness replan tasks。
- 每个 attention item 使用 deterministic task id，重复运行不会重复创建 task。
- 每个 readiness replan task 都会关联一个 task issue。
- handoff JSON/Markdown 写回 `taskId`、`issueId`、`affectedFiles`。
- handoff summary 增加 `replanTaskCount`。
- 单测覆盖 no-op-risk/unknown attention items 的 task/issue 创建和幂等复跑。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 30 tests passed

真实 MD run 回放：

```bash
node dist/cli.js actions handoff --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z --create-replans --json
```

结果：

- current MD handoff has `attentionItemCount:0`
- current MD handoff has `replanTaskCount:0`
- target `md` git status: clean

Unit coverage:

- no-op-risk attention item creates a readiness replan task and task issue.
- unknown attention item creates a readiness replan task and task issue.
- repeated `actions handoff --create-replans --json` reuses existing deterministic tasks.
- generated handoff items include `taskId`, `issueId`, and `affectedFiles`.

## 4. Safety Boundary

`--create-replans` is explicit. Plain `actions handoff` remains artifact-only. The command mutates only Migration Guard run artifacts (`task-graph.json`, `issues.json`, handoff JSON/Markdown) and does not modify the target repository or create proposals.
