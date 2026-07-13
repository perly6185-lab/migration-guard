# Phase 125 Report: UI Diff Decision Workflow

Phase 125 closes the loop from seeing behavior drift in the local `serve` board
to recording a reviewed diff decision.

## Changes

- `/api/diffs` now includes decision coverage, policy status, and any existing
  decision summary for each diff row.
- Added `POST /api/actions/diff-decision` to record intentional, accidental, or
  unknown classifications from the UI.
- The diff decision endpoint only accepts compare artifacts inside the
  configured `artifactsDir`.
- Diff rows now render a decision form with classification, reason, optional
  approver, and a record button.
- Recording a decision refreshes the run-scoped diff view and shows the updated
  policy status plus the ledger artifact path.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
