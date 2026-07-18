# Completed Work Issues

Updated: 2026-07-18

This list tracks the work required to move the current `0.3.0-beta.1`
workspace from locally validated development changes to a reviewable release
candidate. Remote publication, Git tags and GitHub mutation remain manual.

## MG-171: Close the current core-refactor change set

- Priority: P0
- Status: completed
- Scope: CLI registry, issue-control module split, command execution hardening,
  self-refactor foundation, CI and smoke coverage.
- Acceptance:
  - `git diff --check` passes.
  - `npm test` passes with the manifest floor enforced.
  - `npm run beta:readiness` reports GO.
  - `npm run package:golden` passes all four installed-package fixtures.
  - Public CLI commands, runtime exports and artifact compatibility remain stable.
- Current evidence:
  - `git diff --check`: passed on 2026-07-18; CRLF conversion warnings only.
  - Final clean-candidate suite: 182/182 tests passed.
  - `npm run beta:readiness`: GO, 10/10 checks passed; report hash
    `93bbd1e414bc9661d8adc3476697031c10d15631160af41694765469c327e66a`.
  - `npm run package:golden`: four fixtures passed; evidence run
    `golden-2026-07-18T01-47-31-485Z-308a94b0`.
  - Sync-gate policy extraction: public API and Issue Control integration tests
    passed; the final manifest floor is 182 tests.

## MG-172: Validate self-refactor against a clean immutable driver

- Priority: P1
- Status: completed
- Scope: create a clean driver tarball, generate a bounded issue-control plan,
  execute one reviewed extraction task, cross-validate the candidate and produce
  a manual promotion handoff.
- Acceptance:
  - Driver evidence is bound to a clean commit and tarball hash.
  - Execution stays within the changed-file budget and introduces no dependency
    cycles or runtime export drift.
  - Stable-driver checks and candidate cross-validation pass.
  - Rollback evidence is retained and promotion remains manual.
- Current evidence:
  - Clean validation commit: `eaf29198b57173e0576b160cfeecf3caeb8ed732`.
  - Driver: `driver-1784341150974-07fdbbca`.
  - Driver/candidate tarball hash:
    `53a608cee4c89a911d14d2d07834a0f0cd5bb73d812f74d5698b670e68dec101`.
  - Passing run: `self-refactor-run-1784341167156-59ef7ffb`.
  - Passing cross-validation: `self-refactor-cross-1784341225530-3010db32`.
  - Promotion handoff: `self-refactor-promotion-1784341245132-3eeb7035`;
    status `ready-for-review`, publish and tag remain manual.

## MG-173: Complete real-project beta pilots

- Priority: P0
- Status: completed
- Required inputs: `MG_PILOT_ASCLLCREATOR_ROOT`,
  `MG_PILOT_CURSORMADE_ROOT` and `MG_PILOT_AIWAY_ROOT`.
- Acceptance:
  - All three pilots execute in the same release run without skipped, stale or
    historical evidence.
  - Pilot fingerprints, configuration hashes and artifact hashes validate.
  - The full `npm run release:gate` reports GO.
- Current evidence:
  - Release run `release-2026-07-18T02-20-54-944Z-1320ba15` executed all
    three configured projects in the same evidence ledger.
  - Three projects passed, none skipped, with zero behavior differences,
    regressions or changed failures.

## MG-174: Review issue-control extraction completeness

- Priority: P1
- Status: completed
- Scope: keep `issueControl.ts` as the compatibility orchestration entry point
  while policy, rendering, artifact persistence and execution live in bounded
  modules under `src/core/issueControl/`.
- Acceptance:
  - No pure policy or renderer depends on filesystem, command execution or CLI.
  - Existing public exports, CLI output, paths and plan hashes remain compatible.
  - Characterization and boundary tests cover every extracted responsibility.
- Current evidence:
  - Sync classification, run routing and reviewed command construction moved to
    `src/core/issueControl/syncGatePolicy.ts`.
  - Duplicate issue ids, terminal-state classification, run precedence and shell
    quoting have focused tests.
  - `issueControl.ts` remains the compatibility orchestration entry point and its
    runtime public API test is unchanged.
  - `issueControl.ts` is reduced to 1,842 lines; pure policy, rendering,
    persistence, execution, recovery and safety responsibilities are separated.

## MG-175: Prepare the reviewed beta release handoff

- Priority: P2
- Status: completed
- Scope: review changelog and known issues, generate the final evidence manifest
  and tarball hash, and prepare commands for npm publish, tag and GitHub release.
- Acceptance:
  - Release evidence is tied to a clean commit, current configuration and current
    pilot artifacts.
  - Package, install-mode, UI and golden-path smoke tests pass.
  - Publishing, tagging and remote release mutation require explicit human review.
- Current evidence:
  - Full clean-checkout release gate passed for `0.3.0-beta.1`.
  - Evidence manifest: release run
    `release-2026-07-18T02-20-54-944Z-1320ba15` under the validation
    workspace's `.migration-guard/releases/` directory.
  - Candidate and publish handoff are stored beside the release evidence.
  - No npm publication, Git tag or GitHub mutation was executed.

## Completed Execution Order

1. MG-171: finish and review the current local change set.
2. MG-173: configure and execute the three real-project pilots.
3. MG-172 and MG-174: prove the self-refactor and module-boundary workflow on a
   clean driver.
4. MG-175: produce the reviewed beta release handoff.
