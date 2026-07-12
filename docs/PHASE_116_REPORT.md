# Phase 116 Report: Max-Step Continuation Decision

## Goal

Clarify scheduler behavior when an advance loop reaches its max-step guard. A
max-step stop is a bounded pause, not proof that the global refactor lane is
complete.

## Delivered

- Added max-step pause detection.
- `schedulerDecision.action` can now return `run-advance-loop`.
- When loop state is `complete` with `stopReason` like `Reached max steps N.`,
  the scheduler decision now reports:
  - `action: run-advance-loop`
  - `canRunUnattended: true`
  - `requiresHuman: false`
  - `exitCode: 0`
  - a bounded next advance-loop command
- Loop state `nextAction` now distinguishes max-step pauses from true sync
  readiness.
- README, md2 orchestration notes and operator runbook now document
  `run-advance-loop`.

## Safety Boundary

- `run-advance-loop` is advisory; the tool does not execute the command.
- The next loop still requires explicit `issue-control advance --execute
  --max-steps <n>`.
- Existing max-step, repeat-guard, failed and blocked gates still apply.
- No dependency install, commit or GitHub mutation was added.

## Verification

- Added coverage for older state files without `schedulerDecision`, confirming
  max-step pauses are enriched as `run-advance-loop`.
- Full verification command:

```bash
npm test
```
