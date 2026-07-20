import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createMigrationRun } from "./migrationRun.js";
import { executeMethodExtractionSession, readMethodExtractionSession } from "./methodExtractionSession.js";

const execFileAsync = promisify(execFile);

test("manual method extraction session pauses for exact confirmation and completes idempotently", async () => {
  const fixture = await createSessionFixture();
  try {
    const awaiting = await executeMethodExtractionSession(fixture.loaded, fixture.pkg, "calculate", { trustTier: "manual" });
    assert.equal(awaiting.state, "awaiting-confirmation");
    assert.ok(awaiting.patchHash);
    assert.match(awaiting.nextAction?.command ?? "", new RegExp(awaiting.patchHash!));

    const completed = await executeMethodExtractionSession(fixture.loaded, fixture.pkg, "calculate", {
      trustTier: "manual",
      confirmPatchHash: awaiting.patchHash
    });
    assert.equal(completed.state, "completed");
    assert.equal(completed.applyStatus, "applied");
    assert.equal(completed.quality?.behaviorConfidence, "passed");
    assert.equal(completed.quality?.structuralImprovement, "improved");
    const appliedSource = await readFile(fixture.sourcePath, "utf8");
    assert.match(appliedSource, /function \w+\(input: number\)/);

    const repeated = await executeMethodExtractionSession(fixture.loaded, fixture.pkg, "calculate", { trustTier: "manual" });
    assert.equal(repeated.state, "completed");
    assert.equal(await readFile(fixture.sourcePath, "utf8"), appliedSource);
    assert.equal((await readMethodExtractionSession(fixture.loaded, fixture.pkg.run.id)).sessionHash, completed.sessionHash);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("supervised session automatically applies low-risk work and rolls it back when a required quality gate is unavailable", async () => {
  const fixture = await createSessionFixture();
  const original = await readFile(fixture.sourcePath, "utf8");
  try {
    const session = await executeMethodExtractionSession(fixture.loaded, fixture.pkg, "calculate", {
      trustTier: "supervised",
      advancedGates: [{ kind: "mutation", required: true }]
    });
    assert.equal(session.state, "rolled-back");
    assert.equal(session.applyStatus, "applied");
    assert.equal(session.quality?.advancedGates.find((gate) => gate.kind === "mutation")?.status, "not-evaluated");
    assert.equal(await readFile(fixture.sourcePath, "utf8"), original);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createSessionFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-session-"));
  const sourcePath = path.join(dir, "calculate.ts");
  const source = [
    "export function calculate(input: number): number {",
    "  const doubled = input * 2;",
    "  const result = doubled + 1;",
    "  return result;",
    "}"
  ].join("\n");
  await writeFile(sourcePath, source);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test *.test.ts" } }));
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, allowImportingTsExtensions: true, noEmit: true },
    include: ["*.ts"]
  }));
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "migration-guard@example.invalid"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Migration Guard Test"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: dir });
  const loaded = await loadConfig(configPath);
  const pkg = await createMigrationRun(loaded, { goal: "method symbol=calculate", sourceRoot: dir, targetRoot: dir, mode: "manual", adapter: "method-refactor" });
  return { dir, sourcePath, loaded, pkg };
}
