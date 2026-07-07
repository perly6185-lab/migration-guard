# Phase 54: AI Repair Briefs for Readiness Failures

生成日期：2026-07-07

## 1. 阶段目标

Phase 54 把 readiness replan task 进一步转成 AI/human 可执行的 repair brief。每个 readiness attention item 都可以获得 task-scoped Markdown brief 和 JSON context，帮助修复 no-op-risk、unknown 或 missing metadata checks。

## 2. 新增能力

- `actions handoff --repair-briefs` 写出 readiness repair briefs。
- `--repair-briefs` 会确保对应 replan task / task issue 存在。
- 每个 handoff item 写回 `repairBriefPath` 和 `repairContextPath`。
- handoff summary 增加 `repairBriefCount`。
- repair context JSON 包含 run、item、task、issue、paths、commands。
- repair brief 明确 AI 任务、证据、修复约束、命令和完成标准。
- 单测覆盖 brief/context 写出、内容、路径回写和幂等复跑。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 30 tests passed

真实 MD run 回放：

```bash
node dist/cli.js actions handoff --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z --create-replans --repair-briefs --json
```

结果：

- current MD handoff has `attentionItemCount:0`
- current MD handoff has `replanTaskCount:0`
- current MD handoff has `repairBriefCount:0`
- target `md` git status: clean

Unit coverage:

- no-op-risk readiness item writes repair brief/context.
- unknown readiness item writes repair brief/context.
- repair context includes linked task/issue and recommended commands.
- repeated `actions handoff --create-replans --repair-briefs --json` remains idempotent.

## 4. Safety Boundary

`--repair-briefs` writes only Migration Guard artifacts under the run directory. It does not modify the target repository, generate proposals, weaken no-op-risk gates, or apply patches.
