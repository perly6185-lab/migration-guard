# Changelog

## Unreleased

- Add local refactoring project registration, stack preview, project switching and initial-run creation to the operator UI.
- Add project workflow progress and leased Scan, Baseline, Verify and Checkpoint actions to the operator UI.
- Add a Recovery Center with checkpoint preflight plans, hash-confirmed apply and project run history.
- Add reviewed single-task execution plans with path budgets, automatic checkpoints and post-task behavior verification.
- Add provider-neutral AI Handoff Contract v1 with hashed evidence, explicit permissions, validation, explanation and redaction.
- Add guarded external AI result import with manifest/patch validation, reviewed apply hashes, checkpoints and idempotent audit evidence.
- Fix UI smoke screenshots so fresh desktop/mobile captures are required instead of accepting stale files.
- Discover built tests recursively with stable ordering and minimum file/test-count guards.
- Split patch and issue-control pure models from orchestration and route CLI commands through a narrow registry.

## 0.2.0 - 2026-07-15

- Bind release gates and real-project pilots to a shared release run and context hash.
- Reject skipped, missing, stale, mutated or historical pilot evidence from GO reports.
- Add resumable release evidence manifests covering tests, package, install and pilot gates.
- Write snapshot, compare and UI job artifacts through validated v2 envelopes while preserving v1 reads.
- Extend artifact migration dry-runs and apply-confirm plans to core artifacts and metadata.
- Add an installed-package golden path smoke covering TypeScript, pnpm workspace, Go and Python fixtures.
- Change `init --detect` into a preview-first flow with explicit `--apply`, source/confidence metadata and skipped suggestions.
- Harden `doctor` diagnostics for unresolved variables, missing executables and artifact directory permissions.
- Let `report` summarize latest baseline/verify compare evidence when no migration run package exists.
- Fence UI job leases with stable owners and tokens, persist recovery plans, and refuse late worker results.
- Add clean-commit GA candidate evidence with tarball inventory, SHA-256 and reviewed publish handoff.

## 0.2.0-rc.1 - 2026-07-13

- Classify check health as healthy, inherited failure, regression, changed failure, recovered or missing.
- Add Webpack, Jest, pnpm and Go output normalization presets.
- Add workspace package summaries and improved test-file association to scans.
- Add cross-process UI job claims, owner PID recovery guards and artifact safety denylist.
- Add portable three-project pilot configuration and release-candidate validation.
