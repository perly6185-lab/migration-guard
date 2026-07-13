# Phase 137 Report: UI Job Duplicate Guard

## Summary

Phase 137 prevents accidental duplicate active jobs for the same action parameters.

## Delivered

- Added active duplicate detection for queued/running jobs.
- Rejected duplicate job creation with `409`.
- Normalized readiness jobs to the resolved run id before duplicate comparison.
- Covered duplicate guard behavior in UI server tests.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
