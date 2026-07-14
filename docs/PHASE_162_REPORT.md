# Phase 162 Report: Artifact Schema v2 Mainline Adoption

## Delivered

- Snapshot, compare and UI job writers now emit validated Artifact Schema v2 envelopes.
- All product readers unwrap v2 envelopes while preserving read-only compatibility with v1 payloads.
- Snapshot metadata records normalization operations, stable check health fingerprints and package scan summaries.
- Compare metadata records baseline/current snapshot hashes, check-health summary, policy decision and health-debt ledger decisions when available.
- UI job metadata records action, status, owner PID, retry lineage, attempt, heartbeat, lease duration and result artifact paths.
- Proposal behavior, one-shot, bootstrap, executor and issue-control snapshot/compare artifacts use the same core writer.
- Diff decisions, UI diff views, one-shot reports and proposal flows use the same v1/v2 reader.
- `artifacts migrate` now discovers snapshot, compare and UI job files and wraps v1 payloads through the existing dry-run, plan-hash and apply-confirm workflow.
- Existing early v2 envelopes without metadata remain readable and can be backfilled by migration.
- Phase 161 release pilot evidence now validates and unwraps v2 core artifacts.

## Compatibility and Safety

- Future source versions are rejected.
- Envelope kind mismatches are rejected.
- Payload hash mismatches are rejected.
- v1 files are never rewritten without explicit migration apply confirmation.
- Existing migration-run artifact schema v1 remains unchanged and continues sharing the same migration report.

## Validation

- Core artifact unit tests cover idempotency, legacy v2 metadata backfill, v1/v2 reads, kind mismatch and payload tampering.
- Mainline tests verify snapshot and compare v2 metadata.
- Artifact migration tests cover dry-run, plan hash, apply confirmation and idempotent repeat.
- UI job tests verify v2 persistence, v1 compatibility and future-version rejection.
- Bootstrap, one-shot, diff-decision and proposal tests pass with v2 artifacts.

## Artifacts

- Snapshot: `baselines/*.json`, `runs/*.json`, `latest-baseline.json`, `latest-run.json`
- Compare: `compare/*.json` and workflow-scoped compare artifacts
- UI jobs: `ui-jobs/*.json`
- Migration command output: `artifacts migrate --json` or the default text report
