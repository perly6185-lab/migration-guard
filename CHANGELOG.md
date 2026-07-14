# Changelog

## Unreleased

- Bind release gates and real-project pilots to a shared release run and context hash.
- Reject skipped, missing, stale, mutated or historical pilot evidence from GO reports.
- Add resumable release evidence manifests covering tests, package, install and pilot gates.
- Write snapshot, compare and UI job artifacts through validated v2 envelopes while preserving v1 reads.
- Extend artifact migration dry-runs and apply-confirm plans to core artifacts and metadata.

## 0.2.0-rc.1 - 2026-07-13

- Classify check health as healthy, inherited failure, regression, changed failure, recovered or missing.
- Add Webpack, Jest, pnpm and Go output normalization presets.
- Add workspace package summaries and improved test-file association to scans.
- Add cross-process UI job claims, owner PID recovery guards and artifact safety denylist.
- Add portable three-project pilot configuration and release-candidate validation.
