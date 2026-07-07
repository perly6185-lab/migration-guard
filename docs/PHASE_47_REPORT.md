# Phase 47: Action Check Readiness

生成日期：2026-07-07

## 1. 阶段目标

Phase 47 把 no-op check 风险从 proposal gate 前移到 action plan。`actions` 输出现在能直接展示每条 recommended check 的静态 readiness，帮助用户在生成 proposal 前发现明显缺脚本或无法静态解析的命令。

## 2. 新增能力

- `MigrationAction.checkReadiness`
- target package script index
- root script readiness
- `pnpm --filter <pkg> <script>` readiness
- `pnpm --filter <pkg> exec ...` readiness
- `actions` CLI 展示 `check-readiness`

Readiness 状态：

- `ready`: 静态确认 root/package script 存在，或命令是 direct `pnpm exec`
- `no-op-risk`: 静态确认目标 root/package 缺少该 script
- `unknown`: 非 pnpm 命令或静态无法确认

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 28 tests passed

真实 MD action plan 回放：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD action check readiness validation" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-40-11-043Z-iu9r8z
```

结果：

- run: `run-2026-07-07T09-40-11-043Z-iu9r8z`
- action plan includes `checkReadiness`
- `pnpm --filter @md/core test`: `ready`
- `pnpm type-check:packages`: `ready`
- `pnpm --filter @md/web test`: `ready`
- `pnpm vscode:test`: `ready`
- `pnpm build:cli`: `ready`
- MCP runtime smoke: `ready`
- target `md` git status: clean

Unit coverage:

- `pnpm --filter @md/core test` -> `ready`
- `pnpm --filter @md/mcp-server type-check` -> `no-op-risk`
- `pnpm --filter @md/mcp-server exec tsx ...` -> `ready`

## 4. Safety Boundary

Readiness is static guidance, not a replacement for proposal gates. Actual checks still run during `proposal verify --checks` or `action apply`; no-op runtime output remains a gate failure.
