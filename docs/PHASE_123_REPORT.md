# Phase 123 Report: UI Action Server Guards

Phase 123 closes the gap between UI affordances and server behavior. The local
operator board already asks `/api/actions/capabilities` before enabling action
buttons; now the POST endpoints enforce the same capability checks.

## Changes

- Added server-side capability enforcement for readiness, verification snapshot
  capture, and issue-control dry-run actions.
- Unavailable actions now return HTTP `409` with the action capability and
  human-readable reason instead of falling through to a generic failure.
- Issue-control dry-run uses validated positive integer parsing for
  `maxIterations` after the capability gate passes.
- Added tests for stale/missing run readiness requests, missing GitHub repo
  dry-runs, and invalid max-iteration dry-runs.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`

Full suite validation remains expected before release:

- `npm test`
- `npm run ui:smoke`
