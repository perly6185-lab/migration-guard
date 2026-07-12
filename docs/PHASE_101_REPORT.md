# Phase 101 Report: Controlled MD2 Bootstrap From Source

生成日期：2026-07-11

## Goal

`md2` 当前是空 GitHub repository。Phase 101 提供受控 bootstrap，让目标仓库
从 `md` 源 checkout 导入允许文件，进入后续 baseline/verify 和 issue-control
循环可操作的状态。

## Delivered

New CLI:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute
```

Optional explicit paths:

```bash
node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md2 --execute
```

New core module:

- `src/core/bootstrap.ts`

New tests:

- `src/core/bootstrap.test.ts`

## Safety Rules

Bootstrap refuses to run when:

- source and target are the same directory
- target is nested inside source
- target is not a git repository
- target working tree is dirty

Bootstrap excludes:

- `.git`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.migration-guard`
- `.wxt`
- `.output`
- `.turbo`
- `.env*`
- symbolic links

## Artifacts

Bootstrap writes:

```text
.migration-guard/external-targets/md2-fast/bootstrap/md2-bootstrap-*.json
.migration-guard/external-targets/md2-fast/bootstrap/md2-bootstrap-*.md
```

The manifest records:

- source root
- target root
- mode
- target git status before/after
- planned files
- copied files
- skipped files
- planned/copied byte counts
- recommended next commands

## Verification

Focused:

```bash
node --test dist/core/bootstrap.test.js
```

Result:

- 3 tests passed.

Full verification:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 70 tests passed.
- `git diff --check`: passed, with Windows LF/CRLF warnings only.
