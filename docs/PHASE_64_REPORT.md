# Phase 64: Artifact Schema Migration Foundation

生成日期：2026-07-08

## 1. 阶段目标

Phase 64 给 60-62 稳定下来的 proposal / gate / batch / replan artifact 增加 schema migration 底座。目标是升级后旧 run 仍可读，新 artifact 有明确 schema marker，迁移默认 dry-run。

## 2. 新增能力

- 新增 `src/core/artifactMigration.ts`。
- 新增命令：

```bash
node dist/cli.js artifacts migrate
node dist/cli.js artifacts migrate --apply --apply-confirm <plan-hash>
node dist/cli.js artifacts migrate --json
```

- 新写出的 artifact 增加 `artifactSchemaVersion: 1`：
  - proposal
  - proposal verification report
  - proposal batch plan
  - proposal batch report
  - proposal replan context
- 迁移支持 dry-run-first：
- 默认只报告 `would-migrate`
- `--apply --apply-confirm <plan-hash>` 才写回 JSON
- invalid JSON 会计入 report 并让 CLI 返回非零状态

## 3. Backfill Rules

Proposal:

- set `artifactSchemaVersion: 1`
- rejected / ignored proposal 缺少 `exclusion` 时补 `{ state, createdAt }`
- missing `generatedFiles` 补 `[]`

Verification report:

- set `artifactSchemaVersion: 1`
- missing `timeline` 补 `[]`

Batch plan / report:

- set `artifactSchemaVersion: 1`
- missing `excluded` 补 `[]`
- missing `excludedCount` 补当前 excluded 数量
- batch report missing `skipped` 补 `[]`

Replan context:

- set `artifactSchemaVersion: 1`
- missing `proposal.sourceSnippets` 补 `[]`
- missing `failure.latestFailedOutput` 时从 `firstFailedCheck` 补 stdout/stderr
- missing `acceptanceChecklist` 补最小 AI repair checklist

## 4. Real MD Dry-Run Smoke

命令：

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --json
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json
```

结果：

- artifacts dir: `D:\learn\migration-guard\.migration-guard\external-targets\md-fast`
- scanned: 91
- would-migrate: 91
- unchanged: 0
- invalid: 0
- applied: false

Observed migration kinds:

- proposal
- proposal-verification-report
- proposal-batch-plan
- proposal-batch-report

Observed backfills included:

- old verification reports without `timeline`
- old batch plans/reports without `excluded` / `excludedCount`
- old ignored proposal without `exclusion`

该 smoke 未使用 `--apply`，没有写回 artifact，也没有修改 target repository。

Target repository stayed clean:

```text
## main...origin/main
```

## 5. Verification

```bash
npm test
npm run build
git diff --check
```

Current results:

- `npm test`: 37 tests passed
- `npm run build`: passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

新增测试覆盖：

- dry-run migration reports changes but does not modify old artifact files
- `--apply` backfills proposal exclusion/generatedFiles
- verification report timeline backfill
- batch report excluded/skipped backfill
- replan context source snippets, latest failed output, and acceptance checklist backfill

## 6. Exit Criteria

- Artifact migration command exists and defaults to dry-run: passed
- New proposal/gate/batch/replan artifacts include schema marker: passed
- Old artifact fallback/backfill is covered by tests: passed
- Real md-fast migration plan can be reviewed without writes: passed
- Target md repository remains clean: passed
