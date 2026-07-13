# Phase 124 Report: UI Artifact Viewer

Phase 124 makes local evidence paths inspectable from the `serve` board without
turning the UI server into a general file browser.

## Changes

- Added `/api/artifact?path=<artifact-path>` for viewing text artifacts from the
  configured `artifactsDir`.
- The endpoint rejects missing paths, non-files, oversized files, and paths
  outside `artifactsDir`.
- Evidence paths, diff report paths, proposal verification paths, and action
  result artifact paths now render as browser links when they look like local
  artifacts.
- The UI smoke script verifies that `/api/artifact` rejects paths outside the
  artifact root.

## Validation

- `npm run build`
- `node --test dist/core/uiServer.test.js`
- `npm run ui:smoke`
- `npm test`
