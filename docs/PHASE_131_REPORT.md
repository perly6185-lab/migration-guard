# Phase 131 Report: Queued UI Job Cancel

## Summary

Phase 131 adds queue control for UI jobs. Newly created jobs remain queued briefly before execution and can be cancelled before they start.

## Delivered

- Added `cancelled` job status and event type.
- Added `POST /api/jobs/:jobId/cancel`.
- Updated the runner to re-check job status before starting.
- Added Cancel actions for queued jobs in Recent Jobs.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
