# Project Workspace UI v1: First Usable Slice

## Delivered

- Added a versioned, atomically written UI workspace registry under the host artifact directory.
- Added project records for name, source root, target root, goal, config, active run, stack detection and lifecycle state.
- Added read-only project preview with directory, Git, existing-config, language, package-manager, confidence and check detection.
- Rejects missing directories, duplicate targets, identical roots and nested source/target roots.
- Added project list, preview, create, select and archive APIs protected by the existing CSRF boundary.
- Project creation preserves existing target configs; otherwise it writes the detected config after confirmation.
- Project creation generates an initial dry-run migration run and selects the new project.
- Dashboard, jobs, diffs, reports and guarded actions resolve against the selected project config.
- Server startup and project selection recover orphan jobs for the active project.
- Added a responsive project selector and New Project dialog to the first viewport.

## Safety

- This slice accepts existing local directories only; it does not clone, pull, push or install dependencies.
- Registration never copies or edits source repository files.
- Archiving changes registry state and does not delete project directories or evidence.
- Mutation-capable remote Git operations remain outside the UI.

## Validation

- Workspace tests cover path overlap, detected config creation, initial run creation, duplicate registration, selection and archive preservation.
- Full test suite: 27 files and 148 tests passed.
- UI smoke validates Workspace HTML/API and requires newly written desktop and mobile screenshots.
