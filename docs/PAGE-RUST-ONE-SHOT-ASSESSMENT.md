# engine-use-page/page Rust 一次性重构能力评估

评估对象：`POST /zboss/data/view/dynamic/engine/use/engine-use-page/page`

评估入口：`EngineUsePageController.pageByView`

评估日期：2026-07-26

## 结论

该接口已经具备“启动独立 Rust 服务一次性重构”的静态分析条件，但尚不具备“已经能够无证据直接宣称重构达标”的条件。

| 能力层 | 状态 | 结论 |
| --- | --- | --- |
| Java 源码静态闭包 | ready | 无截断、无未解析调用、无重载歧义、无未知行为节点 |
| 合成语义验证 | ready | migration-guard 的分页、横向表、质量筛选、REFRESH、回放门禁测试可执行 |
| 独立 Rust `/page` 实现 | not-started | 当前 `rust/` 仅有 `batch-update-service` |
| 真实旧链/Rust 新链证据 | blocked | 七份真实脱敏夹具、双服务、双数据库快照和 Token 尚未接入 |
| 最终等价达标 | blocked | 必须完成 Rust 实现和真实双路回放后才能宣称通过 |

`zboss-cloud` 只需保持只读。Rust 工程、测试、回放驱动和证据均应落在 `migration-guard`，不需要取得 `zboss-cloud` 写权限。

## 冻结的静态闭包

本次按深度 27、边上限 8000 复跑，最终实际最大深度为 25：

- 调用图节点：3117
- 调用图边：4170
- SQL 来源：138
- 动态 SQL 来源：27
- 未展开边界：0
- 总边上限截断：0
- 深度截断：0
- 单方法调用上限截断：0
- 未解析调用：0
- 重载歧义：0
- 未知行为节点：0
- SQL ownership 缺失契约：0
- 替代计划状态：`ready`

静态行为被收敛为四类边界：

1. `pure-logic`：请求转换、字段解析、查询计划、横向透视和响应组装；
2. `application-orchestration`：普通分页与 REFRESH 分支编排；
3. `infrastructure`：数据库、Redis、动态表、缓存和外部端口；
4. `observable-effects`：刷新写入、时间戳、Undo、事件、锁和事务。

必须显式注入的上下文包括 tenant、user、request、device 和 datasource。

这不是纯查询接口。`operator != REFRESH` 时进入普通分页；`operator == REFRESH` 时执行分布式加锁、刷新同步、副作用处理、分页查询，并在 `finally` 中解锁。因此 Rust 实现不能只迁移 `ViewMetaPageApplicationServiceImpl.page`，必须覆盖 `pageByView` 的完整路由语义。

## 源码语义核验

已确认的正向条件：

- Controller 的请求/响应 assembler 和应用服务入口明确；
- 普通分页包含请求初始化、子表单条件、上传临时表、页大小策略、权限/租户上下文、字段解析、查询计划、SQL 执行、横向透视和响应回填；
- REFRESH 使用 Redis `SET NX` 租约锁、owner token 和 Lua 校验解锁；
- `pageByView` 通过 `finally` 保证异常路径释放锁；
- 横向分页已采用复合业务键分页，并回取当前页全部维度 cell；
- 静态黄金用例已识别：
  `standard-page`、`refresh-operator`、`child-form-page`、`horizontal-page`、
  `quality-text-filter`、`upload-preview-page`、`tenant-auth-context`、`entrypoint-parity`。

仍需在 Rust 目标实现中补齐的 P0 语义：

1. `ViewMetaPageQueryPlanDomainServiceImpl.appendQualityWhereFields` 仍把 quality 字段统一加入 WHERE，没有按普通字段/聚合字段分流到 WHERE/HAVING。
2. `ViewMetaPageQueryPortAdapter.buildHorizontalRowKeySelectTable` 当前执行
   `setHavingFields(new ArrayList<>())`，会丢失横向业务键分页前的 HAVING，无法保证 HAVING 后的 distinct total。
3. Rust `/page` 独立服务、端口实现和集成环境尚未创建。

因此 Rust 重构的目标契约应采用已经在 migration-guard 中固化的正确语义，而不是机械复制上述两个 Java 缺口。

## 证据现状

已通过：

- Java 静态分析与语义注册回归：20/20；
- VMP 合成验证与门禁回归：43/43；
- `CompositeKey.from` 已作为通用、target-owned 的确定性 key value-object factory 识别，未知节点由 2 降为 0。

尚未取得：

- `standard-page.json`
- `refresh.json`
- `child-table.json`
- `horizontal-table.json`
- `quality-filter.json`
- `temporary-table.json`
- `tenant-permission.json`
- 同快照隔离的旧链数据库与 Rust 新链数据库
- 两套可访问服务、运行时 Token、tenant/user 上下文
- 原始请求/响应 hash、快照 hash、SQL 摘要和最终 evidence bundle

`zboss-cloud` 的真实回放夹具目录目前只有 README，没有上述七份 JSON，因此真实等价仍必须 fail-closed。

## 一次性开发边界

可以按一个完整批次开发，但“一个批次”必须包含以下全部内容：

1. 创建独立 Rust page service，冻结 HTTP DTO、响应 envelope、错误码和上下文端口；
2. 实现普通分页查询计划、WHERE/HAVING、动态 SQL ownership、横向 distinct-key 分页与完整 cell 聚合；
3. 实现 REFRESH 的租约锁、owner-token 解锁、副作用顺序、异常补偿和并发隔离；
4. 接入八个静态场景和七份真实脱敏夹具；
5. 在双数据库同快照条件下执行 Java 旧链/Rust 新链双路回放；
6. 仅在静态闭包、合成测试和真实证据三层同时通过后，输出最终达标结论。

不依赖真实服务、数据库快照和 Token 的详细三批次执行计划见
`docs/PAGE-RUST-OFFLINE-COMPLETION-PLAN.md`。

## 基线风险

被评估的 `zboss-cloud` HEAD 为 `8a68de49679502a52232798a3c1f6acba01b7789`，工作树存在 67 个未提交变更。该数字仅用于说明本次评估对象不是干净提交；正式开发冻结前必须重新计算源码身份和静态闭包，避免基线漂移。
