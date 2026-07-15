# Project Workspace UI: Recovery Center

## Delivered

- Added checkpoint history for the selected project and run.
- Added rollback preflight plans covering current HEAD, status fingerprint, untracked files, lockfiles and dependency-directory side effects.
- Added a deterministic plan hash bound to run, checkpoint, strategy and current recovery state.
- Recovery apply requires a persisted plan artifact and the exact reviewed hash.
- Apply recalculates the plan immediately before mutation and rejects changed state.
- Plans with blockers cannot be applied from the UI; force remains a reviewed CLI-only operation.
- Added Project History using the existing run index, task/issue summaries, readiness and checkpoint lineage.

## Safety

- Planning is read-only apart from writing the audit artifact.
- Apply is CSRF protected and requires a visible browser confirmation.
- Missing, stale, malformed, cross-run and blocked plans fail closed.
- Recovery results and rollback evidence are written under the selected migration run.

## Validation

- Checkpoint tests verify stable plan hashes and stale-plan rejection after Git state changes.
- Workspace workflow tests verify plan persistence and successful empty-patch recovery.
- UI smoke checks Recovery Center, Project History and recovery API availability.
