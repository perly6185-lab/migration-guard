# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `de898aec078f0e6d7af068d044cc51e26314442f69bf96d7ca203fbbd0cc749f`
- Cross-layer evidence hash: `db3d92cc6301fd271c8f01200f264248771d69b6382704a81ddf697fd7574eaf`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 1011 | 845 | 54.5% |
| Service | 5506 | 3500 | 2006 | 63.6% |
| Repository | 4067 | 3629 | 438 | 89.2% |

Repository evidence now contains 1543 SQL-backed methods (37.9% coverage), 5 generated boundaries, 6 unknown operations, 221 unresolved-edge findings, and 94 dynamic SQL blockers. The regression gate passes against the checked-in baseline, reducing dynamic SQL blockers by 13 from 107.

Dynamic MyBatis ownership evidence now synthesizes deterministic replay cases for `<if>`/`<when>` true and false branches, `<foreach>` empty/single/multiple cardinalities, `<choose>` fallback, and empty/present `<where>`/`<set>`/`<trim>` content. The SQL contract report aggregates these branch cases. `RP-SQL-DYNAMIC-SOURCE` now identifies only dynamic sources that still lack replay evidence; `RP-SQL-TABLE-UNRESOLVED` separately identifies dynamic sources whose table cannot be resolved. Remaining repository blockers are 94 dynamic sources, including 69 missing table expansions, 145 method-level routing contracts, and 35 methods with unresolved tables; these categories overlap.

External static imports whose declaring type is outside the source model are now explicit external boundaries. Constructor expressions are excluded from bare method-call extraction, including under wildcard static imports. This reduced Controller unresolved routes from 1739 to 434 without suppressing ambiguous candidates; ambiguous routes changed from 675 to 680 as deeper valid traversal exposed additional real candidates.

Lombok-generated accessors are recognized only when the declaring source type carries `@Data`, `@Getter`, `@Value`, or `@Setter`, the matching field exists, and getter/setter arity is valid. The same evidence is used for accessors on a resolved chained return type. Controller unresolved routes decreased from 434 to 423 and Service unresolved findings from 794 to 745; remaining blockers overlap other causes, so Controller ready stayed unchanged.

Injected type resolution now honors explicit Java imports and same-package types before falling back to simple-name candidates. Spring interface implementations are narrowed only by an existing `@Qualifier`, a unique `@Primary`, a unique explicit component name, or a unique field-name/bean-name match. This reduced Controller ambiguous routes from 680 to 346 and raised Controller ready from 778 to 963. Service expansion budget exhaustion increased from 91 to 95 because correct type selection exposed deeper reachable graphs; the budget remains fail-closed.

Unclassified nodes now use narrow semantic rules for JSON/Gson serialization, clock reads, JDK functional/string/regex utilities, string builders, query-wrapper predicates, Spring proxy context, progress reporting, `page`/`rowNum` reads, and DTO-shaped initialization. Generic `handle`, `apply`, and `process` methods remain unclassified without stronger evidence. Controller unclassified routes decreased from 638 to 349 and Service unclassified findings from 1869 to 919.

Overload argument inference now uses local and foreach declarations, primitive declarations, explicit casts, `List<T>.get()`, source-declared method return types, and Lombok getter field types. Controller ambiguous routes decreased from 346 to 132 and Service ambiguous findings from 802 to 453. Deeper valid traversal exposed additional downstream dynamic SQL, unresolved calls, and graph-cap findings; those remain fail-closed.

Cross-layer lineage covers 1856 routes. Of these, 1555 reach SQL and 1553 (83.7%) have a complete Controller -> Service -> Repository -> SQL chain.

## Interpretation and next work

BaseMapper operations are reviewable only when the mapper generic entity resolves to a source type with an explicit `@TableName`. The generated contract records framework, entity, table, operation and predicate class. All 1280 BaseMapper records in this assessment met that requirement; unresolved mappings remain fail-closed with `generated-contract-not-reviewable`.

Next work is ordered by evidence impact:

1. Reduce Controller unresolved edges and ambiguous calls, especially high-fan-out routes hitting the 500-edge cap.
2. Reduce Service unclassified boundaries and the 96 adaptive-expansion budget exhaustions.
3. Resolve table placeholders and routing ownership for the remaining 94 dynamic SQL blockers; prioritize the 69 table-expansion contracts, then the 35 table-unresolved methods.
4. Update the checked-in real-project baseline only after the dirty source fingerprint and reports are reviewed.

Assessment readiness measures static evidence coverage. It does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.

## Command

```text
migration-guard java-endpoint metrics-report --controller <controller.json> --service <service.json> --repository <repository.json> --lineage <lineage.json> --apply --artifacts-dir <dir>
```
