# Phase 51: On-Demand Readiness Handoff CLI

生成日期：2026-07-07

## 1. 阶段目标

Phase 51 把 action check readiness handoff 从 `report` 的副产物变成可按需调用的 CLI。用户可以直接运行 `actions handoff` 生成或刷新 handoff artifact，而不需要重新渲染完整 run report。

## 2. 新增能力

- 新增 `migration-guard actions handoff [--run <id|latest>] [--json]`。
- 默认输出 handoff Markdown，并写出 JSON/Markdown artifacts。
- `--json` 输出机器可读 handoff JSON，并同样刷新 artifacts。
- CLI help 增加 `actions handoff`。
- 单测通过真实 `dist/cli.js actions handoff --json` 覆盖入口。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 30 tests passed

真实 MD run 回放：

```bash
node dist/cli.js actions handoff --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z
node dist/cli.js actions handoff --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z --json
```

结果：

- Markdown 输出显示 `No action check readiness blockers found.`
- JSON 输出 summary: `actions:9`, `checks:14`, `ready:14`, `no-op-risk:0`, `unknown:0`, `attentionItemCount:0`
- artifacts refreshed:
  - `reports/action-check-readiness-handoff.md`
  - `reports/action-check-readiness-handoff.json`
- target `md` git status: clean

## 4. Safety Boundary

`actions handoff` 只读取 run action plan 并刷新 readiness handoff artifacts。它不生成 proposal、不应用 patch、不改变 target repository，也不放宽 `action propose` 的 no-op-risk gate。
