# engine-use-page/page Rust 非真实条件补齐计划

目标接口：`POST /zboss/data/view/dynamic/engine/use/engine-use-page/page`

目标状态：在不依赖真实服务、真实数据库快照和真实 Token 的条件下，一次性完成 Rust
实现、离线验证和证据编排，使剩余 blocker 只包含真实运行条件。

`zboss-cloud` 全程只读。所有新增代码、契约、测试和证据落在 `migration-guard`。

## 完成定义

以下条件必须同时成立，才允许把状态标记为 `offline-ready`：

- `rust/zboss-rust/internal/dynamic-engine-runtime` 可作为统一项目内部能力构建、启动和健康检查；
- HTTP 请求、响应 envelope、错误码和五类上下文契约已版本化；
- 普通分页、横向分页、quality WHERE/HAVING、REFRESH 全部由 Rust 实现；
- 数据库、Redis、时钟、事件等基础设施均通过 port 隔离；
- production adapter 可编译，memory adapter 可完成全部离线场景；
- 八类合成场景、故障、并发和属性测试全部通过；
- Java stub/Rust 双路离线回放生成防篡改 evidence bundle；
- 严格兼容项和批准修正项均有机器可读决策；
- 源码身份、Rust 制品、契约、测试和 evidence hash 可重复生成；
- 不存在 `todo!()`、`unimplemented!()`、未知边界或未分类差异。

`offline-ready` 不等于最终达标。最终达标仍需七类真实夹具和同快照双路回放。

## 工程布局

不把 `/page` 合并进现有 batch crate，创建独立服务：

```text
rust/
├── batch-update-service/
└── zboss-rust/internal/dynamic-engine-runtime/
    ├── Cargo.toml
    ├── Cargo.lock
    ├── README.md
    ├── src/
    │   ├── lib.rs
    │   ├── main.rs
    │   ├── config.rs
    │   ├── http/
    │   │   ├── dto.rs
    │   │   ├── envelope.rs
    │   │   ├── error.rs
    │   │   └── handler.rs
    │   ├── application/
    │   │   ├── page.rs
    │   │   └── refresh.rs
    │   ├── domain/
    │   │   ├── context.rs
    │   │   ├── query_plan.rs
    │   │   ├── filter.rs
    │   │   ├── horizontal.rs
    │   │   └── response.rs
    │   ├── ports/
    │   │   ├── metadata.rs
    │   │   ├── query.rs
    │   │   ├── preference.rs
    │   │   ├── refresh.rs
    │   │   ├── lock.rs
    │   │   ├── clock.rs
    │   │   └── event.rs
    │   └── adapters/
    │       ├── memory/
    │       ├── mysql/
    │       └── redis/
    ├── contracts/
    ├── fixtures/
    └── tests/
```

`memory` 为默认测试 profile；MySQL/Redis adapter 使用独立 feature，CI 必须执行
`cargo check --all-features`，避免未接真实环境时 production adapter 腐化。

## 批次一：工程、契约和端口冻结

### PRP-01：独立服务骨架

- 创建 Rust 2024 edition crate，锁定与 batch 工程一致的 Rust 1.89；
- 建立 library + binary、配置加载、结构化日志、健康检查和 readiness；
- 提供 memory profile，启动时不依赖外部服务；
- 增加格式化、Clippy、测试和 release 构建命令。

验收：

- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --all-features`
- memory profile 能启动并响应 `/health`、`/ready`

### PRP-02：HTTP 与上下文契约

按只读 Java assembler 冻结请求字段：

- `reqId`、`operator`、`pageNo`、`pageSize`
- `usePageId`、`pageId`、`panelId`、`interId`、`httpId`
- `headerValues`、`layoutGlobalCondition`、`postValues`、`selectValues`
- `orderValues`、`qualityValues`、`textFilterValue`
- `horizontalValues`、`horizontalKeyValues`、`horizontalDataPageTreeReqVOs`
- `uploadTmpTableName`、`uploadTmpFlag`
- `pageCreateMode`、`usePageTemplatePage`
- `fieldId`、`dataId`、`childFormFieldId`
- `skipSavePageSize`、`showArchived`、`relateFieldId`
- `primaryKeyId`、`locatePrimaryKeyId`

冻结响应字段：

- CommonResult envelope：code、msg、data；
- data：reqId、defRespKey、respData、headList；
- valueSyncStatusList、valueSyncStatusMap；
- uploadTmpTableName、batchId；
- respData item：reqId、respKey、data、total、pageNo、targetLayoutTag、
  isRecordRowNum、valueSyncStatusList。

上下文不得从全局变量隐式读取，统一形成 `RequestContext`：

- tenant
- user
- device
- request/trace
- datasource/snapshot

交付：

- JSON Schema；
- Rust serde DTO；
- Java fixture → Rust DTO → JSON round-trip 测试；
- null、缺省、数字精度、字段大小写和未知字段策略测试。

### PRP-03：错误与兼容决策

冻结四层错误：

- HTTP/JSON/validation
- permission/context
- query/infrastructure
- refresh/lock/effect

每个错误固定 HTTP status、业务 code、message policy 和 retryable 标识。

创建机器可读兼容清单：

- 默认：`strict-parity`
- 批准修正 `quality-aggregate-routing`：
  聚合字段由 WHERE 改为 HAVING
- 批准修正 `horizontal-having-preservation`：
  横向 row-key 查询保留 HAVING，并在 HAVING 后计算 distinct total

除此之外的差异全部 fail-closed。

### PRP-04：ports 与 memory adapters

建立以下接口：

- `MetadataPort`
- `PageQueryPort`
- `PagePreferencePort`
- `ChildFormPort`
- `PermissionPort`
- `RefreshPort`
- `LeaseLockPort`
- `ClockPort`
- `EventPort`
- `EvidencePort`

memory adapter 必须支持：

- 版本化表元数据和字段元数据；
- tenant/datasource 隔离；
- 查询前后快照；
- 可控时钟；
- owner-token + TTL + fencing token 租约；
- 事件轨迹和故障注入；
- 确定性并发屏障。

## 批次二：完整业务实现

### PRP-05：普通分页应用流

按入口顺序实现：

1. 请求和上下文校验；
2. 子表单 header 条件补全；
3. 从 postValues 解析上传临时表参数；
4. pageNo/pageSize 归一化；
5. 按策略保存 pageSize；
6. 装配 usePage/page/panel/operation/permission 元数据；
7. 字段解析和移动端 selectValues 兜底；
8. 构建查询计划；
9. 执行分页、值转换和响应回填。

必须覆盖 child form、temporary table、tenant permission、primary-key filter、
locate-primary-key、showArchived 和 layout-global-condition。

### PRP-06：安全动态 SQL

Rust 内核只生成类型化查询 AST：

- 字段、表名、聚合函数和操作符来自白名单元数据；
- 值全部绑定参数；
- 动态表名经过 ownership/tenant 校验和 identifier quoting；
- WHERE、HAVING、GROUP BY、ORDER BY 分层存储；
- count 和 data query 从同一计划派生；
- SQL renderer 输出 SQL、binds、table identity 和 query fingerprint。

生产 MySQL adapter 消费 AST；memory adapter 解释同一 AST。禁止测试模型和生产 SQL
各自实现一套筛选规则。

### PRP-07：quality WHERE/HAVING

- 普通字段进入 WHERE；
- SUM/COUNT/AVG/MIN/MAX 字段进入 HAVING；
- WHERE 先过滤明细，HAVING 再过滤业务组；
- `IS NULL`/`IS NOT NULL` 不绑定伪值；
- IN、比较、空条件和未知字段全部有失败关闭行为；
- count 使用 HAVING 后 surviving distinct business keys。

### PRP-08：横向分页与聚合

- 复合业务键采用类型和 null 安全表示；
- 第一阶段查询 HAVING 后 distinct row keys；
- 第二阶段使用 OR-of-AND 精确回取当前页全部 cell；
- 稳定排序避免跨页重复和丢失；
- SUM/COUNT/MIN/MAX 基于完整 cell；
- AVG 保存 sum/count 累加器，禁止平均数的平均数；
- total、page keys、cell rows、pivot values 使用同一 query fingerprint 谱系。

### PRP-09：REFRESH 编排

入口保持两条互斥路径：

- 非 REFRESH：直接执行普通分页；
- REFRESH：acquire → sync → post effects → query → release。

实现要求：

- 锁键至少包含 tenant + page/panel；
- owner token、TTL、fencing token；
- 获取和释放原子；
- sync 失败不得 query、更新时间或清 Undo；
- query 失败必须释放锁；
- 手动刷新优先于自动刷新；
- 同 panel/column 去重，允许不同 column 并发；
- timestamp、Undo clear、reconcile、query、unlock 顺序可审计；
- 失败时保存原错误和补偿错误，不相互覆盖。

## 批次三：测试、离线回放与证据

### PRP-10：八类合成场景

Rust fixtures 和 migration-guard caseId 使用稳定映射：

| 静态场景 | 离线/真实行为 |
| --- | --- |
| `standard-page` | `standard-page` |
| `refresh-operator` | `refresh` |
| `child-form-page` | `child-table` |
| `horizontal-page` | `horizontal-table` |
| `quality-text-filter` | `quality-filter` |
| `upload-preview-page` | `temporary-table` |
| `tenant-auth-context` | `tenant-permission` |
| `entrypoint-parity` | 离线额外场景 |

每个场景同时断言响应、查询计划、数据快照、事件轨迹和 fingerprint。

### PRP-11：故障和并发测试

故障矩阵：

- metadata/permission/query 失败；
- SQL timeout、deadlock、invalid identifier；
- Redis acquire/release/lease expiry；
- sync、timestamp、Undo、reconcile、query 失败；
- 进程在 acquire、sync、query、release 各阶段中断。

并发矩阵：

- 相同 tenant/page/panel；
- 不同 tenant 相同 ID；
- 同列与异列刷新；
- lease 过期后的新 owner；
- 旧 owner 尝试释放新 owner 的锁。

### PRP-12：属性测试

至少覆盖：

- WHERE/HAVING 组合不改变执行顺序；
- horizontal 分页页间无重复、无遗漏；
- 所有页 key 并集等于 HAVING survivors；
- AVG 等于完整 sum/count；
- 复合键对 null、字符串 `"null"`、数字和分隔符无碰撞；
- terminal effect 唯一；
- 任意失败路径最终均不残留 owner lock。

固定随机 seed，并把失败 seed 写入 evidence。

### PRP-13：离线双路回放

新增两个 runtime driver：

- `java-reference-stub`：读取冻结的 Java 参考响应、计划和轨迹；
- `rust-page-memory`：通过 Rust memory profile 执行真实 handler/application/domain 路径。

migration-guard 对两路执行：

- 同一 request hash；
- 同一 snapshot hash；
- 同一 tenant/user/device/request context；
- 响应和副作用比较；
- 应用 compatibility decision；
- 未分类差异 fail-closed。

stub 不作为真实 Java 证据，只用于证明回放、比较和门禁链路已经完整。

### PRP-14：可重复制品与证据

新增 source baseline manifest：

- Java HEAD 和 dirty fingerprint；
- 静态闭包 hash；
- HTTP/schema hash；
- compatibility-decision hash；
- Rust Cargo.lock、源码树和 release binary hash；
- fixture、测试报告和 evidence bundle hash。

所有 hash 使用稳定排序和 SHA-256。createdAt、绝对路径等易变值不得进入内容身份。

输出：

- `artifacts/page-rust/source-baseline.json`
- `artifacts/page-rust/contracts.json`
- `artifacts/page-rust/test-report.json`
- `artifacts/page-rust/offline-replay.json`
- `artifacts/page-rust/evidence-bundle.json`
- `artifacts/page-rust/offline-readiness.md`

### PRP-15：统一门禁

增加一个聚合命令，例如 `npm run page-rust:gate`，顺序执行：

1. TypeScript build 与 VMP tests；
2. Java endpoint 静态闭包复核；
3. Rust fmt/clippy/test/all-features check；
4. schema compatibility；
5. 八类场景、故障、并发和属性测试；
6. 离线双路回放；
7. evidence 完整性验证；
8. offline readiness 判定。

任何步骤失败都不得保留旧的“通过”报告。

## 三批次依赖和提交边界

```text
批次一：PRP-01～04
  service skeleton → contracts/errors → ports/memory
                         │
                         ▼
批次二：PRP-05～09
  normal page → typed SQL → WHERE/HAVING → horizontal → REFRESH
                         │
                         ▼
批次三：PRP-10～15
  scenarios → faults/concurrency/properties → replay → evidence → gate
```

三个批次连续执行，阶段验收只用于定位问题，不把局部通过当成交付完成。

## 最终非真实条件验收表

| 门禁 | 通过标准 |
| --- | --- |
| 静态闭包 | 0 truncation、0 unresolved、0 ambiguous、0 unknown |
| Rust quality | fmt/clippy/test/all-features 全绿 |
| HTTP contract | schema/serde/Java fixture round-trip 全绿 |
| 查询语义 | WHERE/HAVING、distinct total、horizontal 聚合全绿 |
| REFRESH | 顺序、失败释放、租约和并发矩阵全绿 |
| 场景 | 8/8 |
| 故障 | 全矩阵通过且无残留副作用 |
| 属性测试 | 固定 seed 全绿，可重放失败 seed |
| 离线回放 | 0 未分类差异 |
| Evidence | hash 可复算，篡改检测通过 |
| Readiness | 仅真实环境条件显示 blocked |

## 计划完成后仍保留的唯一外部条件

- 七份真实脱敏请求；
- Java 参考服务与 Rust 服务；
- 两套同源、隔离数据库快照；
- Redis/数据库网络与权限；
- Token、tenant/user/device/request 上下文；
- 真实 SQL、响应、副作用和锁轨迹证据；
- 最终容量与延迟 SLO。

上述外部条件不阻碍本计划的代码和离线证据开发。
