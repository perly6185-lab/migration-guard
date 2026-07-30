# ZBoss `engine-use-page/init` migration assessment

## Decision

The Rust HTTP and application entry is implemented, but production CREATE
cutover is deliberately blocked. The endpoint mutates business data and cannot
be treated as a metadata initializer.

## Java behavior that must remain compatible

The current Java controller calls the ViewMeta initialization orchestration and
then records undo data. The orchestration performs:

1. Redis change-state cleanup.
2. Child-form and filter/header default application.
3. Row-number planning and shifting.
4. Tenant-scoped metadata resolution and field-level insert authorization.
5. Primary key, row number, standard number, current user/time and calculated
   value generation.
6. Transactional dynamic INSERT and optional detail-interface re-query.
7. Local calculated-field compensation and panel timestamp update.
8. A row-inserted event consumed after transaction commit for cross-panel
   cascade work.
9. Undo/audit snapshot recording.

Primary reference points:

- `EngineUsePageController.init`
- `ViewMetaInitOrchestrationApplicationServiceImpl.initByView`
- `ViewMetaInitApplicationServiceImpl.init`

## Rust coverage

| Capability | Memory/offline | Production |
| --- | --- | --- |
| Exact route and supplied JSON request | Implemented | Implemented |
| Large string IDs and null/-1 values | Tested | Same DTO |
| Java-style `defRespKey` / `respData` envelope | Implemented | Same handler |
| Tenant, datasource, snapshot and actor context | Enforced | Enforced |
| Panel CREATE authorization | Tested | Scope authorization only |
| Idempotent replay / payload conflict | Tested | Blocked |
| Atomic row + identity + outbox commit | Tested | Blocked |
| Failure rollback | Tested | Blocked |
| Dynamic field/default/calculation parity | Contract boundary only | Blocked |
| Row shift and main/detail insert parity | Contract boundary only | Blocked |
| Undo anchor and post-commit cascade delivery | Required by port | Blocked |

## Production unblock criteria

Production enablement requires all of the following:

- reviewed panel-to-table and logical-field-to-column allowlists from ViewMeta;
- field-level CREATE authorization and server-side default/calculation rules;
- a MySQL transaction covering identity allocation, row shift, INSERT,
  idempotency response and undo anchor;
- a durable outbox whose consumer performs timestamp/cache/cascade work only
  after commit;
- main/child-form and `init_detail_inter_id` response parity;
- same-snapshot Java/Rust replay for success, validation failure, duplicate
  request, transaction failure and post-commit effect failure;
- an explicitly authorized mutation probe with deterministic cleanup.

Until those criteria are met, the production adapter returns a 503 failure
without issuing SQL. This means the broader Rust portfolio now has route-level
Create/Update/Delete/Query coverage, but only Update/Delete/Query retain their
own existing production-readiness status; CREATE is currently
offline-contract-ready, not Java-parity-certified or cutover-ready.
