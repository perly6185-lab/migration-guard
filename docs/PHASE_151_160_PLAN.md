# Phase 151-160 Roadmap

规划日期：2026-07-13

## 总体方向

Phase 150 已完成 `0.2.0-rc.1` 技术闭环。下一阶段围绕：

> RC 实际使用反馈 -> 配置易用性 -> 多语言扫描 -> 长任务可靠性 -> 正式版发布

里程碑：

- Phase 151-155：RC Hardening
- Phase 156-160：`0.2.0` General Availability

## Phase 151：CI 与依赖基线升级

目标：清除 CI 告警，确保构建基础设施长期可用。

交付内容：

- 升级 GitHub Actions，避免使用已弃用的内部 Node runtime。
- CI 覆盖 `npm ci`、`npm test`、UI smoke、package smoke、`git diff --check` 和包内容审计。
- 保留 Node 20、Node 22 与 Windows、Ubuntu 组合矩阵。
- 增加依赖安全审计，只阻断可执行依赖的有效风险。
- 固定 TypeScript 和 Node 类型版本，减少 lockfile 漂移。
- 增加 CI 总耗时和慢测试摘要。

退出标准：

- CI 无 Actions runtime 弃用告警。
- 四条 Node/OS lane 全绿。
- 发布包不包含源码、测试、pilot 或阶段报告。
- CI 总耗时不明显高于当前基线。

## Phase 152：配置诊断与初始化向导

目标：让新用户在 15 分钟内得到可信 baseline。

候选命令：

```bash
migration-guard doctor
migration-guard init --detect
migration-guard config validate
migration-guard config explain
```

交付内容：

- 自动识别 npm、pnpm、yarn、bun、TypeScript、Vite、Webpack、Jest、Vitest、Go、Rust、Python 和 workspace。
- 根据现有 scripts 推荐 checks 和 normalization presets。
- 诊断缺失依赖、无效 cwd、超时过短和 no-op check。
- 展示最终 profile、环境变量插值和默认值来源。
- 初始化前生成 dry-run 配置预览。
- 不自动安装依赖，不修改目标项目 `package.json`。

退出标准：

- 三个现有 pilot 均能生成接近人工配置的推荐配置。
- 错误配置在 baseline 前被发现。
- 诊断信息包含具体修复命令或配置路径。

## Phase 153：健康债务与回归预算

目标：将 inherited failure 提升为可管理的迁移债务。

交付内容：

- 为 inherited failure 生成稳定 fingerprint。
- 增加健康债务 ledger：首次发现、最近确认、owner、原因、到期时间和继续策略。
- 支持 inherited failure、warning、changed failure 和 recovered check 的预算策略。
- status、report 和 UI 展示新增、持续、恢复及过期债务。
- CI 支持严格健康预算模式。

退出标准：

- 已确认 inherited failure 不重复制造噪声。
- 新增 inherited failure 和 changed failure 不会混入旧债务。
- recovered failure 会提示清理过期豁免。

## Phase 154：扫描器多语言增强

目标：将依赖和风险分析扩展到 Go、Rust、Python。

Go：

- 识别 module/package、本地 import、`*_test.go`、`cmd/` 和 `internal/` 边界。
- 风险排序考虑跨 package importer。

Rust：

- 识别 workspace、crate、bin、lib、integration tests、`unsafe`、FFI 和 build script。

Python：

- 识别 package、module、pytest/unittest、相对及项目内绝对 import。
- 关联 `test_*.py` 和 `*_test.py`，识别 CLI、Web 路由和数据库迁移入口。

退出标准：

- Go pilot 不再把测试文件列入业务风险文件。
- 至少新增一个 Rust 或 Python scan fixture。
- 多语言扫描使用统一 package/risk schema。

## Phase 155：RC 用户试用与反馈闭环

目标：验证真实用户的产品理解与配置成本。

交付内容：

- 选择 3-5 个试用项目，覆盖单包 JS/TS、monorepo、Go/Rust/Python 和既有失败场景。
- 记录首次 baseline 用时、配置修改次数、无改动误报、新回归发现率和报告理解时间。
- 提供结构化反馈模板和 RC known issues。
- 按问题严重度决定阻断发布、延后修复或文档说明。

退出标准：

- 至少 3 个非内部 fixture 项目完成 baseline/verify。
- 无改动误报接近 0。
- 新用户能独立解释 inherited failure 与 regression。
- 形成明确 `0.2.0` go/no-go 结论。

## Phase 156：Artifact Schema v2

目标：固化健康、package 和 normalization 证据。

交付内容：

- Snapshot v2 增加 normalization metadata、健康 fingerprint 和 package scan summary。
- Compare v2 增加健康摘要、债务引用和策略决策。
- UI Job v2 增加 owner、claim、attempt 和 heartbeat metadata。
- 提供 v1 -> v2 migration dry-run 和 plan hash 确认。
- 旧 artifact 保持只读兼容。

退出标准：

- 所有 v1 fixture 均可读取。
- v1 -> v2 migration 可重复且幂等。
- 未来 schema 明确拒绝，不静默误读。

## Phase 157：Job Lease 与 Heartbeat

目标：将 claim 文件升级为适合长任务的租约机制。

交付内容：

- claim 增加 owner PID、hostname、acquiredAt、heartbeatAt 和 lease duration。
- 长任务定期续租。
- 只有 lease 过期且 owner 不存活时允许恢复。
- 增加 jobs inspect 和 recover dry-run/apply 命令。
- GC 与恢复操作共用同一锁策略。
- 增加双进程集成测试。

退出标准：

- 两个 server 不会重复执行同一 job。
- 活任务不会被误恢复。
- 崩溃任务可在 lease 过期后确定性恢复。

## Phase 158：Operator UI 产品化

目标：将内部操作台提升为真实用户可长期使用的本地控制台。

交付内容：

- package/workspace 风险、check health、健康债务和 normalization explain 视图。
- compare 支持 regression、changed failure、inherited failure 和 recovered 筛选。
- 支持 artifact 下载及长输出分页或流式读取。
- 增加 CSP、安全响应头和 method/body size 限制。
- 增加大型 run 性能基准。

安全边界：

- 默认只监听 `127.0.0.1`。
- 不增加公网部署或用户账户系统。
- 不直接执行 GitHub live mutation。

退出标准：

- 1,000 个 job 和大型 artifact 场景可正常加载。
- 核心操作具备键盘和基本无障碍支持。
- 写操作继续受 capability、CSRF 和确认保护。

## Phase 159：安装与升级体验

目标：确保 RC 用户升级到正式版时不损坏配置和 artifact。

交付内容：

- 发布 `0.1.x -> 0.2.0` 和 `0.2.0-rc.1 -> 0.2.0` 升级指南。
- 增加 `doctor --upgrade` 与 artifact migration 流程。
- 检查废弃配置、schema、artifact 权限、pilot 环境变量和 Node 版本。
- 增加 provenance/SBOM 策略。
- 覆盖 npm install、npx 和全局安装 smoke。
- 验证 Windows 路径与 PowerShell 体验。

退出标准：

- RC 配置无需人工重写即可升级。
- artifact migration 有 dry-run、确认和回滚证据。
- 三种安装方式均能执行最短工作流。

## Phase 160：正式发布 `0.2.0`

目标：完成 GA 发布闭环。

发布门禁：

- Phase 151-159 全部退出标准完成。
- Node 20/22 与 Windows/Ubuntu CI 全绿。
- 全量测试和新增测试通过。
- 三类真实项目无改动复验零差异。
- changed failure 与真实 regression 稳定阻断。
- npm 包内容审计通过。
- CHANGELOG、升级指南和 known issues 完整。
- tag 与 package version 一致。

建议流程：

1. 创建 `release/0.2.0` 分支。
2. 收口版本号和 changelog。
3. 生成 npm tarball 与 SHA256。
4. 在全新环境完成安装 smoke。
5. 创建 PR 并等待完整 CI。
6. 合并后创建 `v0.2.0` tag。
7. 手动执行 npm publish。
8. 发布后重新安装并执行 smoke。
9. 生成 Phase 160 发布报告。

## 优先级

P0：

1. Phase 151：CI 基线升级
2. Phase 152：配置诊断
3. Phase 153：健康债务
4. Phase 155：用户试用

P1：

1. Phase 154：多语言扫描
2. Phase 156：Artifact Schema v2
3. Phase 157：Job Lease

P2：

1. Phase 158：UI 产品化
2. Phase 159：升级体验
3. Phase 160：正式发布

建议周期：3-5 周。

核心指标：

- 首次 baseline 成功率
- 无改动误报率
- 新回归漏报率
- 配置准备时间
- inherited failure 可解释性
- 崩溃恢复后的重复执行次数，目标为 0
