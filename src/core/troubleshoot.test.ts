import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { diagnoseServe, inspectRunArtifacts } from "./troubleshoot.js";

test("serve doctor reports an available local port without starting a service", async () => {
  const report = await diagnoseServe("127.0.0.1", 0);
  assert.equal(report.status, "available");
  assert.match(report.nextCommand ?? "", /migration-guard serve/);
});

test("artifact inspection reports missing and available baseline evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-troubleshoot-"));
  try {
    const targetRoot = path.join(dir, "target");
    const configPath = path.join(dir, ".migration-guard.json");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), "{}", "utf8");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: "target", artifactsDir: ".migration-guard" }), "utf8");
    const loaded = await loadConfig(configPath);
    const missing = await inspectRunArtifacts(loaded);
    assert.equal(missing.checks.find((item) => item.name === "baseline")?.exists, false);
    await mkdir(path.dirname(missing.checks.find((item) => item.name === "baseline")?.path ?? ""), { recursive: true });
    await writeFile(missing.checks.find((item) => item.name === "baseline")?.path ?? "", "{}", "utf8");
    const present = await inspectRunArtifacts(loaded);
    assert.equal(present.checks.find((item) => item.name === "baseline")?.exists, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
