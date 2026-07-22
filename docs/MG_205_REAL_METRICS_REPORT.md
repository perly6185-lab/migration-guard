# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `c59c9196b572c10a945ec910a48d64f07a165b2a7d8284e035050c9595c4783d`
- Cross-layer evidence hash: `c7ebbae2c1a6e635a4e8bb01c64e4b03a57186522c65b95a1c437dbc1ca43da9`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 989 | 867 | 53.3% |
| Service | 5506 | 3407 | 2099 | 61.9% |
| Repository | 4067 | 3602 | 465 | 88.6% |

Repository evidence now contains 1543 SQL-backed methods (37.9% coverage), 5 generated boundaries, 6 unknown operations, 221 unresolved-edge findings, and 107 dynamic SQL blockers. The regression gate passes against the checked-in baseline.

External static imports whose declaring type is outside the source model are now explicit external boundaries. Constructor expressions are excluded from bare method-call extraction, including under wildcard static imports. This reduced Controller unresolved routes from 1739 to 434 without suppressing ambiguous candidates; ambiguous routes changed from 675 to 680 as deeper valid traversal exposed additional real candidates.

Lombok-generated accessors are recognized only when the declaring source type carries `@Data`, `@Getter`, `@Value`, or `@Setter`, the matching field exists, and getter/setter arity is valid. The same evidence is used for accessors on a resolved chained return type. Controller unresolved routes decreased from 434 to 423 and Service unresolved findings from 794 to 745; remaining blockers overlap other causes, so Controller ready stayed unchanged.

Injected type resolution now honors explicit Java imports and same-package types before falling back to simple-name candidates. Spring interface implementations are narrowed only by an existing `@Qualifier`, a unique `@Primary`, a unique explicit component name, or a unique field-name/bean-name match. This reduced Controller ambiguous routes from 680 to 346 and raised Controller ready from 778 to 963. Service expansion budget exhaustion increased from 91 to 95 because correct type selection exposed deeper reachable graphs; the budget remains fail-closed.

Unclassified nodes now use narrow semantic rules for JSON/Gson serialization, clock reads, JDK functional/string/regex utilities, string builders, query-wrapper predicates, Spring proxy context, progress reporting, `page`/`rowNum` reads, and DTO-shaped initialization. Generic `handle`, `apply`, and `process` methods remain unclassified without stronger evidence. Controller unclassified routes decreased from 638 to 349 and Service unclassified findings from 1869 to 919.

Cross-layer lineage covers 1856 routes. Of these, 1553 reach SQL and 1551 (83.6%) have a complete Controller -> Service -> Repository -> SQL chain.

## Interpretation and next work

BaseMapper operations are reviewable only when the mapper generic entity resolves to a source type with an explicit `@TableName`. The generated contract records framework, entity, table, operation and predicate class. All 1280 BaseMapper records in this assessment met that requirement; unresolved mappings remain fail-closed with `generated-contract-not-reviewable`.

Next work is ordered by evidence impact:

1. Reduce Controller unresolved edges and ambiguous calls, especially high-fan-out routes hitting the 500-edge cap.
2. Reduce Service unclassified boundaries and the 93 adaptive-expansion budget exhaustions.
3. Add branch fixtures, table expansion, and routing contracts for the 107 dynamic SQL blockers.
4. Update the checked-in real-project baseline only after the dirty source fingerprint and reports are reviewed.

Assessment readiness measures static evidence coverage. It does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.

## Command

```text
migration-guard java-endpoint metrics-report --controller <controller.json> --service <service.json> --repository <repository.json> --lineage <lineage.json> --apply --artifacts-dir <dir>
```
