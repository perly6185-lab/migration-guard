import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { migrateCoreArtifactToV2, readCoreArtifactFile, validateArtifactV2, writeCompareArtifactFile, writeCoreArtifactFile } from "./artifactV2.js";
import { loadConfig } from "./config.js";
import { compareSnapshots } from "./compare.js";
import { loadSnapshot, saveSnapshot } from "./snapshot.js";
import type { Snapshot } from "../types.js";

test("core artifact v2 migration is idempotent and hash validated", () => {
  const migrated = migrateCoreArtifactToV2("snapshot", { version: 1, id: "baseline" }, "2026-07-13T00:00:00.000Z");
  assert.equal(migrateCoreArtifactToV2("snapshot", migrated), migrated);
  const { metadata: _metadata, ...legacyV2 } = migrated;
  assert.equal((migrateCoreArtifactToV2("snapshot", legacyV2).metadata as { snapshotId?: string }).snapshotId, "baseline");
  validateArtifactV2(migrated);
  assert.throws(() => validateArtifactV2({ ...migrated, payload: { changed: true } }), /hash mismatch/);
});

test("core artifact v2 rejects future source versions", () => {
  assert.throws(() => migrateCoreArtifactToV2("compare", { version: 3 }), /Unsupported source artifact version/);
});

test("core artifact v2 file IO writes envelopes and reads v1 or v2 payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-artifact-v2-"));
  try {
    const filePath = path.join(dir, "compare.json");
    const payload = { passed: true, baselineId: "baseline", currentId: "run", createdAt: "2026-07-14T00:00:00.000Z", differences: [] };
    await writeCoreArtifactFile(filePath, "compare", payload, { policyDecision: "passed" });
    const stored = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(stored.artifactSchemaVersion, 2);
    assert.equal(stored.kind, "compare");
    assert.equal(stored.metadata.policyDecision, "passed");
    assert.deepEqual(await readCoreArtifactFile(filePath, "compare"), payload);
    assert.throws(() => validateArtifactV2(stored, "snapshot"), /kind mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot and compare mainline writes include v2 metadata and remain readable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-artifact-mainline-"));
  try {
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }), "utf8");
    const loaded = await loadConfig(configPath);
    const baseline = snapshot("baseline", "baseline-mainline");
    const current = snapshot("run", "run-mainline");
    const baselinePath = await saveSnapshot(loaded, baseline);
    const storedBaseline = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.equal(storedBaseline.kind, "snapshot");
    assert.equal(storedBaseline.metadata.snapshotId, baseline.id);
    assert.equal(storedBaseline.metadata.healthFingerprints.length, 1);
    assert.equal((await loadSnapshot(baselinePath)).id, baseline.id);

    const report = compareSnapshots(baseline, current);
    const comparePath = path.join(loaded.artifactsDir, "compare", "mainline.json");
    await writeCompareArtifactFile(comparePath, report, baseline, current);
    const storedCompare = JSON.parse(await readFile(comparePath, "utf8"));
    assert.equal(storedCompare.kind, "compare");
    assert.match(storedCompare.metadata.baselineSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(storedCompare.metadata.policyDecision, "passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function snapshot(kind: Snapshot["kind"], id: string): Snapshot {
  return {
    version: 1,
    kind,
    id,
    createdAt: "2026-07-14T00:00:00.000Z",
    root: "/fixture",
    configHash: "config",
    scan: { root: "/fixture", scannedAt: "2026-07-14T00:00:00.000Z", totalFiles: 1, sourceFiles: 1, testFiles: 0, totalLines: 1, fileTypes: { ".ts": 1 }, packageManager: "npm", stackHints: [], riskFiles: [], dependencyEdges: [], packages: [{ name: "fixture", path: ".", sourceFiles: 1, testFiles: 0, scripts: [], workspaceDependencies: [] }] },
    checks: [{ name: "test", command: "npm test", status: "passed", critical: true, exitCode: 0, durationMs: 1, stdoutHash: "stdout", stderrHash: "stderr", normalizationApplied: ["paths"], stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }],
    probes: []
  };
}
