# Project Workspace UI: Guarded Task Execution

## Delivered

- Expanded ready-task details with description, owner, risk, affected paths, verification commands and acceptance criteria.
- Added task execution preflight plans bound to task state, path budget, baseline, Git HEAD/status and config-derived behavior checks.
- Added stable plan hashes and persisted plan artifacts under the selected migration run.
- Rejects absolute/traversing paths, more than 50 declared paths, missing baselines, invalid task states and all high-risk tasks.
- Revalidates the task and repository immediately before execution; business-file drift invalidates the reviewed plan.
- Excludes Migration Guard's own artifact directory from Git state fingerprints and checkpoint untracked-file checks.
- Executes one task through the fenced UI job runner and creates a checkpoint before task work.
- Automatically captures a verification snapshot, compares it to baseline and records health-debt decisions.
- Returns accepted or verification-failed without continuing to another task.
- Direct retry of task-execution jobs is forbidden; every attempt requires a fresh reviewed plan.

## Safety Boundaries

- High-risk tasks remain CLI/human-supervised only.
- The UI does not accept arbitrary commands or undeclared paths.
- Non-engine owners are surfaced as warnings for explicit review.
- Regression or changed-failure evidence stops the task workflow after the current attempt.

## Validation

- A real Git fixture verifies accepted low-risk execution with checkpoint and compare evidence.
- Repository drift after review rejects the stale plan.
- High-risk execution is rejected before mutation.
- Full suite floor increased to 150 tests.
