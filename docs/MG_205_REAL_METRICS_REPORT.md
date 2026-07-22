# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `e9d20602ca2b6b54f2abe72691ab1f20e0101838a00d721c22ba7656f0944e52`
- Cross-layer evidence hash: `7099fbdcfbf726b4b064f92bacef1b0c0883c7bd6c5812f762cca9ca88e7d1d1`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 1426 | 430 | 76.8% |
| Service | 5524 | 4716 | 808 | 85.4% |
| Repository | 4068 | 4068 | 0 | 100.0% |

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

Overload argument inference now uses local and foreach declarations, primitive declarations, explicit casts, `List<T>.get()`, source-declared method return types, and Lombok getter field types. Controller ambiguous routes decreased from 346 to 132 and Service ambiguous findings from 802 to 453. Deeper valid traversal exposed additional downstream dynamic SQL, unresolved calls, and graph-cap findings; those remain fail-closed.

Cross-layer lineage covers 1856 routes. Of these, 1627 reach SQL and 1624 (87.5%) have a complete Controller -> Service -> Repository -> SQL chain.

## Interpretation and next work

BaseMapper operations are reviewable only when the mapper generic entity resolves to a source type with an explicit `@TableName`. The generated contract records framework, entity, table, operation and predicate class. All 1280 BaseMapper records in this assessment met that requirement; unresolved mappings remain fail-closed with `generated-contract-not-reviewable`.

Next work is ordered by evidence impact:

1. Retain the remaining 8 Controller unresolved-edge findings and 6 ambiguous calls without sufficient implementation, arity, nested-type, or stream-flow evidence as fail-closed.
2. Reduce the remaining 775 Service unclassified boundaries and analyze the 173 adaptive-expansion budget exhaustions exposed by the expanded inventory.
3. Shift the next cleanup phase to Controller and Service graph completeness; Repository has no remaining blockers.
4. Update the checked-in real-project baseline only after the dirty source fingerprint and reports are reviewed.

Assessment readiness measures static evidence coverage. It does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.

## Command

```text
migration-guard java-endpoint metrics-report --controller <controller.json> --service <service.json> --repository <repository.json> --lineage <lineage.json> --apply --artifacts-dir <dir>
```
