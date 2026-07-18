# Core Module Boundaries

## Dependency Direction

```text
CLI entry and command handlers
  -> orchestration services
       -> domain models
            -> artifact repositories and external adapters
```

Dependencies point inward. Domain models may depend on shared types and pure helpers, but do not read configuration, execute commands, mutate Git, or write artifacts. Artifact repositories and external adapters implement IO requested by orchestration; they do not depend on CLI handlers.

During the incremental split, `issueControl.ts` and `patch.ts` remain compatibility entry points. New implementation modules live below `issueControl/` and `proposal/`, and their `index.ts` files preserve the existing public exports until callers have migrated.

## Responsibilities

| Module | Owns | Must not own |
| --- | --- | --- |
| `cliDispatch.ts` | Command-to-handler lookup | CLI parsing, output rendering, business logic |
| `cliRegistry.ts` | Canonical top-level command catalog and registry validation | Command implementation or argument parsing |
| `issueControlModel.ts` | Remote metadata parsing and deterministic plan routing | GitHub requests, execution, artifact writes |
| `issueControl.ts` | Pull, supervision, recovery and artifact orchestration | New parsing/selection rules that can be pure |
| `issueControl/audit.ts` | Append-only unattended audit log paths and writes | Scheduling or safety decisions |
| `issueControl/recoveryArtifacts.ts` | Recovery JSON/Markdown artifact persistence | Recovery classification or execution |
| `issueControl/recoveryRender.ts` | Pure recovery Markdown rendering | Filesystem writes or recovery execution |
| `issueControl/githubConfig.ts` | Resolve and validate the configured GitHub repository | GitHub requests or orchestration |
| `issueControl/renderHelpers.ts` | Pure Markdown cell escaping | Report selection or artifact writes |
| `issueControl/basicRender.ts` | Pure pull and plan Markdown rendering | Artifact writes or orchestration |
| `issueControl/basicArtifacts.ts` | Pull report JSON/Markdown persistence | Pull selection or remote requests |
| `issueControl/executionRender.ts` | Pure run and auto Markdown rendering | Artifact writes or execution orchestration |
| `issueControl/executionArtifacts.ts` | Run and auto report JSON/Markdown persistence | Execution selection or command dispatch |
| `issueControl/progressRender.ts` | Pure progress-status Markdown rendering | Progress decisions or artifact writes |
| `issueControl/supervisionRender.ts` | Pure supervise report and progress-ledger Markdown rendering | Supervision decisions or artifact writes |
| `issueControl/supervisionArtifacts.ts` | Supervise, ledger and progress JSON/Markdown persistence with injected construction/rendering | Ledger policy, supervision or execution decisions |
| `issueControl/advanceRender.ts` | Pure advance, loop, scheduler and sync-gate Markdown rendering | Scheduling decisions or artifact writes |
| `issueControl/advanceArtifacts.ts` | Stateless advance, scheduler and sync-gate JSON/Markdown persistence | Loop-state calculation or scheduling decisions |
| `issueControl/advanceLoopArtifacts.ts` | Advance-loop report and state persistence with injected state construction | Ledger safety evaluation or scheduler policy |
| `issueControl/advanceLoopPolicy.ts` | Pure repeat-guard, next-action and scheduler decisions | Filesystem access or report persistence |
| `issueControl/selectionPolicy.ts` | Pure auto/supervise selection, trust-tier and risk-budget policy | Execution, filesystem access or artifact writes |
| `issueControl/safetyPolicy.ts` | Pure ledger safety envelope, failed-check and adaptive-gate policy | Git checks, filesystem access or artifact writes |
| `issueControl/progressPolicy.ts` | Pure progress report, automation decision, next-action and command reconstruction policy | Ledger discovery, filesystem access or artifact writes |
| `issueControl/supervisionProgress.ts` | Pure supervise progress-ledger, item-state, event and artifact-path mapping | Supervision execution or persistence |
| `issueControl/planExecution.ts` | Dispatch and execute one guarded issue-control plan item | Selection, batching or report persistence |
| `issueControl/recoveryPolicy.ts` | Pure recovery classification, evidence collection, strategy selection and plan construction | Recovery execution, behavior checks or artifact writes |
| `issueControl/recoveryExecution.ts` | Execute one recovery strategy or repair agent with an injected behavior-diff guard | Recovery classification, supervision flow or artifact persistence |
| `issueControl/verificationService.ts` | Shared baseline/run snapshot comparison and verification artifact production | Recovery or supervision policy decisions |
| `issueControl/watchdog.ts` | Roll back a failed supervised iteration to its latest checkpoint | Verification or recovery policy |
| `issueControl/safetyIo.ts` | Read target repository cleanliness for the safety envelope | Trust-tier or selection policy |
| `issueControl/supervisionSafety.ts` | Assemble the supervise safety envelope from target, baseline and control evidence | Supervision execution or artifact writes |
| `issueControl/recommendations.ts` | Pure run, auto and supervise recommended-next-action generation | Execution or artifact writes |
| `issueControl/syncGatePolicy.ts` | Pure sync classification, run routing and reviewed command construction | Ledger discovery, artifact writes or GitHub mutation |
| `patchModel.ts` | Portable patch paths and deterministic patch text | Filesystem writes, checks, rollback |
| `patch.ts` | Proposal lifecycle, checks, batch execution and artifacts | New deterministic patch primitives |
| `selfRefactor.ts` | Structural inventory, bounded plans and immutable driver evidence | Candidate source edits or self-approval |
| `selfRefactorExecution.ts` | Checkpoint evidence, bounded checks, tarball cross-validation and promotion handoff | Publishing, tagging or unconfirmed promotion |

## Split Invariants

- Runtime exports from `issueControl.ts` and `patch.ts` remain stable while implementation moves.
- CLI command names, aliases, exit codes and JSON/text output remain compatible.
- Artifact paths, JSON schemas, plan-hash inputs and rendered Markdown are compatibility surfaces.
- Domain/model modules must not import Node filesystem/process APIs, configuration loaders, or orchestration entry points.
- The existing type-only `issueControlModel.ts -> issueControl.ts` dependency is transitional and must move to `issueControl/types.ts` in the type-extraction PR.
- A structural move must not include unrelated behavior changes.

## Test Layers

- Unit: deterministic module behavior with no cross-process workflow.
- Integration: filesystem, Git, child process or multi-module workflow behavior.
- Smoke: installed package and operator UI workflows, run through explicit scripts.
- Pilot: behavior evidence against configured real projects, required by the release gate.

`scripts/ci/test-manifest.json` prevents accidental loss of discovered test files or test cases. New compiled `*.test.js` files enter `npm test` automatically.
