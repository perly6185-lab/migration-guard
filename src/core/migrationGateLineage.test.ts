import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeGateIntegrity,
  validateGateIntegrity,
  type MigrationGateUpstream
} from "./migrationGateLineage.js";

test("gate integrity binds report content and project hash", () => {
  const report = finalizeGateIntegrity({
    version: 1,
    gate: "offline" as const,
    projectHash: "project-a",
    status: "passed" as const
  }, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(validateGateIntegrity(report, "project-a"), []);
  assert.ok(validateGateIntegrity({ ...report, status: "blocked" }, "project-a")
    .includes("MG-GATE-REPORT-HASH-MISMATCH"));
  assert.ok(validateGateIntegrity(report, "project-b").includes("MG-GATE-PROJECT-HASH-STALE"));
});

test("real gate integrity detects stale upstream lineage", () => {
  const upstream: MigrationGateUpstream = {
    gate: "offline",
    path: "gates/offline-gate.json",
    projectHash: "project-a",
    reportHash: "a".repeat(64),
    status: "passed"
  };
  const report = finalizeGateIntegrity({
    version: 1,
    gate: "real" as const,
    projectHash: "project-a",
    status: "passed" as const,
    upstream: [upstream]
  }, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(validateGateIntegrity(report, "project-a", [upstream]), []);
  assert.ok(validateGateIntegrity(report, "project-a", [{
    ...upstream,
    reportHash: "b".repeat(64)
  }]).includes("MG-GATE-UPSTREAM-STALE:offline"));
});
