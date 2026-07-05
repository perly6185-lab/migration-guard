# Phase 15: Proposal Lifecycle + Rollback Report

生成日期：2026-07-05

## 1. 阶段目标

Phase 15 的目标是让 proposal 从“可 apply + verify”升级为完整生命周期管理。

本阶段重点补齐：

- 状态流转
- 手动 rollback
- apply 失败后的自动 rollback 入口
- run report 中的 proposal 汇总

这让后续真实 codemod、测试补丁、Playwright probe patch 可以更放心地进入自动执行链路。

## 2. 已实现能力

### 2.1 Proposal 状态扩展

`ProposedPatch.applyState` 现在支持：

- `proposed`
- `verified`
- `verification-failed`
- `applied`
- `applied-with-failed-checks`
- `rolled-back`
- `rollback-failed`
- `rejected`

同时新增：

- `lastVerificationPath`
- `lastRollbackPath`

### 2.2 `proposal status`

新增命令：

```bash
node dist/cli.js proposal status --config <config> --run latest --proposal <proposal-id>
node dist/cli.js proposal status --config <config> --run latest --proposal <proposal-id> --json
```

输出内容包括：

- 当前状态
- action/task 关联
- generated files
- recommended checks
- 最近 verification/rollback artifact
- verification/rollback report 数量

### 2.3 `proposal rollback`

新增命令：

```bash
node dist/cli.js proposal rollback --config <config> --run latest --proposal <proposal-id>
```

行为：

- 执行 `git apply -R --check`
- 通过后执行 `git apply -R`
- 写出 `rollback-*.json`
- 更新 proposal 状态为 `rolled-back`
- 写入 `proposal` evidence

### 2.4 `action apply --rollback-on-fail`

`action apply` 新增选项：

```bash
node dist/cli.js action apply --config <config> --run latest --proposal <proposal-id> --rollback-on-fail
```

行为：

- apply patch
- 执行 recommended checks
- 如果 checks 失败，自动执行 proposal rollback
- 保留 verification 和 rollback artifacts

### 2.5 Run Report Proposal 汇总

`migration-guard report` 现在会输出 `## Proposals` 区块，列出当前 run 下所有 proposal 的：

- id
- apply state
- risk
- title

## 3. 验证结果

### 3.1 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 12 个测试通过
- 覆盖 proposal verify/apply/rollback
- 覆盖 `rollbackOnFail`

### 3.2 真实 md lifecycle smoke

使用 run：

```text
run-2026-07-04T23-28-09-710Z-3p95bj
```

新建 proposal：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-api-type-contract
```

结果：

```text
patch-2026-07-05T00-59-53-339Z-1jeqkp
```

初始状态：

```bash
node dist/cli.js proposal status --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T00-59-53-339Z-1jeqkp
```

结果：

- state: `proposed`
- generated file: `scripts/migration-guard/action-api-type-contract.mjs`

### 3.3 Verify

命令：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T00-59-53-339Z-1jeqkp
```

结果：

- mode: `verify`
- applied: `no`
- passed: `yes`
- patch check: `passed`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T00-59-53-339Z-1jeqkp/verification-1783213212897.json`

### 3.4 Apply + Checks

命令：

```bash
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T00-59-53-339Z-1jeqkp
```

结果：

- proposal applied
- patch check: `passed`
- checks: `2`
- `pnpm type-check:packages`: `passed`
- `node scripts/migration-guard/action-api-type-contract.mjs`: `passed`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T00-59-53-339Z-1jeqkp/verification-1783213227617.json`

### 3.5 Rollback

命令：

```bash
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T00-59-53-339Z-1jeqkp
```

结果：

- rollback passed
- reverse check: `passed`
- reverse apply: `passed`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T00-59-53-339Z-1jeqkp/rollback-1783213239435.json`

最终状态：

- state: `rolled-back`
- verification reports: `2`
- rollback reports: `1`

### 3.6 Run Report

命令：

```bash
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

结果：

- run report 包含 `## Proposals`
- 新 proposal 显示为 `[rolled-back/medium]`

### 3.7 目标仓库清洁度

命令：

```bash
git -C D:\learn\migration-guard-targets\md status --short --branch
```

结果：

```text
## main...origin/main
```

目标 `md` 仓库保持 clean。

## 4. 下阶段建议

Phase 16 建议进入 “Playwright UI Probe Adapter”：

1. 为 `ui-smoke-probe` 生成真实 Playwright probe patch。
2. 增加 dev server lifecycle 管理，复用 preview probe 的进程树清理。
3. 支持 DOM selector 断言和 screenshot artifact。
4. 把 UI probe 结果纳入 proposal verification report。
5. 在 `md` 的大 Vue 组件 action 上跑通 UI smoke proposal。
