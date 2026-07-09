# Phase 92 Report: One-Shot Status Reporting

生成日期：2026-07-09

## Goal

把一次性重构平台从“能生成 runbook”推进到“能读 runbook 并回答当前做到哪一步”：状态命令根据最新 runbook 和其后的 evidence artifacts，汇总 target prep、baseline、verify、pre-PR report、PR merge、post-merge verify、closure report 的进度，并给出唯一 next action。

## Delivered

New CLI command:

```text
migration-guard one-shot status
```

Key options:

```text
--runbook <path>
--skip-target-git
--strict
--json
```

New status model:

```text
OneShotStatusReport
OneShotStatusStep
```

Status inputs:

```text
latest one-shot runbook
latest baseline after the runbook
latest run after the runbook
latest compare after the runbook
latest one-shot report after the runbook
target git cleanliness
```

Output behavior:

```text
status: go | hold
steps: passed / ready / blocked / pending
next action: first actionable lifecycle step
```

The status reader filters evidence by the runbook creation time, so a new window cannot accidentally appear complete because of old baseline, verify, compare, or report artifacts from an earlier one-shot.

## Real md-one-shot Validation

Command:

```text
node dist/cli.js one-shot status --config configs/md-one-shot.migration-guard.json
```

Result:

```text
Status: hold
Runbook: one-shot-runbook-2026-07-09T09-56-00-015Z
Target clean: yes
Steps: 1/8 passed, 1 ready, 0 blocked, 6 pending
Next Action: baseline
Command: node dist/cli.js baseline --config "D:\learn\migration-guard\configs\md-one-shot.migration-guard.json"
```

Interpretation:

```text
The latest runbook is open and target prep has passed.
No post-runbook baseline exists yet, so the platform correctly points to baseline as the next action.
Older Phase 88 one-shot evidence is ignored for this new runbook window.
```

## Verification

Build:

```text
npm run build
```

Result:

```text
passed
```

Test:

```text
npm test
```

Result:

```text
50 tests passed
```

Focused coverage:

- status renders lifecycle progress from a runbook
- status points to `pre-pr-report` after fresh baseline, run and compare evidence exists
- evidence older than the selected runbook is ignored
- status reports target cleanliness before closure

## Exit Criteria

- `one-shot status` reads the latest runbook: passed.
- Status reports passed, ready, blocked and pending lifecycle steps: passed.
- Status produces a single next action with command when available: passed.
- Status ignores evidence older than the selected runbook: passed.
- Real `md-one-shot` config returns the correct next action for a fresh runbook: passed.
- Full test suite passes: passed.

## Next

Phase 93 can make one-shot windows more platform-like by adding a persistent one-shot session ledger: open/close lifecycle state, named windows, explicit evidence links per step, and resume commands that avoid relying only on latest artifact discovery.
