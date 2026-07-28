# batchUpdateWithProgress Rust 一次性交付计划

## 唯一目标

只读分析 `zboss-cloud` 中
`ViewMetaBatchUpdateApplicationServiceImpl.batchUpdate/doBatchUpdate`
及其完整依赖语义，在独立 Rust 工程中一次性重新实现，并由 migration-guard 评估和证明
Rust 实现与 Java 源方法行为等价。

阶段性产物只用于推进，不视为完成。只有以下终态全部满足才算完成：

- Rust 独立拥有该服务方法涉及的预检、update/insert、horizontal upsert、事务、幂等、
  progress、Undo、cascade 和锁协调语义；
- `zboss-cloud` 全程只读，不增加 Java → Rust 调用，不修改入口或业务代码；
- 九类业务用例与四类故障注入完成 Java 参考实现/Rust 重实现的对照评估；
- 响应、数据库写集合、失败行、Undo、progress、cascade 和锁轨迹通过证据门禁；
- Rust 工程可独立构建、测试和部署，并产出完整迁移评估报告。

## 目标架构

```text
Read-only zboss-cloud Java source
    │ static contract / fixtures / reference evidence
    ▼
migration-guard equivalence gate
    ▲
    │ Rust tests / replay / evidence
    │
Independent Rust batch-update implementation
    ├── request/context normalization
    ├── precheck + batch planner
    ├── update/insert/horizontal executors
    ├── transaction + idempotency ledger
    ├── progress state machine + outbox
    ├── undo journal
    ├── cascade/outbox
    └── distributed batch/refresh lease
    └── MySQL / Redis / progress transport ports
```

Rust 工程不嵌入 `zboss-cloud`，也不要求 `zboss-cloud` 调用 Rust。Java 源码只作为契约和
参考行为来源；是否在未来系统中接入 Rust 属于评估完成后的独立决策。

## 工作流 A：契约冻结

### 已冻结的静态闭包基线

只读目标源码已使用自适应分析收敛到以下边界：

- 最大实际深度：26（分析预算 27）；
- 调用图节点：4157；
- 调用边：5729；
- SQL sources：163；
- edge/depth/per-method call cap：全部未触发；
- unexpanded boundary nodes：0；
- unresolved calls：0；
- ambiguous calls：0。

该结果取代此前 499 条边触顶的谱系，作为 Rust 重实现的静态冻结基线。后续源码 identity
变化时必须重新生成，禁止沿用旧闭包。

1. 固化真实 Java 新链、旧链、RPC 入口及 4157-node/5729-edge/163-SQL 完整调用谱系。
2. 冻结请求、响应、错误码、failedRows、batchId、operationKind/Label 和上下文字段。
3. 冻结 10000 行边界、部分成功、默认值、横向键、Undo 和 progress 行为。
4. 为九类业务用例生成脱敏 fixture。
5. 为数据库失败、消息失败、分片异常和实例崩溃生成故障 fixture。

交付：版本化 OpenAPI/JSON Schema、行为契约、数据快照规范和差异分类规则。

## 工作流 B：Rust 工程与接口

1. 创建独立 Rust workspace/service，锁定 Rust toolchain。
2. 建立独立服务/库接口、健康检查、配置、日志、指标和 trace。
3. 定义 tenant/user/datasource/request/snapshot 上下文。
4. 根据只读 Java DTO 生成 Rust 兼容 DTO 和契约测试，不修改 Java DTO。
5. 实现严格超时、请求体限制和错误映射。

交付：可独立部署的 Rust 服务/库及契约说明。

## 工作流 C：批命令领域内核

1. 实现 post/header 双列表限制。
2. 实现字段元数据加载、格式/长度/枚举/唯一/主键预检。
3. 输出 requested/valid/failed/insert/update/horizontal 明确集合。
4. 实现 header/post 默认值和关联字段清洗。
5. 保留原始 rowIndex/chunkIndex，贯穿响应与副作用。

交付：无数据库依赖的确定性 Rust planner，逐 fixture 对齐 Java。

## 工作流 D：数据写入与事务

1. 建立 Rust MySQL 数据访问层和动态 datasource 路由。
2. 实现普通 update、无 ID insert 和 horizontal upsert。
3. 固化唯一约束、乐观冲突和死锁重试策略。
4. 明确部分成功事务单位；提交集合必须可审计。
5. 数据库异常不得产生成功 progress 或 Undo。

交付：写前/写后快照、事务轨迹及 committed row set。

## 工作流 E：幂等与分片

1. 幂等键使用 tenant + clientSessionId + chunkNo。
2. 原子保存 request hash、状态、结果和终态。
3. 相同 hash 重放返回原结果，不重复写入。
4. 不同 hash 冲突、乱序、缺片和重复末片 fail-closed。
5. 支持进程中断后的 lease takeover 与结果恢复。

交付：幂等账本、恢复任务和并发/崩溃测试。

## 工作流 F：Progress、Undo 与 Cascade

1. progress 固定为 accepted → validating → writing → committed/failed。
2. processed + failed = total，计数单调且终态唯一。
3. progress、Undo、cascade 统一使用事务 Outbox。
4. Undo 只记录 committed 行的写前值，绑定幂等键。
5. cascade/SelectRef/祖先面板刷新从 committed delta 生成。
6. Outbox 投递支持去重、重试、死信、告警和人工重放。

交付：事件状态机、Undo journal、Outbox worker 和事件守恒证据。

## 工作流 G：Batch/REFRESH 分布式协调

1. 共享资源键使用 tenant + panel。
2. Redis/数据库租约包含 owner token、TTL 和 fencing token。
3. 获取、续租、释放必须原子。
4. Batch 与 REFRESH 使用同一协议，禁止单 JVM 状态作为正确性依据。
5. 覆盖超时、崩溃、脑裂、旧 owner 释放和租约过期。

交付：分布式协调器及多实例并发测试。

## 工作流 H：参考实现/Rust 对照验证与证据门禁

1. 同一脱敏请求、租户、用户和初始数据库快照分别运行只读 Java 参考环境与 Rust。
2. 对比 HTTP/RPC 响应和错误形状。
3. 对比 committed/failed/inserted/updated/horizontal row set。
4. 对比 Undo、progress、cascade、Outbox 和锁轨迹。
5. 运行九类业务用例和四类故障注入。
6. 未分类差异、快照不一致、证据缺失或事件不守恒全部阻断。

交付：带 SHA-256 完整性校验的 evidence bundle。

## 工作流 I：独立交付与迁移评估

1. 提供 Rust 本地、测试和部署清单。
2. 提供隔离数据库快照回放方式，禁止影响 Java 参考环境。
3. 完成容量、延迟、数据库连接、Redis 和 Outbox 压测。
4. 输出能力覆盖矩阵、等价差异、风险和接入建议。
5. 将任何尚未证明的 Java 动态行为明确列为 blocker，不以推断替代证据。

交付：Rust 制品、监控说明、运行手册和最终迁移评估报告。

## 一次性交付任务顺序

1. A + B：冻结契约并建立 Rust 可部署骨架。
2. C + D：完成核心语义和数据库写入。
3. E + F + G：完成可靠性、副作用和多实例正确性。
4. H：完成全部双路与故障证据。
5. I：完成 Rust 独立制品和最终迁移评估。

各步骤连续推进；除非遇到权限、环境或不可判定业务决策，不在局部步骤停止交付。

## 硬门禁

- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test` 全绿；
- schema compatibility 全绿；
- 九类业务用例、四类故障注入全绿；
- 多实例 lease 与幂等测试全绿；
- 旧链/Rust evidence bundle 通过；
- 压测满足确认后的 SLO；
- Rust 独立部署与压测通过；
- 最终报告不存在未分类差异。

## 前置条件

- `zboss-cloud` 只需要读取权限；
- Rust 目标目录具备写权限；
- 明确 Rust 服务仓库/模块位置；
- 提供测试 MySQL、Redis、进度传输及可脱敏 Token；
- 确认部分成功事务策略和生产 SLO；
- 为 Rust 独立测试数据库提供迁移权限（幂等、Undo/Outbox、锁或 fencing 字段），
  不修改 `zboss-cloud` 仓库。
