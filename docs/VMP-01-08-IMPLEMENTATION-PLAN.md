# VMP-01～08 独立实现计划

本计划只适用于 `migration-guard`，`zboss-cloud` 仅作为只读案例，不作为实现工作区。

| Issue | 独立实现目标 | 状态 |
|---|---|---|
| VMP-01 | HTTP 响应规范化、状态/分页/行差异比较器 | 已完成 |
| VMP-02 | 横向表业务键分页、跨页聚合和 total 语义验证 | 离线闭环完成，真实回放待接入 |
| VMP-03 | 质量筛选 WHERE/HAVING 语义验证 | 已串联 VMP-02，真实 SQL 回放待接入 |
| VMP-04 | REFRESH 副作用顺序、失败策略和并发验证 | 离线执行器完成，真实分布式回放待接入 |
| VMP-05 | 输入快照、Token/数据库/服务就绪度预检 | fixture/契约门禁完成，真实探针待接入 |
| VMP-06 | 旧链/新链双快照运行器与隔离配置 | 执行契约完成，真实 HTTP 环境待接入 |
| VMP-07 | 七类行为回放数据集和敏感信息脱敏 | 七类离线 fixture 完成，真实脱敏数据待接入 |
| VMP-08 | 回放汇总、差异门禁和验收证据包 | 防篡改落盘与 CLI/CI 门禁完成，真实证据待接入 |

## VMP-01 验收边界

- 不导入 Java 业务类，不修改案例工程。
- 默认忽略请求 ID、追踪 ID、时间戳等明确声明的易变字段。
- HTTP 状态、响应头、分页元数据、数据行分别报告差异。
- 支持有序行比较和无序行多重集比较；不使用简单字符串包含判断。
- 每次比较生成基于规范化响应的 fingerprint，供后续双路回放和证据包引用。
- 无序行比较会使用相同的规范化顺序生成 fingerprint；预期状态不符必须产生显式差异证据。

## 后续实现顺序

VMP-02 和 VMP-03 复用 VMP-01 的响应模型；VMP-04 引入有序副作用事件模型；VMP-05～07
负责输入和运行环境证据；VMP-08 只消费已固化证据，不放宽比较器门禁。

## VMP-02 验收边界

- 分页单位是复合业务键，不是单个维度 cell；`total` 是过滤后 distinct 业务键数。
- 当前页返回该页业务键的全部维度 cell，不能因数据库 LIMIT 拆散业务行。
- 复合键使用类型和 null 安全编码，避免字符串拼接碰撞。
- SUM/COUNT/MIN/MAX 直接按完整关系聚合；AVG 按完整 sum/count 计算，禁止平均数的平均数。
- 该模型只验证语义，不连接或修改案例工程；真实旧链/新链回放由 VMP-06～08 接入。

## VMP-03 验收边界

- 普通字段只生成 WHERE；聚合字段生成带 `SUM/COUNT/AVG/MIN/MAX` 函数的 HAVING。
- `IS NULL`/`IS NOT NULL` 不绑定虚假值；比较和 IN 条件全部使用命名参数。
- 字段名、聚合函数和操作符均来自白名单，未知字段或 SQL 片段直接拒绝。
- WHERE 与 HAVING 可以在同一计划中共存；离线 evaluator 已验证 WHERE 先过滤明细、HAVING 再过滤业务组，
  并输出 surviving business keys 和 HAVING 后 distinct total 供横向分页校验。

## VMP-04 验收边界

- 成功路径固定为 sync → timestamp/undo/reconcile/query → unlock。
- sync 失败不得执行 query、timestamp 或 undo-clear，但必须 unlock。
- query 失败仍必须 unlock，不能留下持锁状态。
- 手动刷新按 panel 去重并优先于自动刷新；不同列可并发，同列不可重复执行。
- 当前协调器覆盖确定性单进程互斥，并提供带租约、owner token 和
  acquired/rejected/released 事件的分布式锁契约模型；真实 Redis 等原子存储适配仍属于环境接入阶段。

## VMP-05～08 验收边界

- readiness 对旧/新服务、旧/新数据库、Token、七类 case、重复 ID 和 fixture 敏感字段 fail-closed。
- 双路执行使用同一脱敏请求并记录稳定 request hash；每路必须返回 snapshot hash 和 tenant/user context。
- 快照或上下文不一致、结果或比较证据缺失、执行异常时证据门禁失败。
- 响应差异必须按 caseId + path 提供带原因的人工分类；未分类差异禁止通过。
- 离线 evidence 已支持 SHA-256 防篡改落盘，fixture 与静态代码契约已接入 `migration-guard vmp`
  和 `npm run vmp:gate`；真实 HTTP/数据库探针与 Token 运行时注入仍待环境接入。
