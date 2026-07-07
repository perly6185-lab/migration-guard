# Phase 23: Configurable Gate Policy + Batch Summary Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 23 把 proposal gate 的策略从内部默认值升级为项目配置，并增强 batch report / run report 的批量执行摘要。

核心目标：

- 项目可以声明默认 proposal gate policy。
- 项目可以声明 batch gate policy。
- 项目可以按 check kind 声明 retry 默认值。
- CLI `--gate-policy` 继续作为单次命令覆盖。
- batch report 能直接解释本次执行策略、执行数量、跳过数量、首个失败 proposal 和下一步动作。
- run report 能展示最近 proposal batch。

## 2. 配置格式

`.migration-guard.json` 新增：

```json
{
  "proposalGate": {
    "defaultPolicy": "collect-all",
    "batchPolicy": "fail-fast",
    "retry": {
      "unit-test": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected"]
      },
      "ui-probe": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected", "timeout"]
      }
    }
  }
}
```

默认值：

- `defaultPolicy`: `collect-all`
- `batchPolicy`: `fail-fast`
- `unit-test` retry: `flake-suspected` 重试一次
- `ui-probe` retry: `flake-suspected` / `timeout` 重试一次

优先级：

```text
CLI --gate-policy > proposal/checkPlan explicit retry > config proposalGate > internal default config
```

## 3. 已实现能力

### 3.1 Configurable Gate Policy

`verifyProposedPatch` 和 `applyProposedPatch` 在没有 CLI/调用方 policy 时，会读取：

```text
loaded.config.proposalGate.defaultPolicy
```

`applyProposalBatch` 在没有 CLI/调用方 policy 时，会读取：

```text
loaded.config.proposalGate.batchPolicy
```

### 3.2 Configurable Retry Defaults

当 proposal checkPlan item 没有显式 `retry` 时，执行时会读取：

```text
loaded.config.proposalGate.retry[check.kind]
```

新生成的 proposal checkPlan 也会把当前配置化 retry 写入 proposal artifact。

### 3.3 Batch Summary

`ProposalBatchReport` 新增：

- `gatePolicy`
- `executedCount`
- `skippedCount`
- `firstFailedProposalId`
- `firstFailedVerificationPath`
- `recommendedNextActions`

失败 batch 仍保留 Phase 22 的：

- `stopReason`
- `nextCommand`
- `skipped`
- `firstFailedCheck`

### 3.4 Run Report Batch Section

run report 新增：

```text
## Recent Proposal Batches
```

展示：

- batch id
- passed/failed
- policy
- executed count
- skipped count
- stop reason
- next command

## 4. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 19 个测试通过

新增/扩展覆盖：

- config `defaultPolicy` 能控制 proposal apply 默认 gate policy
- config retry 能被没有显式 retry 的 checkPlan 使用
- batch report 写入 `gatePolicy`
- batch report 写入 executed/skipped count
- batch report 写入 first failed proposal 和 verification path
- batch report 写入 recommended next actions

## 5. 真实 md 失败 Smoke

目标仓库：

```text
D:\learn\migration-guard-targets\md
```

命令：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 23 failing batch smoke" --dry-run --adapter pnpm-vite-vue --issue-provider local
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run latest --limit 2 --json
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --json
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run latest --proposal patch-phase23-fail --json
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

说明：本次 smoke 通过向 run artifact 写入两个专用 proposal 验证失败路径：

- `patch-phase23-fail`
- `patch-phase23-skip`

结果：

- run: `run-2026-07-06T02-23-11-039Z-j5ue3e`
- batch report: `proposal-batch-report-2026-07-06T02-24-31-991Z-s4mt6s`
- batch apply: failed as expected
- gate policy: `fail-fast` from `configs/md-fast.migration-guard.json`
- executed: `1`
- skipped: `1`
- first failed proposal: `patch-phase23-fail`
- first failed category: `command-failed`
- skipped proposal: `patch-phase23-skip`
- rollback: `patch-phase23-fail` rollback passed
- `proposal replan` created/reused `task-replan-patch-phase23-fail`
- run report includes `Recent Proposal Batches`
- target repository stayed clean:

```text
## main...origin/main
```

## 6. 实现边界

当前 Phase 23 仍保持保守：

- 配置只支持 gate policy 和 retry 默认值，不支持复杂表达式。
- retry 配置按 check kind 生效，不支持按具体命令正则匹配。
- run report 展示 batch summary，但 issue sync 还没有导出 batch summary。

## 7. 后续建议

下一阶段可以进入 “External Issue Gate Context + CI Handoff”：

1. issue sync 导出 remediation hints 和 batch summary。
2. CI verify/report 输出最近 batch/gate 摘要。
3. GitHub PR comment 展示 failed proposal、stopReason 和 nextCommand。
4. 为真实失败 smoke 增加可复用 fixture/command，避免手写 proposal artifact。
