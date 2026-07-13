import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { acceptHealthDebt, updateHealthDebtLedger } from "./healthDebt.js";
import type { CompareReport } from "../types.js";

test("health debt ledger tracks new, accepted, expired, and recovered failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-health-debt-"));
  try {
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));
    const loaded = await loadConfig(configPath);
    const first = await updateHealthDebtLedger(loaded, compare("fingerprint-a"));
    assert.equal(first.newCount, 1);
    assert.equal(first.strictPassed, false);
    await acceptHealthDebt(loaded, "fingerprint-a", { reason: "known failure", owner: "team", expiresAt: "2999-01-01T00:00:00.000Z" });
    const accepted = await updateHealthDebtLedger(loaded, compare("fingerprint-a"));
    assert.equal(accepted.acceptedCount, 1);
    assert.equal(accepted.strictPassed, true);
    const recovered = await updateHealthDebtLedger(loaded, compare());
    assert.equal(recovered.recoveredCount, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function compare(fingerprint?: string): CompareReport {
  return { passed: true, baselineId: "baseline", currentId: "run", createdAt: new Date().toISOString(), differences: [], checkHealth: { total: fingerprint ? 1 : 0, healthy: 0, inheritedFailure: fingerprint ? 1 : 0, regression: 0, changedFailure: 0, recovered: 0, missing: 0, results: fingerprint ? [{ name: "test", critical: true, classification: "inherited-failure", baselineStatus: "failed", currentStatus: "failed", baselineExitCode: 1, currentExitCode: 1, outputChanged: false, fingerprint }] : [] } };
}
