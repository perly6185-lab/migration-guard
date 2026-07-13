# Phase 136 Report: UI Job Recovery

## Summary

Phase 136 recovers orphan UI jobs left behind by a previous server process.

## Delivered

- Recovered old queued jobs to `cancelled` on startup.
- Recovered old running jobs to `failed` on startup.
- Added `recovered` job timeline events.
- Covered startup recovery in UI server tests.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
