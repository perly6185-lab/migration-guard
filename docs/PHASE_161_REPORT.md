# Phase 161 Report: Release Evidence Ledger and Freshness Gate

## Delivered

- Added a unique release run and context hash covering package, Git, Node, OS and pilot project fingerprints.
- Added JSON and Markdown release evidence under `.migration-guard/releases/<runId>/`.
- Bound pilot scan, baseline, run and compare artifacts to the current release run with hashes and lineage checks.
- Changed pilot reports so skipped, missing, stale, mutated or historical evidence is always NO-GO.
- Added resumable release gates for tests, UI smoke, package audit, package smoke, install modes, diff checks and three real-project pilots.
- Resume reuses unchanged expensive gates, verifies the pilot smoke evidence root and reruns the lightweight pilot report.
- Preserved manual reviewed boundaries for npm publish and Git tags.

## Validation

- `npm test`: 131 tests passed.
- Missing pilot roots: 0 executed, 3 skipped, report returned NO-GO.
- Three real pilot projects: 3 executed, 3 passed, zero regressions and zero changed failures.
- Full `npm run release:gate` passed on Windows with tests, UI, package, install and pilot gates.
- `npm run release:gate -- --resume <runId>` reused completed gates with unchanged context.
- Adding a new untracked file changed the content fingerprint and correctly blocked resume.
- Validation release run: `release-2026-07-14T01-26-25-580Z-c29ba96b`.

## Artifacts

- `.migration-guard/releases/<runId>/release-evidence.json`
- `.migration-guard/releases/<runId>/release-evidence.md`
- `.migration-guard/releases/<runId>/pilot-smoke.json`
- `.migration-guard/releases/<runId>/pilot-report.json`
- `.migration-guard/releases/<runId>/pilot-report.md`
- `.migration-guard/releases/<runId>/pilot-results/*.json`
