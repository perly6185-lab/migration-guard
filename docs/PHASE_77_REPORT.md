# Phase 77 Report: Scoped Real md.git Refactor Trial

生成日期：2026-07-08

## Goal

在 Phase 76 `readiness --strict: go` 之后，执行第一条真实但小范围的 `md.git` refactor trial。目标不是扩大变更面，而是证明 Migration Guard 可以保护一个真实项目源码变更：先 baseline，再改一处 shared 代码，再 verify/compare，最后以 target PR 形式交付。

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
migration-guard/phase-77-reading-time-refactor
```

Target commit:

```text
26acf6b refactor(shared): clarify reading time ranges
```

Target PR:

```text
https://github.com/perly6185-lab/md/pull/1
```

## Change

File:

```text
packages/shared/src/utils/readingTime.ts
```

Scope:

- Named the default words-per-minute constant.
- Moved ANSI word boundary characters into a named constant.
- Moved CJK and punctuation range tables into named constants.
- Kept exported types, default export, word counting logic, and display output unchanged.

This is intentionally a small behavior-preserving refactor in the shared contracts lane.

## Migration Guard Evidence

Baseline before the target change:

```text
baseline-2026-07-08T06-02-01-478Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
```

First verify after the local edit:

```text
run-2026-07-08T06-03-07-596Z
Passed: yes
No differences detected.
```

Final verify after target commit and pre-commit lint-staged:

```text
run-2026-07-08T06-09-10-258Z
checks: core-test:passed, packages-type-check:passed
probes: md-renderer-behavior:passed, md-api-contract:passed
compare: passed, no differences detected
```

Final compare artifact:

```text
.migration-guard/external-targets/md-fast/compare/1783490950281.json
```

## Validation

Target validation:

```text
git diff --check: passed with Windows LF/CRLF warning only
Migration Guard verify: passed
Migration Guard compare: passed, no differences detected
```

Target PR checks:

```text
no checks reported on the branch
```

Migration Guard evidence is therefore the source of truth for this scoped trial.

## Exit Criteria

- `readiness --strict` was already `go` before the trial: passed.
- Real target source changed in one shared file: passed.
- Baseline captured before change: passed.
- Verify captured after change: passed.
- Compare detected no behavior differences: passed.
- Target branch pushed and PR opened: passed.
- Target working tree clean: passed.

## Next

Keep `md.git` PR #1 open for review or merge. After it is accepted, the next trial can expand carefully to one of:

- MCP render guard lane with behavior diff evidence.
- API contract lane with request/response contract evidence.
- Another shared utility refactor with explicit unit coverage added in target repo.
