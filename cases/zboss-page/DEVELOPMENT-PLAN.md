# Java page 语义门禁开发计划

## 范围与原则

- 只完善 migration-guard 的 Java 分析、fixture、采集和门禁能力。
- `zboss-cloud` 始终只读，不向案例源码提交代码。
- 通用核心禁止出现 zboss 类名、路由和场景 ID。
- page 案例差异只进入 `cases/zboss-page/` 的 profile、语义规则、fixture 和 evidence。
- 所有新能力保持 fail-closed；合成证据不得升级为真实证据。

## 缺口清单

### P0：page 语义没有接入 Java runtime evidence

当前 `JavaRuntimeScenarioEvidence.semantics` 只有 `batch`。pagination、quality、horizontal、refresh 虽有独立校验能力，但不能参与通用 Java real gate。

需要补充：

- `PageEvidenceInput`
- `PageGateRequirements`
- `semantics.page`
- `expectations.page`
- page evidence schema、校验错误码和 evidence hash
- `gatePageEvidence`

### P0：没有项目可配置的语义门禁绑定

不能因为 workload 是 `query` 就默认它一定是分页，也不能在核心中判断 `standard-page`、`horizontal-page` 等案例名称。

需要在项目语义包中声明：

- 入口启用哪些 runtime semantic gates
- 每个场景要求哪些 page 语义块
- 每个场景要求哪些 collectors
- 严格兼容或批准修正对应的 decision ID

### P0：collector 粒度过粗

当前 collectors 定义在 entry 级，导致所有 16 个场景都要求 MySQL、Redis 和 events。

应改为 scenario 级：

- 标准分页：HTTP/page
- quality：HTTP/page + SQL trace
- horizontal：HTTP/page + SQL trace
- refresh：HTTP/page + MySQL + Redis + events
- validation：HTTP/page，无状态变化证明
- transaction/concurrency：MySQL + Redis + events

entry 级 collectors 只保留兼容性汇总，不参与逐场景强制校验。

### P0：缺少实际执行 SQL 的结构化证据

现有 MySQL collector 只能执行只读 snapshot，不能证明运行请求实际生成的 WHERE、HAVING、GROUP BY、DISTINCT 和 ORDER BY。

需要新增通用 `sql-trace` collector，支持读取场景相关 JSONL/结构化日志，并输出：

- statement fingerprint
- normalized clauses
- parameter count/type，不保存敏感值
- datasource/tenant/request correlation
- statement order
- trace hash

无法提供 SQL trace 时，可以用已批准的“结果集不变量”替代，但必须在 compatibility decision 中显式记录。

### P0：缺少 page 内部一致性门禁

需要自动验证：

- `returnedRows <= pageSize`
- `total >= returnedRows`
- row keys 唯一且与响应行一致
- 同一 fixture 重放的 rows/total/order 稳定
- total 查询与数据查询过滤语义一致
- 空页、末页、越界页和大页边界

### P0：quality 与 horizontal 没有结构化门禁

quality 需要验证普通字段与聚合字段的 WHERE/HAVING 路由。

horizontal 需要验证：

- row-key 查询保留要求的 HAVING
- row keys、pivot cells 和响应行对应
- distinct total 与 page-key 域一致
- 重复 pivot key、空 cell 和跨页顺序

### P0：REFRESH 效果、锁和事件没有联合门禁

需要把 HTTP、MySQL、Redis 和 events 证据按 correlation ID 合并为一条 trace，并验证：

- owner-token 获取与释放
- 同一资源并发只能有一个有效 owner
- sync → 状态写入 → undo/补偿 → query → terminal event → unlock 的批准顺序
- 每个失败路径均有终态事件和锁释放
- 非 owner 不得释放锁
- 重放不会重复产生不可接受的副作用

### P1：真实 fixture 仍是统一占位模板

16 个 draft 尚未包含真实请求、场景 seed、预期 page 语义及场景级 collector spec。

需要让 authoring generator 根据语义门禁绑定生成不同模板，避免每个场景手工删除无关 collector。

### P1：运行驱动仍需项目适配

通用 driver 协议已经存在，但 page 案例还缺：

- 健康检查
- seed/cleanup
- 授权请求调用
- fault injection
- before/after snapshot
- SQL/event/Redis correlation
- 清理结果证明

凭据只能通过环境变量或外部 secret provider 注入，不写入 fixture、报告和日志。

### P1：事务 self-invocation 只能识别，不能自动裁决

工具已识别 `REQUIRES_NEW` self invocation，但还需：

- 事务 ID/边界或等价状态证据
- 内层失败、外层失败、重复调用 fixture
- 原子性和回滚 snapshot
- reviewed exception 与源码身份绑定

## 目标数据模型

建议新增通用模型：

```text
PageEvidence
├── response
│   ├── status/envelope
│   ├── pageNumber/pageSize/total
│   ├── rowKeys/rowsHash/orderHash
│   └── error
├── query
│   ├── statements
│   ├── whereFields/havingFields
│   ├── groupBy/distinct/orderBy
│   └── total/data semantic hash
├── horizontal
│   ├── pageKeys
│   ├── pivotKeys/cellRowKeys
│   └── distinctTotal
├── refresh
│   ├── lock owner/acquire/release
│   ├── ordered effects
│   ├── progress terminal
│   └── compensation/rollback
└── lineage
    ├── fixture/spec hashes
    ├── request/correlation IDs
    └── source/runtime contract hashes
```

响应默认只保存结构、业务 key 和 hash；原始敏感行不进入 evidence。

## 实施阶段

当前进度：

- 阶段 1：已完成。
- 阶段 2：已完成。
- 阶段 3：通用 gate 已完成；项目级聚合字段期望和边界数据归入阶段 6 fixture authoring。
- 阶段 4：已完成。
- 阶段 5～7：待开发。

### 阶段 1：通用 page evidence contract

开发内容：

1. 新建通用 `pageRuntimeEvidence` 模块。
2. 定义 page input、requirements、gate report 和稳定错误码。
3. 扩展 fixture metadata 的 `expectations.page`。
4. 扩展 runtime observation 的 `semantics.page`。
5. 更新 JSON schema、hash、合成 evidence 和 malformed/sensitive 检查。

验收：

- 缺 `expectations.page` 或 `semantics.page` 时 real gate 阻断。
- synthetic evidence 结构可通过，但始终 `realEligible=false`。
- 核心源码不包含 zboss 标识。

### 阶段 2：项目可配置的场景语义绑定

开发内容：

1. 扩展 `semantic-rules.json`，增加可选 `runtimeGates`。
2. 将 semantic gate 和 required collectors 下沉到 scenario contract。
3. runtime prepare、authoring、promotion、preflight 和 real gate 使用同一绑定。
4. 为未知 gate、未知 scenario、冲突 decision fail-closed。

page 案例绑定：

- standard/child/upload：pagination
- quality：pagination + quality
- horizontal：pagination + horizontal
- refresh：pagination + refresh
- transaction/concurrency：refresh + state/lock

验收：

- validation 场景不再被错误要求 Redis/events。
- refresh 场景缺任一必要 collector 时阻断。
- 新项目可以只修改语义包启用相同能力。

### 阶段 3：page、quality、horizontal 门禁

开发内容：

1. 实现 pagination 内部一致性校验。
2. 抽取现有 VMP 校验器中的通用算法，VMP 仅保留案例包装。
3. 实现 quality WHERE/HAVING gate。
4. 实现 horizontal page-key/pivot/total gate。
5. 对严格兼容与批准修正使用不同 requirements，不在代码中隐式修正。

验收：

- rows 对、total 错时阻断。
- 聚合字段进入错误 clause 时阻断。
- row-key 与 cells/total 不一致时阻断。
- 顺序差异按照 fixture 明确的 ordered/unordered 规则处理。

### 阶段 4：SQL trace 与联合采集

开发内容：

1. 增加只读 `sql-trace` collector。
2. 增加 statement 规范化、脱敏和 correlation 校验。
3. 支持 before/after MySQL snapshot。
4. 强化 events 终态与 correlation 校验。
5. 强化 Redis owner-token、TTL 和释放结果证据。
6. 增加跨 collector trace assembler。

验收：

- 无 correlation、跨场景串证据或 trace 不完整时阻断。
- SQL 参数值、token、cookie、密码不得出现在 evidence。
- collector spec 与 payload 均有稳定 hash 和完整 lineage。

### 阶段 5：REFRESH 与事务门禁

开发内容：

1. 将 refresh trace 校验接入 `semantics.page.refresh`。
2. 实现成功、同步失败、查询失败、并发冲突和超时路径。
3. 增加 owner-token release、terminal event、rollback/compensation 校验。
4. 增加事务 self-invocation 的 reviewed-exception evidence contract。

验收：

- 任一终态遗漏 unlock 或 terminal event 时阻断。
- 非 owner unlock、重复副作用或失败后继续查询时阻断。
- self-invocation 只有在 decision approved 且对应失败 fixture 通过时才解除静态阻断。

### 阶段 6：page 案例 fixture 与运行驱动

开发内容：

1. 重新生成 16 个场景草稿。
2. 补齐脱敏请求、seed、expected page semantics 和 collector specs。
3. 实现 page 案例 driver adapter。
4. 对远端环境执行 dry-run，先验证命令、连接和清理范围。
5. 经确认后采集 real evidence。

验收：

- `fixturesReady=true`
- `environmentReady=true`
- `executionReady=true`
- 16 个场景全部有真实、相关且可重放的证据
- cleanup 全部通过

### 阶段 7：兼容性决策与最终门禁

逐项处理：

1. `PAGE-DEC-QUALITY-AGGREGATE-ROUTING`
2. `PAGE-DEC-HORIZONTAL-HAVING`
3. `PAGE-DEC-REQUIRES-NEW-SELF-CALL`
4. `PAGE-DEC-REFRESH-EFFECT-ORDER`

每个 decision 必须记录：

- strict parity 或 approved correction
- 评审人和时间
- 绑定源码身份
- fixture/evidence hash
- 回滚条件

最终验收：

- 离线门禁无 pending decision
- Java runtime real gate 通过
- `evidenceReady=true`
- 源码身份、contract hash 或 collector spec 变化后自动失效

## 测试计划

### 单元测试

- page schema、normalization、hash
- pagination/quality/horizontal/refresh gates
- SQL trace normalization 与脱敏
- scenario collector selection
- malformed、missing、stale、synthetic、sensitive fail-closed

### 集成测试

- runtime prepare → authoring → promotion → dry-run → collect → assemble → gate
- fixture/spec/source/contract hash 失配
- 多场景 correlation 隔离
- collector 超时、截断、非零退出和清理失败

### 回归测试

- batch semantics 和现有 VMP gate 不退化
- 普通 query 不被强制要求 page semantics
- collector spec 不再被误识别为 fixture
- 通用核心无项目标识扫描

## 建议执行顺序

可立即离线完成：

1. 阶段 1：page evidence contract
2. 阶段 2：场景语义绑定与 collector 下沉
3. 阶段 3：pagination/quality/horizontal gates
4. 阶段 4：SQL trace 和联合 trace schema
5. 阶段 5：REFRESH/事务门禁及测试

依赖真实环境或业务输入：

6. 阶段 6：真实 fixture、授权请求、seed/cleanup 和采集执行
7. 阶段 7：兼容性评审与最终 real gate
