# Release Checklist 0.3.0-beta.1

## Automated Evidence

- [ ] Clean checkout is on the intended beta commit.
- [ ] `npm test` passes at or above the 157-test floor.
- [ ] `npm run beta:readiness` reports GO with a stable report hash.
- [ ] Package golden path covers single TypeScript, pnpm monorepo, Go and Python.
- [ ] Handoff create, result dry-run/apply, rejection and idempotency tests pass.
- [ ] Failure repair converges through replan/retry/local verification.
- [ ] Worker fencing rejects stale owner heartbeats and results.
- [ ] UI, package audit, package smoke and install smoke pass.
- [ ] All three configured real-project pilots execute in the same release run.
- [ ] Release evidence and tarball inventory bind the clean commit and version.

## Manual Review

- [ ] Review handoff/result compatibility matrix and beta known issues.
- [ ] Recreate and hash the tarball from the bound commit.
- [ ] Publish `0.3.0-beta.1` manually; automation must not publish or tag.
- [ ] Run post-publish `npx migration-guard@0.3.0-beta.1 --help`.
- [ ] Create annotated `v0.3.0-beta.1` tag and GitHub prerelease manually.
- [ ] Deprecate rather than overwrite a broken beta version.
