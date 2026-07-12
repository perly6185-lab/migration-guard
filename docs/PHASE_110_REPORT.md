# Phase 110 Report: Progress Automation Decision

## Goal

Make `issue-control progress` produce a scheduler-readable automation decision
for the next unattended supervisor step, without executing that step.

## Delivered

- Added `controlOptions` to supervise reports.
- Propagated `controlOptions` into supervise progress ledgers.
- Added `IssueControlProgressAutomationDecision`.
- Added `automationDecision` to progress status reports.
- Progress status markdown now renders:
  - automation disposition
  - auto-continue eligibility
  - human-review requirement
  - automation reason
  - reconstructed next command when available
- Supported dispositions:
  - `ready-to-execute`
  - `ready-to-continue`
  - `ready-to-sync`
  - `blocked`
  - `complete`
  - `review`
- Dry-run status can reconstruct a bounded `issue-control supervise --execute`
  command from the original control options.
- Unresolved/blocked status explicitly returns `canAutoContinue: false` and
  `requiresHuman: true`.
- README, md2 orchestration notes and operator runbook now document the decision.

## Safety Boundary

- The decision is advisory.
- The command is not executed automatically.
- This phase does not pull GitHub issues.
- This phase does not run recovery.
- This phase does not install dependencies, commit changes or mutate GitHub.

## Verification

- Added assertions for:
  - dry-run status returning `ready-to-execute`
  - reconstructed supervise command containing `--execute`
  - unresolved failed status returning `blocked`
  - blocked status requiring human review
- Full verification command:

```bash
npm test
```
