# Phase 22: Gate Remediation Hints + Batch Stop Reporting Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 22 承接 Phase 21 的 gate policy、retry 和 batch apply，把失败结果变成更可执行的下一步建议。

核心目标：

- check 失败时生成 remediation hints。
- failure issue 和 replan task 直接展示 hints。
- batch apply 失败后说明为什么停止、哪些 proposal 被跳过、下一步该运行什么命令。
- run report 在 Recent Proposal Gates 中暴露失败分类和第一条 hint。

## 2. 已实现能力

### 2.1 Remediation Hints

`ProposalCommandCheck` 新增：

```json
{
  "failureCategory": "command-failed",
  "remediationHints": [
    "Inspect stdout/stderr in the verification report and rerun the command from the target root.",
    "Keep the proposal rolled back until the failing command has a focused remediation plan."
  ]
}
```

当前映射：

- `flake-suspected`
  - 建议先隔离重跑。
  - CPU-bound check 建议降低 worker 并发或单包运行。
  - browser/preview check 建议检查端口和 preview server。
- `timeout`
  - 建议确认命令没有等待交互输入或卡住的服务。
  - 建议仅在手动通过后再提高 timeout。
  - preview check 建议检查 preview report 和 ready URL。
- `command-failed`
  - 建议查看 verification report 的 stdout/stderr。
  - 建议保持 proposal rollback，直到有聚焦修复计划。
- `error`
  - 建议检查 command path、cwd、shell 和环境变量。

### 2.2 Failure Issue 和 Replan Task

proposal gate 失败时：

- failure issue body 写入 `Failure category`
- failure issue body 写入 `Remediation hints`
- replan task description 写入同样 hints

这样用户在 `issues` / `report` / task graph 中也能看到修复方向，而不是必须打开 verification JSON。

### 2.3 Batch Stop Reporting

`ProposalBatchReport` 新增：

```json
{
  "skipped": [
    {
      "proposalId": "patch-b",
      "reason": "Stopped after proposal patch-a failed at node scripts/migration-guard/a.mjs (command-failed)."
    }
  ],
  "stopReason": "Stopped after proposal patch-a failed at node scripts/migration-guard/a.mjs (command-failed).",
  "nextCommand": "migration-guard proposal replan --run latest --proposal patch-a"
}
```

每个 failed result 还会记录：

- first failed command
- check kind
- check phase
- failure category
- remediation hints

## 3. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 18 个测试通过

新增/扩展覆盖：

- failed proposal verification report 写入 `remediationHints`
- failure issue body 包含 remediation hints
- replan task description 包含 remediation hints
- batch apply 失败后记录 `stopReason`
- batch apply 失败后记录 `skipped`
- batch apply 失败后记录 `nextCommand`
- batch apply 失败后未执行被跳过 proposal 的 patch

## 4. 实现边界

当前 Phase 22 仍保持保守：

- remediation hints 是规则映射，不做自动修复。
- hints 聚焦 gate 层故障，不分析业务断言语义。
- batch apply 仍按顺序执行，不并发。
- batch 失败后只建议 `proposal replan`，不自动创建额外补救 patch。
- 配置化默认 policy 尚未实现，仍通过 CLI option 和内部默认策略控制。

## 5. 后续建议

下一阶段可以进入 “Configurable Gate Policy + Failure Smoke”：

1. 在 `.migration-guard.json` 增加 proposal gate 默认策略。
2. 支持 action/checkPlan 级别覆盖 gate policy。
3. 对真实 `md` 目标仓库跑一条失败 batch smoke，验证 skipped、stopReason、hints、replan issue/task。
4. 将 batch report 的 next command 渲染进 run report。
5. 让 issue sync 导出 remediation hints，方便进入 GitHub/Jira/Linear。
