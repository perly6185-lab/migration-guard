# Phase 96 Report: Autonomous One-Shot Runner and Repair Entry

生成日期：2026-07-11

## Goal

把 one-shot 从“状态和下一步提示”推进到“可无人值守调度的闭环骨架”：
安全步骤自动执行，代码编辑和 PR/merge 通过外部 agent hook 接入，失败 proposal 通过一个 repair 入口进入 replan/retry/verify/accept 修复回路。

## Delivered

New one-shot runner:

```text
migration-guard one-shot session run
```

Key options:

```text
--session <path>
--max-steps <n>
--edit-command <cmd>
--pr-command <cmd>
--external-step-timeout-ms <n>
--skip-target-git
--strict
--json
```

The runner automatically executes:

- baseline capture
- edit hook, when `--edit-command` is provided
- post-edit verify and compare
- pre-PR one-shot report
- PR/merge hook, when `--pr-command` is provided
- post-merge verify and compare
- metadata-complete closure report
- session sync

Without an edit or PR hook, the runner stops at that external boundary and writes a run report instead of guessing.

New repair-loop entry:

```text
migration-guard proposal repair --proposal <failed-proposal-id>
migration-guard proposal repair --proposal <failed-proposal-id> --checks --accept
```

`proposal repair` is idempotent. It creates or reuses the replan artifacts and retry proposal, can verify the retry proposal, and can accept the repair after a passing checked verification.

## Five-Stage Completion

1. Larger bounded one-shot path: completed as an executable runner path with bounded file-budget enforcement and hook-driven edit/PR stages.
2. Controlled executor: completed via `one-shot session run`.
3. Self-healing loop: completed via idempotent `proposal repair` over existing replan/retry/verify/accept artifacts.
4. Autonomy levels: completed to L4.
   - L1 status visibility: `one-shot status`.
   - L2 next action: `one-shot session next`.
   - L3 safe automatic execution: `one-shot session run`.
   - L4 external agent and repair-loop orchestration: `--edit-command`, `--pr-command`, `proposal repair`.
   - L5 fully autonomous business editing depends on the supplied edit agent quality and repository credentials, but the Migration Guard orchestration boundary is in place.
5. Full local validation loop: completed by unit and CLI-level fixture coverage for open -> baseline -> edit hook -> verify -> report -> PR hook -> post-merge verify -> closure.

## Verification

Build and test:

```text
npm test
```

Result:

```text
56 tests passed
```

Focused coverage:

- `one-shot session run` captures baseline then stops safely at a missing edit hook.
- `one-shot session run` writes pre-PR report then stops safely at a missing PR hook.
- `one-shot session run` can execute edit and PR hooks to close a window.
- `proposal repair` creates repair evidence, reuses retry proposal, verifies checks, and accepts the repair.

## Operator Notes

For a real repository, the no-human path is:

```text
migration-guard one-shot session open --max-source-file-delta <n> --budget <budget>
migration-guard one-shot session run --edit-command <agent-command> --pr-command <provider-command> --strict
```

The edit command runs in the target repo and should make only budgeted code changes.
The PR command runs in the target repo and must print JSON containing:

```json
{
  "branch": "main",
  "prUrl": "https://github.com/owner/repo/pull/1",
  "targetCommit": "abc123",
  "mergeCommit": "def456",
  "mergedAt": "2026-07-11T00:00:00Z"
}
```

If either hook fails, or if verification/compare/report returns hold, the runner writes evidence and stops.

## Next

The remaining product frontier is not orchestration but agent quality:
provide a trusted edit agent for each migration class, and a credentialed PR provider command for the target hosting system.
