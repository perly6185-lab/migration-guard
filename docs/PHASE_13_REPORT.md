# Phase 13: Executable Action Proposals Report

生成日期：2026-07-05

## 1. 阶段目标

Phase 13 的目标是把 Phase 12 的 action plan 从“可协作的计划和 issue”，推进到“可生成真实 git patch 的小步自动迁移提案”。

这阶段仍保持保守：默认不直接改目标仓库源码，而是生成可审查、可 `git apply --check` 的 proposal patch。这样后续可以逐步接入真实补测试、Playwright probe、codemod 和自动 apply。

## 2. 已实现能力

### 2.1 Action Plan 正式结构

新增类型：

- `MigrationAction`
- `MigrationActionPlan`
- `MigrationActionPatchTemplate`

`pnpm-vite-vue` adapter 现在会输出带 `version`、`runId`、`patchTemplate` 的 action plan。

### 2.2 `actions` CLI

新增命令：

```bash
node dist/cli.js actions --config configs/md-full.migration-guard.json --run latest
node dist/cli.js actions --config configs/md-full.migration-guard.json --run latest --json
```

用途：

- 读取当前 run 的 action plan
- 输出每个 action 的风险、patch mode、影响文件和推荐检查

### 2.3 `action propose` CLI

新增命令：

```bash
node dist/cli.js action propose --config configs/md-full.migration-guard.json --run latest --action <action-id>
```

用途：

- 从 action plan 中选择一个 action
- 生成 proposal JSON
- 生成真实 `patch.diff`
- 在 proposal 中记录 `actionId`、`generatedFiles`、`recommendedChecks` 和 `patchKind`

### 2.4 真实 Probe Patch

action proposal 现在生成的不是 placeholder，而是新增脚本的 git patch。

默认生成路径：

```text
scripts/migration-guard/<action-id>.mjs
```

当前支持模板：

- `renderer-probe`
- `api-contract-probe`
- `ui-smoke-probe`

这些脚本是轻量 probe：检查 action 影响文件是否存在，并验证最小结构信号。它们不是最终业务测试，但已经是可运行的迁移安全补丁入口。

### 2.5 Patch 生成器测试

新增 `src/core/patch.test.ts`：

- 验证 `createAddFilePatch` 生成的 patch 能通过 `git apply --check`
- 验证 patch 能被实际 apply 到临时 git 仓库
- 验证不允许 `../` 这类不安全路径

## 3. 验证结果

### 3.1 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 10 个测试通过
- 新增 patch 测试通过 `git apply --check`

### 3.2 真实 md action plan 查询

命令：

```bash
node dist/cli.js actions --config configs/md-full.migration-guard.json --run latest
```

结果：

- 成功读取 run `run-2026-07-04T23-15-07-670Z-zjctm1`
- 读取到 3 个 action：
  - `action-renderer-probes`
  - `action-api-type-contract`
  - `action-large-vue-ui-probe`

补充验证：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 13 executable action proposal smoke" --dry-run --adapter pnpm-vite-vue --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run latest --json
```

结果：

- run: `run-2026-07-04T23-28-09-710Z-3p95bj`
- status: `completed`
- action plan 含 `version: 1`、`runId` 和 `patchTemplate`

### 3.3 真实 md action proposal

命令：

```bash
node dist/cli.js action propose --config configs/md-full.migration-guard.json --run latest --action action-renderer-probes
```

结果：

- proposal: `patch-2026-07-04T23-26-35-286Z-7hm74g`
- patch kind: `action-probe`
- generated file: `scripts/migration-guard/action-renderer-probes.mjs`
- recommended checks:
  - `pnpm --filter @md/core test`
  - `pnpm type-check:packages`
  - `node scripts/migration-guard/action-renderer-probes.mjs`

补充验证：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-api-type-contract
```

结果：

- proposal: `patch-2026-07-04T23-28-55-975Z-79m583`
- generated file: `scripts/migration-guard/action-api-type-contract.mjs`

### 3.4 真实 md patch check

命令：

```bash
git -C D:\learn\migration-guard-targets\md apply --check D:\learn\migration-guard\.migration-guard\external-targets\md-full\migration-runs\run-2026-07-04T23-15-07-670Z-zjctm1\proposals\patch-2026-07-04T23-26-35-286Z-7hm74g\patch.diff
```

结果：

- `git apply --check` 通过
- 目标 `md` 仓库未被修改

补充验证：

```bash
git -C D:\learn\migration-guard-targets\md apply --check D:\learn\migration-guard\.migration-guard\external-targets\md-fast\migration-runs\run-2026-07-04T23-28-09-710Z-3p95bj\proposals\patch-2026-07-04T23-28-55-975Z-79m583\patch.diff
```

结果：

- `git apply --check` 通过
- 目标 `md` 仓库仍保持 clean

## 4. 下阶段建议

Phase 14 建议进入 “Probe Patch Apply + Verification Gate”：

1. 增加 `action apply`，在 apply 后自动执行 proposal 的 recommended checks。
2. 对 action probe 生成后的脚本运行结果写入 evidence。
3. 增加 `proposal verify` 命令，支持不 apply 时也能检查 patch 和推荐命令。
4. 把 `ui-smoke-probe` 升级为 Playwright DOM probe。
5. 给 `pnpm-vite-vue` adapter 增加 fixture 测试，覆盖 action plan 和 proposal 生成。
