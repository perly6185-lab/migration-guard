# MG-205 Real-Project Rust Assessment Metrics

评估日期：2026-07-22

## Evidence identity

- Project: `zboss-module-data`
- Source: `8a68de49679502a52232798a3c1f6acba01b7789+dirty:5641e05dcd43`
- Shared initial graph budget: depth 12, edges 500, tests excluded
- Aggregate report hash: `10f2de5d91df22d51b490d48450eeba4f959a94009f4d9d8a9f2a18937684cde`
- Cross-layer evidence hash: `04e7ae270081b4a8cdb4d520dc506e586498194a71b1dcc03e0be7076ae262d6`

`metrics-report` rejects reports whose source identity or shared initial graph budget differs. Service and Repository may use explicitly recorded adaptive expansion budgets after the shared initial budget.

## Current metrics

| Layer | Total | Ready | Blocked | Ready rate |
| --- | ---: | ---: | ---: | ---: |
| Controller | 1856 | 104 | 1752 | 5.6% |
| Service | 5506 | 1884 | 3622 | 34.2% |
| Repository | 4067 | 2347 | 1720 | 57.7% |

Repository evidence now contains 1543 SQL-backed methods (37.9% coverage), 5 generated boundaries, 6 unknown operations, 225 unresolved-edge findings, and 107 dynamic SQL blockers. The regression gate passes against the checked-in baseline.

Cross-layer lineage covers 1856 routes. Of these, 1553 reach SQL and 1551 (83.6%) have a complete Controller -> Service -> Repository -> SQL chain.

## Interpretation and next work

The lower Controller and Service ready rates are not treated as regressions against the older plan numbers: BaseMapper-generated SQL is now modeled as an explicit fail-closed boundary instead of being silently accepted. The new report makes that semantic change visible through cause shares.

Next work is ordered by evidence impact:

1. Model BaseMapper-generated operations as reviewable contracts without declaring their runtime behavior equivalent.
2. Reduce Controller unresolved edges and ambiguous calls, especially high-fan-out routes hitting the 500-edge cap.
3. Reduce Service unclassified boundaries and the 93 adaptive-expansion budget exhaustions.
4. Add branch fixtures, table expansion, and routing contracts for the 107 dynamic SQL blockers.
5. Update the checked-in real-project baseline only after the dirty source fingerprint and reports are reviewed.

Assessment readiness measures static evidence coverage. It does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.

## Command

```text
migration-guard java-endpoint metrics-report --controller <controller.json> --service <service.json> --repository <repository.json> --lineage <lineage.json> --apply --artifacts-dir <dir>
```
