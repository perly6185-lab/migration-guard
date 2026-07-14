import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { detectConfig, detectConfigPlan, diagnoseConfig, explainConfig } from "./configDoctor.js";

test("detectConfig recommends pnpm workspace checks and normalization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-doctor-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"], scripts: { typecheck: "tsc --noEmit", test: "vitest", build: "vite build" }, devDependencies: { typescript: "1", vitest: "1", vite: "1" } }));
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const config = await detectConfig(dir);
    assert.deepEqual(config.checks.map((check) => check.name), ["typecheck", "test", "build"]);
    assert.ok(config.checks.find((check) => check.name === "test")?.normalize?.presets?.includes("vitest"));
    assert.ok(config.checks.find((check) => check.name === "build")?.normalize?.presets?.includes("vite"));
    const plan = await detectConfigPlan(dir);
    assert.equal(plan.confidence, "high");
    assert.equal(plan.packageManager, "pnpm");
    assert.ok(plan.sources.some((source) => source.reason.includes("JavaScript")));
    assert.ok(plan.skippedSuggestions.some((suggestion) => suggestion.includes("lint")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("diagnoseConfig reports missing cwd and npm no-op checks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-doctor-invalid-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard", checks: [{ name: "test", command: "npm test --if-present", cwd: "missing", timeoutMs: 50 }] }));
    const loaded = await loadConfig(configPath);
    const report = await diagnoseConfig(loaded);
    assert.equal(report.valid, false);
    assert.ok(report.findings.some((finding) => finding.code === "check-cwd-missing"));
    assert.ok(report.findings.some((finding) => finding.code === "check-no-op"));
    assert.equal(explainConfig(loaded).targetRoot, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("diagnoseConfig reports unresolved variables and missing executables", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-doctor-command-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }));
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      variables: {
        STILL_MISSING: "${STILL_MISSING}"
      },
      checks: [
        { name: "missing-tool", command: "migration-guard-missing-tool --version" }
      ]
    }));
    const loaded = await loadConfig(configPath);
    const report = await diagnoseConfig(loaded);
    assert.equal(report.valid, false);
    assert.ok(report.findings.some((finding) => finding.code === "unresolved-variable"));
    assert.ok(report.findings.some((finding) => finding.code === "check-command-missing" && finding.check === "missing-tool"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
