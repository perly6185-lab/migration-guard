# Phase 24: External Issue Gate Context + CI Handoff Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 24 把 Phase 21-23 已经形成的 proposal gate、batch、remediation hints 和 configurable policy 信息，导出到团队协作和 CI handoff 层。

核心目标：

- issue sync export 能携带 failed proposal gate context。
- issue sync export 能携带 failed batch context。
- provider-neutral Markdown export 能直接给外部 issue 平台 adapter 使用。
- CI handoff report 能展示最近 failed gate/batch 和下一步命令。

## 2. 已实现能力

### 2.1 Issue Sync Gate Context

`sync-issues` 会读取 run 下的 proposal verification reports，并在 provider-neutral JSON 中写入：

```json
{
  "migrationGuard": {
    "gate": {
      "proposalId": "patch-a",
      "reportPath": ".../verification-*.json",
      "replanIssueId": "issue-...",
      "replanTaskId": "task-replan-patch-a",
      "firstFailedCheck": {
        "command": "node scripts/migration-guard/a.mjs",
        "kind": "other",
        "phase": "pre-preview",
        "failureCategory": "command-failed",
        "remediationHints": []
      }
    }
  }
}
```

Issue body 同时追加：

```text
Proposal gate context:
- Proposal: ...
- Verification report: ...
- Replan issue: ...
- Replan task: ...
- First failed check: ...
- Failure category: ...
- Remediation hints:
```

### 2.2 Issue Sync Batch Context

当 run 中存在最近 failed batch report 时，相关 failure/replan issue export 会追加：

```json
{
  "migrationGuard": {
    "batch": {
      "batchId": "proposal-batch-report-...",
      "reportPath": ".../proposal-batch-report-*.json",
      "passed": false,
      "gatePolicy": "fail-fast",
      "executedCount": 1,
      "skippedCount": 1,
      "firstFailedProposalId": "patch-a",
      "firstFailedVerificationPath": ".../verification-*.json",
      "stopReason": "...",
      "nextCommand": "migration-guard proposal replan --run latest --proposal patch-a",
      "skippedProposals": ["patch-b"],
      "recommendedNextActions": []
    }
  }
}
```

### 2.3 Run Report Handoff Polish

`Recent Proposal Batches` 现在展示：

- batch report path
- first failed verification path
- stop reason
- next command
- skipped proposals
- recommended next actions

### 2.4 CI Handoff

`ci verify` 保持原 verify 行为；当提供 `--run <id|latest>` 时，额外写出：

```text
.migration-guard/migration-runs/run-*/reports/ci-handoff.md
```

命令：

```bash
node dist/cli.js ci verify --baseline .migration-guard/latest-baseline.json --run latest
```

CI handoff report 包含：

- latest failed gate
- failure category
- first remediation hint
- latest failed batch
- batch report path
- first failed verification path
- stop reason
- next command
- skipped proposals

## 3. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 19 个测试通过

新增/扩展覆盖：

- failed batch path 后 `syncIssues(..., "local")` 导出 gate context
- issue export body 包含 proposal gate context
- issue export body 包含 proposal batch context
- issue export JSON 包含 failure category 和 remediation hints
- issue export JSON 包含 stopReason、skipped proposals 和 nextCommand
- CI handoff report 包含 latest failed batch 和 next command

## 4. 真实 md Local Sync / CI Handoff Smoke

复用 Phase 23 的失败 batch run：

```text
run-2026-07-06T02-23-11-039Z-j5ue3e
```

目标仓库：

```text
D:\learn\migration-guard-targets\md
```

命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider local
node dist/cli.js ci verify --config configs/md-fast.migration-guard.json --baseline .migration-guard/external-targets/md-fast/latest-baseline.json --run latest
```

Local issue sync 结果：

- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/issue-sync/local-issues.json`
- exported failure issue contains `migrationGuard.gate`
- exported failure issue contains `migrationGuard.batch`
- proposal id: `patch-phase23-fail`
- failure category: `command-failed`
- skipped proposal: `patch-phase23-skip`
- next command: `migration-guard proposal replan --run latest --proposal patch-phase23-fail`
- issue body includes `Proposal gate context`
- issue body includes `Proposal batch context`

CI handoff 结果：

- `ci verify` returned non-zero because the existing md-fast baseline now reports `core-test` as regressed.
- CI handoff artifact was still written.
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/reports/ci-handoff.md`
- handoff includes latest failed gate, failure category, hint, failed batch, batch report path, first failed verification path, stop reason, next command and skipped proposal.

目标仓库最终状态保持 clean：

```text
## main...origin/main
```

## 5. 实现边界

当前 Phase 24 仍保持 provider-neutral：

- `github` / `gitlab` / `jira` / `linear` 仍只写 JSON/Markdown dry-run/export，不调用外部 API。
- issue context 关联优先使用 replan issue id 和 replan task id。
- 当前只附加最近 failed batch context。
- CI handoff report 是 Markdown artifact，不直接写 PR comment。

## 6. 后续建议

下一阶段可以进入 “Provider Adapter + PR Comment Preview”：

1. GitHub dry-run export 增加 PR comment Markdown。
2. GitHub issue adapter 将 gate/batch context 映射成 labels/body sections。
3. CI mode 输出 GitHub Actions summary 格式。
4. 为真实 provider 调用增加 token/env 检查和 dry-run 默认保护。
