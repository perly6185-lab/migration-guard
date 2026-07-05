# Phase 18-20: Classified Gates, Timeline, and Replan Issues Report

生成日期：2026-07-05

## 1. 阶段目标

本次把 Phase 18、Phase 19、Phase 20 合并交付，目标是让 proposal gate 从“执行一组字符串命令”升级为“可分类、可排序、可审计、可触发重规划”的执行层。

三个阶段分别对应：

- Phase 18：Proposal Check Classification
- Phase 19：Proposal Gate Timeline
- Phase 20：Failed Gate Replan Issues

## 2. 已实现能力

### 2.1 Phase 18: Check Classification

`ProposedPatch` 保留原有：

```json
"recommendedChecks": ["pnpm test"]
```

同时新增：

```json
"checkPlan": [
  {
    "command": "pnpm --filter @md/web test",
    "kind": "unit-test",
    "phase": "pre-preview",
    "timeoutMs": 180000,
    "critical": true
  }
]
```

支持的 `kind`：

- `unit-test`
- `type-check`
- `ui-probe`
- `contract-probe`
- `build`
- `lint`
- `other`

支持的 `phase`：

- `pre-preview`
- `preview`
- `post-preview`

没有 `checkPlan` 的旧 proposal 会在 verify/apply 时自动补齐。

### 2.2 Phase 19: Gate Timeline

`ProposalVerificationReport` 新增：

- `checkPlan`
- `timeline`

timeline 会记录：

- patch applicability check
- regular checks
- managed preview session
- preview-scoped checks

run report 新增：

```text
## Recent Proposal Gates
```

用于汇总最近 proposal gate 的 passed/failed、checks 数量、timeline 数量和 replan issue。

### 2.3 Phase 20: Failed Gate Replan Issues

apply gate 失败时会自动：

- 创建 failure issue
- 在 verification report 写入 `replanIssueId`
- 在 evidence log 写入 `replan` 事件
- issue body 记录 report path、first failed check、check kind、check phase

## 3. 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 14 个测试通过
- 新增/扩展覆盖：
  - proposal apply report 写入 `checkPlan`
  - proposal apply report 写入 `timeline`
  - managed preview check 标记为 `ui-probe/preview`
  - gate 失败自动创建 `replanIssueId`
  - proposal failure issue 写入 run issue store

## 4. 真实 md 验证

### 4.1 UI Proposal Failure Path

proposal：

```text
patch-2026-07-05T02-23-07-201Z-wqiy5i
```

check plan：

```text
unit-test/pre-preview
type-check/pre-preview
ui-probe/preview
```

apply 结果：

- patch check: `passed`
- `pnpm --filter @md/web test`: `failed`
- `pnpm type-check:web`: `passed`
- managed preview: `passed`
- UI probe: `passed`
- timeline events: `5`
- replan issue: `issue-2026-07-05T02-25-48-700Z-oala4t`
- verification: `verification-1783218348694.json`
- rollback: `rollback-1783218376396.json`

失败原因：

`md` 的 web Vitest worker 在本机环境出现 timeout。工具已正确把失败归类为：

```text
kind: unit-test
phase: pre-preview
```

并自动生成 replan/failure issue。

### 4.2 Renderer Proposal Success Path

proposal：

```text
patch-2026-07-05T02-26-47-053Z-78siwu
```

check plan：

```text
unit-test/pre-preview
type-check/pre-preview
other/pre-preview
```

apply 结果：

- patch check: `passed`
- checks: `3/3 passed`
- timeline events: `4`
- `pnpm --filter @md/core test`: `passed`
- `pnpm type-check:packages`: `passed`
- `node scripts/migration-guard/action-renderer-probes.mjs`: `passed`
- verification: `verification-1783218482796.json`
- rollback: `rollback-1783218489874.json`

### 4.3 Run Report

命令：

```bash
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

结果：

- run report 包含 `Recent Proposal Gates`
- 同时展示失败 UI proposal 的 `replanIssueId`
- 展示成功 renderer proposal 的 timeline count

## 5. 清洁度

目标仓库状态：

```text
git -C D:\learn\migration-guard-targets\md status --short --branch
## main...origin/main
```

端口检查：

```text
5173 no listener
```

目标 `md` 仓库保持 clean。

## 6. 下阶段建议

Phase 21 建议进入 “Adaptive Gate Policy + Flake Handling”：

1. 对 `unit-test` 类失败支持一次可配置 retry。
2. 对 Vitest worker timeout 这类疑似环境/并发问题标记 `flake-suspected`。
3. checkPlan 支持 `retry`、`isolation`、`resourceProfile`。
4. gate policy 支持 fail-fast 或 collect-all 两种模式。
5. replan issue 根据失败类型生成不同修复建议。
