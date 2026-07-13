# Phase 152 Report: Configuration Doctor and Detection

## Delivered

- Added `migration-guard doctor`.
- Added `migration-guard config validate` and `config explain`.
- Added `migration-guard init --detect`.
- Detects JavaScript package managers, workspaces, TypeScript, Vite, Webpack, Jest and Vitest.
- Detects Go, Rust and Python manifests and recommends safe checks.
- Recommends output normalization presets from project tooling.
- Reports missing check cwd, unusually short timeouts and npm `--if-present` no-op checks.
- Detection never installs dependencies or edits the target project.

## Validation

- Config doctor unit tests.
- Doctor runs against ascllcreator, cursormade and aiway pilot configurations.
- `npm test`.

Issue: #45
