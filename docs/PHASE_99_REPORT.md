# Phase 99 Report: Single-Issue Issue-Control Runner

生成日期：2026-07-11

## Goal

把 `md2` issue-control plan 接到受控执行层：

```text
md2 issue
  -> issue-control pull
  -> issue-control plan
  -> issue-control run
  -> local execution report
```

本阶段只开放单 issue 执行，不做多 issue 自动循环。

## Delivered

New CLI:

```bash
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json>
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json> --only-issue <mg_issue_id> --execute
```

Bootstrap execution requires an explicit edit hook:

```bash
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json> --only-issue <mg_issue_id> --execute --edit-command <bootstrap-agent-command>
```

Supported actions:

- `execute-task`
- `repair-proposal`
- `bootstrap-target` with `--edit-command`

Non-executing actions remain guarded:

- `classify-risk`
- `review-external`
- `track`

## Safety Boundary

- Default mode is dry-run.
- Real execution requires `--execute`.
- Real execution also requires `--only-issue <mg_issue_id>`.
- Phase 99 rejects `--max-items` greater than `1`.
- Each run writes a local `issue-control-run-*.json` and `.md`.
- The runner does not mutate GitHub; md2 issue updates still go through
  `sync-issues --live-plan` and explicit `sync-issues --live`.

## Verification

Focused:

```bash
node --test dist/core/issueControl.test.js
```

Result:

- 6 tests passed.

Full verification:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 64 tests passed.
- `git diff --check`: passed, with Windows LF/CRLF warnings only.
