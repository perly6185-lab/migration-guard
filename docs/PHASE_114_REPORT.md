# Phase 114 Report: Advance Loop Status

## Goal

Expose the latest advance loop state as a read-only command for unattended
schedulers and operators.

## Delivered

- Added `IssueControlAdvanceLoopStatusOptions`.
- Added `issueControlAdvanceLoopStatus`.
- Added CLI command:
  - `issue-control advance-status`
  - `issue-control advance-status --input <state.json>`
  - `issue-control advance-status --json`
- Reused `renderIssueControlAdvanceLoopState` for human-readable output.
- The CLI exits non-zero when the latest loop is failed, blocked or
  repeat-guard active.
- README, md2 orchestration notes and operator runbook now document the status
  command.

## Safety Boundary

- The status command only reads the fixed loop state or an explicit input file.
- It does not pull GitHub.
- It does not run supervisor.
- It does not execute advance.
- It does not write a new advance report, install dependencies, commit changes
  or mutate GitHub.

## Verification

- Added coverage for:
  - default loop state lookup
  - explicit `--input <state.json>` lookup
  - repeat-guard-active status visibility
- Full verification command:

```bash
npm test
```
