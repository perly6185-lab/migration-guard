# Phase 133 Report: UI Job GC

## Summary

Phase 133 adds dry-run-first garbage collection for UI job ledgers.

## Delivered

- Added `POST /api/jobs/gc`.
- Supported bounded `keepLatest`, status filtering and dry-run/apply modes.
- Added Recent Jobs GC controls to plan or apply terminal job cleanup.
- Covered GC planning and deletion in UI server tests.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
