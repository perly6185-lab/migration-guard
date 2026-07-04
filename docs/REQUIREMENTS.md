# Migration Guard 需求文档

## 1. 背景

重要项目在重构或迁移时，最大的风险不是代码无法编译，而是业务行为发生了不易察觉的偏移。

典型风险包括：

- 空值、默认值、异常处理变化
- 金额、日期、排序、分页逻辑变化
- 权限判断变化
- 接口响应结构变化
- 状态流转变化
- 第三方库升级后的隐性行为变化
- AI 或人工重构引入的局部逻辑漂移

Migration Guard 的目标是为重构和迁移过程提供行为一致性护栏。

## 2. 产品定位

Migration Guard 是一个面向重构和迁移场景的 CLI 工具。

它不是第一优先级的自动代码改写器，而是迁移过程的验证指挥台。

核心问题：

> 每一次迁移动作之后，我们如何证明受保护的行为没有变？

长期产品方向是把这个验证指挥台演进为面向大仓库的 AI 自治迁移执行系统：

> 用户提交 source project、target project 和迁移目标后，工具自动完成理解、估算、规划、执行、验证、回溯、动态重规划和最终报告。

因此当前 MVP 的 baseline、verify、compare、plan、ai-brief 不是一次性工具，而是未来 `run --auto` 长任务循环中的安全内核。完整产品设计见 `docs/PRODUCT_DESIGN.md`。

## 3. 核心目标

### 3.1 行为基线

在迁移开始前，采集当前项目的行为基线。

基线内容包括：

- 构建结果
- 测试结果
- 类型检查结果
- lint 结果
- 命令探针输出
- HTTP 接口探针输出
- 项目扫描摘要

### 3.2 迁移后验证

每次迁移动作后重新执行相同检查和探针，生成新的 run 快照。

### 3.3 差异对比

对比 baseline 和 run，识别行为漂移。

差异分为：

- 阻断级差异：关键检查失败、关键行为探针输出变化
- 警告级差异：检查仍通过但输出变化
- 信息级差异：配置、文件数量等上下文变化

### 3.4 AI 协作

支持 AI 参与迁移，但必须受验证流程约束。

AI 可用于：

- 理解项目结构
- 分析高风险文件
- 生成迁移计划
- 执行小步重构
- 解释 compare 差异
- 推荐补充测试和探针

AI 不应直接绕过：

- baseline
- verify
- compare
- 人类对 intentional behavior change 的确认

## 4. 用户角色

### 4.1 项目负责人

关心迁移风险、进度和可回滚性。

需要看到：

- 当前迁移阶段
- 哪些行为被保护
- 哪些模块高风险
- 每一步是否通过验证

### 4.2 开发者

负责实际迁移代码。

需要看到：

- 本次应该改哪里
- 改动影响范围
- 应运行哪些验证
- 差异是否可接受

### 4.3 AI 迁移助手

负责辅助理解和执行小步迁移。

需要看到：

- 项目上下文
- 高风险文件
- 操作规则
- 当前 baseline/run/compare 证据
- 禁止事项

## 5. MVP 范围

### 5.1 必须支持

#### 初始化配置

命令：

```bash
migration-guard init
```

能力：

- 创建 `.migration-guard.json`
- 写入默认 checks
- 设置 artifacts 输出目录

#### 项目扫描

命令：

```bash
migration-guard scan
```

能力：

- 扫描文件结构
- 识别源代码文件
- 识别测试文件
- 统计代码行数
- 识别包管理器
- 识别技术栈线索
- 构建 JS/TS import 依赖图
- 输出高风险文件

#### 行为基线

命令：

```bash
migration-guard baseline
```

能力：

- 执行 checks
- 执行 probes
- 生成 baseline 快照
- 保存 latest baseline

#### 迁移后验证

命令：

```bash
migration-guard verify
```

能力：

- 执行相同 checks 和 probes
- 生成 run 快照
- 自动和 latest baseline 对比
- 输出 compare report
- 遇到阻断级差异时返回非 0 exit code

#### 快照对比

命令：

```bash
migration-guard compare
```

能力：

- 对比指定 baseline 和 run
- 输出 JSON 和 Markdown 报告

#### 迁移计划

命令：

```bash
migration-guard plan
```

能力：

- 根据扫描结果生成迁移阶段建议
- 标出高风险文件
- 给出验证优先级建议

#### AI 上下文包

命令：

```bash
migration-guard ai-brief
```

能力：

- 汇总项目扫描结果
- 汇总 checks 和 probes
- 汇总 latest baseline/run/compare
- 输出 AI 操作规则
- 输出推荐下一步任务
- 生成可复制给 AI 的提示词

### 5.2 暂不支持

MVP 阶段暂不做：

- 自动大规模代码改写
- 自动提交 git commit
- 自动部署
- 自动批准行为变化
- 复杂 UI 控制台
- 云端项目管理
- 多语言 AST 深度解析

但底层设计应为后续全自动迁移预留：

- migration run 状态
- 动态 task graph
- checkpoint / resume / rollback
- issue 管控层
- evidence log
- planner / replanner
- AI executor adapter

## 6. 行为探针需求

### 6.1 Command Probe

用于验证函数、脚本、CLI、数据转换等确定性行为。

示例：

```json
{
  "type": "command",
  "name": "pricing-rules",
  "command": "node scripts/print-pricing-cases.js",
  "timeoutMs": 30000,
  "normalize": {
    "stripAnsi": true,
    "trimWhitespace": true,
    "lineEndings": "lf",
    "json": {
      "sortKeys": true,
      "ignoreFields": ["generatedAt"]
    }
  }
}
```

### 6.2 HTTP Probe

用于验证接口行为。

示例：

```json
{
  "type": "http",
  "name": "health-api",
  "url": "http://localhost:3000/api/health",
  "method": "GET",
  "normalize": {
    "trimWhitespace": true,
    "json": {
      "sortKeys": true
    }
  }
}
```

### 6.3 Normalize 要求

探针必须支持消除无意义差异：

- ANSI 颜色码
- 换行差异
- 首尾空白
- JSON key 顺序
- 时间戳字段
- 随机 ID 字段
- 构建机器路径

## 7. 差异判定规则

### 7.1 Check Regression

如果 baseline 中某个 critical check 是 passed，而 run 中变为 failed、timed_out 或 error，则判定为 error。

### 7.2 Probe Diff

如果行为探针的 normalized output hash 发生变化，默认判定为 error。

### 7.3 Missing Probe

baseline 中存在的 probe 在 run 中消失，默认判定为 error。

### 7.4 Non-critical Changes

配置变化、文件数量变化、非关键输出变化可作为 info 或 warn。

## 8. AI 协作需求

### 8.1 AI Brief 内容

AI brief 必须包含：

- 迁移任务目标
- 项目路径
- 技术栈信号
- 高风险文件
- 当前 checks
- 当前 probes
- latest baseline
- latest run
- latest compare 结论
- AI 操作规则
- 推荐下一步任务

### 8.2 AI 操作规则

AI 每次迁移必须遵守：

- 一次只做一个小目标
- 改前说明影响范围
- 优先迁移低风险叶子模块
- 不混合依赖升级、格式化、架构调整和业务逻辑变化
- 不删除或弱化 checks/probes/tests 来让验证通过
- 改后必须运行 verify
- 输出差异解释

### 8.3 Human Approval

如果行为变化是预期的，必须由人类确认。

确认后需要：

- 更新行为探针
- 更新测试
- 记录 intentional behavior change
- 重新采集新的 baseline

## 9. 非功能需求

### 9.1 安全性

- 默认只读扫描
- 不自动删除文件
- 不自动修改目标项目源码
- 不自动提交 git
- artifacts 单独存放

### 9.2 可审计性

每次 baseline、run、compare 都应保存为文件。

报告应包含：

- 时间
- 配置 hash
- 检查结果
- 探针结果
- 差异列表

### 9.3 可移植性

MVP 使用 Node.js + TypeScript。

运行要求：

- Node.js 20+
- npm/pnpm/yarn/bun 项目均可作为目标项目

### 9.4 可扩展性

后续可扩展：

- JS/TS AST 适配器
- Vue/React 迁移规则
- Playwright 页面快照
- API contract diff
- 数据库快照
- GitHub Actions 集成
- AI provider adapter
- Web dashboard

## 10. 验收标准

MVP 视为完成时，应满足：

1. 能初始化配置文件。
2. 能扫描目标项目并输出风险文件。
3. 能执行 checks 并保存结果。
4. 能执行 command probe。
5. 能执行 HTTP probe。
6. 能采集 baseline。
7. 能采集 run。
8. 能比较 baseline 和 run。
9. 行为探针输出变化时，compare 失败。
10. critical check 从通过变失败时，compare 失败。
11. 能生成 Markdown compare report。
12. 能生成 AI migration brief。
13. 能在 Windows 环境运行。
14. 有基础单元测试覆盖 normalize 和 compare。

## 11. 推荐开发路线

### 阶段 1：验证闭环

- CLI 骨架
- 配置读取
- scan
- baseline
- verify
- compare
- command/http probe

### 阶段 2：AI 协同

- ai-brief
- 风险文件解释
- 推荐迁移步骤
- 差异解释模板

### 阶段 3：前端项目增强

- Playwright 页面快照
- DOM diff
- screenshot diff
- bundle size diff
- route crawler

### 阶段 4：JS/TS 深度迁移

- TypeScript Compiler API
- ts-morph
- import graph 精准化
- codemod dry-run
- changed files impact analysis

### 阶段 5：团队化和 CI

- GitHub Actions 集成
- PR compare comment
- baseline artifact 管理
- intentional diff 记录
- dashboard

### 阶段 6：自治迁移运行时

- migration run
- 本地 issue store
- 结构化 task graph
- evidence log
- status/report 命令
- task-scoped AI brief

### 阶段 7：动态重规划和 checkpoint

- 执行中插入任务
- 失败任务拆分
- 验证失败自动生成 failure issue
- 行为差异自动生成 diff issue
- checkpoint / resume / rollback
- 预算和剩余时间动态更新

### 阶段 8：同生态全自动迁移

- Webpack -> Vite
- JS -> TS
- Vue2 -> Vue3
- React class -> Hooks
- Node 框架升级
- `migration-guard run --auto`

### 阶段 9：跨语言行为复刻迁移

- 行为基线提取
- 契约测试生成
- 数据模型映射
- 接口兼容检查
- 双跑对比
- 差异白名单
- 分阶段切流
