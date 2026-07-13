# Phase 151 Report: CI and Dependency Baseline

## Delivered

- Upgraded checkout and setup-node actions to v5 to remove deprecated action runtime warnings.
- Kept the Node 20/22 and Windows/Ubuntu matrix.
- Added shared `scripts/ci/run-tests.mjs` test execution with GitHub step summary timing output.
- Added `git diff --check` to every CI lane.
- Added production dependency audit to the Node 22 Ubuntu lane.
- Added npm package content audit and isolated installation smoke to the release lane.
- Pinned TypeScript and Node type definitions to exact versions.

## Validation

- `npm test`
- `npm run ui:smoke`
- `npm run package:audit`
- `npm run package:smoke`
- `npm audit --omit=dev --audit-level=high`
- `git diff --check`

Issue: #44
