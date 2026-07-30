# Java page 接口重新评估

评估日期：2026-07-27

评估对象：

- `POST /zboss/data/view/dynamic/engine/use/engine-use-page/page`
- 只评估 Java 侧。
- `zboss-cloud` 仅作为只读参考源码，未作修改。

## 结论

Java 静态分析已经贯穿“路由定位 → 调用闭包 → SQL 来源 → 行为图 → 场景合成 → fixture 草稿 → 采集器契约 → evidence schema → fail-closed 门禁”。

目前不能判定接口已经完成全流程验证。静态资产和证据生产准备已就绪，page 专属语义已经接入通用 Java runtime evidence 门禁，但 SQL trace、真实 fixture、运行驱动和授权上下文尚未完成。

## 本次结果

- 源码身份：`a95e4cb51ceb62cc07602fe02c3cbb3e45f271ee+dirty:bffb6682d768`
- 路由精确匹配：1
- Java 文件：7116
- 调用图：3194 nodes / 4256 edges
- SQL 来源：138，其中动态 SQL 27
- unresolved calls：0
- ambiguous calls：0
- 截断：无
- 工作负载：`query-with-effects`
- 静态阻断：`REQUIRES_NEW` 方法内部自调用
- 兼容性决策：4 项 pending
- runtime 场景：16
- runtime collectors：MySQL、Redis、events

阶段状态：

- `staticReady=true`
- `authoringReady=true`
- `fixturesReady=false`
- `environmentReady=false`
- `executionReady=false`
- `evidenceReady=false`

合成 evidence 自检有效，但 `realEligible=false`，只能证明 schema、组装和校验链路可运行。

## 当前 Java 行为风险

### P0：quality 聚合字段路由

`ViewMetaPageQueryPlanDomainServiceImpl.appendQualityWhereFields` 仍将 `qualityValues` 命中的字段全部加入 WHERE。聚合字段是否应进入 HAVING 尚无已批准兼容规则，可能改变结果集与 total。

### P0：横向分页 HAVING

`ViewMetaPageQueryPortAdapter.buildHorizontalRowKeySelectTable` 仍执行 `setHavingFields(new ArrayList<>())`。横向 row-key 分页在 distinct total 前丢弃 HAVING，存在页键、数据行和 total 不一致风险。

### P1：事务代理边界

`ViewDynamicFieldCountIndexDataServiceImpl.ensureIndexRecord` 内部调用同类
`createViewDynamicFieldCountIndexData`。两者都声明 `REQUIRES_NEW`，但 self invocation 绕过 Spring 代理。源码注释声明这是有意复用外层事务；在批准例外并获得事务失败证据前，门禁保持阻断。

### P1：REFRESH 效果顺序

REFRESH 分支同时涉及同步、时间戳/状态写入、undo 清理、查询、锁和进度事件。需要真实事件与 MySQL/Redis 快照证明成功、失败和并发路径上的顺序及补偿。

## 工具能力进展与剩余缺口

已完成：

- 通用 `semantics.page`、`expectations.page` 和 evidence schema。
- pagination、quality、horizontal、refresh 的 fail-closed gate。
- 项目可配置 `runtimeGates`。
- collector 从 entry 级下沉到 scenario 级。
- 脱敏 SQL trace collector 和跨 collector correlation trace。
- 16 个场景均绑定 page gate；其中 9 个无需状态 collector、2 个要求 SQL trace、5 个要求 MySQL/Redis/events/SQL trace。

仍缺：

- 服务侧产生场景相关 SQL JSONL 的运行驱动适配。
- 真实 page semantics、fixture、driver 和环境执行证据。

## 运行环境观察

已确认 `10.10.10.177:22882` 上 Java 服务和 Actuator 健康检查可用，MySQL、Redis、服务发现状态正常；部署观察已脱敏并绑定到 authoring report。

尚未使用有效业务授权和请求样本执行该接口，也未完成场景级 seed/snapshot/invoke/collect/cleanup 驱动，因此不得把环境可达性解释为接口行为已验证。

## 下一步

1. 接入 REFRESH/事务联合门禁。
2. 为 16 个草稿补真实请求、page semantics、SQL trace、MySQL snapshot、Redis key probe 和场景相关事件。
3. 配置运行驱动与非落盘授权环境，执行 real evidence gate。
4. 对四项兼容性决策逐项评审并冻结证据。

详细拆分、验收条件和执行顺序见 [DEVELOPMENT-PLAN.md](./DEVELOPMENT-PLAN.md)。

## 日历视图组合场景补充

用户确认 `usePageId=2059838047023181826`、`viewId=2064662147688243201`
对应日历视图。该页面采用两阶段加载：

1. `/engine-use-page/query` 读取指定 `usePageId + viewId` 的页面和视图元数据；
2. `/engine-use-page/page` 使用 `usePageId`、panel/page/inter/http 标识和 26 个投影字段
   拉取最多 10000 条日历数据。

此前相同 `usePageId` 的运行样本命名为 `horizontal-page`。现保留旧名称以维护既有
证据哈希，但其视图类型推断不再视为可信事实。后续必须由 query 响应中的视图类型、
viewId 和 panel 配置证明它是日历视图。

该组合场景新增四项 fail-closed 决策：视图类型来源、query/page 标识绑定、
10000 行资源预算、日历时间语义。精确请求当前也不能被标记为纯只读：
query 链路可能执行字段配置自愈写，page 链路在未设置 `skipSavePageSize=true`
时可能保存分页偏好。

Rust `page-service` 现已直接接受该日历 page 请求：`reqId` 可缺省并从请求上下文
取得，`usePageId` 与 `pageId` 作为不同身份保留，字符串 Long ID 以 `u64` 精确解析，
分页兼容上限提升为 10000。`selectValues` 中的 `field -> field` 自映射按投影声明
处理，不再错误编译成 WHERE 条件。

## 2026-07-30 阻断处理结果

Rust 侧已增加 Axum/Tokio HTTP runtime、SQLx MySQL statement executor、Redis 原子
lease executor，并以 `cargo build --locked --all-features --release` 及 production
profile 进程完成构建、健康检查和 page 路由验证。production-path attestation 的
deployable、adapter、build、runtime、eligible 五项现均为 `true`。

production profile 在缺少部署凭据和完整元数据/权限绑定时保持 fail-closed：
`/health` 返回 200，`/ready` 与业务路由返回 503，避免 memory adapter 冒充生产数据。
剩余 real-gate 阻断是 Java/目标真实回放证据和四项日历语义决策，需由授权现场采集
解除。
