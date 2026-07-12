# Phase 113 Report: Advance Loop State and Repeat Guard

## Goal

Give bounded unattended advance loops a persistent memory so an external
scheduler does not repeatedly re-run the same failed or blocked progress ledger.

## Delivered

- Added loop source-ledger tracking to `IssueControlAdvanceLoopReport`.
- Added `repeatGuard` details to loop reports.
- Added per-step `sourceLedgerPath`.
- Added `IssueControlAdvanceLoopState`.
- Loop mode now writes:
  - `issue-control/issue-control-advance-loop-state.json`
  - `issue-control/issue-control-advance-loop-state.md`
- Execute loops now read the previous loop state before starting.
- If the same source ledger already stopped as failed or blocked, the repeat
  guard writes a blocked loop report without launching supervisor again.
- Added `--force` for reviewed retries that intentionally bypass the repeat
  guard.
- README, md2 orchestration notes and operator runbook now document loop state
  and repeat guard behavior.

## Safety Boundary

- Default single-step `issue-control advance` behavior is unchanged.
- Repeat guard only applies to execute loop mode.
- Guarded repeats do not run supervisor.
- `--force` only bypasses the repeat guard; existing advance and supervisor
  gates still apply.
- No arbitrary shell command execution, install, commit or GitHub mutation was
  added.

## Verification

- Added coverage for:
  - dry-run loop state persistence
  - blocked loop state persistence
  - repeat guard blocking the same failed/blocked ledger
  - explicit repeat-guard override
- Full verification command:

```bash
npm test
```
