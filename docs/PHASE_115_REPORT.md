# Phase 115 Report: Advance Status Scheduler Decision

## Goal

Expose a single machine-readable scheduler decision in advance loop state so
external unattended runners do not need to reimplement status policy.

## Delivered

- Added `IssueControlAdvanceLoopSchedulerAction`.
- Added `IssueControlAdvanceLoopSchedulerDecision`.
- Added `schedulerDecision` to `IssueControlAdvanceLoopState`.
- Loop state writes now persist scheduler decisions.
- Status reads enrich older state files that do not yet contain a decision.
- `renderIssueControlAdvanceLoopState` now shows scheduler action, unattended
  eligibility, human requirement, exit code, reason and next command.
- `issue-control advance-status` now uses `schedulerDecision.exitCode`.
- README, md2 orchestration notes and operator runbook now document the
  scheduler decision fields.

## Decision Surface

- `review-plan`: a dry-run/planned loop needs explicit review before execution.
- `sync-issues`: the loop completed and artifacts should be reviewed before md2
  issue state is refreshed.
- `stop-for-recovery`: the loop failed, blocked or hit repeat guard.

## Safety Boundary

- Scheduler decisions are read-only derived policy.
- The command does not execute `nextCommand`.
- The command does not pull GitHub, run supervisor, install dependencies, commit
  changes or mutate GitHub.

## Verification

- Added coverage for:
  - planned state producing `review-plan`
  - repeat-guard state producing `stop-for-recovery`
  - explicit status reads returning scheduler decision
- Full verification command:

```bash
npm test
```
