# Phase 120 Report: Issue Sync Closure Gate

## Goal

Add a reviewed sync handoff after scheduler completion. When the advance loop is
truly complete, the tool should produce a local report and a reviewed
`sync-issues --live-plan` command instead of mutating GitHub directly.

## Delivered

- Added CLI command:

```bash
node dist/cli.js issue-control sync-gate --config configs/md2-fast.migration-guard.json --labels team:migration,source:md,target:md2
```

- Added `issueControlSyncGate`.
- Added `IssueControlSyncGateReport`.
- Added `renderIssueControlSyncGate`.
- Supervise selection/progress artifacts now preserve optional `runId` so the
  gate can produce a precise sync command when the source issue has
  `mg_run_id`.
- The gate writes:
  - `issue-control/issue-control-sync-gate-*.json`
  - `issue-control/issue-control-sync-gate-*.md`

## Behavior

- If `schedulerDecision.action` is not `sync-issues`, the gate returns
  `not-ready` or `blocked` and does not recommend live sync.
- If the action is `sync-issues`, the gate resolves the progress ledger behind
  the completed loop, summarizes completed/unresolved/pending issue ids, and
  recommends a reviewed GitHub live-plan command.
- If exactly one completed issue is known, the recommendation includes
  `--only-issue <mg_issue_id>`.
- If no run id is available from the ledger, the recommendation falls back to
  `--run latest` and records `runIdSource: latest-fallback`.

## Safety Boundary

- `sync-gate` does not call `sync-issues`.
- It never runs `--live`.
- It never reads or writes GitHub.
- It only writes local JSON/Markdown handoff artifacts.
- Real GitHub mutation still requires the existing `sync-issues --live` plus
  `--live-confirm` and `--live-plan-confirm` flow.

## Verification

Targeted verification:

```bash
npm run build
node --test dist/core/issueControl.test.js
```
