# Phase 48: Action Propose Readiness Gate

生成日期：2026-07-07

## 1. 阶段目标

Phase 48 把 action check readiness 从提示推进到 proposal 生成前门禁。已知 `no-op-risk` 的 action 默认不能生成 proposal，防止明显空跑的 recommended check 进入后续 verification gate。

## 2. 新增能力

- `action propose` 检查 action `checkReadiness`。
- 存在 `no-op-risk` 时默认拒绝。
- 错误信息列出每条 no-op-risk command 和 reason。
- 新增 `--allow-no-op-risk` 显式 override。
- 单测覆盖默认拒绝和 override。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 29 tests passed

真实 MD ready action 回放：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z --action action-md-mcp-render
```

结果：

- proposal: `patch-2026-07-07T09-47-20-459Z-o4i4rx`
- generated file: `scripts/migration-guard/action-md-mcp-render.mjs`
- recommended checks include MCP render runtime smoke
- target `md` git status: clean

Unit coverage:

- no-op-risk action is rejected by default
- no-op-risk action can be proposed with `{ allowNoOpRisk: true }`

## 4. Safety Boundary

The override is intentionally explicit. It does not mark checks as accepted and does not change proposal verification behavior; runtime no-op output still fails proposal gates.
