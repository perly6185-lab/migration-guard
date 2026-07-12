# Phase 112 Report: Advance Loop Guard

## Goal

Allow `issue-control advance` to run a bounded unattended loop while preserving
explicit execution, max-step and failure/blocking safety gates.

## Delivered

- Added `issue-control advance --max-steps <n>`.
- Added `IssueControlAdvanceLoopReport`.
- Added `IssueControlAdvanceLoopStep`.
- Added `advanceIssueControlLoop`.
- Added `renderIssueControlAdvanceLoop`.
- Loop reports write:
  - `issue-control/issue-control-advance-loop-*.json`
  - `issue-control/issue-control-advance-loop-*.md`
- Default single-step advance behavior remains unchanged.
- Dry-run loop plans only one step.
- Execute loop reuses `advanceIssueControl` for each step.
- Loop stops on:
  - failed step
  - blocked step
  - completed supervise cycle
  - max-step limit
- README, md2 orchestration notes and operator runbook now document the loop.

## Safety Boundary

- Continuous progression requires explicit `--execute --max-steps <n>`.
- `--max-steps` is capped at 10.
- The loop does not execute arbitrary shell text.
- The loop does not install dependencies, commit changes or mutate GitHub.
- Each step still goes through the existing progress decision, advance and
  supervisor gates.

## Verification

- Added coverage for:
  - dry-run loop planning only one step
  - execute loop stopping after a failed step
  - blocked loop refusing to run supervise
- Full verification command:

```bash
npm test
```
