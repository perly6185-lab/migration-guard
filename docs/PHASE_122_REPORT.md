# Phase 122 Report: Local UI Operator Controls

Phase 122 turns the local `serve` board from a passive artifact view into a
safer operator surface for choosing a run, understanding blockers, and running
guarded local actions.

## Changes

- Added run-scoped dashboard, blocker, and diff queries to the UI server.
- Added `/api/actions/capabilities` so the browser can disable actions before
  missing configuration turns into a failed click.
- Added guarded action parameter inputs for GitHub repo, labels, and maximum
  issue-control dry-run iterations.
- Added Run Detail, expandable task/proposal summaries, blocker evidence,
  copyable next-action commands, and diff filters.
- Added `scripts/smoke/ui-server-smoke.mjs` plus `npm run ui:smoke` for a
  dependency-free HTML/API smoke check with optional Chrome screenshots.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm test`
- `npm run ui:smoke`

The smoke script writes screenshots to the system temp directory by default, or
to `MG_UI_SMOKE_OUTPUT_DIR` when set.
