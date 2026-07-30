# Java query 接口静态分析评估

评估日期：2026-07-28

评估对象：

- `POST /zboss/data/view/dynamic/engine/use/engine-use-page/query`
- Java 管理端控制器入口 `EngineUsePageController.queryByView`
- `zboss-cloud` 只读，未修改业务源码

## 结论

严格调用图分析通过，图闭合且没有深度、边数或未解析边截断；migration-guard
生成的 endpoint replacement plan 状态为 `ready`。

但人工语义审查发现一个工具当前未拦截的 P0 缓存可变对象问题，因此不能仅凭
`ready` 判定 query 能力已经迁移就绪。另有 query 内写库、异步超时副作用、
Web/RPC 双轨和模板类型覆盖四项需要在迁移前冻结契约或补运行证据。

## 严格分析结果

- 源码身份：`a95e4cb51ceb62cc07602fe02c3cbb3e45f271ee+dirty:bffb6682d768`
- 路由精确匹配：1
- Java 文件：7116
- 调用图：829 nodes / 1002 edges
- 最大实际深度：14（配置上限 32）
- 边数上限：20000，未触发
- 未解析边：0
- 未展开边界：0
- 行为图 unknown kind：0
- SQL 来源：70（67 read、2 write、1 delete）
- 工作负载：`query-with-effects`
- replacement plan findings：0

`sourceKind=unknown` 有 377 个，主要是 DTO accessor、lambda、adapter 和外部边界；
它们均已映射到行为类型，不构成图闭包阻断。包名中包含 `event`、`http` 的配置读取
存在启发式误分类，后续设计 collector 时不能把 26 个 `event-publish` 直接解释为
真实事件发布。

## 风险评估

### P0：缓存对象被请求后处理原地修改

`ViewMetaPageQueryCommonApplicationServiceImpl` 在缓存命中时直接返回缓存中的
`EngineUsePageRespVO`，缓存写入时也直接保存同一对象引用。随后
`ViewMetaLedgerQueryApplicationServiceImpl` 调用
`fieldValueSyncStatusResponseSupport.attachToPageRespVO`，原地修改 panel、column 和
顶层 status map。

影响：

- 第一次请求附加的同步状态会进入共享缓存对象。
- 后续状态为空时，attach 逻辑不会清除旧 status 字段，可能返回过期状态。
- 同 key 并发请求会共同修改同一响应对象，存在跨请求竞争。

建议修复契约：

- 缓存只保存不含瞬时同步状态的不可变基础响应。
- 每次命中后复制响应，再按当前请求状态叠加。
- 当前状态为空时显式清除旧 status 字段。

### P1：query 路径包含真实数据库自愈写

多视图字段合并会在读取过程中：

- 删除非 DB 字段的历史配置；
- 补齐缺失字段配置；
- 修复移动端超过 9 个可见字段的配置。

对应 SQL 为 1 delete、2 write，当前链路没有包住三类操作的显式事务边界。
这不是调用解析误连，最短路径均从 query 入口经过 panel assembly 到
`ViewDynamicFieldEngineServiceImpl.mergeViewFieldConfig`。

迁移前需决定：严格保留 query-time self-healing，还是把修复迁移到独立维护流程。
若保留，至少需要并发幂等、部分失败和缓存失效证据。

### P1：异步超时与副作用终止性

调用图包含 20 个 async boundary。panel 初始化把字段查询/自愈写放入
`CompletableFuture`，整体 10 秒超时后调用 `cancel(true)`。

需要运行证据证明超时返回后未完成任务不会继续写 MySQL/Redis；若不能保证，
应把自愈写改为显式、幂等且可观测的独立任务，避免“请求已失败但副作用继续”。

### P1：Web/RPC 双轨

Web `/query` 已切到 `ViewMetaLedgerQueryApplicationService`，RPC
`AiEngineUsePageRpcApiImpl.queryLedgerPage` 仍调用旧
`EngineUsePageService.query`。静态分析已识别为 parallel entrypoints。

迁移范围必须明确包含或排除 RPC；若包含，应以相同 fixture 比较响应、缓存、
外部服务降级和自愈写副作用。

### P1：模板类型语义变化

旧 Web `query(reqVO)` 固定使用 `SELF_TEMPLATE_PAGE_DATA`；新 Web 链路允许请求中的
`usePageTemplatePage` 覆盖默认值。该变化可能改变数据域和路由分支，必须用真实调用
样本确认是预期扩展，否则应恢复固定模板语义。

## 当前判断

- 工具级静态闭包：通过
- 语义级静态评估：被 P0 缓存可变对象问题阻断
- 事务 self-call：未发现
- 调用图截断：未发现
- 运行证据：尚未准备

下一步优先修复缓存隔离问题，再为 query-time writes、async timeout、Web/RPC parity
和 template override 建立兼容性决策与定向 fixture。

## 日历视图请求补充

新增真实候选请求：

```json
{"usePageId":"2059838047023181826","viewId":"2064662147688243201"}
```

用户确认该 `viewId` 表示日历视图。迁移契约不得只以 `usePageId` 缓存或选择元数据；
必须证明显式 `viewId` 参与视图选择和缓存隔离。query 响应还必须向后续 page 阶段
提供一致的 panel/page/inter/http 标识。

由于 query 调用链包含配置自愈写，该候选保持未执行、非只读证据状态。真实采集需在
可回滚环境中同时记录 SQL trace 和 MySQL 前后快照，并验证两次相同请求不会产生
重复写或跨 viewId 缓存污染。

## Rust 入口状态

`rust/zboss-rust/internal/dynamic-engine-runtime` 已增加
`POST /zboss/data/view/dynamic/engine/use/engine-use-page/query`。入口接受字符串或整数
形式的 Long ID，并将 `usePageId + viewId` 作为显式联合身份；响应显式返回
`viewType`，日历场景门禁负责验证其值为 calendar。

当前实现只读取预先物化的 `ViewMetadataPort`，不会暗中复制 Java 的 query-time
自愈写。生产迁移仍需决定是删除这类读时写，还是通过独立命令实现，并补 MySQL
适配器、缓存隔离及双轨回放证据。

## 2026-07-30 阻断处理结果

Rust 侧的结构性阻断已解除：Axum/Tokio 服务可启动，query 路由已通过生产 profile
的真实进程冒烟验证，构建、运行日志及源码哈希证据均通过 production-path
attestation。当前 real gate 不再报告 HTTP runtime、route、adapter、build 或
runtime verification 缺失。

剩余阻断仅为两类：Java/目标真实回放证据缺失，以及
`QUERY-DEC-CALENDAR-VIEW-BINDING`、`QUERY-DEC-CALENDAR-CACHE-ISOLATION`
尚未依据现场响应批准。未使用模拟响应替代这两项证据。
