# Phase 153 Report: Health Debt and Regression Budget

## Delivered

- Added stable fingerprints for inherited check failures.
- Added the versioned health debt ledger under `artifactsDir/health-debt/ledger.json`.
- Tracks new, accepted, recovered and expired debt.
- Added `health-debt list` and `health-debt accept` commands.
- Added `verify --health-budget strict` to block new or expired debt.
- Changed failures and regressions remain compare failures and cannot reuse inherited debt acceptance.

## Validation

- Health debt unit tests cover new, accepted and recovered states.
- Compare tests cover inherited and changed failure separation.
- `npm test`.

Issue: #46
