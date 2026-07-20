# Work Issues

Updated: 2026-07-20

This list tracks the work required to move the current `0.3.0-beta.1`
workspace from locally validated development changes to a reviewable release
candidate. Remote publication, Git tags and GitHub mutation remain manual.

## MG-191 through MG-201: Full Java-to-Rust endpoint replacement

- Priority: P0
- Status: planned; remote Epic [#63](https://github.com/perly6185-lab/migration-guard/issues/63)
  and child issues [#64](https://github.com/perly6185-lab/migration-guard/issues/64)
  through [#73](https://github.com/perly6185-lab/migration-guard/issues/73) are open
- Goal: prove that a selected Java endpoint can be served directly by Rust with
  no callback into the migrated Java controller, application method, or Java-owned
  post-step.
- MG-192 adds Rust inventory, routes, Cargo checks, and the Java-to-Rust recipe.
- MG-193 adds a fail-closed replacement closure manifest.
- MG-194 and MG-195 make runtime context and ordered side effects explicit.
- MG-196 upgrades golden cases from pure-kernel extraction to full target ownership.
- MG-197 and MG-198 add runtime drivers and stateful replay comparison.
- MG-199 verifies deterministic concurrency, lease, crash, and fault semantics.
- MG-200 adds FR1-FR5 readiness and a source-off cutover gate.
- MG-201 validates the model on the zboss `/refreshSync` endpoint.
- Safety boundary: stateful replay uses isolated fixtures; production routing,
  remote issue creation, publishing, and releases remain reviewed manual operations.
- Detailed plan: [FULL_REPLACEMENT_JAVA_RUST_ISSUES.md](FULL_REPLACEMENT_JAVA_RUST_ISSUES.md).

## MG-180: Execute verified TypeScript method extraction end to end

- Priority: P0
- Status: completed
- Scope: extend the planning-only `method-refactor` adapter with TypeScript AST
  eligibility analysis, data-flow contracts, atomic source patches, generated
  contract tests, temporary verification, rollback and layered execution.
- Safety boundary: Version 1 supports only statically provable TypeScript statement
  ranges. Unsupported or ambiguous control/data flow blocks without source mutation.
- Delivery order: MG-180A/B read-only analysis; MG-180C patch generation; MG-180D/E
  contract and temporary verification; MG-180F reviewed apply; MG-180G call-chain execution.
- Acceptance: a supported extraction must pass compiler, test, build and behavior
  comparison gates; failures reject apply or restore the exact checkpoint.
- Detailed plan: [METHOD_REFACTOR_EXECUTION_ISSUE.md](METHOD_REFACTOR_EXECUTION_ISSUE.md).
- Remote tracking: epic [#55](https://github.com/perly6185-lab/migration-guard/issues/55),
  development issues [#56](https://github.com/perly6185-lab/migration-guard/issues/56)
  through [#62](https://github.com/perly6185-lab/migration-guard/issues/62).
- Evidence: implementation commit `5ad3b33`; 227/227 tests passed before merge.

## MG-181 through MG-190: Method automation and evaluation

- MG-181 (P0, completed): align work status, operator documentation and changelog
  with the shipped MG-180 execution boundary.
- MG-182 (P0, in progress): execute repeatable real-repository pilots for a plain
  function, an async class method and a three-layer call chain, including drift,
  failed-check and behavior-change rollback cases.
- MG-183 (P0, in progress): produce clean-checkout test, beta readiness, package,
  desktop and release-gate evidence for the automation release.
- MG-184 (P0, implemented, validation in progress): rank bounded AST extraction
  candidates and write stable JSON/Markdown suggestions without mutation.
- MG-185 (P1, implemented, validation in progress): propose deterministic,
  conflict-free extracted names from calls, values, validation and method context.
- MG-186 (P0, implemented, validation in progress): bind candidates to AST kind,
  normalized text and adjacent-statement fingerprints; relocate line-only drift
  and reject semantic drift or ambiguity.
- MG-187 (P0, implemented, validation in progress): provide an idempotent method
  extraction session with explicit states, one next action and restart-safe ledger.
- MG-188 (P1, implemented, validation in progress): enforce manual, supervised and
  unattended apply policies with progressively stricter automatic-mutation budgets.
- MG-189 (P1, implemented, validation in progress): report behavior confidence,
  structural improvement and operational risk as separate decisions.
- MG-190 (P2, implemented, validation in progress): run optional coverage,
  mutation, benchmark, memory, bundle and API-compatibility commands; missing gates
  are `not-evaluated`, and missing or failed required gates roll back the apply.

Detailed implementation and release evidence will be recorded in
[METHOD_AUTOMATION_181_190_REPORT.md](METHOD_AUTOMATION_181_190_REPORT.md).

## MG-179: Expose operational troubleshooting through the Node CLI

- Priority: P1
- Status: completed
- Scope: provide scriptable diagnostics for configuration, runs, blockers,
  artifacts, local UI service ports and persisted UI jobs.
- Acceptance:
  - `troubleshoot` aggregates causes and recommended next commands without mutation.
  - Job list/inspect/recovery/cancel/retry/GC workflows are available from the CLI.
  - Recovery and GC are plan-first; cancellation and retry require explicit job-id confirmation.
  - Artifact and serve diagnostics support CI-friendly JSON output and exit codes.
- Evidence: focused diagnostics and orphan recovery tests pass; all commands are
  registered in the public CLI catalog and documented in the operator guide.
  The full suite passes with the manifest floor raised to 184 tests.

## MG-176: Make desktop work-view navigation deterministic

- Priority: P1
- Status: completed
- Scope: preserve URL-selected views through asynchronous workspace loading and
  verify that desktop smoke captures the requested view.
- Acceptance:
  - `?view=execution|monitoring|reports` remains active after data loads.
  - A user-selected tab remains active across refreshes during the session.
  - UI smoke fails when the requested desktop view is not active.
- Evidence: desktop screenshots for Workspace, Execution, Monitoring and Reports
  are asserted pairwise distinct; updated UI smoke passed on 2026-07-18.

## MG-177: Reduce desktop workspace first-screen density

- Priority: P1
- Status: completed
- Scope: keep the current workflow action and primary blocker visible while
  collapsing secondary run metadata, history and additional blockers.
- Acceptance:
  - The current step and its primary action remain immediately visible.
  - Only the highest-priority blocker is expanded initially.
  - Run details and project history remain available without dominating the page.
- Evidence: desktop review confirms the current step and primary blocker remain
  visible while secondary blockers, run details and history are collapsed.

## MG-178: Separate advanced and high-impact controls

- Priority: P1
- Status: completed
- Scope: move expert execution controls behind progressive disclosure and retain
  explicit confirmation for recovery execution.
- Acceptance:
  - Advanced guarded actions are collapsed by default.
  - Recovery execution presents an impact warning before applying a reviewed plan.
  - Unit and UI smoke tests cover both controls.
- Evidence: advanced guarded actions are collapsed in the Execution view; the
  existing recovery impact confirmation is covered by unit and smoke assertions.
  The full suite passed 182/182 tests on 2026-07-18.

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
