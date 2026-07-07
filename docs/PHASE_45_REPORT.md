# Phase 45: Verify Checks Temporary Apply

生成日期：2026-07-07

## 1. 阶段目标

Phase 45 补齐 `proposal verify --checks` 对 generated-script proposal 的行为语义。Phase 44 中生成的 probe 脚本只存在于 patch 内，旧 verify mode 不应用 patch 就直接跑 checks，导致新增脚本找不到。

## 2. 新增能力

- `proposal verify --checks` 在 patch check 通过后临时执行 `git apply`。
- checks 使用与 apply gate 相同的 preview-aware check runner。
- checks 完成后自动执行 `git apply -R`。
- verification report 新增 `temporaryApply`，记录临时 apply 和 rollback 状态。
- 文本报告展示 `Temporary apply: applied, rolled back`。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 26 tests passed

真实 MD proposal 回放：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run run-2026-07-07T07-04-05-365Z-ai5vjd --proposal patch-2026-07-07T07-51-23-220Z-64eeuc --checks
```

结果：

- mode: verify
- applied: no
- patch check: passed
- temporary apply: applied, rolled back
- `pnpm --filter @md/mcp-server type-check`: passed
- `node scripts/migration-guard/action-md-mcp-render.mjs`: passed
- target `md` git status: clean
- generated probe file was not left in the target workspace

## 4. Safety Boundary

Verify mode still does not persist proposal application or mark the proposal as `applied`. The temporary patch is only used to make generated files available while checks run. If temporary rollback fails, the verification report fails through `temporaryApply.passed`.
