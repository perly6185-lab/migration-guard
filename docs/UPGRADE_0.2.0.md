# Upgrade to 0.2.0

## From 0.2.0-rc.1

1. Run `migration-guard doctor --upgrade`.
2. Run `migration-guard artifacts migrate` without `--apply`.
3. Review the migration plan and plan hash.
4. Apply only after review.
5. Capture a fresh baseline before continuing migration work.

## From 0.1.x

- Keep the existing `.migration-guard.json`; schema version 1 remains supported.
- Review inherited failures through `health-debt list` before enabling strict budget mode.
- Existing artifacts remain readable; use the migration dry-run before any schema conversion.
- Node 20 or newer is required.

Publishing and tag creation remain manual reviewed operations.
