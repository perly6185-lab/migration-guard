# Phase 107 Report: Continue After Repair

## Goal

Allow the md2 issue-control supervisor to continue remaining selected safe
issues after a controlled recovery succeeds, while keeping the default behavior
as fail/blocked stop.

## Delivered

- Added `issue-control supervise --continue-after-repair`.
- Added `IssueControlSuperviseOptions.continueAfterRepair`.
- Moved failed/blocked recovery handling into the supervise iteration loop.
- Added iteration-level recovery evidence:
  - `recoveryPlanPath`
  - `recoveryExecutionPath`
  - `recoveryExecutionStatus`
  - `continuedAfterRepair`
  - `recoveryContinuationReason`
- Added report-level continuation evidence:
  - `continuedAfterRepair`
  - `continuedAfterRepairCount`
- Updated supervise markdown to show per-iteration recovery and continuation
  status.
- Updated README, md2 orchestration notes and operator runbook.

## Safety Boundary

- Continuation is opt-in with `--continue-after-repair`.
- Recovery still requires the Phase 106 boundary: `--repair-on-fail --execute`.
- The supervisor continues only when recovery execution status is `executed`.
- Recovery statuses `planned`, `blocked` and `failed` remain stop conditions.
- The phase does not add new executable recovery categories.
- No dependency install, commit or live GitHub mutation is performed.

## Verification

- Added tests for:
  - executed recovery still stops without explicit continuation
  - explicit continuation proceeds after executed recovery
  - failed recovery execution does not continue
- Full verification command:

```bash
npm test
```
