# Phase 108 Report: Supervise Progress Ledger

## Goal

Add a replayable progress ledger to `issue-control supervise` so unattended md2
refactor runs can be inspected at global, issue, event and artifact levels.

## Delivered

- Added `IssueControlSuperviseProgressLedger`.
- Added `IssueControlSuperviseProgressItem`.
- Added `IssueControlSuperviseProgressEvent`.
- Added report links:
  - `progressLedgerPath`
  - `progressLedgerMarkdownPath`
- Each supervise run now writes:
  - `issue-control/issue-control-supervise-progress-*.json`
  - `issue-control/issue-control-supervise-progress-*.md`
- The ledger records selected, reached, unreached selected, recovered,
  continued and unresolved counts.
- Each issue records selected/reached state, iteration state, verification
  status, recovery execution status, continuation status, artifact paths and
  event history.
- Supervise markdown now links the progress ledger artifact.
- README, md2 orchestration notes and operator runbook now mention the ledger.

## Safety Boundary

- This phase is audit-only.
- It does not add new execution actions.
- It does not widen automatic recovery categories.
- It does not install dependencies, commit changes or mutate GitHub.
- Phase 107 continuation still requires explicit `--continue-after-repair` and
  recovery execution status `executed`.

## Verification

- Added test coverage for:
  - normal supervise progress ledger creation
  - recovery executed and continued ledger state
  - failed recovery leaving later selected issues unreached
- Full verification command:

```bash
npm test
```
