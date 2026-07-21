# Rust Assessment Metrics Plan

规划日期：2026-07-21

## 背景

Controller、Service 和 Repository 三层 Java-to-Rust assessment 已经能给出严格 fail-closed 的 ready/blocked 结论。下一阶段不应先扩大自动迁移范围，而是先把“为什么 blocked、哪些证据缺失、改进是否真实降低风险”变成稳定指标。

当前真实项目基线来自 `zboss-module-data`：

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller routes | 1695 | 973 | 722 | 57.4% |
| Service methods | 5239 | 3207 | 2032 | 61.2% |
| Repository methods | 4067 | 2725 | 1342 | 67.0% |

Repository 最新 SQL-source modeling 已将 generated boundaries 从 105 降到 21，并新增 417 条 SQL source records，其中 207 条为 dynamic SQL source records。

## 下阶段目标

目标不是让 ready rate 机械升高，而是让 ready 结论更可复核，让 blocked 结论更可行动。

| Metric | Baseline | Target | Why it matters |
| --- | ---: | ---: | --- |
| Repository generated boundaries | 21 | <= 10 | 剩余无源实现必须尽快归因，否则无法判断是否可替换。 |
| Repository dynamic SQL blocked methods | 107 | <= 60 | 动态表名、条件 XML 和 provider fragment 是下一批主要阻断。 |
| Repository unknown operations | 32 | <= 15 | 未分类操作无法进入可靠 workload 和 state contract。 |
| Repository unresolved-edge findings | 1196 | <= 900 | 未解析调用仍是最大阻断来源，需要 receiver/type inference 收敛。 |
| Repository SQL-backed methods | 247 | >= 350 | 更多 mapper/XML/annotation SQL 应进入显式 evidence graph。 |
| Service methods with unknown nodes | 1864 | <= 1400 | Service 层 unknown ownership 是扩大 Rust planning 的主要噪声。 |
| Service expansion budget exhausted | 96 | <= 50 | 剩余深图应靠边界缓存和更准解析降低，不靠无限加预算。 |
| Controller blocked routes | 722 | <= 600 | 用户入口层应更快暴露可规划范围和阻断原因。 |
| Cross-layer evidence lineage | 0 | >= 1 real report | Controller -> Service -> Repository -> SQL 的链路必须能统一解释。 |

## 指标定义

- `readyRate = ready / total`，只作为趋势指标，不作为单独放行门禁。
- `blockedCauseShare[finding] = findingCount / blocked`，用于识别下一批最高价值改进。
- `sqlCoverage = sqlBackedMethods / repositoryMethods`，衡量 SQL source 是否被显式建模。
- `dynamicSqlOwnershipRate = dynamicSqlSourcesWithBranchEvidence / dynamicSqlSources`，衡量动态 SQL 是否有可 replay 的分支证据。
- `contextCoverage = methodsWithTenantOrDatasourceContext / methodsTouchingSql`，衡量 tenant/datasource 是否显式进入合同。
- `transactionCoverage = transactionalSqlSources / sqlSourcesRequiringTransaction`，衡量事务参与是否进入 state/effect contract。
- `unknownOperationRate = unknownOperations / repositoryMethods`，用于防止 workload 分类退化。
- `graphResolutionRate = resolvedEdges / totalEdges`，用于追踪 receiver/type inference 改进。

## 实施顺序

1. Dynamic SQL ownership evidence

   交付：为 mapper XML 的 `<if>`、`<choose>`、`<foreach>`、`<where>`、`<set>` 和 provider-generated SQL 增加 branch/parameter evidence。动态表名、租户字段和数据源路由要进入 SQL source detail。

   验收：`RP-SQL-DYNAMIC-SOURCE` 不再只是单个阻断标签，而能说明缺少 table expansion、branch fixture、provider fragment 或 routing contract 中哪一项。

2. SQL contract metrics report

   交付：`assess-repositories` 输出 `sqlMetrics` 汇总，包括 SQL source kind、operation、dynamic tag、tables、tenant/datasource context、transaction participation 和 unresolved SQL reasons。

   验收：Markdown report 可以直接回答“哪些 SQL 已可复核，哪些还缺 replay contract”。

3. Receiver and type inference cleanup

   交付：补 multiline call arguments、static imports、factory-return receiver types、generic type substitution 和 varargs/boxing 的保守解析。

   验收：Repository `RP-GRAPH-UNRESOLVED-EDGES` 降到 900 以下，Service unknown nodes 降到 1400 以下，同时 ambiguous calls 不得因为误解析而虚假下降。

4. Cross-layer evidence lineage

   交付：新增一个聚合报告，将 Controller route、Service method、Repository method 和 SQL source 通过 node id/source id 串起来。

   验收：至少一个真实项目报告能展示 top blocked routes 的下游 SQL/root-cause 分布。

5. Metrics regression gate

   交付：加入稳定 fixture 和 real-project snapshot，对关键指标设置 non-regression guard。

   验收：新增语义模型不能让 generated boundaries、unknown operations、unresolved-edge findings 或 dynamic SQL blockers 无解释上升。

## 退出标准

进入下一轮 Rust target replay 或生成前，至少满足：

- Repository ready rate >= 70%，且 generated boundaries <= 10。
- Dynamic SQL blockers 有可分类原因，而不是只给出泛化 `RP-SQL-DYNAMIC-SOURCE`。
- 至少一个真实 cross-layer evidence report 绑定同一 commit 和同一 assessment run。
- `npm test` 全绿，真实 repository assessment report hash 已更新。
- 文档明确声明 assessment 仍不等同于 Rust implementation、runtime replay、performance parity 或 source-off readiness。

## 暂不做

- 不自动生成 Rust SQL adapter。
- 不自动声明 dynamic SQL 可以替换。
- 不引入数据库连接或线上 schema 读取。
- 不为了提高 ready rate 放宽 fail-closed policy。
