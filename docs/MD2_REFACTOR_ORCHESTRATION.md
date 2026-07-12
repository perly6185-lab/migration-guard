# MD2 Refactor Orchestration

生成日期：2026-07-11

## Control Model

The corrected migration lane is:

```text
perly6185-lab/md.git
  -> source repository, read for capability and behavior evidence

perly6185-lab/md2
  -> target repository, receives refactor changes
  -> GitHub issue control plane for planning, replans and self-healing follow-up
```

Migration Guard itself remains the execution engine and evidence store. It does
not use `md` issues for this lane.

## Where To See Status

Primary operator view:

- [MD_OPERATOR_RUNBOOK.md](MD_OPERATOR_RUNBOOK.md)

Local execution artifacts:

- `.migration-guard/external-targets/md2-fast/issue-control/`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/run.json`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/task-graph.json`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/issues.json`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/evidence.jsonl`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/reports/`
- `.migration-guard/external-targets/md2-fast/migration-runs/<run-id>/issue-sync/`

GitHub team control plane:

- `https://github.com/perly6185-lab/md2/issues`

Current local target state, 2026-07-11:

- `D:/learn/migration-guard-targets/md` exists.
- `D:/learn/migration-guard-targets/md2` was cloned from GitHub.
- Git reported `md2` as an empty repository with no commits yet.

That means the first execution stage is target bootstrap/import, followed by
normal guarded refactor verification.

Controlled bootstrap:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration
```

The dry-run writes a manifest without copying. The execute form requires a clean
git target and excludes `.git`, `node_modules`, build outputs, Migration Guard
artifacts and `.env*` files. The verify form then checks install readiness. When
`MG_SOURCE_ROOT` or `--source` is available it captures a source `md` baseline
and a target `md2` run snapshot, writes a source-to-target compare report, and
runs issue-control auto as a dry-run against `perly6185-lab/md2`. Without a
source root it falls back to a target-stability self-check.

If `node_modules` is missing, the verify report stops as blocked with
`install required`. Install dependencies explicitly and rerun verification:

```bash
pnpm --dir D:/learn/migration-guard-targets/md2 install
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --verify --labels team:migration
```

## Issue Sync Rule

The `md2-*` configs contain:

```json
{
  "issueSync": {
    "githubRepo": "perly6185-lab/md2"
  }
}
```

That means these commands use `md2` as the default GitHub issue repo:

```bash
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --dry-run
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan
```

Real mutation still requires explicit confirmation:

```bash
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 5
```

## Issue-Control Pull And Plan

Read `md2` GitHub issues without mutation:

```bash
node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration
```

Generate a guarded execution plan from those remote issues:

```bash
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --labels team:migration
```

Or plan from a saved pull artifact:

```bash
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --input .migration-guard/external-targets/md2-fast/issue-control/<pull>.json
```

Dry-run the executable item handoff:

```bash
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input .migration-guard/external-targets/md2-fast/issue-control/<plan>.json
```

Execute exactly one selected issue:

```bash
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input .migration-guard/external-targets/md2-fast/issue-control/<plan>.json --only-issue <mg_issue_id> --execute
```

Bootstrap/import should use the dedicated bootstrap lane rather than a one-shot
edit hook against an empty target:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration
```

Run the single-step auto loop:

```bash
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 1
```

Run the bounded supervisor loop when multiple safe issues can be handled
without human interaction:

```bash
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --verify-each --max-iterations 3
```

The supervisor pulls and plans once, selects up to the requested number of safe
executable issues, dispatches each selected item through the existing
single-issue runner, and stops on the first blocked or failed iteration. It
writes `issue-control/issue-control-supervise-*.json|md` plus
`issue-control/issue-control-supervise-progress-*.json|md` and does not mutate
GitHub. The progress ledger is the audit index for selected, reached,
unreached, recovered and continued issues. With `--verify-each`, every executed
iteration captures a run snapshot, compares it with `latest-baseline.json`,
records the compare artifact, and stops the supervisor on missing baseline or
failed compare.

Use the progress status view to inspect the latest ledger without another
GitHub read or execution cycle:

```bash
node dist/cli.js issue-control progress --config configs/md2-fast.migration-guard.json
```

It writes `issue-control/issue-control-progress-status-*.json|md` for the
current unresolved/unreached state, next actions and automation decision. The
decision is read-only: it can mark the lane blocked, ready to execute, ready to
continue, ready to sync or complete, and may include a reconstructed supervise
command when the original control options are available.

The controlled advance entry point turns an eligible decision into an advance
artifact and, with explicit `--execute`, starts the next internal supervisor
cycle:

```bash
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json --execute
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json --execute --max-steps 3
```

Advance never executes arbitrary shell text; it reuses the recorded supervisor
options and the existing issue-control safety boundaries. `--max-steps` is a
hard guard for bounded unattended loops. Loop execution also updates:

```text
issue-control/issue-control-advance-loop-state.json
issue-control/issue-control-advance-loop-state.md
```

The state file records the last loop, terminal source ledger and repeated
failed/blocked count. If the same failed or blocked ledger is submitted again,
the repeat guard blocks before launching supervisor; `--force` is the explicit
override for reviewed retries.

External schedulers can poll the state without creating new artifacts:

```bash
node dist/cli.js issue-control advance-status --config configs/md2-fast.migration-guard.json
```

The command is read-only and returns a non-zero exit code when the latest loop is
failed, blocked or repeat-guard active.

Use `--json` when wiring an external scheduler. The output includes
`schedulerDecision.action`, `schedulerDecision.canRunUnattended`,
`schedulerDecision.requiresHuman`, `schedulerDecision.exitCode` and an optional
`schedulerDecision.nextCommand`, so the scheduler can follow a single
machine-readable policy surface. `run-advance-loop` means the prior loop paused
at the max-step guard and can continue with another bounded advance loop.

The productized scheduler entry point writes an audited scheduler report and
only dispatches the internal bounded loop for `run-advance-loop` decisions:

```bash
node dist/cli.js issue-control advance-scheduler --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance-scheduler --config configs/md2-fast.migration-guard.json --execute
```

External schedulers can use the local wrapper:

```bash
node scripts/scheduler/run-advance-scheduler.mjs --config configs/md2-fast.migration-guard.json --once
node scripts/scheduler/run-advance-scheduler.mjs --config configs/md2-fast.migration-guard.json --execute --max-cycles 3
```

When the scheduler decision becomes `sync-issues`, generate the reviewed sync
handoff before any live GitHub mutation:

```bash
node dist/cli.js issue-control sync-gate --config configs/md2-fast.migration-guard.json --labels team:migration,source:md,target:md2
```

The gate writes `issue-control/issue-control-sync-gate-*.json|md` and
recommends a `sync-issues --live-plan` command. It does not execute sync or
mutate GitHub.

Failure and blocked states also write a recovery plan:

```text
issue-control/issue-control-recovery-plan-*.json
issue-control/issue-control-recovery-plan-*.md
```

The plan records the failure category, failed issue, failed action, evidence
paths, auto-repair eligibility and the recommended next command. This is the
classification layer before automatic repair execution. When
`--repair-on-fail --execute` is present, eligible `proposal-repair-needed`
recoveries also produce:

```text
issue-control/issue-control-recovery-execution-*.json
issue-control/issue-control-recovery-execution-*.md
```

For unattended supervision, add `--continue-after-repair` only after accepting
the recovery boundary. The supervisor continues to the next selected safe issue
only when the recovery execution status is `executed`. The failed iteration
retains its recovery artifacts, and the supervise report records
`continuedAfterRepair` for audit and rollback review.

High-risk issues are not auto-selected unless explicitly allowed:

```bash
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 1 --allow-high-risk
```

The plan maps issues to:

- `bootstrap-target`
- `repair-proposal`
- `execute-task`
- `classify-risk`
- `review-external`
- `track`

High-risk and external-review items remain intentionally read-only unless the
operator explicitly widens the execution boundary.

## Planning And Self-Healing Loop

```text
bootstrap/import md into empty md2 when needed
  -> write bootstrap manifest
  -> verify package/install readiness
  -> capture baseline + run snapshots
  -> compare bootstrap behavior evidence
  -> pull md2 issues
  -> generate issue-control plan
  -> dry-run issue-control run
  -> issue-control auto selects one safe item
  -> issue-control supervise selects bounded safe items
  -> execute one selected issue-control item
  -> verify each executed iteration when enabled
  -> stop on failed or blocked iteration
  -> classify failure and write recovery plan
  -> execute eligible proposal repair recovery when explicitly enabled
  -> run md -> md2 migration
  -> generate task graph and local issues
  -> sync issues to perly6185-lab/md2
  -> propose target changes in md2
  -> verify checks/probes
  -> on failure: create replan issue + retry proposal
  -> repair/verify/accept
  -> sync the replan or closure issue back to md2
  -> repeat until readiness/report is go
```

Self-healing is evidence-led:

- Failed proposal gates create a local failure issue.
- `proposal repair` creates or reuses replan artifacts and retry proposals.
- `sync-issues` publishes those failure/replan issues into `md2`.
- GitHub issue matching uses `mg_issue_id`, so repeated syncs update existing
  `md2` issues instead of creating duplicates.

## Recommended First Execution

```bash
node dist/cli.js run --config configs/md2-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md2 --goal "Refactor md into md2 with guarded behavior parity" --dry-run --adapter md-monorepo --issue-provider github
node dist/cli.js resume --config configs/md2-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --dry-run --labels team:migration,source:md,target:md2
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan --labels team:migration,source:md,target:md2
```
