import test from "node:test";
import assert from "node:assert/strict";
import { migrateCoreArtifactToV2, validateArtifactV2 } from "./artifactV2.js";

test("core artifact v2 migration is idempotent and hash validated", () => {
  const migrated = migrateCoreArtifactToV2("snapshot", { version: 1, id: "baseline" }, "2026-07-13T00:00:00.000Z");
  assert.equal(migrateCoreArtifactToV2("snapshot", migrated), migrated);
  validateArtifactV2(migrated);
  assert.throws(() => validateArtifactV2({ ...migrated, payload: { changed: true } }), /hash mismatch/);
});

test("core artifact v2 rejects future source versions", () => {
  assert.throws(() => migrateCoreArtifactToV2("compare", { version: 3 }), /Unsupported source artifact version/);
});