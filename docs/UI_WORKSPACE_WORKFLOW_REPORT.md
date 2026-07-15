# Project Workspace UI: Workflow Actions

## Delivered

- Added an active-project overview with name, goal, source, target, detected stack and configured checks.
- Added explicit progress for registration, scan, baseline, verification and recovery checkpoint evidence.
- Added Scan Project, Capture Baseline, Verify Changes and Create Checkpoint to the first workflow panel.
- Routed all four operations through the existing UI job lease, fencing, heartbeat, retry and recovery machinery.
- Scan writes a project inventory artifact; baseline and verify write Artifact Schema v2 snapshots.
- Checkpoint records Git state, patch evidence and side-effect metadata against the active migration run.
- Project switching changes the config used by dashboard, jobs, diffs, reports and workflow actions.

## Validation

- Workflow tests execute scan, baseline and checkpoint jobs and verify persisted project progress.
- Full suite: 27 discovered files and 149 tests passed.
- Desktop and mobile UI smoke screenshots contain the Project Workflow controls without overlap.
