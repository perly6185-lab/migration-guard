# Release Checklist 0.2.0 RC

## Automated gates

- [ ] `npm ci` from a clean checkout (CI pending)
- [x] `npm test` locally on Node 22; Node 20 is covered by CI matrix
- [ ] Windows and Ubuntu CI lanes pass (CI pending)
- [x] `npm run ui:smoke` passes
- [x] `npm run package:smoke` passes
- [x] `npm run pilot:smoke` executes configured pilots or reports explicit skips
- [x] `npm pack --dry-run` contains no source, tests, pilot logs or internal phase reports
- [x] `git diff --check` passes

## Pilot gates

- [x] pnpm workspace pilot has zero unclassified differences
- [x] VS Code extension pilot has zero unclassified differences
- [x] Go pilot has zero unclassified differences
- [x] Inherited failures are visible and do not mask regressions
- [x] Changed failures block verification

## Publish gates

- [x] Version is `0.2.0-rc.1`
- [x] CHANGELOG and known limitations are current
- [ ] Fresh install completes `init -> scan -> baseline -> verify -> serve`
- [ ] npm publish remains a reviewed manual action

## Go / No-Go

Release is GO only when every automated gate passes and all configured pilots produce passed compare reports.
