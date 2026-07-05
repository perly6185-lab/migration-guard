# Phase 16: Playwright UI Probe Adapter Report

生成日期：2026-07-05

## 1. 阶段目标

Phase 16 的目标是把 `ui-smoke-probe` 从“检查 Vue 文件结构”升级为“可运行 UI smoke probe”。

本阶段采用保守实现：

- 如果目标项目安装了 `playwright`，probe 会启动 Chromium、访问页面、读取 DOM、截图。
- 如果目标项目没有安装 `playwright`，probe 会自动 fallback 到 `fetch`，验证 preview URL 可访问且响应体非空。
- UI probe report 默认写到系统临时目录，避免让目标仓库出现 untracked artifacts。

## 2. 已实现能力

### 2.1 UI Probe Script

`ui-smoke-probe` 现在生成：

```text
scripts/migration-guard/action-large-vue-ui-probe.mjs
```

脚本能力：

- 检查目标 Vue 文件存在
- 检查 `<template>` 和 `<script>`
- 读取 `MG_PREVIEW_URL`
- 优先尝试 `import("playwright")`
- Playwright 可用时访问页面、读取 DOM、截图
- Playwright 不可用时使用 `fetch` fallback
- 输出 JSON report

### 2.2 输出目录不污染目标仓库

UI probe 默认输出到：

```text
<system-temp>/migration-guard-ui-probes/<action-id>/
```

也可通过环境变量覆盖：

```bash
MG_UI_PROBE_OUTPUT_DIR=<path>
```

### 2.3 Proposal Gate 复用

UI probe 继续复用 Phase 15 的 proposal lifecycle：

- `action propose`
- `proposal verify`
- `action apply`
- `proposal rollback`
- run report proposal 汇总

## 3. 验证结果

### 3.1 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 13 个测试通过
- 新增测试覆盖 `ui-smoke-probe` patch 生成
- 测试断言生成脚本包含：
  - `await import("playwright")`
  - `MG_PREVIEW_URL`
  - `runFetchProbe`
  - system temp output dir

### 3.2 真实 md UI Proposal

命令：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-large-vue-ui-probe
```

结果：

- proposal: `patch-2026-07-05T01-46-31-462Z-0bai02`
- generated file: `scripts/migration-guard/action-large-vue-ui-probe.mjs`

### 3.3 Patch Verify

命令：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T01-46-31-462Z-0bai02
```

结果：

- patch check: `passed`
- output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T01-46-31-462Z-0bai02/verification-1783216002091.json`

### 3.4 UI Apply + Checks

先启动 md web dev server：

```bash
pnpm web dev --host 127.0.0.1
```

Vite ready URL：

```text
http://127.0.0.1:5173/md/
```

执行 apply：

```bash
MG_PREVIEW_URL=http://127.0.0.1:5173/md/ node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T01-46-31-462Z-0bai02
```

结果：

- patch check: `passed`
- checks: `3`
- `pnpm --filter @md/web test`: `passed`
- `pnpm type-check:web`: `passed`
- `node scripts/migration-guard/action-large-vue-ui-probe.mjs`: `passed`
- verification output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T01-46-31-462Z-0bai02/verification-1783216038349.json`

UI probe runtime result：

- mode: `fetch`
- status: `200`
- bodyLength: `8295`
- reason for fallback: target `md` does not currently install `playwright`
- report path: `C:\Users\PSY\AppData\Local\Temp\migration-guard-ui-probes\action-large-vue-ui-probe\action-large-vue-ui-probe.json`

### 3.5 Rollback

命令：

```bash
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T01-46-31-462Z-0bai02
```

结果：

- reverse check: `passed`
- reverse apply: `passed`
- proposal state: `rolled-back`
- rollback output: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-04T23-28-09-710Z-3p95bj/proposals/patch-2026-07-05T01-46-31-462Z-0bai02/rollback-1783216048264.json`

### 3.6 目标仓库清洁度

命令：

```bash
git -C D:\learn\migration-guard-targets\md status --short --branch
```

结果：

```text
## main...origin/main
```

目标 `md` 仓库保持 clean。

## 4. 下阶段建议

Phase 17 建议进入 “Managed Preview Server for UI Gates”：

1. 让 proposal verification gate 能声明并启动 preview server。
2. action apply 自动管理 server lifecycle。
3. 把 preview stdout/stderr 和 ready URL 写入 verification report。
4. 支持 per-action `previewCommand` 和 `previewUrl`。
5. Playwright 可用时把 screenshot artifact 路径提升到 proposal verification summary。
