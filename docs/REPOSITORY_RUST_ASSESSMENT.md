# Repository Rust Assessment

## Scope

- Target: `D:\gitlab\ia\test_zboss\zboss-cloud\zboss-module-data`
- Source roles: domain Repository contracts, infrastructure Repository implementations, MyBatis Mapper and DAO types
- Excluded: MapStruct assembler mappers and helper/support classes that only share a repository package
- Graph budget: initial depth 8 / 1200 edges; adaptive maximum depth 16 / 5000 edges / 4 rounds
- Full evidence: `.migration-guard/repository-assessment/repository-rust-assessment.json`
- Report hash: `91d279e8e258b5f0b80f930ba9d32225f14936b9e9a5c0f197ee3c131bd60a37`

## Result

| Metric | Count |
| --- | ---: |
| Repository methods | 4067 |
| Ready | 2587 |
| Blocked | 1480 |
| Generated or external implementation boundaries | 105 |
| Adaptive expansions | 2 |
| Expansion budget exhausted | 0 |

Roles: 2596 Repository methods, 1373 Mapper methods, and 98 DAO methods.

Operations: 2100 reads, 1153 writes, 476 deletes, 277 dynamic SQL operations, 2 DDL operations, and 59 methods whose operation cannot yet be classified safely.

## Blocking Evidence

| Finding | Methods | Meaning |
| --- | ---: | --- |
| `RP-BOUNDARY-GRAPH-INCOMPLETE` | 1375 | Required behavior remains outside the resolved call graph. |
| `RP-GRAPH-UNRESOLVED-EDGES` | 1359 | At least one Java call target cannot be resolved safely. |
| `RP-REPOSITORY-GENERATED-IMPLEMENTATION` | 105 | Contract depends on MyBatis/XML/generated or otherwise absent source implementation. |
| `RP-GRAPH-AMBIGUOUS-CALLS` | 45 | More than one dispatch target remains plausible. |

The largest blocked clusters are `DynamicTableCommandRepositoryImpl` (42), `DynamicTableSchemaRepositoryImpl` (27), `ViewDynamicFieldDataRepositoryImpl` (27), `DynamicTableQueryRepositoryImpl` (25), and `OperationLogHistoryMapper` (25).

## Assessment

The current generic analyzer can safely prepare 63.6% of Repository methods for Rust replacement planning. It must not claim full-project replacement readiness: 36.4% remain blocked under strict fail-closed policy.

The next implementation priority is SQL-source modeling. Annotation SQL, mapper XML statements, inherited `BaseMapper` behavior, generated provider methods, datasource/tenant routing, and transaction participation need explicit graph nodes and ownership evidence. After that, unresolved receiver/type inference and ambiguous mapper overload dispatch should be improved. Increasing graph budgets is not a priority because no method exhausted the configured adaptive limits.
