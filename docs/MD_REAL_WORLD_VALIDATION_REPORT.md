# `perly6185-lab/md` 真实项目闭环验证报告

生成日期：2026-07-05

目标仓库：https://github.com/perly6185-lab/md

> 2026-07-11 更新：本文是历史验证报告，证明 Migration Guard 曾对
> `perly6185-lab/md` 完成真实项目闭环验证。当前重构执行需求已矫正为
> `md` 作为源仓库、`md2` 作为目标仓库和 issue 控制面。最新执行入口见
> [MD_OPERATOR_RUNBOOK.md](MD_OPERATOR_RUNBOOK.md) 和
> [MD2_REFACTOR_ORCHESTRATION.md](MD2_REFACTOR_ORCHESTRATION.md)。

本地目标路径：

```text
D:\learn\migration-guard-targets\md
```

## 1. 总结

本阶段已按 `MD_REAL_WORLD_VALIDATION_PLAN.md` 跑通 `perly6185-lab/md` 的真实项目闭环验证。

结论：

> Migration Guard 已能对 `md` 这种 pnpm + Vue + Vite + TypeScript monorepo 完成扫描、基线、验证、行为探针、migration run、动态任务图、local issues、checkpoint、adapter inventory、evidence log 和最终报告。

本阶段没有修改 `md` 源码。目标仓库最终状态保持干净：

```text
## main...origin/main
```

## 2. 环境和目标画像

本机环境：

- Node：`v22.19.0`
- pnpm：`10.5.2`
- corepack：`0.34.0`

目标项目声明要求：

- Node：`>=22.22.2`

说明：本机 Node 低于目标声明版本，但本轮 install、test、type-check、build 均已通过。该差异仍记录为环境风险，后续 CI/full validation 应使用 `v22.22.2` 或更高版本复验。

目标项目画像：

- package manager：`pnpm`
- workspace globs：`apps/*`、`packages/*`
- package count：11
- source files：477
- test files：14
- config inventory：18
- stack：Vue 3、Vite、Vitest、WXT、TypeScript、Wrangler/Hono

## 3. 新增实现

### 3.1 MD 专用配置

新增：

- `configs/md-fast.migration-guard.json`
- `configs/md-full.migration-guard.json`

fast config 覆盖：

- `pnpm --filter @md/core test`
- `pnpm type-check:packages`
- `md-renderer-behavior` probe

full config 覆盖：

- `pnpm --filter @md/core test`
- `pnpm --filter @md/web test`
- `pnpm type-check:packages`
- `pnpm type-check:web`
- `pnpm web build`
- `md-renderer-behavior` probe

### 3.2 Behavior Probe

新增：

- `scripts/probes/md-behavior-probe.mjs`

覆盖行为：

- `@md/core` Markdown renderer
- front matter parsing
- alert block rendering
- KaTeX block rendering
- script sanitization
- `apps/web` heading extraction
- heading breadcrumb calculation

probe 输出稳定 JSON，并通过 Migration Guard normalize 做排序对比。

### 3.3 `pnpm-vite-vue` Adapter

新增 adapter：

```text
pnpm-vite-vue
```

当前为 non-mutating adapter，只做真实 monorepo inventory 和风险 issue 生成，不修改目标项目源码。

产物：

- `pnpm-vite-vue-workspace.json`
- `pnpm-vite-vue-config-inventory.json`
- `pnpm-vite-vue-risk-report.json`

adapter 能力：

- workspace package graph
- package scripts graph
- workspace dependency detection
- Vite/Vitest/WXT/TypeScript config inventory
- stack signals
- high-risk file issue generation

## 4. 阶段执行结果

### Phase 11.1: External Target Harness

结果：完成。

执行：

```bash
git clone --depth 1 https://github.com/perly6185-lab/md.git D:\learn\migration-guard-targets\md
pnpm --dir D:\learn\migration-guard-targets\md install --no-frozen-lockfile --lockfile=false
```

说明：

- `--frozen-lockfile` 因 lockfile 配置不匹配失败。
- 使用 `--lockfile=false` 安装，避免修改目标 lockfile。
- 安装后目标仓库 git status 保持干净。

### Phase 11.2: MD Safety Config

结果：完成。

执行：

```bash
node dist/cli.js scan --config configs/md-fast.migration-guard.json
node dist/cli.js baseline --config configs/md-fast.migration-guard.json
node dist/cli.js verify --config configs/md-fast.migration-guard.json
```

结果：

- scan passed
- baseline passed
- verify passed
- compare passed

fast lane verify 结果：

- `core-test`: passed
- `packages-type-check`: passed
- `md-renderer-behavior`: passed

非阻断差异：

- `core-test` stdout changed while still passing

### Phase 11.3: Behavior Probes

结果：完成。

probe：

```bash
pnpm exec tsx D:/learn/migration-guard/scripts/probes/md-behavior-probe.mjs
```

验证结果：

- renderer probe passed
- front matter probe passed
- heading extraction probe passed
- probe baseline/verify 稳定

### Phase 11.4: Real Migration Run Dry Run

结果：完成。

执行：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Vite/Vue monorepo safety validation" --dry-run --adapter pnpm-vite-vue --issue-provider local
```

结果：

- migration run created
- task graph valid
- local issues generated
- evidence log generated
- initial report generated

### Phase 11.5: `pnpm-vite-vue` Adapter

结果：完成。

adapter artifacts：

- workspace inventory：11 packages
- config inventory：18 config files
- risk report：10 risk issues

生成的高风险 issue 包括：

- `apps/web/src/components/ai/image-generator/AIImageGeneratorPanel.vue`
- `apps/api/src/types.ts`
- `apps/web/src/components/ai/image-generator/AIImageConfig.vue`
- `apps/web/src/stores/ui.ts`
- `packages/core/src/renderer/renderer-impl.ts`
- `apps/web/src/components/ai/chat-box/AIAssistantPanel.vue`
- `apps/web/src/components/ai/SidebarAIToolbar.vue`
- `apps/web/src/components/editor/editor-header/ShareDialog.vue`
- `apps/web/src/components/ui/search-tab/SearchTab.vue`
- `apps/web/src/components/editor/CssEditor.vue`

### Phase 11.6: Controlled Execution Loop

结果：完成。

执行：

```bash
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
```

结果：

- `task-analyze`: done
- `task-baseline`: done
- `task-plan`: done
- `task-pnpm-vite-vue-workspace`: done
- `task-pnpm-vite-vue-configs`: done
- `task-pnpm-vite-vue-risks`: done
- `task-verify`: done
- `task-report`: done

fast run summary：

- status：completed
- tasks：8 done
- issues：19
- checkpoints：8
- target git status：clean

### Phase 11.7: Full Lane Validation

结果：完成。

执行：

```bash
node dist/cli.js baseline --config configs/md-full.migration-guard.json
node dist/cli.js verify --config configs/md-full.migration-guard.json
node dist/cli.js run --config configs/md-full.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Vite/Vue monorepo full-lane validation" --dry-run --adapter pnpm-vite-vue --issue-provider local
node dist/cli.js resume --config configs/md-full.migration-guard.json --run latest --auto
node dist/cli.js sync-issues --config configs/md-full.migration-guard.json --run latest --provider local
node dist/cli.js report --config configs/md-full.migration-guard.json --run latest
```

full lane baseline：

- `core-test`: passed
- `web-test`: passed
- `packages-type-check`: passed
- `web-type-check`: passed
- `web-build`: passed
- `md-renderer-behavior`: passed

full lane verify：

- `core-test`: passed
- `web-test`: passed
- `packages-type-check`: passed
- `web-type-check`: passed
- `web-build`: passed
- `md-renderer-behavior`: passed

compare result：passed

非阻断差异：

- `core-test` stdout changed while still passing
- `web-test` stdout changed while still passing
- `web-build` stdout changed while still passing
- `web-build` stderr changed while still passing

full run summary：

- status：completed
- tasks：8 done
- issues：19
- checkpoints：8
- issue sync export：generated
- final report：generated
- target git status：clean

## 5. 验证命令

Migration Guard 自身验证：

```bash
npm test
```

结果：

- 5 tests passed

目标项目验证：

```bash
node dist/cli.js baseline --config configs/md-full.migration-guard.json
node dist/cli.js verify --config configs/md-full.migration-guard.json
```

结果：

- passed

## 6. 结论

`perly6185-lab/md` 真实项目闭环已经打穿。

Migration Guard 现在可以在该真实 monorepo 上完成：

- 外部目标配置
- 扫描和风险识别
- fast/full baseline
- fast/full verify
- command behavior probe
- dynamic task graph
- non-mutating adapter inventory
- local issue generation
- checkpoint
- evidence log
- issue sync export
- final report

当前建议：

> 可以进入下一阶段：把 `pnpm-vite-vue` adapter 从“只读 inventory”扩展成“低风险自动修复建议 + 可选代码改写 dry-run”，但在真正改源码前，应先补 UI/HTTP probe 和更细的 adapter fixture 测试。

## 7. 后续建议

1. 增加 provider 实现：把 local issues 同步为真实 GitHub Issues。
2. 增加 Playwright 或 preview HTTP probe，覆盖 `apps/web` 页面级行为。
3. 为 `pnpm-vite-vue` adapter 增加 fixture tests。
4. 为 full lane 的 stdout/stderr warning 增加更细 normalize 策略。
5. 在 Node `>=22.22.2` 环境重新跑 full lane，消除 Node 版本风险。
