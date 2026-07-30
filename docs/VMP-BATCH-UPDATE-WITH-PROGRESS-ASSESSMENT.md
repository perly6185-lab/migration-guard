# batchUpdateWithProgress 达标整改评估

评估对象：
`/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress`

真实源码：
`D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data`

约束：`zboss-cloud` 保持只读。本次已核对真实 Controller、ViewMeta 应用服务、旧链适配服务、
批量进度管理、Undo 异步投递及 batch/REFRESH 协调代码，并复用 migration-guard 已生成的
controller/service/repository/SQL 调用谱系。尚未取得数据库写前/写后快照、完整进度事件流或
旧链/新链真实回放，因此不得宣称接口已经达标。

## 2026-07-27 通用流水线复评

本次不再只使用 VMP 专项规则，而是把接口放入新的通用项目流水线：

`MigrationProjectProfile → Spring/MyBatis analyze → behavior graph → runtime contract → preflight`

复评结果：

- 路由唯一命中 `EngineUseBatchPageController.batchUpdateWithProgress`；
- 扫描 7,086 个 Java 文件、1,856 条路由；
- 闭包包含 4,157 个节点、5,729 条边、163 个 SQL 来源；
- 最大观测深度 26；在深度 32、边数 20,000 的预算下没有截断、未展开边界、
  unresolved edge 或 ambiguous call；
- 行为图没有 unknown 节点，静态 replacement plan 为 `ready`；
- 源码证据绑定提交 `8a68de49679502a52232798a3c1f6acba01b7789` 以及 dirty
  fingerprint `d384407e81a1b6cf8a4e72b03162d98ed3de9f35be3e8b06a0b74881cd34afd5`；
- runtime contract 已生成 18 个场景模板，覆盖成功、校验、上下文、并发、故障、
  兼容性和性能维度；
- runtime preflight 的 `staticReady=true`，但 `fixturesReady=false`、
  `environmentReady=false`；offline gate 因真实 fixture 缺失保持 blocked；
- synthetic evidence 管线自检通过，但被明确标记为 `realEligible=false`，不会冒充真实运行证据。

复评过程中还消除了一个工具误报：同类重载方法使用完全相同的
`@Transactional(rollbackFor = Exception.class)` 时，不再被判为事务属性丢失；
`REQUIRES_NEW` 等真实代理绕过风险仍然阻断。外部只读 Git 仓库也已能通过逐命令
`safe.directory` 绑定真实 revision，不再降级为 `unversioned`。

因此新的准确结论是：**Java 静态分析已经完整贯穿且当前通过；运行时契约和证据模板已经就绪；
接口行为达标仍被真实 fixture、运行环境、数据库副作用和事件流证据阻断。**

## 当前结论

当前状态：**静态闭包与 runtime evidence 准备层已通过，真实行为证据仍不足（hold）**。

已确认：

- 默认入口 `EngineUseBatchPageController.batchUpdateWithProgress` 已切到
  `engineUpdateOperatorService.batchUpdateByView`，旧链保留为
  `/batchUpdateWithProgress-by-old`；
- migration-guard 已解析该真实路由的完整跨层谱系：4,157 个节点、5,729 条边、163 个 SQL 来源；
- Controller 将 `enableProgress` 固定为 true，并在响应前同步过滤预检失败行，再异步提交 Undo；
- ViewMeta 应用服务先做 preCheck，失败行不落库，合格行继续分成 update/insert，结果返回 failedRows；
- 全部预检失败会在注册 progress 前提前返回；
- 分片请求通过 `clientSessionId` 复用 batchId，非末片保持 RUNNING、末片进入终态；
- `BatchUpdateInFlightRegistry` 在入口 enter、finally exit，REFRESH 可据此跳过同 panel 执行；
- 已定义 9 类 golden cases 和写前/写后、失败行、Undo、进度、上下文等比较维度。

尚不能确认：

- worker/insert/horizontal 各自事务的提交边界能否形成可审计的批次级语义；
- 部分失败响应是否与最终数据库提交集合严格一致；
- 重试、重复分片和乱序分片是否会产生重复写或重复 Undo；
- progress 的计数守恒、唯一终态和“数据库提交后完成”语义；
- Web/RPC 入口规范化是否完全一致；
- 横向表 upsert 的业务键、插入/更新判定和并发冲突策略。

## 真实源码确认的主要缺口

1. 行数上限当前只统计 `batchPostValueList`，没有同时约束 `batchHeaderValueList`。
2. Undo 在 HTTP 主写完成后异步投递；异步写失败被记录日志但不影响接口成功，数据写与 Undo 不具备原子证据。
3. `BatchUpdateInFlightRegistry` 明确仅为单 JVM `ConcurrentHashMap + AtomicInteger`，多实例不互斥。
4. 分片会话复用 batchId 并累计进度，但未发现基于 request/chunk hash 的幂等写账本。
5. progress 初始化、主阶段完成、异步 SelectRef/cascade 收尾之间存在延迟清理路径，需要状态机验证避免重复或提前终态。
6. 应用服务本身未声明批次级 `@Transactional`；源码表现为 worker 完成后再汇总日志、表单内容和 cascade，
   因此必须按实际 worker 提交集合验证“部分成功”而不能假设整批原子。

## 达标定义

该写接口需要四层同时成立：

1. 静态代码契约：入口、限制、预检、事务、写集合、Undo、进度和并发边界可识别；
2. 确定性合成验证：无需真实服务即可验证批量规划、部分失败、分片幂等和事件状态机；
3. 数据库副作用证据：同一请求的写前/写后快照、提交集合、Undo 集合与失败行严格对应；
4. 真实双路回放：旧链/新链使用同租户、同用户、同初始快照和同请求，响应、写集合及事件流经过门禁。

## BUP-01：请求与限制契约

风险：

- 真实代码只检查 `batchPostValueList`，`batchHeaderValueList` 未纳入 10000 行限制；
- 空列表、null、重复主键、混合 insert/update、字段缺失和超限错误形状待证；
- headerValues/postValues 默认值覆盖优先级待证。

整改：

- 静态提取并冻结两个列表的限制、必填字段、默认值与错误码；
- 对空批次、边界 9999/10000/10001、重复键和混合写建立合成用例；
- 超限必须在任何数据库写、Undo 或 progress 副作用之前失败。

## BUP-02：预检、部分失败与事务

风险：

- “有效行提交、无效行不变”与整批事务回滚可能混淆；
- 响应 failed rows、实际提交集合和事务提交点可能不一致；
- 事务自调用或异步执行可能绕过 Spring 事务代理。

整改：

- 明确事务策略：全批原子或有效行提交，禁止依赖隐含行为；
- 批量规划器输出 requested/valid/failed/inserted/updated 行集合；
- 数据库执行只消费 valid 集合，响应和审计从同一规划结果生成；
- 捕获事务参与、提交/回滚和写后快照证据。

## BUP-03：分片幂等与重试

风险：

- `clientSessionId + isLastChunk + expectedTotalRows` 只描述进度，不一定构成幂等键；
- 超时重试、重复最后一片、乱序片或跨实例执行可能重复写入；
- 多分片累计数可能与实际提交数漂移。

整改：

- 定义包含租户、会话、请求/分片序号的幂等键；
- 原子记录 accepted/committed/failed 状态和请求 hash；
- 相同 key + 相同 hash 返回既有结果；相同 key + 不同 hash 必须冲突失败；
- 覆盖重复片、乱序片、缺片、最后一片重放和进程中断恢复。

## BUP-04：进度事件状态机

风险：

- progress 可能早于事务提交报告完成；
- processed/failed/total 可能非单调、重复终态或缺少失败终态；
- WebSocket/消息投递失败可能反向影响数据库事务。

整改：

- 固定状态机：accepted → validating → writing → committed/failed；
- processed、failed 和 total 单调且满足最终守恒关系；
- success terminal 只能在数据库提交后产生，失败路径必须恰有一个 failed terminal；
- 事件携带 batchId、clientSessionId、request hash、chunk 和租户上下文；
- 数据提交与事件投递采用明确的 outbox/补偿策略，不以进程内回调假定可靠投递。

## BUP-05：Undo 一致性

风险：

- Controller 已按 failed row index 过滤失败行，这是正向基础；
- Undo 异步投递与主数据提交不原子，失败只记录日志；
- 分片重试仍可能产生重复或不可逆 Undo。

整改：

- Undo 仅覆盖最终 committed 行，并保留写前值；
- failed 行不得进入 Undo；
- Undo 与数据提交使用同事务或可证明的原子/补偿协议；
- Undo 记录绑定幂等键、操作类型、操作标签和 committed row ids。

## BUP-06：横向表 upsert

风险：

- `horizontalId`、header/post 值与真实复合业务键的映射待证；
- 同键并发可能出现重复插入、覆盖或丢失更新；
- flattened rows 的失败行可能无法映射回原始请求。

整改：

- 冻结横向业务键、维度键及 insert/update 判定；
- 通过唯一约束或原子 upsert 处理同键并发；
- 保留原始 row/chunk 索引，使响应、进度、Undo 和数据库行可追溯；
- 合成验证重复键、null/`"null"`、分隔符、并发 upsert 和部分失败。

## BUP-07：与 REFRESH 的并发协调

风险：

- REFRESH 已依赖 batch-in-flight 判断，但真实实现明确是单 JVM registry，无法覆盖多实例；
- batch 完成、进度完成和释放 refresh 屏障的顺序待证；
- 异常路径可能永久阻塞刷新或在批量提交前放行。

整改：

- 使用共享租约锁/活动注册表，资源至少包含 tenant + panel；
- owner token 原子释放并记录 acquired/rejected/released/expired；
- 固定顺序：acquire → validate/write/commit → terminal progress → release；
- 进程崩溃通过租约恢复，REFRESH 仅在批量提交或明确失败后继续。

## BUP-08：权限、入口一致性与证据门禁

风险：

- Web/RPC 入口可能具有不同默认值、校验、事务或权限处理；
- 异步进度线程可能丢失 tenant/user/datasource/request context；
- 仅比较 HTTP 响应无法证明写接口等价。

整改：

- Web/RPC 归一化为同一命令契约，并回放入口一致性；
- 运行时显式传递租户、用户、数据源和 request hash，禁止只依赖 ThreadLocal；
- evidence bundle 同时包含响应、请求 hash、初始/最终快照 hash、提交行、失败行、
  Undo、progress 事件和锁轨迹；
- 任一入口差异、上下文缺失、快照不一致、未分类差异或事件不守恒时 fail-closed。

## 验收用例

最低覆盖以下 9 类：

1. 正常批量更新；
2. 有效/无效行混合的部分失败；
3. 10000 行边界和超限拒绝；
4. 新增行继承 header/post 默认值；
5. 横向表批量 upsert；
6. 多分片粘贴与最终进度；
7. Web/RPC 入口一致性；
8. Undo 排除失败行；
9. progress 事件形状与状态机。

另需增加四类故障注入：

- 数据库写失败/提交失败；
- progress 投递失败；
- 重复、乱序、缺失分片；
- 实例崩溃、租约过期及与 REFRESH 并发。

## 实施优先级

1. 先取得该真实路由的静态分析报告，冻结事务、预检、写集合和进度调用图；
2. 在 migration-guard 实现 batch planner、分片幂等和 progress 状态机的离线模型；
3. 串联 Undo、横向 upsert 与 batch/REFRESH 共享租约契约；
4. 最后接入数据库写前/写后快照和旧链/新链双路回放。

## migration-guard 已补验证能力

本评估后的离线整改已经落地到 `vmpBatch.ts`：

- 批次规划同时限制 post/header 两类列表，并输出 requested/valid/failed/insert/update 行集合；
- 副作用校验要求 committed 只能来自 valid，failed 不得提交，Undo 与 committed 集合一致；
- 分片账本以 tenant + session + chunk + request hash 判定 accepted/replayed/conflict/out-of-order；
- progress 状态机限制阶段前进、计数单调、终态守恒且只能终结一次；
- batch/REFRESH 共享 tenant + panel 租约资源，记录 owner token 的 acquired/rejected/released 证据；
- 批命令门禁在 Undo、终态、幂等或共享锁证据缺失时 fail-closed；
- 上述公开契约已纳入 TypeScript AST 静态检查和 `npm run vmp:gate`。

这些能力用于证明和门禁，不代表真实业务代码中的双列表限制、幂等账本、分布式锁或 Undo 原子性
已经修复；这些仍需 `zboss-cloud` 独立变更和真实回放。
