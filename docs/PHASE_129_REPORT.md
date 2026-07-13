# Phase 129 Report: UI Job Retry

## Summary

Phase 129 adds a guarded retry path for failed UI action jobs. Operators can retry a failed job from the Recent Jobs panel without re-entering parameters, while the retry remains auditable through `retryOf`.

## Delivered

- Added `POST /api/jobs/:jobId/retry` for failed jobs.
- Reused the previous job's action and parameters for retry creation.
- Re-ran action capability checks before creating a retry job.
- Added `retryOf` to job ledgers and queued retry events.
- Rendered Retry controls for failed jobs in the operator board.
- Covered retry rejection for non-failed jobs and retry creation for failed jobs.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
