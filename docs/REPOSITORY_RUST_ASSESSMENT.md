# Repository Rust Assessment

## Scope

- Target: `D:\gitlab\ia\test_zboss\zboss-cloud\zboss-module-data`
- Source roles: domain Repository contracts, infrastructure Repository implementations, MyBatis Mapper and DAO types
- Excluded: MapStruct assembler mappers and helper/support classes that only share a repository package
- Graph budget: initial depth 8 / 1200 edges; adaptive maximum depth 16 / 5000 edges / 4 rounds
- Full evidence: `.migration-guard/repository-assessment/repository-rust-assessment.json`
- Report hash: `b2faf638c6bcfe534cbc5a59bd61dcbfb75a231f8f8811ed9682da1d55918a8b`

## Result

| Metric | Count |
| --- | ---: |
| Repository methods | 4067 |
| Ready | 2725 |
| Blocked | 1342 |
| Generated or external implementation boundaries | 21 |
| SQL-backed methods | 247 |
| SQL source records | 417 |
| Dynamic SQL source records | 207 |
| Context-bearing SQL source records | 240 |
| Adaptive expansions | 2 |
| Expansion budget exhausted | 0 |

Roles: 2596 Repository methods, 1373 Mapper methods, and 98 DAO methods.

Operations: 2073 reads, 1146 writes, 441 deletes, 375 dynamic SQL operations, and 32 methods whose operation cannot yet be classified safely.

## Blocking Evidence

| Finding | Methods | Meaning |
| --- | ---: | --- |
| `RP-BOUNDARY-GRAPH-INCOMPLETE` | 1321 | Required behavior remains outside the resolved call graph. |
| `RP-GRAPH-UNRESOLVED-EDGES` | 1196 | At least one Java call target cannot be resolved safely. |
| `RP-SQL-DYNAMIC-SOURCE` | 107 | Modeled SQL contains dynamic table, condition, provider, or XML tag behavior that still needs explicit ownership evidence. |
| `RP-GRAPH-AMBIGUOUS-CALLS` | 45 | More than one dispatch target remains plausible. |
| `RP-REPOSITORY-GENERATED-IMPLEMENTATION` | 21 | Contract still depends on absent source implementation with no modeled SQL source. |

The largest blocked clusters are `DynamicTableCommandRepositoryImpl` (41), `DynamicTableQueryRepositoryImpl` (25), `ViewDynamicFieldDataRepositoryImpl` (23), `DynamicTableSchemaRepositoryImpl` (21), and `ViewDynamicOperationalDataRepositoryImpl` (17).

## Assessment

The current generic analyzer can safely prepare 67.0% of Repository methods for Rust replacement planning. It must not claim full-project replacement readiness: 33.0% remain blocked under strict fail-closed policy.

SQL-source modeling now recognizes annotation SQL, mapper XML statements, inherited `BaseMapper` calls, provider methods, tenant/datasource signals, and transaction participation when those repositories are reached through service call graphs. The next implementation priority is dynamic SQL ownership evidence: table-name expansion, conditional XML branches, provider-generated fragments, and datasource/tenant routing must be rendered as replayable contracts. After that, unresolved receiver/type inference and ambiguous mapper overload dispatch should be improved. Increasing graph budgets is not a priority because no method exhausted the configured adaptive limits.
