# Phase 105 Report: Supervisor Failure Classification And Recovery Plan

Date: 2026-07-11

## Goal

Phase 105 turns supervisor stops into structured recovery plans. When a
supervisor run is blocked or failed, the tool now classifies the failure,
collects evidence paths, and writes the next recommended recovery command.

## Delivered

- Added `SupervisorFailureCategory`.
- Added `IssueControlRecoveryPlan`.
- Added recovery plan JSON and Markdown artifacts:
  - `issue-control/issue-control-recovery-plan-*.json`
  - `issue-control/issue-control-recovery-plan-*.md`
- Added failure metadata to supervisor reports:
  - `failureCategory`
  - `recoveryPlanPath`
  - `recoveryPlanMarkdownPath`
  - `autoRepairEligible`
  - `humanActionRequired`
- Added classification for missing baseline, install blockers, check/probe
  drift, compare drift, task execution failure, proposal repair, bootstrap
  blockers, GitHub read blockers, human approval and unknown failures.
- Changed `--repair-on-fail` from a plain blocked flag into a recovery-plan
  safety gate.
- Added tests for missing baseline, probe diff and task execution failure.

## Safety Boundaries

- No automatic dependency installation.
- No commit creation.
- No GitHub mutation or live sync.
- No automatic repair execution in Phase 105.
- Recovery plans are diagnostic/planning artifacts only.

## Operator Flow

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --verify-each --max-iterations 3
```

If the supervisor stops, inspect:

```text
issue-control/issue-control-recovery-plan-*.md
```

The plan tells the operator whether the next step is baseline capture,
dependency install, diff classification, task failure inspection or a proposal
repair lane.

## Verification

- `npm test`: passed, 80 tests.
