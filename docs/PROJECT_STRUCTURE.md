# Migration Guard 项目骨架

Migration Guard 是一个面向重构和迁移场景的行为一致性验证工具。第一阶段采用 Node.js + TypeScript 实现，定位为 CLI 工具，不直接自动大规模改写源码，而是为人类和 AI 的迁移动作提供基线、验证、对比和审计护栏。

## 推荐源码结构

```text
migration-guard/
  package.json
  tsconfig.json
  README.md
  .gitignore
  .migration-guard.json

  docs/
    DEVELOPMENT_PHASES.md
    MD_REAL_WORLD_VALIDATION_PLAN.md
    MD_REAL_WORLD_VALIDATION_REPORT.md
    PHASE_COMPLETION_REPORT.md
    PHASE_12_REPORT.md
    PHASE_13_REPORT.md
    PHASE_14_REPORT.md
    PHASE_15_REPORT.md
    PHASE_16_REPORT.md
    PHASE_17_REPORT.md
    PHASE_18_20_REPORT.md
    PHASE_21_REPORT.md
    PHASE_22_REPORT.md
    PHASE_23_REPORT.md
    PHASE_24_REPORT.md
    PHASE_25_REPORT.md
    PHASE_26_REPORT.md
    PHASE_28_REPORT.md
    PHASE_29_REPORT.md
    PRODUCT_DESIGN.md
    PROJECT_STRUCTURE.md
    REQUIREMENTS.md

  configs/
    md-fast.migration-guard.json
    md-full.migration-guard.json

  scripts/
    probes/
      md-behavior-probe.mjs
    smoke/
      create-failing-proposal-batch.mjs

  src/
    cli.ts
    types.ts

    core/
      aiBrief.ts
      actionPlan.ts
      checkNormalize.ts
      checkpoint.ts
      compare.ts
      config.ts
      contract.ts
      exec.ts
      executor.ts
      files.ts
      hash.ts
      githubIssueAdapter.ts
      issueSync.ts
      markdown.ts
      migrationRun.ts
      normalize.ts
      plan.ts
      patch.ts
      preview.ts
      probes.ts
      scan.ts
      snapshot.ts
      taskGraph.ts

      compare.test.ts
      checkNormalize.test.ts
      config.test.ts
      normalize.test.ts
      patch.test.ts
      taskGraph.test.ts

  dist/
    # TypeScript 编译产物
```

## 运行时 artifacts 结构

`.migration-guard/` 是工具运行时生成的目录，默认不提交到仓库。

```text
.migration-guard/
  latest-baseline.json
  latest-run.json
  migration-plan.md

  baselines/
    baseline-*.json

  runs/
    run-*.json

  compare/
    *.json
    *.md

  scan/
    *.json

  ai/
    brief-*.md
    latest-brief.md

  migration-runs/
    run-*/
      run.json
      estimate.json
      task-graph.json
      issues.json
      evidence.jsonl
      checkpoints/
```

## 核心模块职责

### `docs/PRODUCT_DESIGN.md`

长期产品设计文档，描述 Migration Guard 如何从当前行为一致性护栏演进为大仓库 AI 自治迁移执行系统。

重点包括：

- source project / target project
- migration run
- dynamic task graph
- checkpoint / rollback
- issue 管控层
- evidence log
- planner / replanner
- full-auto large-repo migration roadmap

### `src/cli.ts`

CLI 入口，负责命令分发和用户交互。

计划支持命令：

```bash
migration-guard init
migration-guard scan
migration-guard baseline
migration-guard verify
migration-guard compare
migration-guard plan
migration-guard ai-brief
```

### `src/types.ts`

集中定义配置、扫描结果、检查结果、行为探针、快照、差异报告等核心类型。

核心类型包括：

- `MigrationGuardConfig`
- `CheckConfig`
- `BehaviorProbeConfig`
- `Snapshot`
- `ScanSummary`
- `CompareReport`
- `Difference`

### `src/core/config.ts`

负责读取、初始化和合并 `.migration-guard.json`。

主要职责：

- 创建默认配置
- 查找配置文件
- 解析目标项目根目录
- 解析 artifacts 输出目录

### `src/core/scan.ts`

负责只读扫描目标项目。

主要产出：

- 文件数量
- 源码文件数量
- 测试文件数量
- 代码行数
- 包管理器识别
- 技术栈线索
- import 依赖边
- 高风险文件列表

高风险文件判断维度：

- 文件体积较大
- 被多个模块引用
- 缺少邻近测试
- 位于共享模块或核心链路

### `src/core/probes.ts`

负责执行行为验证项。

支持两类探针：

- command probe：执行脚本或命令，采集标准输出
- HTTP probe：请求接口，采集响应状态码和响应体

探针输出会经过 normalize 后计算 hash，用于迁移前后对比。

### `src/core/normalize.ts`

负责消除无意义差异。

支持能力：

- 去除 ANSI 颜色码
- 统一换行
- trim 空白
- JSON key 排序
- 忽略时间戳、随机 ID 等不稳定字段

### `src/core/checkNormalize.ts`

负责 checks stdout/stderr 的输出降噪。

支持能力：

- 去除 ANSI 颜色码
- 统一换行和 trim
- 归一化 Vitest/Vite/timing/path 噪音
- 通过自定义正则替换处理项目特定输出

### `src/core/snapshot.ts`

负责采集和保存快照。

快照分为两类：

- baseline：迁移前的行为基线
- run：迁移后的验证结果

每个快照包含：

- 扫描摘要
- checks 结果
- probes 结果
- 配置 hash
- 创建时间

### `src/core/compare.ts`

负责比较 baseline 和 run。

比较维度：

- check 是否从 passed 变为 failed
- probe 状态是否变化
- probe normalize 后的输出 hash 是否变化
- 配置是否变化
- 源码文件数量是否变化

差异级别：

- `error`：会阻断迁移继续推进
- `warn`：需要 review，但不一定阻断
- `info`：上下文变化提示

### `src/core/aiBrief.ts`

负责生成 AI 迁移上下文包。

AI brief 包含：

- 项目扫描摘要
- 高风险文件
- 当前 checks
- 当前 behavior probes
- 最新 baseline/run/compare 结果
- AI 操作规则
- 推荐下一步迁移任务
- 可复制给 AI 的提示词模板

AI 不直接绕过验证流程。AI 每次迁移动作后必须回到 `verify` 和 `compare`。

### `src/core/actionPlan.ts`

负责读取和渲染 adapter 生成的 action plan。

主要职责：

- 定位 run 内的 action plan artifact
- 加载 `MigrationActionPlan`
- 为 CLI 输出可读 action 摘要

### `src/core/migrationRun.ts`

负责自治迁移运行时的状态管理。

主要职责：

- 创建和加载 migration run
- 保存 `run.json`、`task-graph.json`、`issues.json`
- 追加 evidence log
- 渲染 status、issues、report
- 维护 latest migration run 指针

### `src/core/taskGraph.ts`

负责动态任务图。

主要职责：

- 根据 scan 和 goal 生成初始 task graph
- 校验 DAG 是否有缺失依赖或环
- 计算 ready tasks
- 更新任务状态
- 在失败时插入 replanning task

### `src/core/executor.ts`

负责执行任务节点。

主要职责：

- 执行 analyze、baseline、plan、verify、report 等 engine task
- 执行手动/AI 任务的记录路径
- 执行 JS/Vite adapter 的保守迁移任务
- 验证失败时创建 failure issue 并触发 replan

### `src/core/checkpoint.ts`

负责 checkpoint、resume 和 rollback 所需的文件证据。

主要职责：

- 捕获 git status 和 git diff patch
- 保存 checkpoint metadata
- 显式 rollback 时反向应用 checkpoint patch

### `src/core/issueSync.ts`

负责 issue 管控层导出。

主要职责：

- 导出本地 issue JSON
- 为 GitHub/GitLab/Jira/Linear 生成 provider-neutral issue export
- 为 GitHub live sync 写出 live plan 和 summary
- 为 GitHub live-plan 写出只读计划和 summary
- 写入同步 evidence

### `src/core/githubIssueAdapter.ts`

负责 GitHub issue live adapter。

主要职责：

- 校验 `owner/name` repo 格式
- 查询 open issue 并按 `mg_issue_id` 匹配
- 为 create/update/skip 写出 live plan 数据
- 用正文 SHA-256 跳过 unchanged issue
- 对 changed issue PATCH，对 missing issue POST
- 限制单次 live mutation 数量
- 记录 GitHub rate-limit 非敏感 header
- 对 429/5xx transient failure 做 retry

### `src/core/patch.ts`

负责 task proposal 和 patch apply 流程。

主要职责：

- 为任务生成 dry-run patch proposal
- 记录 affected files 和 recommended checks
- 对真实 git patch 执行 `git apply --check`
- 对 non-mutating proposal 执行 no-op apply 并写入 evidence
- 从 action plan 生成真实 probe patch
- 执行 proposal verify/apply verification gate
- 写出 proposal verification report
- 跟踪 proposal lifecycle status
- 执行 proposal rollback 并写出 rollback report
- 为 UI action 生成 Playwright-first/fetch-fallback probe patch
- 在 proposal apply gate 中接入 managed preview server
- 生成结构化 proposal `checkPlan`
- 写出 proposal gate `timeline`
- gate 失败时创建 replan/failure issue

### `src/core/preview.ts`

负责 preview/HTTP smoke probe 和托管 preview server 生命周期。

主要职责：

- 启动目标项目 dev/preview command
- 等待目标 URL ready
- 为 checks 注入 `MG_PREVIEW_URL`
- 捕获 preview stdout/stderr
- 写出 preview probe JSON
- checks 完成后清理启动命令的进程树

### `src/core/contract.ts`

负责跨语言行为复刻基础能力。

主要职责：

- 捕获 HTTP contract corpus
- 双跑 source/target 并对比状态码和响应体
- 对 target 重放 contract test

### `src/core/plan.ts`

根据扫描结果生成迁移计划。

计划阶段：

1. 锁定当前行为
2. 强化验证体系
3. 先迁移低风险叶子模块
4. 再迁移共享模块
5. 清理兼容层

### `src/core/markdown.ts`

负责把扫描结果、对比结果和快照摘要渲染成 Markdown。

### `src/core/exec.ts`

负责安全执行 shell 命令。

能力包括：

- 超时控制
- stdout/stderr 捕获
- 输出截断
- 退出码记录
- Windows 隐藏子进程窗口

### `src/core/files.ts`

文件系统工具函数。

主要能力：

- 读写 JSON
- 读写文本
- 创建目录
- 判断路径是否存在
- 路径标准化

## 配置文件结构

`.migration-guard.json` 示例：

```json
{
  "schemaVersion": 1,
  "targetRoot": ".",
  "artifactsDir": ".migration-guard",
  "ignore": [
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".migration-guard"
  ],
  "checks": [
    {
      "name": "typecheck",
      "command": "npm run typecheck --if-present",
      "timeoutMs": 120000,
      "critical": true
    },
    {
      "name": "test",
      "command": "npm test --if-present",
      "timeoutMs": 120000,
      "critical": true
    },
    {
      "name": "build",
      "command": "npm run build --if-present",
      "timeoutMs": 180000,
      "critical": true
    }
  ],
  "probes": [],
  "output": {
    "maxOutputBytes": 262144
  },
  "compare": {
    "failOnCheckRegression": true,
    "failOnProbeDiff": true
  }
}
```

## 行为一致性主流程

```text
初始化配置
  -> 扫描项目
  -> 配置 checks 和 probes
  -> 采集 baseline
  -> 人类或 AI 做一个小迁移动作
  -> verify 采集 run
  -> compare 对比 baseline 和 run
  -> 处理差异
  -> 进入下一步迁移
```

## AI 协作流程

```text
migration-guard baseline
  -> migration-guard ai-brief
  -> AI 阅读 brief 并声明本次迁移范围
  -> AI 做一个小改动
  -> migration-guard verify
  -> compare report 决定是否继续
```

AI 的职责：

- 读懂代码和迁移目标
- 提出小步改造方案
- 执行局部重构
- 解释差异

Migration Guard 的职责：

- 固定迁移前行为
- 执行验证命令
- 采集行为输出
- 对比迁移前后差异
- 输出可审计证据

人类的职责：

- 决定迁移目标
- 审核高风险改动
- 批准 intentional behavior change
- 补充业务语义和关键样本
