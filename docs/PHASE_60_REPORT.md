# Phase 60: Proposal Lifecycle UX

生成日期：2026-07-08

## 1. 阶段目标

Phase 60 补齐 proposal lifecycle 的 operator UX，让 reject / ignore 不只存在于 evidence log，而是可查询、可筛选、可解释。

## 2. 新增能力

- `ProposedPatch` 新增 `exclusion`：
  - `state`
  - `reason`
  - `supersededBy`
  - `createdAt`
- `proposal status` 显示 exclusion reason 和 superseded-by。
- 新增 `proposal list`：
  - `--state <state>`
  - `--action <action-id>`
  - `--risk low|medium|high`
  - `--json`
- `proposal ignore --superseded-by <proposal-id>` 记录替代关系。
- applied / applied-with-failed-checks / rollback-failed proposal 仍不能被 reject / ignore。
- `proposal batch plan` 显示 excluded proposal 数量和原因。

## 3. Real MD Smoke

使用 run:

- `run-2026-07-08T00-50-09-687Z-hej4rh`

生成替代 proposal：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --action action-md-mcp-render
```

生成：

- `patch-2026-07-08T01-32-23-492Z-pqggw1`

忽略旧 proposed-only proposal：

```bash
node dist/cli.js proposal ignore --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --proposal patch-2026-07-08T00-51-13-114Z-b2boml --reason "superseded by Phase 60 lifecycle smoke" --superseded-by patch-2026-07-08T01-32-23-492Z-pqggw1
```

结果：

- `patch-2026-07-08T00-51-13-114Z-b2boml` state: `ignored`
- reason: `superseded by Phase 60 lifecycle smoke`
- superseded-by: `patch-2026-07-08T01-32-23-492Z-pqggw1`

查询：

```bash
node dist/cli.js proposal list --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --state ignored
node dist/cli.js proposal status --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --proposal patch-2026-07-08T00-51-13-114Z-b2boml
```

Batch plan:

```bash
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --limit 2
```

结果：

- selected: `patch-2026-07-08T01-32-23-492Z-pqggw1`
- excluded: `patch-2026-07-08T00-51-13-114Z-b2boml`
- excluded reason and superseded-by were shown in CLI output

Target repository stayed clean:

```text
## main...origin/main
```

## 4. Verification

```bash
npm test
git diff --check
```

Results:

- `npm test`: 36 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

