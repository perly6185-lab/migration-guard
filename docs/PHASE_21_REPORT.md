# Phase 21: Adaptive Gate Policy + Flake Handling Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 21 承接 Phase 18-20 的 proposal gate 执行层，把 gate 从“结构化、可审计、可重规划”继续推进到“能适应环境抖动、能按策略执行、能批量推进低风险 proposal”。

重点解决的问题：

- Vitest worker、端口占用、socket reset、fetch timeout 等疑似环境抖动会造成一次性失败。
- 单个 proposal 需要尽量收集完整失败面，批量 proposal 则更适合遇到关键失败后停止。
- 已失败的 verification report 需要可以显式补建 replan task。
- 多个 ready proposal 需要有一个低风险优先的 batch plan/apply 入口。

## 2. 已实现能力

### 2.1 Check Retry 和失败分类

`ProposalCheckPlanItem` 新增：

```json
{
  "retry": {
    "maxAttempts": 2,
    "delayMs": 1000,
    "retryOn": ["flake-suspected"]
  },
  "resourceProfile": "cpu-bound"
}
```

`ProposalCommandCheck` 新增：

- `attemptCount`
- `attempts`
- `failureCategory`
- `flakeSuspected`
- `resourceProfile`
- `retry`

当前失败分类：

- `command-failed`
- `timeout`
- `error`
- `flake-suspected`

默认策略：

- `unit-test`：对 `flake-suspected` 重试一次。
- `ui-probe`：对 `flake-suspected` 和 `timeout` 重试一次。

### 2.2 Gate Policy

`ProposalVerificationReport` 新增：

```json
"gatePolicy": {
  "mode": "collect-all"
}
```

支持两种 mode：

- `collect-all`：继续执行计划内 checks，尽量收集完整失败面。
- `fail-fast`：第一个 failed critical check 后停止后续 checks。

默认行为：

- 单个 proposal apply/verify 默认 `collect-all`。
- batch apply 默认 `fail-fast`。

CLI 支持：

```bash
node dist/cli.js proposal verify --run latest --proposal <proposal-id> --checks --gate-policy collect-all
node dist/cli.js action apply --run latest --proposal <proposal-id> --gate-policy fail-fast
node dist/cli.js proposal batch apply --run latest --limit 3 --gate-policy fail-fast
```

### 2.3 Explicit Proposal Replan

新增命令：

```bash
node dist/cli.js proposal replan --run latest --proposal <proposal-id>
```

行为：

- 读取 proposal 最新失败 verification report。
- 如果缺少 replan issue，则补建 failure issue。
- 创建或复用 proposal 对应的 replan task。
- 将 `replanIssueId` 和 `replanTaskId` 写回 verification report。
- 写入 evidence log。

### 2.4 Proposal Batch

新增命令：

```bash
node dist/cli.js proposal batch plan --run latest --limit 3
node dist/cli.js proposal batch apply --run latest --limit 3 --gate-policy fail-fast
```

行为：

- 选择 `proposed` / `verified` 状态的 proposal。
- 按 risk 从低到高、再按 createdAt 排序。
- 写出 batch plan artifact。
- 顺序 apply proposal。
- 任一 proposal 失败后停止后续 proposal。

主要 artifacts：

- `.migration-guard/migration-runs/run-*/proposal-batches/*/batch-plan.json`
- `.migration-guard/migration-runs/run-*/proposal-batches/*/proposal-batch-report-*.json`

## 3. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 17 个测试通过

新增/扩展覆盖：

- apply gate 失败时创建 `replanIssueId` 和 `replanTaskId`
- 疑似 flaky check 会按 retry policy 重试并最终通过
- `fail-fast` policy 在第一个 critical failure 后停止后续 check
- batch plan 按低风险优先排序
- batch apply 按计划顺序执行 ready proposal

## 4. 实现边界

当前 Phase 21 仍保持保守：

- flaky 判断基于命令输出特征，不做概率模型。
- retry 次数较低，避免掩盖真实失败。
- gate policy 只影响 proposal checks，不改变 patch applicability check。
- batch apply 是顺序执行，不引入并发。
- batch apply 失败后停止，不自动尝试修复后续 proposal。

## 5. 真实 md Smoke

目标仓库：

```text
D:\learn\migration-guard-targets\md
```

命令：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 21 proposal batch smoke" --dry-run --adapter pnpm-vite-vue --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-renderer-probes
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-api-type-contract
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run latest --limit 2 --json
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --gate-policy fail-fast --json
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-06T01-28-32-533Z-4psx9h --json
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-06T01-28-32-546Z-l7t75g --json
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

结果：

- run: `run-2026-07-06T01-24-36-110Z-ry2z5z`
- proposal batch report: `proposal-batch-report-2026-07-06T01-29-26-631Z-fnjmp7`
- batch apply: `passed`
- renderer proposal: `passed`, checks `3/3`, timeline `4`, gate policy `fail-fast`
- API contract proposal: `passed`, checks `2/2`, timeline `3`, gate policy `fail-fast`
- rollback: 两个 proposal 均 `passed`
- run report 包含 `Recent Proposal Gates`
- 目标仓库最终状态保持 clean：

```text
## main...origin/main
```

## 6. 后续建议

下一阶段可以进入 “Gate Remediation Hints + Configurable Policy”：

1. 将 failure category 转成更具体的 remediation hints。
2. 允许在配置文件或 action plan 中声明默认 gate policy。
3. 为 resource profile 引入 worker/端口/浏览器隔离策略。
4. batch report 汇总跳过原因和下一步建议。
5. 扩展真实目标仓库 smoke，覆盖失败 proposal 的 batch 停止和 replan task 路径。
