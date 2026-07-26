import test from "node:test";
import assert from "node:assert/strict";
import {
  createJavaFieldConfigSnapshot,
  deriveJavaFieldProjectionFacts,
  javaFieldConfigByAlias,
  validateJavaFieldConfigSnapshot
} from "./javaFieldConfigSnapshot.js";

const source = {
  revision: "a19626e4c49d89c7f405e0c05abfe391d97f4eb1",
  dirty: false,
  dirtyFingerprint: "0".repeat(64),
  identity: "a19626e4c49d89c7f405e0c05abfe391d97f4eb1"
};

test("field configuration snapshots have stable normalized hashes", () => {
  const first = createJavaFieldConfigSnapshot({
    source,
    tenantId: "7",
    panelIds: ["20", "10"],
    fields: [
      { fieldId: "2", panelId: "20", alias: "amount", fieldTag: "NUMBER", formatterKinds: ["percentage"], relationFieldIds: ["9", "8"] },
      { fieldId: "1", panelId: "10", alias: "createdAt", formatTag: "DATE", formatterKinds: ["date"] }
    ]
  });
  const second = createJavaFieldConfigSnapshot({
    source,
    tenantId: "7",
    panelIds: ["10", "20"],
    fields: [
      { fieldId: "1", panelId: "10", alias: "createdAt", formatTag: "DATE", formatterKinds: ["date"] },
      { fieldId: "2", panelId: "20", alias: "amount", fieldTag: "NUMBER", formatterKinds: ["percentage"], relationFieldIds: ["8", "9"] }
    ]
  });
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.deepEqual(first.scope.panelIds, ["10", "20"]);
});

test("projection facts are complete only when every selected alias has formatter evidence", () => {
  const snapshot = createJavaFieldConfigSnapshot({
    source,
    tenantId: "7",
    panelIds: ["10"],
    fields: [
      { fieldId: "1", panelId: "10", alias: "amount", formatterKinds: ["percentage"] },
      { fieldId: "2", panelId: "10", alias: "name", formatterKinds: [] },
      { fieldId: "3", panelId: "10", alias: "legacy" }
    ]
  });
  const complete = deriveJavaFieldProjectionFacts(snapshot, "10", ["name", "amount"]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.formatterKinds, ["percentage"]);
  assert.match(complete.evidenceHash, /^[a-f0-9]{64}$/);

  const unknown = deriveJavaFieldProjectionFacts(snapshot, "10", ["missing", "legacy"]);
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.reasons, [
    "projection-alias-missing:missing",
    "projection-formatter-classification-missing:legacy"
  ]);
});

test("field configuration snapshot validation fails closed on drift and incomplete scope", () => {
  const snapshot = createJavaFieldConfigSnapshot({
    source,
    tenantId: "7",
    panelIds: ["10"],
    fields: [{ fieldId: "1", panelId: "10", alias: "amount", fieldTag: "NUMBER" }]
  });
  assert.equal(validateJavaFieldConfigSnapshot(snapshot, {
    source,
    tenantId: "7",
    panelIds: ["10"]
  }).trusted, true);

  const tampered = structuredClone(snapshot);
  tampered.fields[0].fieldTag = "DATE";
  assert.deepEqual(validateJavaFieldConfigSnapshot(tampered, {
    source,
    tenantId: "7",
    panelIds: ["10", "20"]
  }).reasons, [
    "field-config-snapshot-hash-mismatch",
    "field-config-snapshot-panel-scope-incomplete"
  ]);
  assert.deepEqual(validateJavaFieldConfigSnapshot(snapshot, {
    source: { ...source, revision: "b".repeat(40), identity: "b".repeat(40) },
    tenantId: "8",
    panelIds: ["10"]
  }).reasons, [
    "field-config-snapshot-source-revision-mismatch",
    "field-config-snapshot-tenant-mismatch"
  ]);
});

test("field configuration snapshot alias lookup remains panel scoped", () => {
  const snapshot = createJavaFieldConfigSnapshot({
    source,
    tenantId: "7",
    panelIds: ["10", "20"],
    fields: [
      { fieldId: "1", panelId: "10", alias: "status", fieldTag: "TEXT" },
      { fieldId: "2", panelId: "20", alias: "status", fieldTag: "ENUM" }
    ]
  });
  assert.equal(javaFieldConfigByAlias(snapshot, "10").get("status")?.fieldTag, "TEXT");
  assert.equal(javaFieldConfigByAlias(snapshot, "20").get("status")?.fieldTag, "ENUM");
});
