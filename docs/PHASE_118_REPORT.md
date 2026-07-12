# Phase 118 Report: Scheduler Poller Script

## Goal

Add a small external scheduler wrapper that can poll `advance-status --json`
and invoke `advance-scheduler` only when the machine-readable decision allows
another unattended bounded loop.

## Delivered

- Added `scripts/scheduler/run-advance-scheduler.mjs`.
- The script supports:
  - `--config <path>`
  - `--input <state.json>`
  - `--once`
  - `--max-cycles <n>`
  - `--sleep-ms <n>`
  - `--execute`
- The script reads `schedulerDecision` from `advance-status --json`.
- It only calls `issue-control advance-scheduler` when:
  - `schedulerDecision.action = run-advance-loop`
  - `schedulerDecision.canRunUnattended = true`
- It writes local run logs:
  - `issue-control/issue-control-scheduler-run-*.json`
  - `issue-control/issue-control-scheduler-run-*.md`

## Safety Boundary

- The script does not execute `nextCommand`.
- Without `--execute`, it only plans through `advance-scheduler`.
- With `--execute`, it still goes through the productized internal scheduler
  command and bounded advance loop guards.
- It does not install dependencies, commit, or mutate GitHub.

## Verification

Targeted verification:

```bash
npm run build
node --test dist/core/issueControl.test.js
```
