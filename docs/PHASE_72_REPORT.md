# Phase 72: Artifact Schema v1 Freeze

生成日期：2026-07-08

## 1. 阶段目标

Phase 72 把 artifact schema 从“有 migration backfill”推进到“有冻结 registry 和兼容边界”。目标是让 proposal / gate / batch / replan / repair acceptance artifacts 的 v1 shape 可审查、可迁移，并且未来 schema marker 不会被当前版本误写。

## 2. 新增能力

- 新增 `src/core/artifactSchema.ts`
- 定义 frozen v1 registry：
  - `proposal`
  - `proposal-verification-report`
  - `proposal-batch-plan`
  - `proposal-batch-report`
  - `proposal-replan-context`
  - `proposal-repair-acceptance`
- migration report 输出 `schema`，包含 frozen phase、current schema version、每类 artifact 的 required fields 和 backfill rules。
- artifact migration dry-run 会标记 unsupported future schema。
- artifact migration apply 遇到 unsupported artifact 会拒绝写回。

## 3. Backfill 增强

Phase 72 真实 dry-run 暴露一个旧 batch report 缺少 `executedCount` / `skippedCount`。本阶段将其纳入 v1 backfill：

- missing `executedCount` 从 `results.length` 回填，缺 `results` 时为 `0`
- missing `skippedCount` 从 `skipped.length` 回填，缺 `skipped` 时为 `0`

## 4. Real MD Dry-Run Smoke

命令：

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --json
```

Result:

- artifacts dir: `D:\learn\migration-guard\.migration-guard\external-targets\md-fast`
- scanned: 130
- would-migrate: 91
- unchanged: 39
- unsupported: 0
- invalid: 0
- applied: false
- plan hash: `fb559443ccace047b8f873d24836eb39ac4510a5092fbae75d5fd17798b34bdf`

Observed v1 schema registry:

- current artifact schema version: 1
- frozen at phase: 72
- kinds: 6

Target repository stayed clean:

```text
## main...origin/main
```

## 5. Verification

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Current results:

- `npm test`: 41 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- target md repo: `## main...origin/main`

新增测试覆盖：

- migration report exposes frozen schema metadata
- old batch reports backfill `executedCount` / `skippedCount`
- future `artifactSchemaVersion` is reported as unsupported
- apply refuses unsupported artifacts

## 6. Exit Criteria

- v1 artifact schema registry exists: passed
- migration report exposes frozen schema metadata: passed
- unsupported future schema is blocked from apply: passed
- real md-fast dry-run has unsupported 0 and invalid 0: passed
- target repository remains clean: passed
