# Phase 156 Report: Core Artifact Schema v2

## Delivered

- Added a versioned v2 envelope for snapshot, compare and UI job artifacts.
- Preserves v1 payloads for read-only compatibility.
- Adds source version, migration timestamp and stable payload hash.
- Migration is idempotent for existing v2 envelopes.
- Future source versions and hash mismatches are rejected.

## Validation

- Artifact v2 idempotency and validation tests.
- Existing v1 artifact tests remain unchanged.

Issue: #49
