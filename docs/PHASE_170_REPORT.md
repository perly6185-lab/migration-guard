# Phase 170 Report: 0.3.0-beta.1 Readiness Gate

## Outcome

The collaboration foundation now has a beta-specific aggregate gate. It binds the
package version to multi-stack golden fixtures, portable handoff/result protocols,
repair convergence, worker fencing, policy presets and artifact compatibility.

## Evidence

`npm run beta:readiness` writes `.migration-guard/beta-readiness/latest.json` and
`latest.md` with per-check evidence, a compatibility matrix, safety boundaries, a
stable report hash and exactly one next action.

The full `release:gate` now accepts `0.3.0-beta.1`, includes beta readiness, and still
requires package/install smoke plus all three current real-project pilots. Fixture
evidence cannot turn skipped pilots into GO.

## Safety

- npm publish, tag creation and GitHub prerelease remain manual.
- Remote mutation is denied by default.
- Result import remains hash-confirmed and local verification remains authoritative.
- Force recovery remains CLI-only.

## Validation Coverage

- Single TypeScript, pnpm monorepo, Go and Python golden fixtures.
- Handoff creation, result acceptance/rejection and path budgets.
- Injected proposal failure followed by replan, retry, verify and acceptance.
- Stale UI worker fencing rejection and recovery lineage.
- Handoff/result/core artifact compatibility matrix.

Real-project pilot execution remains an environment-bound release requirement and is
not claimed by the local fixture gate.

Current workspace status: `MG_PILOT_ASCLLCREATOR_ROOT`, `MG_PILOT_CURSORMADE_ROOT`
and `MG_PILOT_AIWAY_ROOT` are not configured, so the final release-run GO is pending.
