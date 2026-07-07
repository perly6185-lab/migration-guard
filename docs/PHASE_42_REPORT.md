# Phase 42: MD UI/API Contract Probe Expansion

生成日期：2026-07-07

## 1. 阶段目标

Phase 42 回到 `perly6185-lab/md` 真实项目，为后续整仓自动重构补充更强的项目级行为证据。本阶段只增加探针和配置，不修改 `md` 业务源码。

## 2. 新增能力

- `scripts/probes/md-api-contract-probe.mjs`
- `scripts/probes/md-web-static-probe.mjs`
- `configs/md-fast.migration-guard.json` 增加 `md-api-contract`
- `configs/md-full.migration-guard.json` 增加 `md-api-contract` 和 `md-web-static-contract`

## 3. Probe Coverage

API contract probe 覆盖：

- `GET /` root health
- allowed-origin CORS echo
- `OPTIONS /upload` preflight
- disabled upload response
- unauthenticated `/me`

Web static probe 覆盖：

- `main.ts` bootstraps app
- `bootstrap.ts` mounts `#app`
- `App.vue` includes editor, command palette, confirm dialog and toaster
- Vite base protects `/md/`
- `apps/web/dist/index.html` includes app mount, module script, stylesheet and `/md/` assets

## 4. Safety Boundary

本阶段不启动长期 dev server，不打外部 API，不依赖真实 Cloudflare D1/R2/GitHub credentials。API probe 使用 in-memory Hono app 和 mock env；web probe 检查源码入口和已生成 build artifact。

## 5. Verification

已单独验证：

```bash
pnpm exec tsx D:/learn/migration-guard/scripts/probes/md-api-contract-probe.mjs
pnpm exec tsx D:/learn/migration-guard/scripts/probes/md-web-static-probe.mjs
```

结果：

- `md-api-contract`: passed
- `md-web-static-contract`: passed
- target git status: clean

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 23 tests passed

`md-fast` lane 验证：

```bash
node dist/cli.js baseline --config configs/md-fast.migration-guard.json
node dist/cli.js verify --config configs/md-fast.migration-guard.json
```

结果：

- `core-test`: passed
- `packages-type-check`: passed
- `md-renderer-behavior`: passed
- `md-api-contract`: passed
- compare: passed, no differences detected

说明：第一次 `md-fast baseline` 遇到 Vitest worker startup timeout；随后单独重跑 `pnpm --filter @md/core test` 通过，再重跑 baseline/verify 通过。该失败归类为环境/worker flake，不是新增 API probe 失败。

`md-full` lane 追加验证：

```bash
node dist/cli.js baseline --config configs/md-full.migration-guard.json
node dist/cli.js verify --config configs/md-full.migration-guard.json
```

结果：

- `core-test`: passed
- `web-test`: passed
- `packages-type-check`: passed
- `web-type-check`: passed
- `web-build`: passed
- `md-renderer-behavior`: passed
- `md-api-contract`: passed
- `md-web-static-contract`: passed
- compare: passed

说明：`md-full` compare 仅报告 `web-build` passing stdout/stderr changed warn，未阻断验证。target `md` git status 仍为 clean。
