# Phase 12: From Validation to Assisted Migration Report

生成日期：2026-07-05

## 1. 目标

Phase 12 的目标是把 Migration Guard 从“能在真实项目上证明行为没坏”，推进到“能对真实项目提出可验证、可回滚、可协作的迁移动作”。

本阶段围绕 `perly6185-lab/md` 继续推进：

- 可移植外部目标配置
- check 输出降噪
- `pnpm-vite-vue` action planner
- dry-run patch proposal
- GitHub issue sync dry-run
- preview/HTTP smoke probe

## 2. 已实现能力

### 2.1 Portable Target Harness

`configs/md-fast.migration-guard.json` 和 `configs/md-full.migration-guard.json` 已去除硬编码目标路径，支持变量插值：

- `${MG_TARGET_ROOT}`
- `${MG_ARTIFACTS_DIR}`
- `${MG_REPO_ROOT}`

默认变量仍可在本仓库直接运行，也可通过环境变量覆盖。

### 2.2 Check Output Normalization

新增 `src/core/checkNormalize.ts`，支持 checks 的 stdout/stderr normalize。

已支持 presets：

- `vitest`
- `vite`
- `paths`
- `timing`

check result 现在会保存：

- `normalizedStdout`
- `normalizedStderr`
- `normalizedStdoutHash`
- `normalizedStderrHash`

compare 优先使用 normalized hash 判断 passing check 的输出差异。

### 2.3 `pnpm-vite-vue` Action Planner

adapter 现在除了 inventory，还会生成：

- `pnpm-vite-vue-action-plan.json`
- candidate action issues

当前 action 类型：

- renderer probes before renderer refactor
- API type/schema review before shared type changes
- UI probe before splitting large Vue components

### 2.4 Dry-Run Patch System

新增：

```bash
node dist/cli.js task propose --run latest --task <task-id>
node dist/cli.js task apply --run latest --proposal <proposal-id>
```

当前 proposal 默认生成 non-mutating patch，用于记录 review intent、recommended checks 和审批流程。后续 adapter 可以在这个机制上生成真实 patch。

### 2.5 GitHub Issue Sync Dry Run

`sync-issues` 支持：

```bash
node dist/cli.js sync-issues --run latest --provider github --dry-run
```

dry-run 会生成 provider-neutral JSON/Markdown，不回写 external issue id。

### 2.6 Preview Probe

新增：

```bash
node dist/cli.js preview --command <command> --url <url>
```

能力：

- 启动 dev/preview command
- 等待目标 URL ready
- 输出 JSON 结果
- 失败时返回非 0

## 3. 验证结果

### 3.1 本仓库单元测试

```bash
npm test
```

结果：

- TypeScript build 通过
- `normalize.test`、`checkNormalize.test`、`config.test`、`compare.test`、`taskGraph.test` 全部通过
- 共 8 个测试通过

### 3.2 `md-full` 行为基线与对比

命令：

```bash
node dist/cli.js baseline --config configs/md-full.migration-guard.json
node dist/cli.js verify --config configs/md-full.migration-guard.json
```

结果：

- baseline: `baseline-2026-07-04T23-14-16-113Z`
- run: `run-2026-07-04T23-14-57-624Z`
- checks: `core-test`、`web-test`、`packages-type-check`、`web-type-check`、`web-build` 全部通过
- probe: `md-renderer-behavior` 通过
- compare: `Passed: yes`
- diff: `No differences detected.`

这验证了 check output normalization 已经能压住 Vitest/Vite/timing/path/plugin timing 等非业务噪音。

### 3.3 `pnpm-vite-vue` 迁移 run

命令：

```bash
node dist/cli.js run --config configs/md-full.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Vite/Vue monorepo assisted migration" --dry-run --adapter pnpm-vite-vue --issue-provider local
node dist/cli.js resume --config configs/md-full.migration-guard.json --run latest --auto
```

结果：

- run: `run-2026-07-04T23-15-07-670Z-zjctm1`
- status: `completed`
- mode: `auto`
- adapter: `pnpm-vite-vue`
- task graph: 8 个任务全部 `done`
- issues: 22 个
- risk: `high`
- confidence: `medium`

关键产物：

- `.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/adapter/pnpm-vite-vue-workspace.json`
- `.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/adapter/pnpm-vite-vue-config-inventory.json`
- `.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/adapter/pnpm-vite-vue-risk-report.json`
- `.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/adapter/pnpm-vite-vue-action-plan.json`
- `.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/reports/latest-report.md`

### 3.4 GitHub issue dry-run

命令：

```bash
node dist/cli.js sync-issues --config configs/md-full.migration-guard.json --run latest --provider github --dry-run
```

结果：

- dry-run 导出 22 个 issue
- 未回写 external issue id
- 输出：`.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/issue-sync/github-dry-run-issues.json`
- 同步 Markdown：`.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/issue-sync/github-dry-run-issues.md`

### 3.5 Dry-run patch proposal

命令：

```bash
node dist/cli.js task propose --config configs/md-full.migration-guard.json --run latest --task task-pnpm-vite-vue-risks
node dist/cli.js task apply --config configs/md-full.migration-guard.json --run latest --proposal patch-2026-07-04T23-16-49-357Z-f54j3w
```

结果：

- proposal: `patch-2026-07-04T23-16-49-357Z-f54j3w`
- 当前 proposal 为 non-mutating，占位记录 review intent、recommended checks 和审批流
- apply 命令识别 non-mutating patch 并标记为 applied
- 输出：`.migration-guard/external-targets/md-full/migration-runs/run-2026-07-04T23-15-07-670Z-zjctm1/proposals/patch-2026-07-04T23-16-49-357Z-f54j3w/proposal.json`

### 3.6 Preview probe

命令：

```bash
node dist/cli.js preview --config configs/md-full.migration-guard.json --command "pnpm web dev --host 127.0.0.1" --url http://127.0.0.1:5173 --timeout-ms 120000
```

结果：

- ready: `true`
- HTTP status: `200`
- duration: `4214ms`
- output: `.migration-guard/external-targets/md-full/preview/1783207081257.json`

补充说明：本机 Node 版本为 `v22.19.0`，低于 `md` 当前声明的 `>=22.22.2`，但本阶段 `md-full` lane 全部通过。正式 CI 建议在满足 engines 的 Node 版本上复跑。

## 4. 后续建议

1. 让 dry-run patch 从 placeholder 进化为真实补测试/probe patch。
2. 接入真实 GitHub Issues API。
3. 增加 Playwright DOM/screenshot probe。
4. 为 `pnpm-vite-vue` adapter 增加 fixture tests。
5. 在 Node `>=22.22.2` 环境复跑 `md` full lane。
