# Phase 46: No-Op Check Detection

生成日期：2026-07-07

## 1. 阶段目标

Phase 46 修复 proposal gate 的一个真实误判：`pnpm --filter @md/mcp-server type-check` 会以 exit code 0 结束，但输出 `None of the selected packages has a "type-check" script`，实际没有运行检查。工具现在把这类输出识别为 `no-op` failure。

## 2. 新增能力

- `ProposalCheckFailureCategory` 增加 `no-op`。
- proposal checks 识别 pnpm no-op 输出，包括 selected packages 无脚本和 filter 无匹配项目。
- no-op check 失败时输出专门 remediation hints。
- `md-task-mcp-render` recommended check 改成真实 runtime smoke：导入 `buildRenderedOutput` 并确认渲染结果包含 heading。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 27 tests passed

旧 proposal 回放：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run run-2026-07-07T07-04-05-365Z-ai5vjd --proposal patch-2026-07-07T07-51-23-220Z-64eeuc --checks
```

结果：

- patch check: passed
- temporary apply: applied, rolled back
- `pnpm --filter @md/mcp-server type-check`: failed
- failure category: `no-op`
- generated probe check: passed

新 proposal 回放：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD monorepo no-op gate validation" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-28-06-708Z-aljy8b --auto
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-28-06-708Z-aljy8b --action action-md-mcp-render
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run run-2026-07-07T09-28-06-708Z-aljy8b --proposal patch-2026-07-07T09-29-24-002Z-p387d6 --checks
```

结果：

- proposal: `patch-2026-07-07T09-29-24-002Z-p387d6`
- patch check: passed
- temporary apply: applied, rolled back
- MCP render runtime smoke: passed with `{"hasHeading":true,"words":2}`
- generated renderer probe: passed
- target `md` git status: clean
- generated probe file was not left in the target workspace

## 4. Safety Boundary

No-op detection only affects proposal check results. Raw command stdout/stderr are still preserved in verification reports, and real nonzero failures continue to use their existing failure categories.
