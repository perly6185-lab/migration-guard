# Phase 126 Report: UI Action Job Ledger

## Summary

Phase 126 moves operator-board write actions from synchronous button waits to an auditable job workflow. The board now creates action jobs, polls job status, shows recent jobs, and links any produced artifacts through the existing artifact endpoint.

## Delivered

- Added `POST /api/jobs/actions/:action` for `readiness`, `verify`, and `issue-control-dry-run`.
- Added `GET /api/jobs` and `GET /api/jobs/:jobId` for recent job inspection and polling.
- Persisted job ledgers under `artifactsDir/ui-jobs/*.json` with status, timestamps, parameters, result, error, and artifact paths.
- Kept capability checks before job creation, returning `409` when an action is unavailable.
- Updated the operator board to queue jobs, poll until completion, and render a Recent Jobs panel.
- Preserved the legacy synchronous `/api/actions/*` endpoints for compatibility.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
