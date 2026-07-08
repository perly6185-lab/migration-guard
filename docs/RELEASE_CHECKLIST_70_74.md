# Release Checklist: Phases 70-74

生成日期：2026-07-08

## 1. Release Scope

This checklist covers the post-merge hardening lane after the Phase 57-69 release train:

- Phase 70 post-merge real `md` soak
- Phase 71 Ubuntu/Windows CI and path hardening
- Phase 72 artifact schema v1 freeze
- Phase 73 AI repair loop CLI practical acceptance
- Phase 74 README quick path and release-readiness consolidation

Use `docs/RELEASE_CHECKLIST_57_68.md` for the earlier release train scope.

## 2. Required Checks

Run from `D:/learn/migration-guard`:

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Current verified baseline:

- `npm test`: 42 tests passed
- `git diff --check`: passed with Windows LF/CRLF warnings only
- target md repo: `## main...origin/main`

GitHub CI gate:

- `Build and Test (ubuntu-latest)`: required
- `Build and Test (windows-latest)`: required

## 3. Evidence Documents

- `docs/PHASE_70_REPORT.md`
- `docs/PHASE_71_REPORT.md`
- `docs/PHASE_72_REPORT.md`
- `docs/PHASE_73_REPORT.md`
- `docs/PHASE_74_REPORT.md`

Supporting runbooks:

- `docs/MD_OPERATOR_RUNBOOK.md`
- `docs/PR_MERGE_READINESS.md`

## 4. Release Gates

Phase 70:

- PR #7 was merged to `main`.
- New real `md-fast` run passed a 5-proposal batch.
- Batch included shared TS and MCP render proposals.
- All applied proposals rolled back.
- Target `md` repo ended clean.

Phase 71:

- CI runs on Ubuntu and Windows.
- `toPosixPath` handles Windows, POSIX and mixed separators.
- Artifact migration path discovery uses shared normalization.

Phase 72:

- Artifact schema v1 registry exists.
- Migration report exposes frozen schema metadata.
- Future `artifactSchemaVersion` is marked unsupported.
- Apply refuses unsupported artifacts.
- Real md-fast artifact migration dry-run reports unsupported 0 and invalid 0.

Phase 73:

- CLI smoke covers failed proposal -> replan -> retry -> verify -> accept -> report.
- Retry proposal inherits source failure category.
- Repair acceptance artifact is written only after checked passing verification.
- Run report surfaces `repair:accepted`.

Phase 74:

- README includes a quick path for local checks, real `md` validation and repair loop.
- Current release checklist links 70-74 evidence.
- Development phase index includes Phase 74.

## 5. Boundaries

In scope:

- Local CLI runtime behavior
- Real `md` validation evidence
- Cross-platform CI gate
- Artifact schema compatibility boundary
- CLI repair-loop acceptance

Out of scope:

- New provider adapters
- GitHub close/reopen, assignee, milestone or pagination work
- Broad source rewriting beyond guarded proposal scaffolds

## 6. Ready To Release

The current hardening lane is release-ready when:

- both GitHub CI matrix jobs pass
- local checks pass
- target `md` repo is clean
- no `.migration-guard/` runtime artifacts are staged
- README links resolve to current runbooks/checklists
- Phase 70-74 reports are present
