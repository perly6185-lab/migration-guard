# Service-to-Rust Assessment

## Scope

The Service assessment scans implemented public and protected methods from
classes whose names identify them as services or which carry Spring's
`@Service` annotation. Interface declarations are not counted as independent
implementations. Methods do not need to be reachable from a Controller.

```bash
migration-guard java-endpoint assess-services \
  --root D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data/zboss-module-data-service/src/main/java \
  --max-depth 8 --max-edges 1200 --adaptive \
  --max-expansion-depth 16 --max-expansion-edges 5000 \
  --max-expansion-rounds 4 --apply
```

The command builds the Java project model once, exits nonzero when any method
is blocked, and writes JSON and Markdown evidence when `--apply` is present.

## Real repository evidence

The enhanced validation on 2026-07-21 assessed all 5239 discovered Service
methods with an initial depth of 8/1200 edges and bounded adaptive expansion to
depth 16/5000 edges.

| Result | Count |
| --- | ---: |
| Ready for reviewed Rust planning | 3207 |
| Strictly blocked | 2032 |
| Truncated after adaptive expansion | 96 |
| Containing unclassified nodes | 1864 |
| Containing explicit external boundaries | 4894 |
| Adaptively expanded | 430 |
| Expansion budget exhausted | 96 |

Workload distribution:

| Workload | Count |
| --- | ---: |
| query | 2405 |
| query-with-effects | 987 |
| command | 1410 |
| batch | 223 |
| sync | 58 |
| async-job | 4 |
| upload | 84 |
| export | 46 |
| idempotent-command | 24 |

The stable enhanced report hash is
`8921ea93174855431c6f8a7123b16b49f21c94c52610cbcd258592f3244f5681`.

Compared with the first Service assessment, ready methods increased by 287,
blocked methods decreased by 287, methods with unknown nodes decreased by 419,
and truncated methods decreased by 341. Gates were not weakened. The enhanced
analysis additionally exposes 729 ambiguous-dispatch methods, 239 methods with
unresolved calls, and 71 transaction self-invocation methods as strict blockers.

Representative results:

- `AiEmpowerRefreshBizServiceImpl.startRefresh`: async-job, blocked by graph
  limits and unclassified ownership.
- `AiEmpowerRefreshBizServiceImpl.queryTask`: query, ready.
- `AiEmpowerRefreshBizServiceImpl.cancelTask`: idempotent-command, complete graph
  but blocked by unclassified ownership.
- `LedgerFileUploadLogServiceImpl.uploadAndRecord`: upload, ready with explicit
  file API and persistence effects.
- `EngineRefreshSyncServiceImpl.refreshSync`: sync, blocked by graph limits and
  unclassified ownership.
- `ViewMetaBatchUpdateApplicationServiceImpl.batchUpdate`: batch, graph complete
  at depth 16/5000 but still blocked by unclassified ownership.

## Implemented semantic enhancements

- Overload selection uses argument count, inferred literal/variable types,
  primitive-wrapper compatibility, and stable candidate scoring. Ties are
  reported as ambiguous and blocked.
- A data-driven semantic registry classifies logging, JDK utilities, mappings,
  clocks, Redis/Lua coordination, and asynchronous execution.
- Type roles cover application/domain services, support, pipeline, processor,
  coordinator, adapter, client, mapper, policy, and assembler components.
- Adaptive expansion records every budget round and fails closed with
  `RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED`.
- Lambda, method reference, inheritance, interface default method,
  `@Qualifier`-narrowed dynamic dispatch, and transaction self-invocation
  evidence are represented explicitly.
- Reviewed ownership policies require narrow matches, reviewer, reason, expiry,
  and evidence requirements. Unsafe exclusions and policy conflicts block.

## Remaining analyzer limitations

The blocked count is intentionally conservative. The next improvements should
address these evidence gaps before automated Rust generation is widened:

1. Multiline call expressions retain unknown arity unless a unique candidate
   exists; full AST symbol resolution would improve those 729 ambiguous cases.
2. Generic type substitution, varargs, implicit widening, static imports, and
   factory-return receiver types need compiler-grade type resolution.
3. Spring conditional beans, profiles, runtime proxies, and reflection can still
   leave dynamic dispatch unresolved when qualifiers are absent.
4. Adaptive expansion currently recomputes the selected method graph per round;
   persistent boundary-subgraph caching would reduce work further.
5. Reviewed ownership must still be supplied and approved by the migration
   team; the analyzer does not auto-exclude business behavior.

No Rust source generation, target replay, performance comparison, or source-off
claim is made by this report. Those stages still require a real Rust target root
and runtime drivers.
