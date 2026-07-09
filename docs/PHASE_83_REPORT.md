# Phase 83 Report: Small Multi-Lane Batch Rehearsal

生成日期：2026-07-09

## Goal

从连续 scoped refactor 进入小型 multi-lane batch rehearsal：在真实 `md.git` target 上同时覆盖 shared、API、renderer 三个风险域，做一批小范围行为保持重构，并用 fresh baseline / verify / compare 证明组合变更仍无行为差异。

## Target

Repository:

```text
https://github.com/perly6185-lab/md.git
```

Local target:

```text
D:/learn/migration-guard-targets/md
```

Target branch:

```text
migration-guard/phase-83-small-multilane-batch
```

Target commit:

```text
850aa49 refactor: rehearse small multi-lane batch
```

Target PR:

```text
https://github.com/perly6185-lab/md/pull/4
```

PR status:

```text
OPEN
mergeStateStatus: CLEAN
checks: none reported
```

## Change

Files:

```text
packages/shared/src/utils/basicHelpers.ts
apps/api/src/origin.ts
packages/core/src/utils/markdownHelpers.ts
```

Scope:

- Shared lane: named image validation suffix and size constants.
- API lane: named the wildcard host-label regex fragment used by origin pattern matching.
- Renderer lane: extracted sanitize placeholder protection into a small helper.
- Kept image validation behavior, CORS origin matching, renderer HTML output, and API behavior unchanged.

## Migration Guard Evidence

Fresh baseline before the batch:

```text
baseline-2026-07-09T06-20-02-792Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
```

First verify after local batch edit:

```text
run-2026-07-09T06-22-06-583Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final verify after target commit and pre-commit lint-staged:

```text
run-2026-07-09T06-24-21-720Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final compare artifact:

```text
.migration-guard/external-targets/md-fast/compare/1783578261749.json
```

## Validation

Target validation:

```text
git diff --check: passed with Windows LF/CRLF warning only
pre-commit lint-staged: passed
Migration Guard verify: passed
Migration Guard compare: passed, no differences detected
```

Target PR validation:

```text
PR #4 is open and mergeable.
No checks are reported on the branch.
Migration Guard evidence is the source of truth for this rehearsal.
```

## Exit Criteria

- Fresh baseline captured on clean target `main`: passed.
- Real target source changed across shared, API, and renderer lanes: passed.
- Batch stayed small: three files, one low-risk refactor per lane.
- Verify captured before and after commit: passed.
- Compare detected no behavior differences: passed.
- Target branch pushed and PR opened: passed.
- Target working tree clean: passed.

## Next

Review or merge `md.git` PR #4. After it is accepted, run post-merge verify/compare on target `main`. If that passes, the project can move from small multi-lane rehearsal toward a larger 5-8 proposal batch rehearsal.
