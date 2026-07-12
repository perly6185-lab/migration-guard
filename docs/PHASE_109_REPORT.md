# Phase 109 Report: Issue-Control Progress Status

## Goal

Turn the Phase 108 supervise progress ledger into an operator-facing status
entry point that can be read by humans or unattended schedulers without running
another GitHub pull or execution cycle.

## Delivered

- Added `migration-guard issue-control progress`.
- Added `IssueControlProgressStatusReport`.
- Added `issueControlProgressStatus`.
- Added `renderIssueControlProgressStatus`.
- The command reads the latest `issue-control-supervise-progress-*.json` by
  default.
- Added `--input <progress.json>` support for inspecting a specific ledger.
- The command writes:
  - `issue-control/issue-control-progress-status-*.json`
  - `issue-control/issue-control-progress-status-*.md`
- Status reports include:
  - source ledger path
  - global progress summary
  - unresolved items
  - unreached selected items
  - next actions
- CLI exits non-zero when the status is failed, blocked or unresolved.
- README, md2 orchestration notes and operator runbook now document the command.

## Safety Boundary

- This phase is read/status only.
- It does not pull GitHub issues.
- It does not run issue-control execution.
- It does not run recovery.
- It does not install dependencies, commit changes or mutate GitHub.

## Verification

- Added coverage for:
  - explicit `--input`-style ledger reads
  - latest ledger discovery
  - dry-run next action
  - failed recovery unresolved/unreached status
- Full verification command:

```bash
npm test
```
