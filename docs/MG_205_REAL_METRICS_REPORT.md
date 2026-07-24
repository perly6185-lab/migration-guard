# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `5714498d165b4b4e1528909da131c65c3425f669caa06df0b02d1acbb48bc818`
- Cross-layer evidence hash: `5b39ac6db37c96ced658f29c0ee0ef8e430ac70d9ae92b27ed226d681e6e7049`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 1421 | 435 | 76.6% |
| Service | 5541 | 4880 | 661 | 88.1% |
| Repository | 4068 | 4064 | 4 | 99.9% |

Repository evidence now contains 3316 SQL-backed methods (81.5% coverage), no generated boundaries, 6 unknown operations, no unresolved-edge findings, no ambiguous-call findings, and no dynamic SQL blockers. The regression gate passes against the checked-in baseline, reducing generated boundaries by 21, unresolved-edge findings by 1196, and dynamic SQL blockers by 107 to zero.

Dynamic MyBatis ownership evidence now synthesizes deterministic replay cases for `<if>`/`<when>` true and false branches, `<foreach>` empty/single/multiple cardinalities, `<choose>` fallback, and empty/present `<where>`/`<set>`/`<trim>` content. The SQL contract report aggregates these branch cases. `RP-SQL-DYNAMIC-SOURCE` now identifies only dynamic sources that still lack replay evidence; `RP-SQL-TABLE-UNRESOLVED` separately identifies dynamic sources whose table cannot be resolved.

Dynamic table placeholders now synthesize known, unknown, and invalid identifier replay cases. Whole-statement `${sql}` and `${...Script}` inputs synthesize valid, invalid, and rejected multi-statement cases. SQL that is intrinsically tableless, such as `LAST_INSERT_ID()` and `DATABASE()`, is classified separately. This clears all 69 method-level table-expansion contracts and all 35 table-unresolved methods without treating raw SQL as a statically resolved table.

Tenant routing now synthesizes active, missing-context, and mismatch cases. Datasource routing synthesizes default, selected, and unavailable cases. This clears all 145 method-level routing contracts and the final 17 dynamic SQL blockers; all 2501 discovered SQL records now have reviewable static replay contracts.

BaseMapper ownership now includes inherited `insertBatch`, `updateBatch`, `deleteByIds`, `selectByIds`, and convention-backed `selectListBy*` operations. Generic parameter declarations are preserved for overload inference; `forEach` lambdas and Map/Collection method references infer their element arguments; generated BaseMapper return entities and same-class method return types participate in overload scoring. Repository unresolved-edge findings decreased from 221 to zero and ambiguous-call findings from 31 to zero.

Abstract BaseMapper methods with a recognized read/write/delete prefix and a `By...` predicate now generate a narrow method-convention contract only when the mapper entity and explicit `@TableName` both resolve. Explicit annotation or XML SQL remains authoritative and suppresses the generated fallback. This supplies evidence for the final five mapper declarations and their callers, bringing Repository readiness to 100%.

Controller and Service call extraction now scans a position-preserving copy with string and character literals masked, while argument arity and types are recovered from the original source. This removes method-shaped text inside log and SQL literals without dropping real string arguments. Chained calls whose declared return type is outside the source model are classified as external library boundaries, and source-declared Feign clients are treated as explicit remote boundaries. Controller unresolved-edge findings decreased from 349 to 43 and readiness rose from 1189 to 1342; Service unresolved-edge findings decreased from 407 to 117 and readiness rose from 4256 to 4318.

Interface declarations overridden by a concrete Spring implementation are now collapsed by normalized Java signature before overload selection. Generic local declarations, collection implementation assignability, stream-lambda element types, chained getters, Lombok `@Value` fields, and narrow external ID/list factories now contribute argument evidence. True multi-implementation and unresolved overloads remain fail-closed. Controller ambiguous-call findings decreased from 168 to 6 and readiness rose to 1387; Service ambiguous-call findings decreased from 586 to 16 and readiness rose to 4500.

Java declaration discovery now accepts multiline type headers, long method signatures, package-private support methods, and static initializer blocks. Brace ranges ignore string and character literal contents, preventing regex and template text from swallowing later methods. This reduced Controller unresolved-edge findings from 43 to 8 and discovered 18 additional Service methods plus one SQL-backed Repository method. The expanded Service inventory exposes deeper unclassified and graph-budget findings rather than suppressing them.

External static imports whose declaring type is outside the source model are now explicit external boundaries. Constructor expressions are excluded from bare method-call extraction, including under wildcard static imports. This reduced Controller unresolved routes from 1739 to 434 without suppressing ambiguous candidates; ambiguous routes changed from 675 to 680 as deeper valid traversal exposed additional real candidates.

Lombok-generated accessors are recognized only when the declaring source type carries `@Data`, `@Getter`, `@Value`, or `@Setter`, the matching field exists, and getter/setter arity is valid. The same evidence is used for accessors on a resolved chained return type. Controller unresolved routes decreased from 434 to 423 and Service unresolved findings from 794 to 745; remaining blockers overlap other causes, so Controller ready stayed unchanged.

Injected type resolution now honors explicit Java imports and same-package types before falling back to simple-name candidates. Spring interface implementations are narrowed only by an existing `@Qualifier`, a unique `@Primary`, a unique explicit component name, or a unique field-name/bean-name match. This reduced Controller ambiguous routes from 680 to 346 and raised Controller ready from 778 to 963. Service expansion budget exhaustion increased from 91 to 95 because correct type selection exposed deeper reachable graphs; the budget remains fail-closed.

Unclassified nodes now use narrow semantic rules for JSON/Gson serialization, clock reads, JDK functional/string/regex utilities, string builders, query-wrapper predicates, Spring proxy context, progress reporting, `page`/`rowNum` reads, and DTO-shaped initialization. Generic `handle`, `apply`, and `process` methods remain unclassified without stronger evidence. Controller unclassified routes decreased from 638 to 349 and Service unclassified findings from 1869 to 919.

The semantic registry now also recognizes JDK stream terminals, deterministic string/number/date value operations, future joins and executor lifecycle, in-memory queue/barrier coordination, SQL session flushes, exception diagnostics, and JSON object conversion. Controller unclassified findings decreased from 362 to 306 and readiness rose to 1426; Service unclassified findings decreased from 995 to 775 and readiness rose to 4716. Random UUID generation and generic business verbs remain fail-closed.

Adaptive expansion now records cap signals, unexpanded boundaries, and maximum out-degree per round, then classifies exhausted graphs as edge-cap, depth-growth, high-fanout, or mixed. The original 173 Service exhaustions split into 158 high-fanout edge caps and 15 depth-growth cases. Raising only the depth ceiling from 24 to 36 and the reachable round count from 4 to 6 closed 14 depth cases at depth 27; one transitioned to high-fanout. The remaining 159 high-fanout graphs retain the 2000-edge hard limit and remain fail-closed. Graph-incomplete findings decreased from 231 to 217 without changing readiness.

Unclassified review now separates private deterministic helpers, value-object factory candidates, and application-context coordination without weakening unknown-boundary blocking. Narrow rules for private format/parse/extract/compare helpers, explicit result factories, and `*Context` scope access reduced Service unclassified findings from 775 to 747 and raised readiness to 4744; Controller unclassified findings decreased from 306 to 282 and readiness rose to 1428. Among the remaining blocked Service methods, 639 reach business helpers, 63 reach value-object factory candidates, 9 reach context-coordination candidates, and 235 contain residual unknowns; categories can overlap within a method.

The 9 context-coordination candidates were reviewed against their source implementations. `AiCallContext.runWithBizContext` and Cascade Context push/pop/exit/snapshot operations are ThreadLocal scope lifecycle, while `ruleContext.rulesOf` and `nodesOf` are read-only preloaded Map lookups. Classifying only those shapes cleared the context-coordination bucket, reduced Service unclassified findings from 747 to 744, and raised readiness to 4747. Controller unclassified findings decreased from 282 to 280 and readiness rose to 1430; six of the original nine Service methods retain independent blockers.

The 63 value-object-factory candidates collapsed to ten unique source symbols. Source review confirmed deterministic number parsing (`IntegerExtractor`, `NumberExtractor`, and `NumberPercentageExtractor`), value selection (`AiOutputTypeResolver`, `ImportFailureMessageResolver`, and `ViewMetaRespKeyResolver`), in-memory validation (`BatchTypedFieldResolver`), and value construction (`Eligibility.no`, `NoMenuUsePageCleanupStats.empty`, and `ViewMetaExcelHeadSnapshot.from`) with no database, network, clock, or random effects. An explicit type-and-method allowlist clears the candidate bucket without classifying generic `resolve`, `extract`, `from`, or `create` calls. Service unclassified findings decreased from 744 to 722 and readiness rose from 4747 to 4769; the other 41 candidate methods retain independent blockers. Controller unclassified findings decreased from 280 to 279 while readiness remained 1430.

The 639 business-helper candidates collapsed to 217 unique source methods. Review separated deterministic field formatting, DTO/config transformation, scalar conversion, formula rendering, key construction, local status-cache coordination, and an explicit dynamic-DDL write from effectful orchestration. Narrow class-and-method rules preserve nested repository, remote, logging, and state effects instead of treating generic `handle`, `process`, `apply`, `copy`, or `sync` verbs as pure. The business-helper bucket decreased from 639 to 275 methods, Service unclassified findings fell from 722 to 410, and readiness rose from 4769 to 4990. Controller unclassified findings decreased from 279 to 235 and readiness rose from 1430 to 1437. The remaining helpers include repository/remote orchestration, task lifecycle, synchronization, file cleanup, OCR, copying, and other behavior that remains fail-closed pending stronger ownership evidence.

The 235 residual-unknown methods expanded to 258 distinct symbols, dominated by missed deterministic JDK collection/date operations, source value accessors, and expression parsing/evaluation helpers. Extending those narrow semantic families reduced the residual bucket from 235 to 162 without classifying random UUID generation, WebSocket/JDBC calls, processes, files/ZIP streams, schedulers, or dynamic ports as pure. Service unclassified findings decreased from 410 to 359 and readiness rose from 4990 to 5034. Controller unclassified findings decreased from 235 to 221 and readiness rose from 1437 to 1443. The remaining residuals retain explicit effect or ownership uncertainty.

A second review of the 275 remaining business-helper methods collapsed them to 175 unique implementations and assigned explicit effect kinds instead of purity: relationship cleanup, synchronization, initialization, copying, task lifecycle, and backup/cleanup operations are state writes; OCR, speech, and document operations are external calls; background refresh and heartbeat work is asynchronous or coordinated; WebSocket notification is event publication; current-user lookup is context resolution. Local request, DTO, metadata, rendering, and scalar helpers remain calculations with nested effects retained. The business-helper bucket decreased from 275 to 23, Service unclassified findings fell from 359 to 173, and readiness rose from 5034 to 5179. Controller unclassified findings decreased from 221 to 139 and readiness rose from 1443 to 1475. The final 23 business helpers remain fail-closed because their cross-module refresh, dynamic-port, or complex synchronization ownership is still insufficiently evidenced.

Overload argument inference now uses local and foreach declarations, primitive declarations, explicit casts, `List<T>.get()`, source-declared method return types, and Lombok getter field types. Controller ambiguous routes decreased from 346 to 132 and Service ambiguous findings from 802 to 453. Deeper valid traversal exposed additional downstream dynamic SQL, unresolved calls, and graph-cap findings; those remain fail-closed.

Cross-layer lineage covers 1856 routes. Of these, 1632 reach SQL and 1629 (87.8%) have a complete Controller -> Service -> Repository -> SQL chain.

## Interpretation and next work

BaseMapper operations are reviewable only when the mapper generic entity resolves to a source type with an explicit `@TableName`. The generated contract records framework, entity, table, operation and predicate class. All 1280 BaseMapper records in this assessment met that requirement; unresolved mappings remain fail-closed with `generated-contract-not-reviewable`.

Next work is ordered by evidence impact:

1. Review the 336 Controller routes that reach at least one method whose extracted calls exceed the retained-call cap; all remain fail-closed.
2. Review the remaining 19 Service unclassified boundaries: 5 insufficiently evidenced business helpers and 14 residual-unknown methods; retain all 636 call-cap-saturated high-fanout assessments behind the 2000-edge hard limit.
3. Review the four Repository methods blocked only by per-method call-cap saturation; their SQL contracts remain reviewable, but their behavior graphs are incomplete.
4. Update the checked-in real-project baseline only after the dirty source fingerprint and reports are reviewed.

Assessment readiness measures static evidence coverage. It does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.

## Full evidence recomputation (2026-07-24)

The full Controller, Service, Repository, and cross-layer evidence set was recomputed from the same source identity and shared initial graph budget. The source revision is `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`. Tests are excluded. Service uses a hard adaptive maximum of depth 36 / 2000 edges across six rounds; Repository uses depth 24 / 2000 edges across four rounds.

The per-method call cap is now an explicit truncation signal. Any graph that omits extracted calls at that cap is incomplete and remains blocked even when the total edge and depth budgets have room. This conservative correction changes the aggregate result to Controller 1421/1856 ready, Service 4880/5541 ready, and Repository 4064/4068 ready. Controller has 336 call-cap findings. Service has 636 call-cap-saturated high-fanout assessments and 19 unknown-boundary methods. Repository has four call-cap-saturated methods; it still has zero generated boundaries, zero unresolved-edge findings, and zero dynamic SQL blockers.

Service diagnostics report 1271 cap-saturated nodes with 37674 omitted calls across 636 affected methods. Of those methods, 442 contain repeated outgoing-subgraph shapes and 235 contain cyclic strongly connected components. Conservative triage labels 50 `likely-analyzer-amplified` and 586 `mixed`. None are auto-unblocked: call-cap saturation proves analyzer truncation is present, but does not disprove genuine business fan-out.

The recomputed component report hashes are Controller `3954b18195df4ea5c5d387d4fe677c9a07812501344d8a162bbb0c71c7151209`, Service `9ef9b769c1f9a4d6f564a66860c0192087bf2a7bbcc6fe7bb8ea9b35bffddcde`, Repository `fec9f05ce42916b536f283b2ffb9b90ab6c7231d861727a4e12f9c7e1599d378`, and lineage report `1549698af7fc5fd156e4001437fb7da6a0b20d40a533a7e9a4cdc9a20269ca01`.

## Command

```text
migration-guard java-endpoint metrics-report --controller <controller.json> --service <service.json> --repository <repository.json> --lineage <lineage.json> --apply --artifacts-dir <dir>
```
