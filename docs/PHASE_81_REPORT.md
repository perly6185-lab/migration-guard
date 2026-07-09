# Phase 81 Report: Renderer Core Scoped Real Refactor

生成日期：2026-07-09

## Goal

执行第三条不同风险域的真实 `md.git` scoped refactor lane。这次选择 renderer/core lane：只整理核心 Markdown renderer 中重复的 mac code block sign markup，不改变渲染 HTML、diff code rendering、Markdown 行为或 API 行为。

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
migration-guard/phase-81-renderer-core-refactor
```

Target commit:

```text
4e1471d refactor(core): name mac code sign markup
```

Target PR:

```text
https://github.com/perly6185-lab/md/pull/3
```

PR status:

```text
OPEN
mergeStateStatus: CLEAN
checks: none reported
```

## Change

File:

```text
packages/core/src/renderer/renderer-impl.ts
```

Scope:

- Named the repeated mac code block sign markup as `macCodeSign`.
- Reused the same markup in normal code block and `diff-*` code block rendering.
- Kept generated HTML strings unchanged.
- Kept renderer behavior and API contract behavior unchanged.

## Migration Guard Evidence

Baseline before the target change:

```text
baseline-2026-07-09T05-49-10-873Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
```

First verify after local edit:

```text
run-2026-07-09T05-50-20-303Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final verify after target commit and pre-commit lint-staged:

```text
run-2026-07-09T05-52-29-891Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final compare artifact:

```text
.migration-guard/external-targets/md-fast/compare/1783576349924.json
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
PR #3 is open and mergeable.
No checks are reported on the branch.
Migration Guard evidence is the source of truth for this scoped trial.
```

## Exit Criteria

- Real target source changed in one renderer/core file: passed.
- Renderer/core lane differed from Phase 77 shared utility and Phase 79 API contract lanes: passed.
- Baseline captured before change: passed.
- Verify captured after change: passed.
- Compare detected no behavior differences: passed.
- Target branch pushed and PR opened: passed.
- Target working tree clean: passed.

## Next

Review or merge `md.git` PR #3. After it is accepted, run post-merge verify/compare on target `main` before expanding batch size.
