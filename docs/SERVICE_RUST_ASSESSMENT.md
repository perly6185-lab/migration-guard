# Service-to-Rust Assessment

## Scope

The Service assessment scans implemented public and protected methods from
classes whose names identify them as services or which carry Spring's
`@Service` annotation. Interface declarations are not counted as independent
implementations. Methods do not need to be reachable from a Controller.

```bash
migration-guard java-endpoint assess-services \
  --root D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data/zboss-module-data-service/src/main/java \
  --max-depth 8 --max-edges 1200 --apply
```

The command builds the Java project model once, exits nonzero when any method
is blocked, and writes JSON and Markdown evidence when `--apply` is present.

## Real repository evidence

Validation on 2026-07-21 assessed all 5239 discovered Service methods in about
23 seconds with depth 8 and 1200 edges per method.

| Result | Count |
| --- | ---: |
| Ready for reviewed Rust planning | 2920 |
| Strictly blocked | 2319 |
| Truncated at configured limits | 437 |
| Containing unclassified nodes | 2283 |
| Containing explicit external boundaries | 4895 |

Workload distribution:

| Workload | Count |
| --- | ---: |
| query | 2287 |
| query-with-effects | 1086 |
| command | 1437 |
| batch | 219 |
| sync | 54 |
| async-job | 4 |
| upload | 84 |
| export | 46 |
| idempotent-command | 22 |

The stable report hash is
`b6626209b69b7563edcdaa0652a3faab6afb2d22b02e8c8b58f57f4ef18c9b93`.

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

## Remaining analyzer limitations

The blocked count is intentionally conservative. The next improvements should
address these evidence gaps before automated Rust generation is widened:

1. Resolve overloaded calls by arity and compatible parameter types. Current
   name-based dispatch can over-expand large service graphs.
2. Classify framework and utility calls such as logging, JDK conversions,
   collectors, clocks, Redis templates, and Lua execution without hiding their
   observable semantics.
3. Infer roles for internal `Support`, `Pipeline`, `DomainService`, `Manager`,
   and processor classes instead of relying mainly on service/repository names.
4. Add adaptive graph expansion so only truncated boundary subgraphs are
   deepened rather than rerunning every method at a global high limit.
5. Model async executors, method references, lambdas, inherited/default methods,
   transaction proxies, and dynamic dispatch as explicit boundaries.
6. Add reviewed ownership policies that can classify safe utility exclusions
   separately from infrastructure ports and target-owned business behavior.

No Rust source generation, target replay, performance comparison, or source-off
claim is made by this report. Those stages still require a real Rust target root
and runtime drivers.
