# Phase 98 Report: MD2 Issue-Control Pull And Plan

生成日期：2026-07-11

## Goal

把 `md2` GitHub Issues 从“同步落点”推进为可读取的控制面：

```text
md2 GitHub issues
  -> issue-control pull
  -> local control-plane artifact
  -> issue-control plan
  -> guarded execution actions
```

本阶段仍然保持只读，不直接执行远端 issue，也不修改 `md2` 代码。

## Delivered

New CLI:

```bash
node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --labels team:migration
```

Plan from saved pull artifact:

```bash
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --input <pull.json>
```

New core module:

- `src/core/issueControl.ts`

New tests:

- `src/core/issueControl.test.ts`

GitHub read adapter enhancement:

- `readGitHubIssues`
- GET-only issue read
- PR filtering
- optional token for public reads
- label and state filters

Parsed metadata:

- `mg_run_id`
- `mg_issue_id`
- `mg_task_id`
- `mg_issue_type`
- `mg_status`
- `mg_risk`
- `mg_owner`

Plan actions:

- `bootstrap-target`
- `repair-proposal`
- `execute-task`
- `classify-risk`
- `review-external`
- `track`

## Safety Boundary

`issue-control pull` and `issue-control plan` do not call POST/PATCH and do not
edit target files. They only write local artifacts under:

```text
.migration-guard/external-targets/md2-fast/issue-control/
```

Live issue mutation remains under `sync-issues --live` and still requires
`--live-confirm` plus `--live-plan-confirm`.

## Verification

Focused:

```bash
node --test dist/core/issueControl.test.js
```

Result:

- 3 tests passed.

Full verification:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 61 tests passed.
- `git diff --check`: passed, with Windows LF/CRLF warnings only.
