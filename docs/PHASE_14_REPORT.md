# Phase 14: Probe Patch Apply + Verification Gate Report

生成日期：2026-07-05

## 1. 阶段目标

Phase 14 的目标是把 Phase 13 的 executable proposal 接入验证门禁。

本阶段让 proposal 具备两个清晰入口：

- `proposal verify`：只执行 patch check，可选执行 recommended checks，不修改目标仓库。
- `action apply`：应用 proposal patch，并默认执行 proposal 的 recommended checks。

这使迁移工具从“能生成补丁”推进到“能验证补丁应用和补丁后的安全检查”。

## 2. 已实现能力

### 2.1 Proposal Verification Report

新增类型：

- `ProposalPatchCheck`
- `ProposalCommandCheck`
- `ProposalVerificationReport`

报告会记录：

- patch check 命令、状态、stdout/stderr、耗时
- 每条 recommended check 的命令、状态、stdout/stderr、耗时
- proposal 是否已应用
- 总体是否通过
- 输出 artifact 路径

### 2.2 `proposal verify`

新增命令：

```bash
node dist/cli.js proposal verify --config <config> --run latest --proposal <proposal-id>
node dist/cli.js proposal verify --config <config> --run latest --proposal <proposal-id> --checks
node dist/cli.js proposal verify --config <config> --run latest --proposal <proposal-id> --json
```

默认行为：

- 执行 `git apply --check`
- 写出 `verification-*.json`
- 追加 `proposal` evidence
- 不修改目标仓库

### 2.3 `action apply`

新增命令：

```bash
node dist/cli.js action apply --config <config> --run latest --proposal <proposal-id>
node dist/cli.js action apply --config <config> --run latest --proposal <proposal-id> --skip-checks
```

默认行为：

- 执行 `git apply --check`
- 应用 patch
- 执行 proposal 的 `recommendedChecks`
- 写出 `verification-*.json`
- proposal `applyState` 更新为 `applied`
- 追加 `proposal` evidence

如果 recommended check 失败，命令返回非 0，并保留验证报告路径。

### 2.4 单元测试

扩展 `src/core/patch.test.ts`：

- 临时 git 仓库中验证 proposal verify
- apply proposal
- 执行新增 probe 脚本作为 recommended check
- 验证 verification report 通过

## 3. 验证结果

### 3.1 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 11 个测试通过
- proposal verify/apply 测试通过

### 3.2 真实 md `proposal verify`

命令：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-04T23-28-55-975Z-79m583
```

结果：

- proposal: `patch-2026-07-04T23-28-55-975Z-79m583`
- mode: `verify`
- applied: `no`
- passed: `yes`
- patch check: `passed`
- checks: `0`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-04T23-28-55-975Z-79m583/verification-1783211210457.json`

### 3.3 真实 md `action apply`

命令：

```bash
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-04T23-28-55-975Z-79m583
```

结果：

- proposal applied
- patch check: `passed`
- checks: `2`
- `pnpm type-check:packages`: `passed`
- `node scripts/migration-guard/action-api-type-contract.mjs`: `passed`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-04T23-28-55-975Z-79m583/verification-1783211225311.json`

### 3.4 目标仓库清洁度

真实 md smoke 中，`action apply` 会新增 probe 脚本。验证通过后，本次 smoke 通过反向应用同一 patch 移除测试新增文件。

收尾状态：

```bash
git -C D:\learn\migration-guard-targets\md status --short --branch
```

结果：

```text
## main...origin/main
```

目标 `md` 仓库保持 clean。

## 4. 下阶段建议

Phase 15 建议进入 “Proposal Lifecycle + Rollback”：

1. 增加 proposal 状态：`verified`、`verification-failed`、`applied-with-failed-checks`。
2. 增加 `proposal rollback`，从 proposal patch 自动反向应用。
3. 对 `action apply` 增加失败后自动 rollback 策略选项。
4. 把 proposal verification report 汇总进 run report。
5. 增加 Playwright DOM probe 作为 `ui-smoke-probe` 的真实实现。
