# Phase 103 Report: Issue-Control Supervisor Loop

Date: 2026-07-11

## Goal

Phase 103 adds a bounded supervisor above the existing issue-control pull,
plan, auto and run primitives. The tool can now select multiple safe md2 issues
and dispatch them through the existing single-issue runner without widening the
mutation boundary.

## Delivered

- Added `superviseIssueControl`.
- Added `renderIssueControlSupervise`.
- Added CLI command: `issue-control supervise`.
- Added JSON and Markdown reports:
  - `issue-control/issue-control-supervise-*.json`
  - `issue-control/issue-control-supervise-*.md`
- Added bounded `--max-iterations`; Phase 103 caps it at 10.
- Added dry-run multi-issue planning.
- Added execute mode that runs selected issues in order.
- Added stop-on-first `failed` or `blocked` iteration.
- Added high-risk skip by default, with `--allow-high-risk` as the explicit
  override.
- Added tests for dry-run, execute and blocked supervisor paths.

## Safety Boundaries

- Dry-run remains the default.
- Execution still goes through `runIssueControlPlan` one issue at a time.
- No dependency install.
- No commit creation.
- No GitHub mutation or live issue sync.
- No unbounded retry loop.

## Operator Commands

Dry-run:

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --max-iterations 3
```

Execute reviewed iterations:

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 3
```

## Current Self-Healing Level

The supervisor now handles orchestration self-healing at the queue level:

- skips unsafe/high-risk issues unless explicitly allowed
- records why non-selected issues were skipped
- stops on blocked or failed execution
- preserves all child pull/plan/run artifacts for diagnosis

Automatic failure repair loops remain delegated to existing proposal repair
commands and will be deepened in a later phase.

## Verification

- `npm test`: passed, 76 tests.
