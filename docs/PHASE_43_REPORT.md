# Phase 43: MD Adapter Task Graph

生成日期：2026-07-07

## 1. 阶段目标

Phase 43 把 `perly6185-lab/md` 的整仓自动重构准备路线落成可执行 adapter。它生成项目专属任务图、action plan、issues 和 Markdown/JSON artifact，但仍不修改 `md` 目标仓库业务源码。

## 2. 新增能力

- 新增 `md-monorepo` adapter task graph。
- 新增 `md-monorepo:plan` executor，输出 MD refactor task plan。
- 新增 `md-monorepo:actions` executor，输出 AI-owned action candidates。
- action plan loader 支持 `adapter/md-monorepo-action-plan.json`。
- 单测覆盖 task graph、关键 domain、probe/check 映射。

## 3. Task Plan Coverage

MD task plan 覆盖：

- `packages/core` renderer/extensions
- `packages/shared` shared contracts and utilities
- `apps/web` editor shell, AI/image panels, stores
- `apps/api` route and contract boundaries
- `apps/vscode` preview behavior
- `packages/md-cli` packaging flow
- `packages/mcp-server` render contract
- root cross-package verification

每个任务包含 risk、owner、affected files、recommended checks、required probes、acceptance criteria 和 rollback boundary。

## 4. Safety Boundary

本阶段只写 Migration Guard run artifacts 和本地 issue 记录，不写入 `D:/learn/migration-guard-targets/md` 的业务源码。高风险 domain action 默认 `manual-approval-required`，后续 proposal 仍需走现有 gate。

## 5. Verification

已验证：

```bash
npm run build
npm test
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD monorepo refactor task planning" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
node dist/cli.js tasks --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run latest
```

结果：

- `npm run build`: passed
- `npm test`: 25 tests passed
- smoke run: `run-2026-07-07T07-04-05-365Z-ai5vjd`
- resume status: completed
- task graph: 7 tasks done
- actions: 9 action candidates
- target `md` git status: clean

产物：

- `adapter/md-monorepo-task-plan.json`
- `adapter/md-monorepo-task-plan.md`
- `adapter/md-monorepo-action-plan.json`
- planned task/action issues
