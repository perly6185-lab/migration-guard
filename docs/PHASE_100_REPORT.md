# Phase 100 Report: Single-Step Issue-Control Auto Loop

生成日期：2026-07-11

## Goal

把 md2 issue 控制面推进到单步自动循环：

```text
issue-control auto
  -> pull md2 issues
  -> plan guarded actions
  -> select one safe executable item
  -> dry-run or execute it
  -> write auto report
```

本阶段仍然只允许单步，不开放多 issue 多轮无人值守。

## Delivered

New CLI:

```bash
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 1
```

High-risk override:

```bash
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 1 --allow-high-risk
```

Selection priority:

1. `bootstrap-target`
2. `repair-proposal`
3. `execute-task`

Safety behavior:

- Default mode is dry-run.
- Phase 100 rejects `--max-iterations` greater than `1`.
- High-risk items are skipped unless `--allow-high-risk` is provided.
- `classify-risk`, `review-external`, and `track` are never auto-selected.
- GitHub mutation is not performed by auto; md2 issue mutation still uses
  `sync-issues --live-plan` and explicit `sync-issues --live`.

## Artifacts

Auto writes:

```text
.migration-guard/external-targets/md2-fast/issue-control/issue-control-auto-*.json
.migration-guard/external-targets/md2-fast/issue-control/issue-control-auto-*.md
```

It also links the pull, plan, and run artifacts created during the same cycle.

## Verification

Focused:

```bash
node --test dist/core/issueControl.test.js
```

Result:

- 9 tests passed.

Full verification:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 67 tests passed.
- `git diff --check`: passed, with Windows LF/CRLF warnings only.
