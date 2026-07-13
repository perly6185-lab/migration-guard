# Phase 132 Report: UI Write Safety

## Summary

Phase 132 hardens UI write actions with a per-server CSRF token and JSON body support.

## Delivered

- Added `GET /api/session` for the UI session token.
- Required `x-migration-guard-csrf` on POST requests.
- Added JSON body parsing for UI write routes while keeping query-string compatibility.
- Updated board write actions to send JSON bodies.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
