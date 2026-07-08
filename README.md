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

For the real `md` validation lane:

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD guarded migration" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run <run-id> --limit 5
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run <run-id> --limit 5 --gate-policy fail-fast
```

For failed proposal repair:

```bash
node dist/cli.js proposal replan --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal retry --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal verify --run <run-id> --proposal <retry-proposal-id> --checks
node dist/cli.js proposal accept --run <run-id> --proposal <retry-proposal-id> --notes "verified repair"
```

Current release readiness is tracked in
[docs/RELEASE_CHECKLIST_70_74.md](docs/RELEASE_CHECKLIST_70_74.md).
For real `md` operations, use
[docs/MD_OPERATOR_RUNBOOK.md](docs/MD_OPERATOR_RUNBOOK.md).

## Core idea

Every migration step should answer:

- What behavior was protected before the change?
- What checks and probes were run after the change?
- Which outputs changed?
- Are the differences expected or risky?

## Commands

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
node dist/cli.js proposal accept --run latest --proposal <retry-proposal-id> --notes "verified repair"
node dist/cli.js proposal list --run latest --state ignored
node dist/cli.js proposal reject --run latest --proposal <proposal-id> --reason "wrong probe shape"
node dist/cli.js proposal ignore --run latest --proposal <proposal-id> --reason "superseded by regenerated proposal"
node dist/cli.js proposal ignore --run latest --proposal <proposal-id> --superseded-by <proposal-id>
node dist/cli.js proposal batch plan --run latest --limit 3
node dist/cli.js proposal batch apply --run latest --limit 3 --gate-policy fail-fast
node dist/cli.js diff list --run latest --compare <compare.json>
node dist/cli.js diff decide --run latest --compare <compare.json> --area probe --name renderer --as intentional --reason "expected renderer behavior change"
node dist/cli.js sync-issues --run latest --provider local
node dist/cli.js sync-issues --run latest --provider github --dry-run
node dist/cli.js sync-issues --run latest --provider github --live-plan --repo owner/name
node dist/cli.js sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --live-plan-confirm <plan-hash> --only-issue <issue-id> --max-live-mutations 1 --labels team:migration
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
Issue sync exports include the same gate and batch context so local/provider
neutral issue exports can be handed to a team or external tracker.
GitHub dry-run exports also write a PR comment preview at
`issue-sync/github-pr-comment.md`.
GitHub live issue sync requires explicit `--live`, `--repo owner/name`,
`--live-confirm <run-id>`, and `GITHUB_TOKEN`; tokens are never written to
artifacts. Existing open GitHub issues are updated when their body contains the
same `mg_issue_id`; unchanged issue bodies are skipped by SHA-256 body hash;
otherwise a new issue is created. Live runs also write
`issue-sync/github-live-plan.json` before any create/update mutation. Use
`--live-plan` for a read-only GitHub lookup that writes the same plan without
mutating issues. Live mutations are capped by `--max-live-mutations` and GitHub
429/5xx responses are retried conservatively; non-sensitive rate-limit headers
are written to summary artifacts. Each live plan includes a stable `planHash`;
real live sync requires `--live-plan-confirm <plan-hash>` so mutations are bound
to a reviewed plan.

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
Migration Guard when old proposal, verification, batch or replan artifacts need
new compatibility fields:

```bash
node dist/cli.js artifacts migrate
node dist/cli.js artifacts migrate --apply --apply-confirm <plan-hash>
```

Review the dry-run output first and copy its `planHash` into `--apply-confirm`
only when the migration plan matches the artifacts you intend to update.

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

See [docs/MD_REAL_WORLD_VALIDATION_PLAN.md](docs/MD_REAL_WORLD_VALIDATION_PLAN.md)
for the next real-world validation plan using `perly6185-lab/md`.

See [docs/MD_REAL_WORLD_VALIDATION_REPORT.md](docs/MD_REAL_WORLD_VALIDATION_REPORT.md)
for the completed real-world validation report.
