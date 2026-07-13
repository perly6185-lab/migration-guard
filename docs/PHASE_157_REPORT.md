# Phase 157 Report: UI Job Lease and Heartbeat

## Delivered

- Claim files are now JSON leases with owner PID, hostname, acquisition time, heartbeat and lease duration.
- Running UI jobs renew their heartbeat every ten seconds.
- Added claim inspection with expiration calculation.
- Lease heartbeat validates process ownership.
- Existing exclusive claim and recovery behavior remains compatible.

## Validation

- UI job store claim, inspection, heartbeat and release tests.
- UI server tests.
- `npm test`.

Issue: #50
