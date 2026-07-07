# Phase 44: First MD Domain Gated Proposal

生成日期：2026-07-07

## 1. 阶段目标

Phase 44 从 Phase 43 生成的 `md-monorepo` action candidates 中选择 `action-md-mcp-render`，跑通第一个真实 MD domain proposal gate：proposal verify、apply checks、proposal-scoped behavior diff 和 rollback。

## 2. 新增能力

- generated action probes 支持 affected path 为目录。
- 非 UI probe 对整个 action 范围聚合 renderer/API/package 信号，而不是要求每个 affected path 单独满足全部信号。
- UI probe 的 file inspection 也能读取目录内源码文件，避免目录路径直接 `readFileSync`。
- 单测覆盖目录型 `renderer-probe` proposal apply。

## 3. Smoke Target

选择：

- run: `run-2026-07-07T07-04-05-365Z-ai5vjd`
- action: `action-md-mcp-render`
- proposal: `patch-2026-07-07T07-51-23-220Z-64eeuc`
- generated file: `scripts/migration-guard/action-md-mcp-render.mjs`

原因：该 action 为 `medium/dry-run-only`，范围集中在 `packages/mcp-server`，依赖 `md-renderer-behavior`，适合作为整仓自动重构前的首个小步 gate。

## 4. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 26 tests passed

Patch-only verify：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run run-2026-07-07T07-04-05-365Z-ai5vjd --proposal patch-2026-07-07T07-51-23-220Z-64eeuc
```

结果：

- patch check: passed
- checks: skipped in verify mode

Apply gate：

```bash
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run run-2026-07-07T07-04-05-365Z-ai5vjd --proposal patch-2026-07-07T07-51-23-220Z-64eeuc --rollback-on-fail --behavior-diff
```

结果：

- patch check: passed
- `pnpm --filter @md/mcp-server type-check`: passed
- `node scripts/migration-guard/action-md-mcp-render.mjs`: passed
- behavior diff: passed
- behavior diff errors: 0
- behavior diff warnings: 0

Rollback:

```bash
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run run-2026-07-07T07-04-05-365Z-ai5vjd --proposal patch-2026-07-07T07-51-23-220Z-64eeuc
```

结果：

- reverse check: passed
- reverse apply: passed
- target `md` git status: clean

## 5. Notes

An initial `proposal verify --checks` attempt failed because verify mode does not apply newly generated probe scripts before running checks. The working path for generated-script proposals remains: patch-only verify, apply with checks, then rollback when the proposal is only a smoke artifact.
