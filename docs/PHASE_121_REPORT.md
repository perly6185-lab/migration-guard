# Phase 121 Report: Guard Control Plane Hardening

## Scope

Implemented guard issue #17-20 in dependency order:

- #17 dashboard and global blockers.
- #18 commit-aware checkpoint and rollback precheck.
- #19 repair strategy contract and auto-fixable recovery classification.
- #20 trust tiers, unattended safety envelope and scheduler audit log.

## Highlights

- Added `issue-control dashboard` and `issue-control blockers`.
- Added `migration-runs/run-index.json` maintenance in `saveRunPackage`.
- Checkpoints now record git HEAD, branch, stash snapshot, untracked files and dependency side-effect fingerprints.
- Rollback now prechecks HEAD, new untracked files and dependency side effects; `--force` is required to cross unsafe boundaries.
- Added `RepairStrategy` with deterministic missing-baseline/dependency-install routing and proposal repair strategy metadata.
- Recovery plans now include `autoFixable`, `repairStrategy` and `behaviorDiffRequired`.
- Added `--trust-tier manual|supervised|unattended` to issue-control auto/supervise.
- Unattended supervise only selects low-risk issues and forces verify/repair/continue watchdog gates.
- Scheduler decisions now include trust tier and safety envelope; scheduler execution blocks when unattended safety is not green.
- Added append-only `issue-control-unattended-audit.jsonl`.

## Verification

- `npm run build`: passed.
- `node --test dist/core/checkpoint.test.js dist/core/dashboard.test.js`: passed.
- `node --test dist/core/issueControl.test.js dist/core/repairStrategy.test.js`: passed.
