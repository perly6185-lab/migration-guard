# Controller-to-Rust Assessment

## Scope

The controller assessment evaluates every normalized Spring route using one
shared Java project model. It does not modify the source repository or claim
that a Rust implementation exists.

```bash
migration-guard java-endpoint assess-controllers \
  --root D:/gitlab/ia/test_zboss/zboss-cloud/zboss-module-data/zboss-module-data-service/src/main/java \
  --max-depth 8 --max-edges 1200 --apply
```

The command exits nonzero when any method is blocked. JSON and Markdown
artifacts contain route, handler, workload, graph size, external boundaries,
unknown nodes, findings, and stable report hash.

## P0 capabilities

- Parse class and method mappings, multiline signatures, annotated parameters,
  and compact one-line method bodies.
- Reuse one project model for all routes instead of rescanning the repository
  for every endpoint.
- Preserve unresolved receiver calls as explicit external behavior nodes.
- Recognize general mutation verbs including cancel, submit, enable, disable,
  approve, reject, and archive.
- Fail closed on incomplete graphs, unresolved ownership, unknown effects, and
  unknown effect failure policies.
- Use the normalized Spring parser in Java cross-language inventory while
  retaining compatibility for minimal non-public fixture controllers.

## P1 capabilities

- Classify query, query-with-effects, command, batch, sync, async-job, upload,
  export, and idempotent-command workloads.
- Extract validation, authorization, audit, transaction, multipart, response
  envelope, and exception mapping requirements when source evidence exists.
- Produce request/response data contracts with DTO fields and mapping strategy.
- Sequence reachable effects and assign explicit fail, retry, compensate,
  ignore, or unknown failure policies.
- Distinguish external service clients/APIs from repository/database behavior.

## Real repository evidence

Validation on 2026-07-21 analyzed all 1695 normalized routes in about 41 seconds
with depth 8 and 1200 edges per method:

| Result | Count |
| --- | ---: |
| Ready for reviewed Rust planning | 973 |
| Strictly blocked | 722 |
| Truncated at configured limits | 228 |
| Containing unclassified nodes | 686 |

Workloads: 499 query, 461 query-with-effects, 468 command, 29 batch, 2 sync,
2 async-job, 51 upload, 169 export, and 14 idempotent-command.

Representative corrections:

- `AiEmpowerRefreshController.startRefresh`: `async-job`, blocked on remaining
  unclassified ownership rather than reported ready.
- `AiEmpowerRefreshController.cancelTask`: `idempotent-command`, not query.
- `LedgerFileUploadLogController.uploadFile`: `upload`, with validation, audit,
  response, request DTO, external file API, and database record evidence.
- `LedgerFileUploadLogController.page`: multiline route now discovered as query.

The 722 blocked methods require higher graph limits, reviewed ownership, or
additional source semantics. No RP4-RP6 target replay or source-off claim is
possible until a real Rust target root and runtime drivers are available.
