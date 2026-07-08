# Phase 57: Probe Template Repair and Proposal Exclusion

生成日期：2026-07-07

## 1. 阶段目标

Phase 57 修复 Phase 55/56 保留下来的三个实际批处理问题：

- shared TS package action 不再使用要求 Vue `<template>` / `<script>` 的 `ui-smoke-probe`。
- MCP render runtime smoke 不再依赖远程 highlight CSS fetch。
- proposed-only patch 可以显式 `reject` 或 `ignore`，避免通过 rollback 来排除后续 batch。

## 2. 新增能力

- 新增 `ts-structural-probe` action patch template。
- `md-task-shared-contracts` 现在生成 TS structural probe，检查 TypeScript 模块和结构信号。
- MCP render recommended check 调用 `buildRenderedOutput` 时传入 `codeBlockTheme: ''`，保留真实 renderer smoke，同时跳过远程 CSS。
- 新增 proposal apply state：`ignored`。
- 新增 CLI：

```bash
node dist/cli.js proposal reject --run latest --proposal <proposal-id> --reason "wrong probe shape"
node dist/cli.js proposal ignore --run latest --proposal <proposal-id> --reason "superseded by regenerated proposal"
```

- `proposal batch plan/apply` 继续只选择 `proposed` / `verified` proposal，因此 `rejected` 和 `ignored` proposal 会被排除。
- 被排除的 proposal 不能继续 `verify`、`apply` 或 `rollback`。
- retry proposal 选择会跳过 `rejected` / `ignored` retry。

## 3. Verification

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 32 tests passed

新增覆盖：

- shared package action 生成并执行 `ts-structural-probe`。
- rejected / ignored proposal 不进入 batch plan。
- ignored proposal 不能 apply，rejected proposal 不能 verify。
- MD MCP render check 包含 `codeBlockTheme: ''`，避免远程 CSS fetch。

## 4. Safety Boundary

本阶段不扩大 GitHub provider 范围，不修改真实目标仓库源码。`proposal reject|ignore` 只修改 Migration Guard run artifact 中的 proposal JSON 和 evidence log。
