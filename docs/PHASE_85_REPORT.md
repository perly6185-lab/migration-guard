# Phase 85 Report: Larger Multi-Lane Batch Rehearsal

生成日期：2026-07-09

## Goal

从 Phase 83/84 的 3-file small multi-lane batch 扩大到 6-file larger multi-lane batch rehearsal。目标是在真实 `md.git` target 上同时覆盖 shared、API、core 三个风险域，验证更接近一次性重构窗口的批量行为保持改动仍能被 fresh baseline / verify / compare 稳定守住。

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
migration-guard/phase-85-larger-multilane-batch
```

Target commit:

```text
52168ab refactor: rehearse larger multi-lane batch
```

Target PR:

```text
https://github.com/perly6185-lab/md/pull/5
```

PR status:

```text
OPEN
mergeStateStatus: CLEAN
checks: none reported
```

## Lane Budget

Shared lane:

```text
packages/shared/src/utils/fileHelpers.ts
packages/shared/src/utils/fetch.ts
```

API lane:

```text
apps/api/src/upload-filename.ts
apps/api/src/upload-config.ts
apps/api/src/share-sanitize.ts
```

Core lane:

```text
packages/core/src/utils/mathDetection.ts
```

## Change

Scope:

- Named repeated defaults, regexes, and limits across shared, API, and core utility files.
- Extracted one small share sanitization helper.
- Kept download behavior, axios request behavior, upload config/filename behavior, share sanitization, math detection, renderer output, and API behavior unchanged.

## Migration Guard Evidence

Fresh baseline before the batch:

```text
baseline-2026-07-09T06-47-53-257Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
```

First verify after local batch edit:

```text
run-2026-07-09T06-50-47-607Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final verify after target commit and pre-commit lint-staged:

```text
run-2026-07-09T06-53-10-141Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final compare artifact:

```text
.migration-guard/external-targets/md-fast/compare/1783579990186.json
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
PR #5 is open and mergeable.
No checks are reported on the branch.
Migration Guard evidence is the source of truth for this larger batch rehearsal.
```

## Exit Criteria

- Fresh baseline captured on clean target `main`: passed.
- Real target source changed across shared, API, and core lanes: passed.
- Batch expanded beyond Phase 83 while staying bounded: six files, low-risk helper/constant refactors only.
- Verify captured before and after commit: passed.
- Compare detected no behavior differences: passed.
- Target branch pushed and PR opened: passed.
- Target working tree clean: passed.

## Next

Review or merge `md.git` PR #5. After it is accepted, run post-merge verify/compare on target `main`. If that passes, the next step is to decide whether the project is ready for a tightly bounded one-shot refactor window or needs one more batch with MCP/web-specific guard coverage.
