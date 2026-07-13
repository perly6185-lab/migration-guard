# Phase 128 Report: UI Job Filters and Auto-Refresh

## Summary

Phase 128 makes the operator board's job ledger easier to monitor. The jobs API now supports filtering, and the Recent Jobs panel refreshes itself while work is active.

## Delivered

- Added `/api/jobs` filters for `status`, `run`, and bounded `limit`.
- Returned job list metadata: applied filters, total job count, and active job count.
- Added Recent Jobs status and run filters to the UI.
- Auto-refreshed Recent Jobs while queued or running jobs exist.
- Extended tests and smoke coverage for job filtering and UI controls.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
