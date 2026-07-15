# Migration Guard

Migration Guard is a behavior-consistency guardrail CLI for important refactoring
and migration projects.

It does not rewrite code in the first version. It helps you prove that behavior
stayed consistent by capturing a baseline, running repeatable checks and probes,
and comparing later runs against that baseline.

The long-term product direction is larger: Migration Guard should become an AI
autonomous migration runner for large repositories. Users submit a source
project, target project and migration goal; the tool then analyzes, estimates,
plans, executes, verifies, checkpoints, replans and reports until the migration
converges. The current CLI is the safety core for that future system.

## Quick path

For local development on Migration Guard itself:

```bash
npm install
npm test
git diff --check
```

For the real `md -> md2` refactor lane:

```bash
node dist/cli.js run --config configs/md2-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md2 --goal "Refactor md into md2 with guarded behavior parity" --dry-run --adapter md-monorepo --issue-provider github
node dist/cli.js resume --config configs/md2-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --dry-run --labels team:migration,source:md,target:md2
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan --labels team:migration,source:md,target:md2
node dist/cli.js readiness --config configs/md2-fast.migration-guard.json --run <run-id>
```

For failed proposal repair:

```bash
node dist/cli.js proposal replan --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal retry --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal verify --run <run-id> --proposal <retry-proposal-id> --checks
node dist/cli.js proposal repair --run <run-id> --proposal <failed-proposal-id> --checks --accept
node dist/cli.js proposal accept --run <run-id> --proposal <retry-proposal-id> --notes "verified repair"
```

Phase 146-150 health semantics, normalization, workspace scanning, persistence hardening and RC results are documented in
[docs/PHASE_150_REPORT.md](docs/PHASE_150_REPORT.md). Release gates are tracked in
[docs/RELEASE_CHECKLIST_0.2.0.md](docs/RELEASE_CHECKLIST_0.2.0.md).
The completed Phase 151-160 RC hardening roadmap is tracked in
[docs/PHASE_151_160_PLAN.md](docs/PHASE_151_160_PLAN.md). The next release
integrity and portable AI collaboration roadmap is tracked in
[docs/PHASE_161_170_PLAN.md](docs/PHASE_161_170_PLAN.md).

CI and local `npm test` recursively discover built tests with stable ordering and
enforce the minimum file/test counts in `scripts/ci/test-manifest.json`. Unit and
integration tests run together; packaged smoke and real-project pilots remain
explicit release gates. CI also publishes total and slowest-test timings, audits
production dependencies, checks the npm package allowlist and runs installation smoke.

The release gate binds every result to one release run, repository context and
current pilot evidence. Configure all three real-project roots before running it:

```powershell
$env:MG_PILOT_ASCLLCREATOR_ROOT = "D:\learn\ascllcreator"
$env:MG_PILOT_CURSORMADE_ROOT = "D:\learn\cursormade"
$env:MG_PILOT_AIWAY_ROOT = "D:\learn\aiway"
npm run release:gate
npm run release:gate -- --resume <release-run-id>
```

The operator UI starts with a project selector and a **New project** workflow.
Enter separate local source and target repository directories plus the refactoring
goal, run read-only detection, then confirm creation. Confirmation writes a detected
`.migration-guard.json` only when the target has no config, creates an initial dry-run
migration run, and switches the workbench to that project. Source files are never
copied or modified by project registration.

Evidence is written under `.migration-guard/releases/<release-run-id>/`. A
skipped, missing, changed or historical pilot result is always NO-GO. Standalone
pilot execution must pass the same run id to both commands:

```bash
node scripts/smoke/real-project-pilot.mjs --release-run <release-run-id>
npm run pilot:report -- --release-run <release-run-id>
```

Phase 141-145 stabilization and real-project pilot results are documented in
[docs/PHASE_145_REPORT.md](docs/PHASE_145_REPORT.md). The checked-in pilot configs
write project evidence under `.migration-guard/pilots` and release-bound evidence
under `.migration-guard/releases`.

Current release readiness is tracked in
[docs/RELEASE_CHECKLIST_70_74.md](docs/RELEASE_CHECKLIST_70_74.md).
For real `md -> md2` operations, use
[docs/MD_OPERATOR_RUNBOOK.md](docs/MD_OPERATOR_RUNBOOK.md) and
[docs/MD2_REFACTOR_ORCHESTRATION.md](docs/MD2_REFACTOR_ORCHESTRATION.md).

## Core idea

Every migration step should answer:

- What behavior was protected before the change?
- What checks and probes were run after the change?
- Which outputs changed?
- Are the differences expected or risky?

## Commands

Configuration onboarding commands:

```bash
migration-guard init --target <project> --detect
migration-guard init --target <project> --detect --apply
migration-guard doctor --config <path>
migration-guard config validate --config <path>
migration-guard config explain --config <path> --json
```

Detection is read-only: it inspects manifests and scripts, recommends checks and
normalization presets, and never installs dependencies or edits the target project.
`init --detect` prints a preview by default; add `--apply` to write
`.migration-guard.json`.

Health debt workflow:

```bash
migration-guard verify --health-budget strict
migration-guard health-debt list
migration-guard health-debt accept --fingerprint <hash> --reason "known baseline failure" --owner team --expires-at 2026-09-01T00:00:00Z
```

```bash
npm install
npm run build
node dist/cli.js init --target ../your-project
node dist/cli.js scan
node dist/cli.js baseline
node dist/cli.js verify
node dist/cli.js compare
node dist/cli.js plan
node dist/cli.js ai-brief
```

After `init`, edit `.migration-guard.json` to add behavior probes that represent
your critical paths.

Autonomous migration runtime commands:

```bash
node dist/cli.js run --goal "Webpack to Vite" --dry-run --adapter js-vite
node dist/cli.js status --run latest
node dist/cli.js runs list
node dist/cli.js serve
node dist/cli.js tasks --run latest
node dist/cli.js issues --run latest
node dist/cli.js checkpoint create --run latest
node dist/cli.js resume --run latest --auto
node dist/cli.js sync-issues --run latest --provider local
node dist/cli.js contract capture --source http://localhost:3000/health
node dist/cli.js dual-run --source http://localhost:3000/health --target http://localhost:4000/health
```

Proposal gate commands:

```bash
node dist/cli.js actions --run latest
node dist/cli.js actions handoff --run latest
node dist/cli.js actions handoff --run latest --create-replans
node dist/cli.js actions handoff --run latest --create-replans --repair-briefs
node dist/cli.js action propose --run latest --action action-renderer-probes
node dist/cli.js proposal verify --run latest --proposal <proposal-id> --checks
node dist/cli.js action apply --run latest --proposal <proposal-id> --rollback-on-fail --behavior-diff
node dist/cli.js proposal rollback --run latest --proposal <proposal-id>
node dist/cli.js proposal replan --run latest --proposal <proposal-id>
node dist/cli.js proposal retry --run latest --proposal <failed-proposal-id>
node dist/cli.js proposal repair --run latest --proposal <failed-proposal-id> --checks --accept
node dist/cli.js proposal accept --run latest --proposal <retry-proposal-id> --notes "verified repair"
node dist/cli.js proposal list --run latest --state ignored
node dist/cli.js proposal reject --run latest --proposal <proposal-id> --reason "wrong probe shape"
node dist/cli.js proposal ignore --run latest --proposal <proposal-id> --reason "superseded by regenerated proposal"
node dist/cli.js proposal ignore --run latest --proposal <proposal-id> --superseded-by <proposal-id>
node dist/cli.js proposal batch plan --run latest --limit 3
node dist/cli.js proposal batch apply --run latest --limit 3 --gate-policy fail-fast
node dist/cli.js readiness --run latest --min-proposals 3 --min-batch-size 3 --strict
node dist/cli.js one-shot runbook --max-source-file-delta 1 --budget "bounded helper cleanup"
node dist/cli.js one-shot session open --max-source-file-delta 1 --budget "bounded helper cleanup"
node dist/cli.js one-shot session next
node dist/cli.js one-shot session run
node dist/cli.js one-shot session status
node dist/cli.js one-shot status
node dist/cli.js one-shot report --max-source-file-delta 1 --strict
node dist/cli.js one-shot report --max-source-file-delta 1 --pr-url <url> --target-commit <sha> --merge-commit <sha> --merged-at <iso> --budget "bounded helper cleanup" --strict
node dist/cli.js diff list --run latest --compare <compare.json>
node dist/cli.js diff decide --run latest --compare <compare.json> --area probe --name renderer --as intentional --reason "expected renderer behavior change"
node dist/cli.js sync-issues --run latest --provider local
node dist/cli.js sync-issues --run latest --provider github --dry-run
node dist/cli.js sync-issues --run latest --provider github --live-plan --repo owner/name
node dist/cli.js sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --live-plan-confirm <plan-hash> --only-issue <issue-id> --max-live-mutations 1 --labels team:migration
node dist/cli.js issue-control dashboard --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control blockers --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control plan --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json>
node dist/cli.js issue-control run --config configs/md2-fast.migration-guard.json --input <plan.json> --only-issue <mg_issue_id> --execute
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration
node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 1
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --verify-each --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --execute --repair-on-fail --repair-agent "<cmd>" --max-iterations 3
node dist/cli.js issue-control supervise --config configs/md2-fast.migration-guard.json --labels team:migration --trust-tier unattended --execute --max-iterations 3
node dist/cli.js issue-control progress --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance --config configs/md2-fast.migration-guard.json --execute --max-steps 3
node dist/cli.js issue-control advance-status --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control advance-scheduler --config configs/md2-fast.migration-guard.json
node scripts/scheduler/run-advance-scheduler.mjs --config configs/md2-fast.migration-guard.json --once
node dist/cli.js issue-control sync-gate --config configs/md2-fast.migration-guard.json --labels team:migration,source:md,target:md2
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration
node dist/cli.js ci verify --baseline .migration-guard/latest-baseline.json --run latest
```

Merge readiness:

```bash
npm test
node dist/cli.js actions handoff --run latest --json
gh pr checks 1
```

Pull requests run GitHub Actions CI on Ubuntu and Windows with Node 22,
`npm ci`, and `npm test`.
Use [docs/PR_MERGE_READINESS.md](docs/PR_MERGE_READINESS.md) as the final PR
handoff checklist.
For the real `md` validation workflow, use
[docs/MD_OPERATOR_RUNBOOK.md](docs/MD_OPERATOR_RUNBOOK.md). For the current
Phase 57-68 review split, use
[docs/PR_SPLIT_PLAN_57_68.md](docs/PR_SPLIT_PLAN_57_68.md). For final
release readiness, use
[docs/RELEASE_CHECKLIST_57_68.md](docs/RELEASE_CHECKLIST_57_68.md).
For the current post-merge release readiness baseline, use
[docs/RELEASE_CHECKLIST_70_74.md](docs/RELEASE_CHECKLIST_70_74.md).

Proposal gates support two execution policies:

- `collect-all` runs all planned checks and records the full failure surface.
- `fail-fast` stops after the first failed critical check and is the default for
  batch apply.

Check plans can also include retry metadata. Unit-test and UI-probe checks get
conservative default retries for suspected environment flakes such as worker
startup failures, transient socket resets and timeouts.

When a proposal gate fails, verification and batch reports include remediation
hints. Batch reports also explain why the batch stopped, which proposals were
skipped, and the next `proposal replan` command to run.
`status` and `report` also show one current next action. After `proposal replan`,
Migration Guard writes a focused replan brief and JSON context pack under
`replans/<proposal-id>/` so Codex, another AI assistant, or a human can repair
the failed proposal from evidence instead of guessing. `proposal retry` then
creates a linked retry proposal scaffold so the next verification/apply step is
tracked as part of the same failure loop.
`proposal repair` is the idempotent repair-loop entry point: it creates or
reuses the replan and retry proposal, can run retry checks, and can accept the
repair when the checked retry verification passes.
After a retry proposal has a passing checked verification, `proposal accept`
writes a repair acceptance report that links the source failure, retry proposal,
retry verification and AI repair checklist.
Proposal lifecycle UX includes `proposal list` filters by state/action/risk,
stored rejected/ignored reasons, and `proposal ignore --superseded-by` links.
Batch plans and reports distinguish proposals excluded before selection from
proposals skipped after an earlier batch failure.
When a latest compare report exists, failed proposal gates also reference
specific check/probe behavior drift in the verification report, failure issue,
replan brief, issue sync export, and run report.
Use `--behavior-diff` on apply commands to capture proposal-scoped before/after
snapshots and a compare report around the applied patch.
Use `diff decide` to classify compare differences as `intentional`,
`accidental` or `unknown`. Decisions are written to a local diff decision ledger
and appear in refreshed compare Markdown, run reports and replan briefs.
Migration run verification now interprets those decisions as a separate
decision gate: raw compare results stay unchanged, while accepted intentional
risk differences can continue, accidental differences require replan, and
pending/unknown risk differences require classification.
The `pnpm-vite-vue` adapter also emits low-risk proposal candidates for fixture
coverage and normalization review before broader automated source edits.
The `md` validation configs include renderer behavior, API contract, and web
static/build probes so large refactors can be guarded by project-specific
evidence instead of generic tests alone.
Use `--adapter md-monorepo` to generate a project-specific refactor task plan
and action candidates for `md` domains before allowing whole-repo source edits.
Action probe proposals can inspect affected directories as well as individual
files, which lets domain-scoped proposals use real package boundaries.
Shared TypeScript-only `md` package actions use `ts-structural-probe` instead of
the Vue-focused UI smoke probe.
MCP render runtime smoke disables remote code-block CSS fetches while still
exercising the real renderer path.
`proposal verify --checks` temporarily applies generated-script proposals while
checks run, then rolls them back and keeps the proposal unapplied.
Proposal checks also fail on package-manager no-op output, such as a pnpm filter
that exits successfully without running the requested script.
MD action plans include static check-readiness hints so missing pnpm scripts can
be spotted before proposal gates run.
`action propose` blocks `no-op-risk` actions by default; use
`--allow-no-op-risk` only for an explicitly accepted exception.
Run `status` and `report` now summarize action check readiness as well, so
no-op-risk checks become visible in the run handoff before proposal generation.
Writing a run report also emits `reports/action-check-readiness-handoff.json`
and `.md`, with attention items for no-op-risk, unknown, or missing readiness
metadata.
Use `actions handoff` to generate or refresh the same readiness handoff without
rendering the full run report.
Use `actions handoff --create-replans` to turn readiness attention items into
deduplicated replan tasks and task issues inside the migration run.
Use `actions handoff --create-replans --repair-briefs` to write AI/human repair
briefs and JSON context for each readiness attention item.
Use `proposal reject` or `proposal ignore` to exclude a proposed-only patch from
future batch plans without trying to rollback a patch that was never applied.
Run reports include an evidence graph that links proposals, gates, batches,
behavior decisions, replans and next actions. Replan contexts include template
selection, check readiness, source snippet indexes, failed stdout/stderr
summaries and an AI repair acceptance checklist.
`readiness` evaluates whether a run has enough clean evidence to enter a
large-batch refactor. It requires a valid action plan, clear action check
readiness, enough candidate proposals, required probe template coverage, a
recent passing batch and a clean target repository before it returns `go`.
`one-shot runbook` writes a reusable JSON/Markdown checklist for a bounded
one-shot window, including baseline, verify, pre-PR report, PR merge,
post-merge verify and final closure report command templates. `one-shot status`
reads the latest runbook and reports which lifecycle steps have passed, which
step is ready, and the next command to run. It only counts evidence created
after the selected runbook, so old closure artifacts cannot make a new window
look complete. `one-shot session open` writes a persistent session ledger
alongside its runbook, and `one-shot session status` / `sync` refresh that
ledger with baseline, pre-PR, PR/merge, post-merge and closure evidence links
so a window has explicit lifecycle state instead of relying only on latest
artifact discovery. `one-shot session next` prints the current runnable lifecycle
command, such as baseline, verify, pre-PR report or closure report, from the
active session. `one-shot session run` automatically executes safe lifecycle
steps such as baseline, verify, report and sync until it reaches an external
edit/PR boundary or a failing gate. Pass `--edit-command` and `--pr-command` to
connect external code-change and PR/merge agents; the edit hook is followed by
post-edit verification, while the PR hook must print closure metadata as JSON
and is followed by post-merge verification plus a final closure report.
`one-shot report` summarizes a bounded one-shot closure from the latest
baseline/run/compare artifacts, critical check and probe status, source-file
delta budget and target git cleanliness. Use
`--max-source-file-delta` to make the planned file-count budget explicit and
`--strict` to fail the command when the report returns `hold`. For final closure
evidence, add `--pr-url`, `--target-commit`, `--merge-commit`, `--merged-at` and
`--budget`; the report also auto-detects the target branch and current HEAD
commit when possible.
Issue sync exports include the same gate and batch context so local/provider
neutral issue exports can be handed to a team or external tracker.
GitHub dry-run exports also write a PR comment preview at
`issue-sync/github-pr-comment.md`.
GitHub live issue sync requires explicit `--live`, a GitHub repo from either
`--repo owner/name` or config `issueSync.githubRepo`, `--live-confirm <run-id>`,
and `GITHUB_TOKEN`; tokens are never written to artifacts. Existing open GitHub
issues are updated when their body contains the same `mg_issue_id`; unchanged
issue bodies are skipped by SHA-256 body hash; otherwise a new issue is created.
Live runs also write
`issue-sync/github-live-plan.json` before any create/update mutation. Use
`--live-plan` for a read-only GitHub lookup that writes the same plan without
mutating issues. Live mutations are capped by `--max-live-mutations` and GitHub
429/5xx responses are retried conservatively; non-sensitive rate-limit headers
are written to summary artifacts. Each live plan includes a stable `planHash`;
real live sync requires `--live-plan-confirm <plan-hash>` so mutations are bound
to a reviewed plan.
`runs list` writes a run-index backed JSON/Markdown inventory across migration
runs, including readiness, failed and blocked counts. `serve` starts a local
operator board over the same artifacts with run selection, blocker evidence,
run-scoped diffs and guarded actions for readiness, verification snapshot
capture and issue-control dry-run. Browser action buttons create asynchronous
UI jobs under `artifactsDir/ui-jobs`, return a `jobId`, and poll `/api/jobs`
until the job succeeds or fails; each job ledger records the action, parameters,
status, timestamps, timeline events, result and artifact paths. The Recent Jobs
panel supports status/current-run filtering and auto-refreshes while jobs are
queued or running; failed jobs can be retried from their original action
parameters and record `retryOf` for auditability. Job detail views show retry
chains, child retries, timeline events, structured result/params and classified
artifact links. Queued jobs can be cancelled before execution, and terminal job
ledgers can be pruned with a dry-run-first GC control. UI write requests include
a per-server CSRF token and accept JSON request bodies while query-string
compatibility remains available. On server startup, orphan queued/running jobs
from a previous process are recovered to terminal states, and active duplicate
jobs with the same action parameters are rejected. Diff reports also support
batch classification by severity from the board. The action panel asks
`/api/actions/capabilities` before enabling buttons, so missing configuration
such as `issueSync.githubRepo` is shown before an operator clicks. Run
`npm run ui:smoke` to verify the board HTML/API and capture optional Chrome
screenshots to a temp directory. Action POST endpoints enforce the same
capabilities server-side and return `409` with the unavailable reason when a
request is stale or bypasses the browser controls. The legacy synchronous
`/api/actions/*` endpoints remain available for compatibility, while
`/api/jobs/actions/*` is the preferred UI workflow. Evidence paths in the board
open through `/api/artifact`, which only serves files under the configured
`artifactsDir`. Diff report rows can be classified from the board as
intentional, accidental or unknown; the UI writes the same diff decision ledger
as `migration-guard diff decide`.
`issue-control dashboard` writes a single JSON/Markdown control view over the
latest run, run-index, ready tasks, stuck proposals, readiness, progress ledger
and target git status. `issue-control blockers` extracts the global blocker
root causes as a CI/operator friendly list.
`issue-control pull` reads GitHub issues from `--repo owner/name` or config
`issueSync.githubRepo` and writes read-only control-plane artifacts.
`issue-control plan` maps those remote issues into guarded actions such as
target bootstrap, proposal repair, task execution handoff, risk classification,
or external review. It does not mutate GitHub and does not edit the target
repository.
`issue-control run` is dry-run by default. In Phase 99, real execution requires
`--execute --only-issue <mg_issue_id>` and supports one selected executable item
at a time.
`issue-control auto` chains pull, plan and a single selected run. Phase 100
allows only `--max-iterations 1`; high-risk items are skipped unless
`--allow-high-risk` is passed. Add `--trust-tier manual|supervised|unattended`
to make the risk model explicit.
`issue-control supervise` is the bounded multi-issue supervisor. It pulls and
plans once, selects up to `--max-iterations` safe executable md2 issues, runs
each through the existing single-issue runner, and writes
`issue-control-supervise-*.json|md` plus a machine-readable progress ledger at
`issue-control-supervise-progress-*.json|md`. Dry-run is the default.
Selection uses a trust-tier risk budget: `supervised` keeps existing bounded
selection, while `unattended` selects only low-risk issues and automatically
enables `verify-each`, `repair-on-fail` and `continue-after-repair` as the
mutation watchdog envelope.
`--execute` still uses one issue per iteration, stops on the first failed or
blocked iteration, and does not commit, install dependencies or mutate GitHub.
Add `--verify-each`
to capture a run snapshot and compare it with `latest-baseline.json` after each
executed iteration. Missing baseline or compare failure stops the supervisor
and records the verification artifact on that iteration. `--repair-on-fail` is
reserved for recovery planning: on blocked/failed supervisor runs the tool
writes `issue-control-recovery-plan-*.json|md` with a failure category,
evidence paths, `autoFixable`, selected `repairStrategy`, behavior-diff
requirements and the next recommended command.
When `--repair-on-fail` is used with `--execute`, eligible proposal repair
recoveries also write `issue-control-recovery-execution-*.json|md` and attempt
the bounded proposal repair lane. Deterministic strategies can also capture a
missing baseline, install dependencies, patch a conservative missing package
script alias, rewrite a drifted probe path when the replacement basename is
unique, or confirm a formatting-only no-op when the category is auto-fixable.
Add `--repair-agent <cmd>` to delegate the recovery to an external command; it
receives `MG_RECOVERY_PLAN`, `MG_RECOVERY_CATEGORY`, `MG_FAILED_ISSUE_ID` and
`MG_FAILED_ISSUE_NUMBER`. Any executed recovery that requires behavior-diff
evidence captures a run snapshot and compare report after the repair; missing
baseline or compare failure downgrades the recovery execution to blocked or
failed.
Non-eligible categories still stop as blocked. Add `--continue-after-repair`
only when the supervisor should continue
remaining selected issues after an eligible recovery execution returns
`executed`; planned, blocked or failed recovery executions still stop.
Use `issue-control progress` to read the latest progress ledger, write
`issue-control-progress-status-*.json|md`, and surface unresolved or unreached
selected issues without pulling GitHub or executing work. The status report also
includes `automationDecision`, which classifies whether the lane is blocked,
ready to execute, ready to continue, ready to sync or complete, and includes a
bounded next command when one can be reconstructed from the supervise options.
It also includes an adaptive gate: failed or blocked batches downgrade the next
batch to one issue, clean completed execute batches may grow by one, and all
other states hold the current bound.
Use `issue-control advance` to turn that decision into a planned advance report;
add `--execute` only when the decision is eligible and the next supervised cycle
should actually run. Advance calls the internal supervisor path instead of
executing arbitrary shell text. Add `--max-steps <n>` with `--execute` to run a
bounded advance loop; the loop stops on failed/blocked steps, completed
supervision or the max-step guard. Loop mode also refreshes
`issue-control/issue-control-advance-loop-state.json|md`; if a later execute
loop starts from the same failed/blocked progress ledger, the repeat guard
blocks before re-running the supervisor. Use `--force` only to override that
guard after reviewing the evidence. Use `issue-control advance-status` to read
that fixed state without pulling GitHub, running supervisor, or writing a new
advance report; it exits non-zero when the latest loop is failed, blocked or
repeat-guard active. Its JSON includes `schedulerDecision` with an action such
as `review-plan`, `run-advance-loop`, `sync-issues` or `stop-for-recovery`,
plus `canRunUnattended`, `requiresHuman`, `exitCode` and an optional next
command. `run-advance-loop` is emitted when a loop only paused at the max-step
guard and another bounded loop may continue. For `trust-tier unattended`,
`canRunUnattended` is true only when the safety envelope is green: clean target
repo, baseline available for execution, low-risk selected set, required
verify/repair/continue watchdog flags, critical verification coverage, no
no-op-risk and no unresolved failures.
Use `issue-control advance-scheduler` to convert that state decision into an
audited scheduler report; even with `--execute`, it only dispatches the
internal bounded advance loop when the decision is `run-advance-loop` and the
decision allows unattended execution. Scheduler decisions/results append to
`issue-control/issue-control-unattended-audit.jsonl`. External schedulers can
call `scripts/scheduler/run-advance-scheduler.mjs` to poll the JSON decision
and write a local scheduler run log. Use `issue-control
sync-gate` after scheduler completion to produce a reviewed
`sync-issues --live-plan` handoff; the gate does not call `sync-issues` or
mutate GitHub.
`issue-control bootstrap` creates a controlled md -> md2 import manifest and,
with `--execute`, copies allowed source files into an empty clean md2 target
while excluding git metadata, dependencies, build output, Migration Guard
artifacts and environment files. Add `--verify` to run the post-bootstrap
closure: package/install readiness checks, baseline snapshot, verification
snapshot, compare report and issue-control auto dry-run. The verify step does
not install dependencies, commit changes or mutate GitHub; missing
`node_modules` is reported as `blocked: install required`.

Proposal gate defaults can be configured:

```json
{
  "proposalGate": {
    "defaultPolicy": "collect-all",
    "batchPolicy": "fail-fast",
    "retry": {
      "unit-test": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected"]
      },
      "ui-probe": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected", "timeout"]
      }
    }
  }
}
```

CLI `--gate-policy` options override config defaults for that command.

Config profiles let one config carry local, CI, fast, and full lanes without
copying the whole file. Pass `--profile <name>` on commands that load config, or
set `MG_PROFILE=<name>`.

```json
{
  "schemaVersion": 1,
  "targetRoot": ".",
  "artifactsDir": ".migration-guard",
  "issueSync": {
    "githubRepo": "owner/target-repo"
  },
  "profiles": {
    "local": {
      "artifactsDir": ".migration-guard/local"
    },
    "ci": {
      "artifactsDir": ".migration-guard/ci",
      "proposalGate": {
        "batchPolicy": "collect-all"
      }
    },
    "fast": {
      "checks": [
        { "name": "test", "command": "npm test", "critical": true }
      ]
    },
    "full": {
      "checks": [
        { "name": "test", "command": "npm test", "critical": true },
        { "name": "build", "command": "npm run build", "critical": true }
      ]
    }
  }
}
```

Runtime artifacts can be reviewed and pruned with a dry-run-first GC command:

```bash
node dist/cli.js artifacts gc --keep-runs 5
node dist/cli.js artifacts gc --keep-runs 5 --apply
```

Artifact schema migrations are also dry-run-first. Use them after upgrading
Migration Guard when old snapshot, compare, UI job, proposal, verification,
batch or replan artifacts need a current envelope or compatibility fields:

```bash
node dist/cli.js artifacts migrate
node dist/cli.js artifacts migrate --apply --apply-confirm <plan-hash>
```

Review the dry-run output first and copy its `planHash` into `--apply-confirm`
only when the migration plan matches the artifacts you intend to update.

New snapshot, compare and UI job files use Artifact Schema v2 envelopes. Readers
continue to accept v1 payloads, while kind mismatches, future versions and payload
hash mismatches fail explicitly. Snapshot metadata records normalization,
health fingerprints and package summaries; compare metadata records snapshot
hashes, health policy and health-debt decisions; UI jobs record owner, attempt,
heartbeat, lease and result artifact references.

## Probe types

Command probe:

```json
{
  "type": "command",
  "name": "pricing-rules",
  "command": "node scripts/print-pricing-cases.js",
  "normalize": {
    "stripAnsi": true,
    "trimWhitespace": true,
    "json": {
      "sortKeys": true,
      "ignoreFields": ["generatedAt"]
    }
  }
}
```

HTTP probe:

```json
{
  "type": "http",
  "name": "health-api",
  "url": "http://localhost:3000/api/health",
  "method": "GET",
  "normalize": {
    "trimWhitespace": true,
    "json": {
      "sortKeys": true
    }
  }
}
```

## Suggested workflow

1. Run `baseline` before touching code.
2. Make one small migration change.
3. Run `verify` after the change.
4. Inspect the generated compare report.
5. Record intentional differences explicitly before continuing.

The goal is not to make change impossible. The goal is to make behavior drift
visible as soon as it appears.

## AI-assisted migration

The migration process can include AI, but AI should work inside the same
verification loop:

1. Run `baseline` before risky changes.
2. Run `ai-brief` to generate a context pack for the AI assistant.
3. Ask the AI to make one small scoped change.
4. Run `verify` immediately after the change.
5. Review the compare report before continuing.

`ai-brief` is intentionally offline and provider-neutral. It does not call an AI
API by itself. It packages the project signals, high-risk files, configured
checks, behavior probes, latest baseline, latest run, and operating rules into a
Markdown file that can be given to Codex, Claude, OpenAI models, local models, or
human reviewers.

The intended responsibility split is:

- AI proposes and implements small migration steps.
- Migration Guard proves whether protected behavior stayed consistent.
- Humans approve intentional behavior changes and update probes/tests.

## Product design

See [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) for the planned evolution
from the current verification CLI into a full autonomous migration system with
dynamic task graphs, checkpoints, issue-based control, evidence logs and
continuous replanning.

See [docs/DEVELOPMENT_PHASES.md](docs/DEVELOPMENT_PHASES.md) for the
independently runnable implementation phases.

See [docs/PHASE_COMPLETION_REPORT.md](docs/PHASE_COMPLETION_REPORT.md) for the
current phase completion report.

See [docs/PHASE_21_REPORT.md](docs/PHASE_21_REPORT.md) for the adaptive gate
policy, flaky check retry and proposal batch report.

See [docs/PHASE_22_REPORT.md](docs/PHASE_22_REPORT.md) for remediation hints
and batch stop reporting.

See [docs/PHASE_23_REPORT.md](docs/PHASE_23_REPORT.md) for configurable gate
policy, retry defaults and batch summary reporting.

See [docs/PHASE_24_REPORT.md](docs/PHASE_24_REPORT.md) for external issue gate
context and CI handoff reporting.

See [docs/PHASE_25_REPORT.md](docs/PHASE_25_REPORT.md) for GitHub PR comment
preview, provider mapping and CI summary artifacts.

See [docs/PHASE_26_REPORT.md](docs/PHASE_26_REPORT.md) for the GitHub live
adapter boundary and mock API coverage.

See [docs/PHASE_28_REPORT.md](docs/PHASE_28_REPORT.md) for GitHub live plan
artifacts, unchanged issue skipping and failing batch smoke helpers.

See [docs/PHASE_29_REPORT.md](docs/PHASE_29_REPORT.md) for GitHub live
guardrails, read-only planning, labels, retry and rate-limit observability.

See [docs/PHASE_30_REPORT.md](docs/PHASE_30_REPORT.md) for plan-hash
confirmation before GitHub live mutation.

See [docs/GITHUB_READ_ONLY_SMOKE_RUNBOOK.md](docs/GITHUB_READ_ONLY_SMOKE_RUNBOOK.md)
for the opt-in real GitHub read-only smoke procedure and the local no-network
planHash stability check.

See [docs/GITHUB_MUTATION_SMOKE_PLAN.md](docs/GITHUB_MUTATION_SMOKE_PLAN.md)
for the future single-issue GitHub mutation smoke plan.

See [docs/PHASE_32_REPORT.md](docs/PHASE_32_REPORT.md) for the completed real
GitHub read-only smoke result.

See [docs/PHASE_33_REPORT.md](docs/PHASE_33_REPORT.md) for single-issue
mutation smoke planning and filtered read-only verification.

See [docs/PHASE_34_REPORT.md](docs/PHASE_34_REPORT.md) for runner loop replan
briefs and unique next-action reporting.

See [docs/PHASE_35_REPORT.md](docs/PHASE_35_REPORT.md) for the completed
authorized single-issue GitHub mutation smoke.

See [docs/PHASE_36_REPORT.md](docs/PHASE_36_REPORT.md) for the replan task to
retry proposal loop.

See [docs/PHASE_37_REPORT.md](docs/PHASE_37_REPORT.md) for behavior drift
references in proposal gates.

See [docs/PHASE_38_REPORT.md](docs/PHASE_38_REPORT.md) for proposal-scoped
before/after behavior diff artifacts.

See [docs/PHASE_57_REPORT.md](docs/PHASE_57_REPORT.md) for TS structural probe,
MCP render smoke stabilization and proposal exclusion semantics.

See [docs/NEXT_MAJOR_PHASES.md](docs/NEXT_MAJOR_PHASES.md) for the larger
roadmap after the GitHub mutation smoke.

See [docs/MD2_REFACTOR_ORCHESTRATION.md](docs/MD2_REFACTOR_ORCHESTRATION.md)
for the corrected `perly6185-lab/md` to `perly6185-lab/md2` refactor control
model and issue sync plan.

See [docs/MD_REAL_WORLD_VALIDATION_PLAN.md](docs/MD_REAL_WORLD_VALIDATION_PLAN.md)
for the historical real-world validation plan using `perly6185-lab/md`.

See [docs/MD_REAL_WORLD_VALIDATION_REPORT.md](docs/MD_REAL_WORLD_VALIDATION_REPORT.md)
for the completed real-world validation report.

See [docs/PHASE_96_REPORT.md](docs/PHASE_96_REPORT.md) for the autonomous
one-shot runner, edit/PR hooks and idempotent proposal repair entry.

See [docs/PHASE_97_REPORT.md](docs/PHASE_97_REPORT.md) for the corrected
`md -> md2` issue-controlled refactor lane.

See [docs/PHASE_98_REPORT.md](docs/PHASE_98_REPORT.md) for md2
issue-control pull and guarded execution planning.

See [docs/PHASE_99_REPORT.md](docs/PHASE_99_REPORT.md) for the first
single-issue issue-control runner.

See [docs/PHASE_100_REPORT.md](docs/PHASE_100_REPORT.md) for the single-step
issue-control auto loop.

See [docs/PHASE_101_REPORT.md](docs/PHASE_101_REPORT.md) for controlled
bootstrap from the source `md` checkout into the empty `md2` target.

See [docs/PHASE_117_REPORT.md](docs/PHASE_117_REPORT.md) for the productized
advance scheduler entry point.

See [docs/PHASE_118_REPORT.md](docs/PHASE_118_REPORT.md) for the external
scheduler poller script.

See [docs/PHASE_119_REPORT.md](docs/PHASE_119_REPORT.md) for the real
`md2-fast` scheduler dry-run drill.

See [docs/PHASE_120_REPORT.md](docs/PHASE_120_REPORT.md) for the issue sync
closure gate and reviewed live-plan handoff.
