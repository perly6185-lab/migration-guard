# Phase 144 Report: Package and Release Readiness

## Summary

Added release-package controls and installation-level verification.

## Delivered

- Added npm package file allowlist and package metadata.
- Reduced the dry-run package from 404 files / 4.1 MB unpacked to 92 files / about 185 KB tarball size.
- Added `npm run package:smoke`, which packs, installs and invokes the CLI in an isolated directory.
- Expanded CI to Node 20 and Node 22 on Ubuntu and Windows.
- Added UI smoke to every CI matrix lane and package smoke to the Node 22 Ubuntu lane.

## Validation

- `npm run package:smoke`
- isolated `migration-guard --help`
- isolated `migration-guard init --target fixture`
