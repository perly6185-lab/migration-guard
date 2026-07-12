# Phase 111 Report: Controlled Issue-Control Advance

## Goal

Add a controlled advance entry point that can consume the progress automation
decision and, only with explicit authorization, run the next internal supervisor
cycle.

## Delivered

- Added `migration-guard issue-control advance`.
- Added `IssueControlAdvanceReport`.
- Added `advanceIssueControl`.
- Added `renderIssueControlAdvance`.
- Default mode is dry-run/planned.
- `--execute` is required before a next supervisor cycle can run.
- The advance report writes:
  - `issue-control/issue-control-advance-*.json`
  - `issue-control/issue-control-advance-*.md`
- Eligible advance execution calls `superviseIssueControl` directly with the
  recorded control options.
- Blocked/unresolved automation decisions return blocked and do not run
  supervise.
- README, md2 orchestration notes and operator runbook now document the command.

## Safety Boundary

- Advance does not execute arbitrary shell text.
- Advance does not run by default.
- Advance does not install dependencies, commit changes or mutate GitHub.
- The underlying supervisor still owns safe issue selection, verification,
  repair and continuation gates.

## Verification

- Added coverage for:
  - planned dry-run advance
  - explicit execute dispatch
  - blocked decision refusal
- Full verification command:

```bash
npm test
```
