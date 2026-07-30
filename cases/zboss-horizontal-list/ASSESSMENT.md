# ZBoss horizontal-list migration assessment

## Supplied request

- Method: `POST`
- Route: `/zboss/data/view/dynamic/engine/use/engine-use-horizontal/list`
- Environment: `https://test.ia-gz.com/admin-api`
- Scenario: `provided-horizontal-list`
- Declared page size: `10000`
- Explicit `horizontalId`: yes
- Explicit `operator`: no
- Composite projection key:
  `custField60040_0|custField59627`

The request is stored as an unexecuted, non-real-eligible candidate. It contains
no credential or raw response.

## Source behavior

The route resolves to `EngineUseHorizontalController.list` and has four
observable phases:

1. If `horizontalId` is absent, treat `usePageId` as the horizontal identity,
   load horizontal metadata, and rewrite `usePageId`, `pageId`, and `panelId`.
2. If `operator == REFRESH`, call `syncColDataUpdate(horizontalId)` before the
   list query. This is a reachable write path.
3. Call `horizontalListPackage` to build the list response.
4. Mutate/enrich the response with calculated horizontal-field data.

For the supplied request, phase 1 should be skipped because `horizontalId` is
present, and phase 2 should be skipped because `operator` is absent. Those
branch assumptions require runtime evidence; they are not inferred as proof.

## Contract risks

1. `showArchived` is not declared by `EngineUseHorizontalInterReqVO`. The
   deployed MVC `ObjectMapper` configuration must prove whether the field is
   ignored or rejected.
2. `pageSize=10000` needs a latency, memory, response-size and total-count
   budget. A successful HTTP response alone is insufficient.
3. Ordering must remain stable for `custField59623 ASC`, including null and
   mixed-type values.
4. `custField60040_0|custField59627` must retain its composite projection
   identity and calculated-field semantics.
5. The query response can be enriched after cache retrieval. A defensive-copy
   or immutable-response contract is required to prevent cross-request aliasing.
6. The `REFRESH` branch must be split from the read path or retain explicit
   transaction, lock, idempotency and failure-order semantics.
7. Tenant, user, request, datasource and device context must be explicit inputs
   to target execution.

## Recommended target boundary

Do not migrate the controller as one Rust function. Split it into:

- `HorizontalRequestNormalizer`: validates IDs and produces an immutable query
  command.
- `HorizontalQueryExecutor`: owns read-only SQL, pagination, ordering and
  projection.
- `HorizontalCalculatedFieldProcessor`: performs deterministic response
  enrichment without mutating cached objects.
- `HorizontalRefreshCoordinator`: separate command path for `REFRESH`, with
  fencing, transaction and replay semantics.
- HTTP adapter: rejects unknown fields deliberately or documents compatible
  ignore behavior.

## Evidence required to approve the supplied request

- two authenticated read-only executions with matching canonical response
  hashes;
- HTTP/business status and redacted response shape;
- row count, total count, latency and response byte size;
- `custField59623` ascending-order assertion;
- selected and composite projection-key presence;
- SQL trace proving no write statement when `operator` is absent;
- a separate disposable test for the `REFRESH` branch;
- source/target dual replay after the Rust target exists.

Use `scripts/probes/zboss-horizontal-list-readonly.py` with credentials supplied
only through `MG_JAVA_TOKEN` and `MG_JAVA_TENANT_ID`. The collector does not
persist credentials or raw responses and refuses any request containing an
operator.

## Rust entry status

The route now exists in `rust/zboss-rust/internal/dynamic-engine-runtime` as
`POST /zboss/data/view/dynamic/engine/use/engine-use-horizontal/list`.
It accepts the supplied string-encoded identifiers, enforces the 10000-row
boundary, preserves selected composite keys, and provides deterministic
ordering in the memory adapter.

This is an entry and contract implementation, not production equivalence.
`operator` remains fail-closed until a concrete `HorizontalRefreshCoordinator`
is bound, and the real gate must still require a concrete
`MysqlHorizontalQueryExecutor`, SQL evidence and source/target replay.

## Blocker resolution update — 2026-07-30

The Rust target now contains concrete `SqlxMysqlHorizontalQueryExecutor` and
`RedisHorizontalRefreshCoordinator` implementations. The query executor uses a
validated horizontal-ID catalog, bound values, deterministic ordering and an
explicit archived-field mapping. The refresh coordinator publishes a
tenant-scoped request and waits for a worker acknowledgement with a bounded
timeout.

Axum/Tokio runtime, locked release build and production-profile route smoke
evidence now pass production-path attestation. The HTTP read endpoint still
rejects `operator` deliberately because refresh remains a separate command
boundary. Remaining blockers require authenticated Java/target replay and
approval of the five supplied-request semantics; they cannot be replaced by
memory fixtures.
