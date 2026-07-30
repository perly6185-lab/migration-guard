# ZBoss field list/detail/add/update/delete migration assessment

## Decision

The Rust boundary now treats these five client operations as one field catalog:

1. `POST /zboss/data/view/dynamic/engine/use/engine-use-page/query` with only
   `usePageId` lists all ledger fields under each panel's
   `viewDynamicFieldDataDOList`;
2. `PUT /zboss/data/view-dynamic-field-data/update` without `id` adds a field
   and physical column;
3. the same PUT with `id` edits an existing field;
4. `DELETE /zboss/data/view-dynamic-field-data/delete?id={fieldId}` deletes or
   hides field metadata and returns a Boolean;
5. `GET /zboss/data/view-dynamic-field-data/get?id={fieldId}` returns one field
   detail object, or `data: null` when it is absent.

For the shared PUT endpoint:

- the add request has no field `id`, so Java resolves CREATE mode and executes
  a physical `ALTER TABLE ADD COLUMN`;
- the edit request has `id=2082674387292954625`, so Java resolves UPDATE mode,
  loads the existing field and does not execute the create-column branch.

The Rust HTTP/contract entry is implemented. Production schema mutation remains
blocked and fails before SQL. The production use-page-only query and field
detail GET can now read a reviewed, scope-bound static catalog. Startup rejects
unbound fields, duplicate logical/physical identities, unsafe tokens, and
inconsistent or cross-panel response keys.

The Java DELETE path saves an undo snapshot, verifies references, removes
related quick/AI/bill/reference configuration, deletes ordinary custom-field
metadata, hides protected/system/function fields, disbands empty groups and
runs cache/calculation/undo work after commit. It does not issue a physical
`DROP COLUMN`.

The Java GET path is read-only and returns the large type-specific
`ViewDynamicFieldDataRespVO`, including reference rules, conditions, color,
permission, AI and specialized field configuration. The Rust catalog returns
the common identity/type/physical fields plus safe configuration values
captured from ADD/EDIT or explicitly reviewed in production configuration.
Full dynamic-join response parity remains blocked.

## Java behavior inventory

The current Java path performs:

1. Load the old field and decide CREATE versus UPDATE.
2. Deduplicate the display name inside the panel.
3. Resolve a field-type strategy and validate reference/type transitions.
4. In CREATE mode, derive the physical table/column/type from server metadata
   and execute `ALTER TABLE ADD COLUMN`. UPDATE mode preserves the existing
   server-owned physical column identity.
5. Persist field metadata, type-specific configuration and column sort. UPDATE
   mode additionally clears/rebuilds references and runs type-change cleanup.
6. Initialize existing row values for applicable field types.
7. Register after-commit cache invalidation and metadata cascade work.
8. Run calculated-field, reference-panel, color and AI/value synchronization
   asynchronously with progress/status events.

The Java schema adapter explicitly documents that MySQL DDL implicitly commits.
Consequently, failure after `ADD COLUMN` can leave an orphan physical column
even though the surrounding Spring transaction rolls back.

## Rust safety model

The read path and all three mutations share one tenant/datasource/snapshot-scoped
field catalog. A successful ADD is immediately visible to the next query; an
EDIT updates the same catalog entry while preserving its server-owned physical
column identity; DELETE removes it from subsequent catalog queries without
dropping the physical database column. Protected/system/function fields are
instead marked hidden while a delete tombstone prevents a second logical
delete. Every successful delete saves one pre-change snapshot. DETAIL resolves
the same scoped record, so edits are immediately visible; an ordinary deleted
field returns null while protected metadata remains available with hidden
flags.

The Rust port requires a durable transition keyed by tenant, panel and request
identity:

```text
planned -> ddl-applied -> succeeded
```

- A request hash mismatch returns 409 before DDL.
- An edit must find its field in the same tenant, panel and use-page scope;
  unknown or cross-scope IDs fail before a transition is created.
- The DDL executor receives only metadata-derived structured identifiers; the
  client payload never becomes raw SQL.
- An edit reuses the server-stored `field` and `tableScriptField`; it never
  derives physical identifiers from `selectValues` and never executes ADD DDL.
- A delete resolves the target by tenant scope and field ID, verifies panel
  permission, commits metadata removal plus one durable event atomically and
  never accepts a table/column name from the caller.
- Replaying the same delete request is idempotent; concurrent different request
  IDs produce exactly one successful delete.
- Detail lookup uses only tenant scope plus the validated positive field ID,
  enforces panel permission and cannot enumerate another tenant's fields.
- Production field reads use only catalog entries pre-bound to a reviewed
  use-page/panel pair; configured `panelRespKey` values are preserved exactly
  and cannot be shared by different panels.
- Failure before DDL leaves `planned`.
- Failure after DDL preserves `ddl-applied`.
- A retry from `ddl-applied` verifies/reuses the column and completes metadata
  plus the durable post-commit event without executing DDL again.
- Tenant/panel authorization is mandatory before transition creation.

## Production unblock criteria

- reviewed panel-to-table and field-type-to-SQL-type allowlists;
- a Redis/database lease serialized by tenant and panel;
- a durable schema transition ledger and request hash;
- `information_schema` verification before each idempotent `ADD COLUMN`;
- metadata, ordering, role permission and outbox writes in one database
  transaction after DDL;
- orphan-column detection/repair and an explicit rollback policy;
- after-commit cache, value-sync, reference, color, AI and progress workers;
- Java/Rust replay covering normal create, duplicate name, concurrent create,
  DDL timeout, DDL-success/metadata-failure, metadata-success/effect-failure and
  retry recovery, plus edit rename/type changes, stale IDs, concurrent edit,
  reference rebuild and historical-data cleanup;
- delete replay covering referenced/protected/missing fields, empty-group
  disbanding, transactional related-config cleanup, undo snapshot recovery,
  concurrent deletion and after-commit failure;
- exact Java response replay for `panelRespKeyList`, panel response keys,
  `headList`/`formList`, HTTP/button/event configuration,
  `viewDynamicFieldDataDOList` and value-sync status;
- runtime-backed GET detail joins and replay for every supported field type,
  including nested reference/condition/permission/AI configuration (reviewed
  static values are already supported);
- an authorized isolated mutation probe with deterministic column cleanup.

Until these conditions are satisfied, this capability is
offline-contract-ready only and is not production cutover-ready.
