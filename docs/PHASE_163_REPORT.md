# Phase 163 Report: Installed Golden Path and Config Detection Closure

## Delivered

- Added an installed-package golden path smoke that packs the current project, installs it into an isolated temp project and drives the published CLI.
- Covered four first-use fixtures: single-package TypeScript, pnpm workspace, Go module and Python package.
- Changed `init --detect` to preview generated config by default and require explicit `--apply` before writing `.migration-guard.json` or `.migration-guard/`.
- Added config detection metadata for target root, package manager, detected languages, confidence, source files and skipped suggestions.
- Kept config generation read-only for target `package.json`, dependencies and business source files.
- Hardened `doctor` with diagnostics for no-op checks, missing cwd, unresolved variables, missing check executables and artifact directory permission failures.
- Added a behavior evidence fallback for `report`, so baseline/verify compare results can be summarized without a migration-run package.
- Switched the generated Python check to AST parsing to avoid `__pycache__` drift during first-use verify.

## Validation

- `npm test`: 137 tests passed.
- `npm run package:golden`: 4 fixtures passed from empty Migration Guard config to no-change verify.
- Golden path smoke asserted that preview mode writes no config, apply output matches preview config and business files remain unchanged.
- Latest golden path run: `golden-2026-07-14T13-15-44-675Z-b45db286`.

## Artifacts

- `.migration-guard/golden-path/<runId>/golden-path.json`
- `.migration-guard/golden-path/<runId>/golden-path.md`
- `scripts/smoke/golden-path-smoke.mjs`
