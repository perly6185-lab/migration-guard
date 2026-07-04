# `perly6185-lab/md` 真实项目闭环验证规划

目标仓库：https://github.com/perly6185-lab/md

## 1. 目标

使用 `perly6185-lab/md` 作为真实 monorepo 目标项目，验证 Migration Guard 是否能在大型同生态项目上跑通完整闭环：

```text
clone target
  -> configure Migration Guard
  -> scan
  -> baseline
  -> verify / compare
  -> migration run
  -> dynamic task graph
  -> local issues
  -> checkpoint
  -> evidence log
  -> report
```

本阶段目标不是强行做 `Webpack -> Vite`，因为 `md` 当前已经是 Vite/Vue/TS 项目。更合理的目标是：

> 打穿真实 pnpm + Vue + Vite + TypeScript monorepo 的迁移安全闭环，并为后续同生态自动迁移 adapter 做准备。

## 2. 目标项目初步画像

从 `perly6185-lab/md.git` 浅克隆观察到：

- 包管理器：`pnpm`
- Node 要求：`.nvmrc` 为 `v22.22.2`
- monorepo：`pnpm-workspace.yaml`
- workspace：
  - `apps/web`
  - `apps/api`
  - `apps/utools`
  - `apps/vscode`
  - `packages/core`
  - `packages/shared`
  - `packages/config`
  - `packages/mcp-server`
  - `packages/md-cli`
- 前端栈：
  - Vue 3
  - Vite 8
  - WXT
  - Vitest
  - vue-tsc
  - Cloudflare Worker / Wrangler
- 根脚本：
  - `pnpm type-check`
  - `pnpm test`
  - `pnpm web build`
  - `pnpm --filter @md/core test`
  - `pnpm --filter @md/web test`

## 3. 闭环验证策略

### 3.1 不直接污染目标仓库

目标仓库克隆到工作区外：

```text
D:\learn\migration-guard-targets\md
```

Migration Guard 的验证配置和 artifacts 建议放在 `migration-guard` 仓库的运行产物目录中，避免把 `.migration-guard/`、probe scripts 或 report 写进目标仓库。

建议约定：

```text
D:\learn\migration-guard\.migration-guard\external-targets\md
```

### 3.2 使用真实命令，但分层执行

`md` 的完整 build/test 可能较重，因此闭环分三层：

1. **Fast lane**
   - scan
   - selected package tests
   - selected type-check
   - migration run dry-run

2. **Standard lane**
   - root type-check
   - root test
   - core/web tests
   - report

3. **Full lane**
   - `pnpm web build`
   - optional preview / HTTP probes
   - optional UI probes

### 3.3 先验证安全能力，再验证自动迁移能力

本阶段不急于修改 `md` 源码。第一目标是让 Migration Guard 对真实 monorepo 具备可信观察能力：

- 能识别技术栈和风险文件
- 能建立基线
- 能重复验证
- 能记录 issue/checkpoint/evidence
- 能生成最终报告
- 能说明是否可以继续自动迁移

随后再增加 `pnpm-vite-vue` adapter，做低风险自动任务。

## 4. 阶段拆分

## Phase 11.1: External Target Harness

目标：让 Migration Guard 能稳定针对外部目标仓库运行。

任务：

- 增加 `docs/MD_REAL_WORLD_VALIDATION_PLAN.md`
- 准备本地目标路径约定
- 准备示例配置模板
- 记录 clone/install/run 命令

建议命令：

```bash
git clone --depth 1 https://github.com/perly6185-lab/md.git D:/learn/migration-guard-targets/md
corepack enable
pnpm --dir D:/learn/migration-guard-targets/md install --frozen-lockfile
```

验收：

- 目标仓库可克隆
- 能读取 `package.json`、`pnpm-workspace.yaml`
- 不向目标仓库提交任何 Migration Guard 产物

## Phase 11.2: MD Safety Config

目标：为 `md` 建立专用 Migration Guard 配置。

建议 checks：

```json
[
  {
    "name": "core-test",
    "command": "pnpm --filter @md/core test",
    "timeoutMs": 180000,
    "critical": true
  },
  {
    "name": "web-test",
    "command": "pnpm --filter @md/web test",
    "timeoutMs": 240000,
    "critical": true
  },
  {
    "name": "packages-type-check",
    "command": "pnpm type-check:packages",
    "timeoutMs": 240000,
    "critical": true
  },
  {
    "name": "web-type-check",
    "command": "pnpm type-check:web",
    "timeoutMs": 300000,
    "critical": true
  },
  {
    "name": "web-build",
    "command": "pnpm web build",
    "timeoutMs": 600000,
    "critical": false
  }
]
```

建议先把 `web-build` 设为 non-critical，等 fast/standard lane 稳定后再提升为 critical。

验收：

```bash
node dist/cli.js scan --config <md-config>
node dist/cli.js baseline --config <md-config>
node dist/cli.js verify --config <md-config>
```

必须产出：

- scan JSON
- baseline JSON
- run JSON
- compare JSON/Markdown

## Phase 11.3: Behavior Probes

目标：给 `md` 增加稳定行为探针，不只依赖 build/test。

优先探针：

1. **Markdown renderer probe**
   - 输入固定 Markdown
   - 调用 `@md/core` renderer
   - 输出 normalized HTML hash

2. **Front matter probe**
   - 输入含 front matter 的 Markdown
   - 验证 body、reading time、metadata

3. **Alert / Mermaid / KaTeX probe**
   - 覆盖 `packages/core/src/renderer`
   - 避免依赖浏览器

4. **Web heading parser probe**
   - 覆盖 `apps/web/src/lib/markdown`
   - 验证 heading extraction/navigation

实现策略：

- probe script 放在 Migration Guard artifacts 或临时目录，不提交到目标仓库
- 使用 `pnpm --dir <target> exec tsx <probe-script>`
- 输出 JSON，启用 `sortKeys` 和 `ignoreFields`

验收：

```bash
node dist/cli.js baseline --config <md-config>
node dist/cli.js verify --config <md-config>
```

probe diff 必须稳定为 0。

## Phase 11.4: Real Migration Run Dry Run

目标：用真实 `md` 仓库跑通 migration run。

建议目标：

```text
Vite/Vue monorepo safety validation
```

建议命令：

```bash
node dist/cli.js run \
  --config <md-config> \
  --source D:/learn/migration-guard-targets/md \
  --target D:/learn/migration-guard-targets/md \
  --goal "Vite/Vue monorepo safety validation" \
  --dry-run \
  --issue-provider local
```

随后执行：

```bash
node dist/cli.js status --config <md-config> --run latest
node dist/cli.js tasks --config <md-config> --run latest
node dist/cli.js issues --config <md-config> --run latest
node dist/cli.js checkpoint create --config <md-config> --run latest
node dist/cli.js report --config <md-config> --run latest
```

验收：

- `task-graph.json` 有效
- `issues.json` 生成
- `evidence.jsonl` 生成
- checkpoint 生成
- report 能说明当前状态和下一步

## Phase 11.5: `pnpm-vite-vue` Adapter

目标：新增一个适合 `md` 的同生态 adapter，而不是复用 `js-vite`。

Adapter 名称建议：

```text
pnpm-vite-vue
```

初版只做分析和低风险任务：

- workspace package graph
- package scripts graph
- Vite config inventory
- Vitest config inventory
- TypeScript project references / tsconfig inventory
- Vue/Vite/WXT/Cloudflare 特性识别
- 高风险模块排序
- 迁移建议 issue 生成

暂不自动改源码。

验收：

```bash
node dist/cli.js run \
  --config <md-config> \
  --source D:/learn/migration-guard-targets/md \
  --target D:/learn/migration-guard-targets/md \
  --goal "Vite/Vue monorepo safety validation" \
  --dry-run \
  --adapter pnpm-vite-vue
```

必须生成：

- workspace graph artifact
- config inventory artifact
- risk issue list
- adapter report

## Phase 11.6: Controlled Execution Loop

目标：在不破坏目标仓库的前提下验证执行闭环。

可执行任务：

- run analyze task
- run baseline task
- run plan task
- run verify task
- run report task

避免第一轮自动修改源码。

建议命令：

```bash
node dist/cli.js task run --config <md-config> --run latest --task task-analyze
node dist/cli.js task run --config <md-config> --run latest --task task-baseline
node dist/cli.js task run --config <md-config> --run latest --task task-plan
node dist/cli.js task run --config <md-config> --run latest --task task-verify
node dist/cli.js task run --config <md-config> --run latest --task task-report
```

验收：

- 每个 task 状态能推进
- 失败时生成 failure issue
- report 能包含失败原因和下一步
- target git status 不因 artifacts 变脏

## Phase 11.7: Full Lane Validation

目标：让 `md` 的完整验证命令进入 Migration Guard report。

包含：

- `pnpm type-check`
- `pnpm test`
- `pnpm web build`
- optional `pnpm vscode:test`

验收：

```bash
node dist/cli.js baseline --config <md-full-config>
node dist/cli.js verify --config <md-full-config>
node dist/cli.js report --config <md-full-config> --run latest
```

完成标准：

- 全量命令能稳定完成，或失败被清楚记录为环境/依赖问题
- compare report 可读
- final report 能判断：
  - 是否适合进入自动迁移
  - 哪些 checks 必须先修
  - 哪些 probes 仍缺失

## 5. 预期产物

代码侧：

- `pnpm-vite-vue` adapter
- 外部目标运行配置能力增强
- task graph 针对 monorepo 的任务生成
- probe script 支持或示例
- 更强 report 输出

文档侧：

- `docs/MD_REAL_WORLD_VALIDATION_PLAN.md`
- `docs/MD_REAL_WORLD_VALIDATION_REPORT.md`

运行产物：

- scan report
- baseline/run/compare
- migration run state
- task graph
- issues
- checkpoints
- evidence log
- final report

## 6. 风险和处理

### Node 版本

`md` 要求 Node `>=22.22.2`。如果本地版本不满足，先不跑 full lane，只跑 scan 和 dry-run。

### pnpm install 成本

依赖较多，第一次安装可能慢。规划上先跑 scan/dry-run，再进入 install/test/build。

### 构建环境

Cloudflare/Wrangler/WXT 相关命令可能依赖本地环境。先把这些设为 non-critical，避免环境问题遮蔽 Migration Guard 自身能力。

### 目标仓库污染

所有 Migration Guard artifacts 应写到外部目录。目标仓库只允许在专门的 controlled execution 阶段出现可解释的源码变更。

## 7. 本阶段完成定义

本阶段完成时，应满足：

1. `md` 仓库可被 Migration Guard 扫描并生成风险摘要。
2. `md` 的 fast lane baseline/verify 可稳定通过或明确失败原因。
3. 至少 2 个 behavior probes 稳定运行。
4. `run --dry-run` 能生成 task graph、issues、evidence 和 report。
5. checkpoint create/list 能针对 `md` 正常运行。
6. `pnpm-vite-vue` adapter 能生成 workspace/config/risk artifacts。
7. 最终生成 `MD_REAL_WORLD_VALIDATION_REPORT.md`。
8. 整个过程不污染目标仓库，或所有目标仓库变更都能被 checkpoint/report 解释。
