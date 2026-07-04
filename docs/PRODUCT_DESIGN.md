# Migration Guard 产品工具设计

## 1. 产品愿景

Migration Guard 的长期目标不是只做代码扫描器，也不是简单的 codemod 包装器，而是：

> 面向大型代码仓库迁移的 AI 自治执行系统。用户提交迁移目标后，工具自动完成仓库理解、估算、规划、执行、验证、回溯、动态重规划和最终报告。

用户体验上应尽量接近：

```bash
migration-guard run --source ./legacy-app --target ./modern-app --goal "Webpack to Vite" --auto
```

系统内部不能是一把梭改完整仓，而应是可恢复、可验证、可插入任务的长事务：

```text
Analyze -> Estimate -> Plan -> Baseline -> Execute -> Verify -> Replan -> Continue
                                                           ^                  |
                                                           |__________________|
```

最终目标是一次启动后自动迁移完整大仓库；工程实现上通过多阶段任务图、checkpoint、issue 管控、证据日志和持续验证来保证质量。

## 2. 设计原则

### 2.1 用户看到一次迁移，系统执行多轮闭环

用户不需要手动拆几十个迁移步骤。工具内部负责把迁移目标拆成动态任务图，并在执行中不断插入、合并、暂停、回滚或重排任务。

### 2.2 计划是运行时状态，不是一次性文档

大仓迁移无法靠初始计划预测所有问题。计划必须在以下事件后更新：

- 构建失败
- 测试失败
- 类型错误新增
- 行为探针差异
- 依赖冲突
- 文件影响范围扩大
- AI 执行结果偏离预期
- 用户批准或拒绝某个差异

### 2.3 Issue 是管控层，不是唯一状态机

Issue 很适合做人机协作、进度展示和审计记录，但不适合承担 DAG 调度、checkpoint、锁、结构化验证结果和恢复上下文。

因此系统应采用：

```text
Migration Engine
  维护真实 run state、task graph、checkpoint、evidence log

Issue Layer
  将任务、风险、差异、失败、决策和报告同步到 GitHub/GitLab/Jira/Linear
```

早期可以先做本地 issue store，再接外部平台。

### 2.4 自动执行必须受验证门禁约束

AI 可以理解和改代码，但每一轮修改都必须回到验证系统：

- checks
- probes
- tests
- build
- typecheck
- lint
- API contract diff
- UI snapshot diff
- behavior baseline compare

不能通过删除测试、弱化探针、隐藏错误来让迁移看起来成功。

## 3. 核心概念

### 3.1 Source Project

迁移来源项目，可以是：

- 同仓库旧分支
- 同仓库当前工作区
- 独立旧项目目录
- 旧服务地址

Source Project 提供：

- 原始代码
- 原始依赖
- 运行脚本
- 测试和探针
- 行为基线
- API 或页面行为样本

### 3.2 Target Project

迁移目标项目，可以是：

- 同仓库迁移分支
- 独立目标目录
- 新服务实现
- 新框架或新语言项目

Target Project 承载自动改写、重构和验证结果。

同语言迁移时，source 和 target 常常是同一个仓库的不同分支或工作区。跨语言迁移时，source 和 target 通常是两个项目。

### 3.3 Migration Run

一次完整迁移任务的总控对象。

它记录：

- 迁移目标
- source/target 信息
- 初始估算
- 当前状态
- 动态任务图
- checkpoint 列表
- 验证结果
- issue 映射
- 预算与实际消耗
- 最终报告

### 3.4 Dynamic Task Graph

迁移任务不是线性列表，而是动态 DAG。

每个任务节点包含：

- 任务类型
- 输入和输出
- 修改范围
- 前置依赖
- 风险等级
- 执行策略
- 验收标准
- 关联 checkpoint
- 关联 issue
- 失败后的重规划策略

任务图可以在执行中新增节点。例如：

```text
Task: migrate webpack aliases to Vite
  -> verify build failed
  -> insert task: align tsconfig paths with Vite aliases
  -> insert task: replace webpack-only env variables
  -> retry original verification
```

### 3.5 Evidence Log

证据日志记录每个重要决策和结果：

- 为什么创建这个任务
- AI 根据哪些上下文修改了哪些文件
- 哪个验证失败
- 差异是否被批准
- 为什么回滚
- 为什么重新规划
- 最终哪些风险仍然存在

长时间大仓迁移必须有证据链，否则迁移完成后无法判断结果是否可信。

### 3.6 Checkpoint

checkpoint 是可恢复点，至少应记录：

- git 状态或 patch
- task graph 状态
- issue 状态
- 最新验证结果
- artifact 路径
- AI 上下文摘要

失败时可以局部回退某个任务，也可以回退到上一组验证通过的 checkpoint。

### 3.7 Difference Allowlist

迁移不一定要求所有输出完全一致。预期差异需要显式记录：

- 差异位置
- 差异类型
- 原因
- 批准人或批准来源
- 生效范围
- 过期条件

未进入白名单的关键行为差异默认视为迁移风险。

## 4. 产品架构

```text
CLI / Dashboard
  |
  v
Migration Run Controller
  |
  +-- Repository Analyzer
  +-- Estimator
  +-- Planner / Replanner
  +-- Dynamic Task Graph
  +-- AI Execution Adapter
  +-- Verification Engine
  +-- Checkpoint Manager
  +-- Issue Sync Layer
  +-- Evidence Log
  +-- Report Generator
```

### 4.1 Migration Run Controller

总控运行循环：

```text
load run state
analyze current source/target state
update estimate
select next ready task
execute task
verify task outcome
compare with baseline
record evidence
update issue
replan when needed
repeat until completion criteria are met
```

### 4.2 Repository Analyzer

负责读懂仓库：

- 技术栈识别
- 包管理器识别
- 构建脚本识别
- 测试脚本识别
- 文件结构扫描
- import/call graph
- 高风险文件
- 框架配置
- 迁移目标差距

后续通过语言/框架适配器增强：

- JS/TS adapter
- Vue adapter
- React adapter
- Node adapter
- Java adapter
- Python adapter
- Go adapter

### 4.3 Estimator

负责给出迁移预期：

- 影响文件数
- 任务数量
- 风险等级
- 预计验证轮数
- 预计耗时
- 预计 AI 调用预算
- 当前置信度

估算应在执行过程中持续更新。

### 4.4 Planner / Replanner

Planner 生成初始任务图，Replanner 根据运行结果动态改图。

常见重规划触发器：

- 任务失败
- 验证失败
- 行为差异
- 依赖冲突
- 修改范围扩大
- 用户决策
- 预算超限
- 发现缺失测试或探针

### 4.5 AI Execution Adapter

负责把任务转成 AI 可执行上下文，并约束 AI 输出。

AI 执行前需要：

- 任务目标
- 修改范围
- 禁止事项
- 相关文件
- 当前验证结果
- 回滚点

AI 执行后需要：

- 修改摘要
- 影响文件
- 风险说明
- 建议验证命令
- 若失败，给出修复假设

### 4.6 Verification Engine

当前项目已有的 baseline、verify、compare 是 Verification Engine 的基础。

后续应扩展：

- API contract diff
- Playwright 页面快照
- screenshot diff
- bundle size diff
- 数据库读写样本
- 双跑对比
- 跨语言契约测试

### 4.7 Issue Sync Layer

将内部任务同步成 issue，供人类查看和协作。

支持顺序建议：

1. Local issue store
2. GitHub Issues
3. GitLab Issues
4. Jira
5. Linear

Issue 同步应是双向的：

- 引擎创建/更新 issue
- 用户在 issue 中批准差异、补充信息、标记阻塞
- 引擎读取这些决策并更新 run state

## 5. Issue 管控模型

### 5.1 Issue 层级

```text
Epic Issue: Migration Run
  Phase Issue: Analyze
  Phase Issue: Baseline
  Phase Issue: Execute
  Phase Issue: Verify
  Phase Issue: Stabilize
  Phase Issue: Final Report

Task Issue:
  具体可执行任务

Risk Issue:
  风险、阻塞、人工决策

Diff Issue:
  行为差异、白名单申请

Failure Issue:
  验证失败、构建失败、测试失败
```

### 5.2 Issue 状态

```text
discovered
planned
ready
running
changed
verifying
failed
replanned
blocked
rolled-back
accepted-diff
done
```

### 5.3 Issue 字段

每个 issue 应至少包含：

- run id
- task id
- issue type
- source project
- target project
- migration goal
- priority
- risk level
- owner: ai | human | engine
- affected files
- depends on
- checkpoint id
- verification commands
- latest result
- evidence links
- external issue id

本地存储可以使用结构化 JSON，外部平台 issue 正文中保留机器可读 front matter：

```yaml
---
mg_run_id: run-20260704-001
mg_task_id: task-vite-alias-003
mg_issue_type: task
mg_status: verifying
mg_risk: medium
mg_owner: ai
mg_checkpoint: cp-0007
---
```

## 6. 迁移生命周期

### 6.1 启动

输入：

- source project
- target project
- migration goal
- 约束条件
- 自动化等级
- 预算上限
- 验收标准

示例：

```bash
migration-guard run --source ./legacy-web --target ./legacy-web --goal "migrate webpack to vite" --auto --issue-provider local
```

### 6.2 理解和估算

产物：

- scan summary
- stack hints
- dependency graph
- risk files
- migration gap analysis
- estimate report
- initial issue set

### 6.3 初始规划

产物：

- dynamic task graph v1
- phase issues
- task issues
- verification strategy
- rollback strategy

### 6.4 基线采集

产物：

- latest baseline
- protected behaviors list
- missing probes recommendation
- baseline issue update

### 6.5 自动执行

每轮：

```text
pick next ready task
create checkpoint
build AI context
apply changes
run focused verification
run broader verification when needed
compare with baseline
update evidence
update issue
decide continue/replan/rollback/block
```

### 6.6 动态重规划

重规划结果可以是：

- 插入新任务
- 拆分当前任务
- 合并重复任务
- 提高某任务优先级
- 标记任务需要人工确认
- 回滚某个任务
- 调整验收标准
- 更新预算和预计剩余时间

### 6.7 收敛和交付

完成条件不是“任务列表为空”，而是：

- 目标技术栈迁移完成
- 所有 critical checks 通过
- 关键 probes 通过
- 行为差异均已解决或进入白名单
- 高风险 issue 清零或明确标注
- 最终报告生成
- target project 处于可合并状态

## 7. CLI 设计草案

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --auto
migration-guard status --run latest
migration-guard issues --run latest
migration-guard resume --run latest
migration-guard pause --run latest
migration-guard report --run latest
migration-guard sync-issues --run latest --provider github
```

当前已有命令仍然保留为底层能力：

```bash
migration-guard scan
migration-guard baseline
migration-guard verify
migration-guard compare
migration-guard plan
migration-guard ai-brief
```

长期关系：

```text
run
  calls scan/baseline/plan/ai-brief/verify/compare repeatedly
```

## 8. Artifact 设计草案

```text
.migration-guard/
  migration-runs/
    run-*/
      run.json
      estimate.json
      task-graph.json
      issues.json
      evidence.jsonl
      checkpoints/
        cp-*/
          metadata.json
          patch.diff
          verification.json
      baselines/
      verifications/
      reports/
        final-report.md
```

## 9. 阶段路线图

### Phase 1: Safety Core

当前仓库已经在做这一层：

- scan
- baseline
- verify
- compare
- plan
- ai-brief
- probes
- reports

目标：先证明迁移前后行为差异可被捕获。

### Phase 2: Run State + Local Issues

新增：

- migration run
- local issue store
- task status
- evidence log
- estimate report
- status/report 命令

目标：把单次验证工具升级为可跟踪的迁移运行系统。

### Phase 3: Dynamic Task Graph

新增：

- 任务 DAG
- task dependency
- checkpoint
- replanning trigger
- failure issue
- diff issue

目标：支持执行中插入新任务和动态调整计划。

### Phase 4: AI Executor for Same-Ecosystem Migration

优先支持：

- Webpack -> Vite
- JS -> TS
- Vue2 -> Vue3
- React class -> Hooks
- Node framework upgrade

目标：同生态迁移可以自动执行、自动验证、自动修复。

### Phase 5: Full Auto Large-Repo Migration

能力：

- 一次启动
- 长时间运行
- 自动 checkpoint
- 自动修复
- 自动重规划
- issue 同步
- 最终质量报告

目标：用户提交目标后，工具自动完成大仓库迁移。

### Phase 6: Cross-Language Behavior Replay

跨语言迁移重点从代码改写转为行为复刻：

- 行为基线提取
- 契约测试生成
- 数据模型映射
- 接口兼容检查
- 双跑对比
- 差异白名单
- 分阶段切流

目标：自动重建目标语言系统，并证明关键行为保持一致。

## 10. MVP 调整建议

当前 MVP 不需要立刻做全自动改写，但应尽早调整底层抽象：

1. 在 artifacts 中引入 `migration-runs/run-*` 目录，避免和当前验证快照 `runs/run-*.json` 混淆。
2. 增加 `MigrationRun`、`MigrationTask`、`MigrationIssue`、`EvidenceEvent` 类型。
3. 让 `plan` 输出结构化 task graph，而不仅是 Markdown。
4. 让 `ai-brief` 可以针对某个 task 生成上下文。
5. 增加本地 issue store，先不依赖 GitHub/Jira。
6. 增加 `status` 和 `report` 命令。
7. 后续再让 `run --auto` 调用这些底层能力循环执行。

这样既不破坏现有“行为一致性护栏”的稳健定位，又能自然演进到“全自动大仓迁移执行系统”。
