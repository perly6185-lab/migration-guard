# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `2d9ffd06fa6d0600c0e9997bb1f2fb642e0645213401a5c493a3c1be0c3b369d`
- Cross-layer evidence hash: `5ce469edd3855dafb5fc8378344daf50b2589b47cac1895fd026379a8cb59b92`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 778 | 1078 | 41.9% |
| Service | 5506 | 3198 | 2308 | 58.1% |
| Repository | 4067 | 3602 | 465 | 88.6% |

Repository evidence now contains 1543 SQL-backed methods (37.9% coverage), 5 generated boundaries, 6 unknown operations, 221 unresolved-edge findings, and 107 dynamic SQL blockers. The regression gate passes against the checked-in baseline.

External static imports whose declaring type is outside the source model are now explicit external boundaries. Constructor expressions are excluded from bare method-call extraction, including under wildcard static imports. This reduced Controller unresolved routes from 1739 to 434 without suppressing ambiguous candidates; ambiguous routes changed from 675 to 680 as deeper valid traversal exposed additional real candidates.

Lombok-generated accessors are recognized only when the declaring source type carries `@Data`, `@Getter`, `@Value`, or `@Setter`, the matching field exists, and getter/setter arity is valid. The same evidence is used for accessors on a resolved chained return type. Controller unresolved routes decreased from 434 to 423 and Service unresolved findings from 794 to 745; remaining blockers overlap other causes, so Controller ready stayed unchanged.

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
