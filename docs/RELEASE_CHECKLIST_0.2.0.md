# Release Checklist 0.2.0

## Bound automated gates

- [ ] Clean checkout is on the intended GA commit and `package.json` is `0.2.0`.
- [ ] `npm test`, UI smoke, package audit and package smoke pass.
- [ ] Installed-package golden path passes for TypeScript, pnpm workspace, Go and Python.
- [ ] Local tarball, `npx` and global installation modes pass.
- [ ] All three real-project pilots execute in this release run and report GO.
- [ ] `git diff --check` passes.
- [ ] `ga-candidate.json` records the tarball inventory, sizes and SHA-256.
- [ ] Release evidence is bound to a clean commit and every gate is passed.

## Manual publish review

- [ ] Recreate the tarball from the bound commit and verify its SHA-256.
- [ ] Review `PUBLISH_HANDOFF.md`; do not publish or tag from automation.
- [ ] Publish npm package, then run a post-publish `npx migration-guard@0.2.0 --help` smoke.
- [ ] Create and push the annotated `v0.2.0` tag.
- [ ] Create the GitHub Release and attach or link the release evidence.
- [ ] If post-publish smoke fails, deprecate the version and prepare a patch; never overwrite `0.2.0`.
