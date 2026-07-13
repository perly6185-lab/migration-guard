# Phase 150 Report: 0.2.0 Release Candidate

## Delivered

- Set package version to `0.2.0-rc.1`.
- Added CHANGELOG and RC release checklist.
- Pilot roots use environment variables and missing roots produce explicit skips.
- Added a third Go project pilot alongside pnpm workspace and VS Code extension pilots.
- Package smoke validates an isolated install and CLI initialization.

## Pilot Findings

- ascllcreator: two healthy checks, one inherited failure, zero differences.
- cursormade: two healthy checks, one inherited failure, zero differences.
- aiway full tests exposed a genuine changed failure and were correctly blocked.
- aiway deterministic compile lane preserves one inherited vet failure and stable passing compile checks.

## Validation

- `npm test`
- `npm run ui:smoke`
- `npm run package:smoke`
- `npm run pilot:smoke`
- `git diff --check`
