# Phase 117 Report: Advance Scheduler Productization

## Goal

Turn the existing `issue-control advance-scheduler` path into a documented,
tested scheduler handoff. The command should only execute the next bounded
advance loop when the persisted scheduler decision explicitly says
`run-advance-loop`.

## Delivered

- Productized `issue-control advance-scheduler`.
- Added scheduler coverage for:
  - dry-run planning from a `run-advance-loop` decision
  - blocked refusal for `stop-for-recovery`
  - execute dispatch into a bounded advance loop
- Confirmed non-executable actions such as `review-plan`, `sync-issues` and
  `stop-for-recovery` do not launch a loop.
- The command writes:
  - `issue-control/issue-control-advance-scheduler-*.json`
  - `issue-control/issue-control-advance-scheduler-*.md`

## Safety Boundary

- Dry-run is the default.
- `--execute` is required before any bounded loop is dispatched.
- The command never executes `schedulerDecision.nextCommand` as shell text.
- Only the internal `advanceIssueControlLoop` path can be called.
- It does not install dependencies, commit, or mutate GitHub.

## Verification

Targeted verification:

```bash
npm run build
node --test dist/core/issueControl.test.js
```
