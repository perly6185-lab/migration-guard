# MD -> MD2 Operator Runbook

生成日期：2026-07-11

## 1. Purpose

This runbook is the short path for operating Migration Guard against the real
`md` to `md2` refactor lane.

Boundaries:

- Source repository: `https://github.com/perly6185-lab/md.git`
- Target repository: `https://github.com/perly6185-lab/md2`
- Issue control plane: `perly6185-lab/md2`
- Tool repository: `D:/learn/migration-guard`

`md` is read as source evidence only. Planning, execution state, self-healing
issues, and GitHub issue sync belong to `md2`.

## 2. Preconditions

- Source checkout: `D:/learn/migration-guard-targets/md`
- Target checkout: `D:/learn/migration-guard-targets/md2`
- Fast config: `configs/md2-fast.migration-guard.json`
- Full config: `configs/md2-full.migration-guard.json`
- One-shot config: `configs/md2-one-shot.migration-guard.json`

Prepare local checkouts:

```bash
git clone https://github.com/perly6185-lab/md.git D:/learn/migration-guard-targets/md
git clone https://github.com/perly6185-lab/md2.git D:/learn/migration-guard-targets/md2
```

Both repositories should start clean:

```bash
git -C D:/learn/migration-guard-targets/md status --short --branch
git -C D:/learn/migration-guard-targets/md2 status --short --branch
```

Current local observation, 2026-07-11: `md2` cloned successfully but is empty
(`No commits yet`). Treat the first target change as a controlled bootstrap
from `md` into `md2`; do not expect target checks to pass until that bootstrap
has created the package/workspace structure.

## 3. Bootstrap Empty MD2

If `md2` is empty, use the built-in bootstrap lane for the initial import before
opening any normal one-shot refactor window:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration
```

The built-in bootstrap copies allowed source files from
`D:/learn/migration-guard-targets/md` to `D:/learn/migration-guard-targets/md2`
and avoids `.git`, `node_modules`, build outputs, Migration Guard artifacts and
environment files. A one-shot agent can still be used afterward for a more
opinionated first refactor once the target has a healthy baseline.

`--verify` writes `bootstrap/md2-bootstrap-verify-*.json|md`. It checks
`package.json`, pnpm evidence, pnpm availability and `node_modules`; if
dependencies are missing, install them explicitly with `pnpm --dir
D:/learn/migration-guard-targets/md2 install` and rerun:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --verify --labels team:migration
```

The verify step captures a source `md` baseline and target `md2` run snapshot
when `MG_SOURCE_ROOT` or `--source` is available, writes a source-to-target
compare report, and runs issue-control auto in dry-run mode only. Without a
source root it falls back to a target-stability self-check. It does not commit,
install or mutate GitHub.

After bootstrap, commit or PR the target change through the normal provider
flow, then continue with the run below.

## 4. Create And Resume A Run

```bash
node dist/cli.js run --config configs/md2-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md2 --goal "Refactor md into md2 with guarded behavior parity" --dry-run --adapter md-monorepo --issue-provider github
node dist/cli.js resume --config configs/md2-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js actions --config configs/md2-fast.migration-guard.json --run <run-id>
node dist/cli.js readiness --config configs/md2-fast.migration-guard.json --run <run-id>
```

For issue-driven unattended orchestration, start with a supervisor dry-run:

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --max-iterations 3
```

After reviewing the selected iterations, execute the same bounded lane:

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --verify-each --max-iterations 3
```

The supervisor writes `issue-control/issue-control-supervise-*.json|md` and a
progress ledger at `issue-control/issue-control-supervise-progress-*.json|md`.
Use the ledger to inspect global progress, unreached selected issues, recovery
events and continuation decisions. It does not install dependencies, commit
changes or mutate GitHub; it stops at the first failed or blocked iteration and
records the stop reason. With
`--verify-each`, every executed iteration captures a run snapshot and compare
artifact against `latest-baseline.json`; missing baseline or compare failure
stops the lane before the next issue.

To inspect the latest supervisor state without running another pull/plan/execute
cycle:

```bash
node dist/cli.js issue-control progress --config configs/md2-fast.migration-guard.json
```

This writes `issue-control/issue-control-progress-status-*.json|md` and surfaces
unresolved items, unreached selected issues, next actions and an
`automationDecision`. Automation decisions are advisory and read-only: blocked
or unresolved lanes require review, while dry-run or unreached lanes may include
a reconstructed bounded `issue-control supervise` command for the next
supervisor cycle.

To create an advance report without running the next cycle:

```bash
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json
```

Only add `--execute` after reviewing that the automation decision is eligible.
Advance does not execute arbitrary shell text; it calls the internal supervisor
with the recorded control options.

For bounded unattended progression, add a max-step guard:

```bash
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json --execute --max-steps 3
```

The loop stops when a step fails, blocks, completes supervision, or reaches the
max-step limit.

Loop mode also writes a fixed state file for unattended orchestration:

```text
issue-control/issue-control-advance-loop-state.json
issue-control/issue-control-advance-loop-state.md
```

If the next execute loop starts from the same failed or blocked progress ledger,
the repeat guard stops before launching another supervisor cycle. Produce a new
supervise progress ledger after resolving the blocker, or add `--force` only
after reviewing the evidence.

To poll the latest loop state without running another cycle:

```bash
node dist/cli.js issue-control advance-status --config configs/md2-fast.migration-guard.json
```

`advance-status` is read-only and exits non-zero when the latest loop is failed,
blocked or repeat-guard active.

For unattended schedulers, prefer the JSON decision fields:

```bash
node dist/cli.js issue-control advance-status --config configs/md2-fast.migration-guard.json --json
```

Read `schedulerDecision.action`, `schedulerDecision.canRunUnattended`,
`schedulerDecision.requiresHuman` and `schedulerDecision.exitCode` instead of
reconstructing policy from raw status fields.
When `schedulerDecision.action` is `run-advance-loop`, the last loop only
paused at the max-step guard; a scheduler may run the provided next command as
another bounded loop.

To let Migration Guard perform that scheduler step without executing arbitrary
shell text:

```bash
node dist/cli.js issue-control advance-scheduler --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance-scheduler --config configs/md2-fast.migration-guard.json --execute
```

For an external polling wrapper:

```bash
node scripts/scheduler/run-advance-scheduler.mjs --config configs/md2-fast.migration-guard.json --once
node scripts/scheduler/run-advance-scheduler.mjs --config configs/md2-fast.migration-guard.json --execute --max-cycles 3
```

Both paths refuse to run unless the state decision is `run-advance-loop`.

When the scheduler reaches `sync-issues`, create a reviewed sync handoff before
any GitHub mutation:

```bash
node dist/cli.js issue-control sync-gate --config configs/md2-fast.migration-guard.json --labels team:migration,source:md,target:md2
```

`sync-gate` writes `issue-control/issue-control-sync-gate-*.json|md` and only
recommends a `sync-issues --live-plan` command. It does not run sync, install
dependencies, commit or mutate GitHub.

When the lane stops as failed or blocked, inspect the generated recovery plan:

```text
issue-control/issue-control-recovery-plan-*.json
issue-control/issue-control-recovery-plan-*.md
```

The recovery plan classifies the failure, points at evidence artifacts and
records whether automatic repair is eligible. With `--repair-on-fail
--execute`, eligible proposal repair recoveries also write:

```text
issue-control/issue-control-recovery-execution-*.json
issue-control/issue-control-recovery-execution-*.md
```

Non-eligible categories such as missing baselines, dependency install blockers
and compare/probe diffs still stop for human review.

Use `--continue-after-repair` only for unattended lanes where the supervisor may
continue after recovery. Continuation is gated on a recovery execution status of
`executed`; recovery statuses of `planned`, `blocked` or `failed` remain stop
conditions. The failed iteration keeps its recovery plan/execution artifacts for
backtracking, while the top-level supervise report records
`continuedAfterRepair` when the run proceeds.

The `md2-*` configs set `issueSync.githubRepo` to `perly6185-lab/md2`, so
GitHub issue sync defaults to the target repo control plane. You can still pass
`--repo perly6185-lab/md2` explicitly for audit clarity.

## 5. Sync Planning Issues To MD2

First read the md2 control plane without mutating it:

```bash
node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json>
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json> --only-issue <mg_issue_id> --execute
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration
```

Start with read-only or dry-run sync:

```bash
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --dry-run --labels team:migration,source:md,target:md2
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan --labels team:migration,source:md,target:md2
```

Only mutate GitHub after reviewing the live plan hash:

```bash
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 5 --labels team:migration,source:md,target:md2
```

Expected issue behavior:

- Migration Guard issues are created or updated in `perly6185-lab/md2`.
- Matching is by `mg_issue_id` in the GitHub issue body.
- `md` GitHub issues are not used for this migration lane.
- `migration-guard` GitHub issues are not used for this migration lane.

## 6. Generate Proposals

```bash
node dist/cli.js action propose --config configs/md2-fast.migration-guard.json --run <run-id> --action action-md-shared-contracts
node dist/cli.js action propose --config configs/md2-fast.migration-guard.json --run <run-id> --action action-md-core-renderer
node dist/cli.js action propose --config configs/md2-fast.migration-guard.json --run <run-id> --action action-md-web-editor-shell
node dist/cli.js action propose --config configs/md2-fast.migration-guard.json --run <run-id> --action action-md-api-contracts
node dist/cli.js action propose --config configs/md2-fast.migration-guard.json --run <run-id> --action action-md-mcp-render
```

Expected template coverage:

- shared contracts: `ts-structural-probe`
- core renderer: `renderer-probe`
- web editor shell: `ui-smoke-probe`
- API contracts: `api-contract-probe`
- MCP render: `renderer-probe`

## 7. Plan, Apply, And Self-Heal

```bash
node dist/cli.js proposal batch plan --config configs/md2-fast.migration-guard.json --run <run-id> --limit 5
node dist/cli.js proposal batch apply --config configs/md2-fast.migration-guard.json --run <run-id> --limit 5 --gate-policy fail-fast
node dist/cli.js readiness --config configs/md2-fast.migration-guard.json --run <run-id> --min-proposals 3 --min-batch-size 3 --strict
```

If a proposal fails, use the repair loop and sync the resulting replan issue to
`md2`:

```bash
node dist/cli.js proposal repair --config configs/md2-fast.migration-guard.json --run <run-id> --proposal <failed-proposal-id> --checks --accept
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan --only-issue <replan-issue-id>
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 1 --only-issue <replan-issue-id>
```

## 8. One-Shot Unattended Lane

For the no-human middle path, open a bounded one-shot session against `md2`:

```bash
node dist/cli.js one-shot session open --config configs/md2-one-shot.migration-guard.json --max-source-file-delta 5 --budget "md to md2 bounded refactor window"
node dist/cli.js one-shot session run --config configs/md2-one-shot.migration-guard.json --edit-command <agent-command> --pr-command <provider-command> --strict
```

The runner stops at failing gates or missing external hooks. Safe lifecycle
steps, verification, compare, reports, and repair artifacts are written under
the `md2-one-shot` artifacts directory.

## 9. Refresh Report

```bash
node dist/cli.js report --config configs/md2-fast.migration-guard.json --run <run-id>
```

Review:

- `Next Action`
- `Evidence Graph`
- `Recent Proposal Gates`
- `Recent Proposal Batches`
- `Recent Repair Acceptances`
- `issue-sync/github-live-plan.json`
- `issue-sync/github-live-sync.json`

## 10. Final Clean Check

Always finish with:

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
git -C D:/learn/migration-guard-targets/md2 status --short --branch
```

Expected:

- Migration Guard tests pass.
- `git diff --check` passes with Windows LF/CRLF warnings only.
- Source `md` remains clean.
- Target `md2` changes are either cleanly committed/merged or explained by the
  latest Migration Guard checkpoint/report.
