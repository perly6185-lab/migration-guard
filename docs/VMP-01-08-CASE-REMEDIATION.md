# engine-use-page/page 达标整改评估

评估对象：`/zboss/data/view/dynamic/engine/use/engine-use-page/page`

约束：案例工程只读。以下方案在 `migration-guard` 中实现验证、回放和证据门禁；若未来需要修改业务实现，必须由案例工程维护者在其独立变更中落地。

Rust 一次性重构的最新静态闭包、源码语义核验和真实证据缺口见
`docs/PAGE-RUST-ONE-SHOT-ASSESSMENT.md`。

## 达标定义

“具备能力”必须同时满足三层：

1. 代码契约：入口、计划、状态、副作用和权限边界可静态识别；
2. 确定性验证：无服务时可用合成数据验证分页、聚合、WHERE/HAVING 和 REFRESH 失败策略；
3. 真实证据：旧链/新链在同快照、同请求、同租户上下文下完成七类回放，差异经过门禁分类。

## VMP-01：响应比较器

当前缺口：案例 Controller 只返回结果，没有旧/新响应比较。

整改：

- 使用 `vmpBehavior.ts` 规范化状态码、响应头、分页元数据和行数据；
- 明确允许忽略的 requestId/traceId/timestamp 路径；
- 对 `total`、行顺序、空值和错误响应分别报告差异；
- 真实回放时保存旧链/新链原始响应 hash，禁止只比较日志。

达标证据：每个 case 有 `VmpCompareReport`，差异为零或有明确人工决策。

## VMP-02：横向表

当前缺口：案例虽有横向计划和 pivot 代码，但无法仅凭源码证明数据库分页前完成业务键聚合，也没有跨页真实证据。

整改：

- 以复合业务键分页，`total` 取过滤后 distinct key 数；
- 当前页必须回放该页所有维度 cell；
- SUM/COUNT/MIN/MAX 直接按完整关系聚合，AVG 使用完整 sum/count；
- 对 null、字符串 `"null"`、分隔符和跨页重复键做合成回归；
- 真实回放捕获 SQL 摘要或查询计划，证明 HAVING 未被清空。

达标证据：`vmpHorizontal.ts` 期望结果与旧/新响应的 total、page keys、pivot values 一致。

## VMP-03：质量筛选

当前缺口：案例 `appendQualityWhereFields` 会把质量字段统一放入 WHERE，聚合字段 HAVING 闭环无法从源码证明。

整改：

- 字段元数据决定普通字段 WHERE、聚合字段 HAVING；
- 操作符和字段白名单化，值全部参数化；
- WHERE 先作用于明细，HAVING 再作用于业务组；
- 回放必须验证 HAVING 改变后的 distinct total；
- 覆盖 IS NULL、IS NOT NULL、IN、组合条件和空条件。

达标证据：`vmpQuality.ts` 生成计划并在离线 evaluator 中验证 surviving business keys。

## VMP-04：REFRESH

当前缺口：案例有单 JVM manual/auto 集合和 page lock，但 `/refreshSync` 直接进入应用服务，多实例互斥、异常释放和副作用顺序仍需证据。

整改：

- 固定事件顺序：sync → timestamp/undo/reconcile/query → unlock；
- sync 失败不得 query、更新时间或清 Undo，但必须 unlock；
- query 失败仍必须 unlock；
- 手动刷新 panel 去重并优先于自动刷新；同列去重、异列可并发；
- 真实部署必须使用带租约和 owner token 的分布式锁，并记录 lock acquired/rejected/released。

达标证据：`vmpRefresh.ts` 轨迹报告 + 并发屏障测试 + 真实日志事件序列。

## VMP-05～08：执行层补齐

- VMP-05：预检旧/新服务、两套数据库、Token、七类 case；任何一项缺失 fail-closed。
- VMP-06：旧链/新链使用同一脱敏请求和同一快照标识并行执行，记录 request hash、snapshot hash、tenant/user context。
- VMP-07：七类 case 分开存储，保留 pageId/panelId/字段关系，运行时注入 Token，文件中禁止 Cookie/手机号/密码。
- VMP-08：生成 compare/evidence bundle；存在未分类 error、请求异常、快照不一致或 case 缺失时禁止宣称通过。

达标证据：`vmpReplay.ts` readiness、双路结果、脱敏 fixture 和 fail-closed evidence bundle。

## 优化优先级

1. 先修正/证明 VMP-03 的 WHERE/HAVING 分流，因为它直接影响 VMP-02 的 total；
2. 再固化 VMP-04 的分布式锁和副作用日志；
3. 最后接入 VMP-05～08 的真实环境，不以“服务可访问”替代同快照和响应证据。
