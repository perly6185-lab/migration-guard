import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createMigrationRun } from "./migrationRun.js";
import { pathExists } from "./files.js";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan
} from "./methodExtraction.js";
import { createMethodExtractionTestPlan } from "./methodExtractionTest.js";
import { verifyMethodExtractionTemporarily } from "./methodExtractionVerification.js";
import { applyVerifiedMethodExtraction, renderMethodExtractionApply } from "./methodExtractionApply.js";

const execFileAsync = promisify(execFile);

test("verified method extraction apply persists the atomic patch after post-apply verification", async () => {
  const fixture = await createApplyFixture();
  try {
    const pipeline = await createVerifiedPipeline(fixture.dir);
    const report = await applyVerifiedMethodExtraction(fixture.loaded, fixture.pkg, pipeline.patch, pipeline.testPlan, pipeline.verification, {
      confirmPatchHash: pipeline.patch.patchHash!
    });
    assert.equal(report.status, "applied", report.reason);
    assert.equal(report.passed, true);
    assert.ok(report.checkpointId);
    assert.equal(report.behavior.equal, true);
    assert.ok(report.behavior.current);
    assert.match(report.commands[0]?.command ?? "", /MG_METHOD_OBSERVATION_ROOT/);
    assert.equal(report.cleanup.testRemoved, true);
    assert.equal(report.cleanup.observationRemoved, true);
    assert.match(await readFile(fixture.sourcePath, "utf8"), /function calculateResult\(input: number\)/);
    assert.equal(await pathExists(path.join(fixture.dir, pipeline.testPlan.generatedTest!.targetPath)), false);
    assert.equal(await pathExists(path.join(fixture.dir, pipeline.testPlan.generatedTest!.observationFile)), false);
    assert.match(renderMethodExtractionApply(report), /Status: applied/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("method extraction apply rejects wrong confirmation without changing source", async () => {
  const fixture = await createApplyFixture();
  try {
    const pipeline = await createVerifiedPipeline(fixture.dir);
    const report = await applyVerifiedMethodExtraction(fixture.loaded, fixture.pkg, pipeline.patch, pipeline.testPlan, pipeline.verification, {
      confirmPatchHash: "0".repeat(64)
    });
    assert.equal(report.status, "rejected");
    assert.match(report.reason, /confirmation/);
    assert.equal(report.checkpointId, undefined);
    assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.source);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("method extraction apply rolls back when post-apply verification fails", async () => {
  const fixture = await createApplyFixture();
  try {
    const pipeline = await createVerifiedPipeline(fixture.dir);
    const report = await applyVerifiedMethodExtraction(fixture.loaded, fixture.pkg, pipeline.patch, pipeline.testPlan, pipeline.verification, {
      confirmPatchHash: pipeline.patch.patchHash!,
      commands: ["node -e \"process.exit(3)\""]
    });
    assert.equal(report.status, "rolled-back", report.reason);
    assert.equal(report.passed, false);
    assert.equal(report.cleanup.rollbackAttempted, true);
    assert.equal(report.cleanup.rollbackPassed, true);
    assert.equal(report.cleanup.sourceMatchesBefore, true);
    assert.equal(report.cleanup.testRemoved, true);
    assert.equal(report.cleanup.observationRemoved, true);
    assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.source);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createApplyFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-extraction-apply-"));
  const sourcePath = path.join(dir, "calculate.ts");
  const source = [
    "export function calculate(input: number): number {",
    "  const doubled = input * 2;",
    "  const result = doubled + 1;",
    "  return result;",
    "}"
  ].join("\n");
  await writeFile(sourcePath, source);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "node --test *.test.ts" }
  }));
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true
    },
    include: ["*.ts"]
  }));
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "migration-guard@example.invalid"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Migration Guard Test"], { cwd: dir });
  await execFileAsync("git", ["add", "calculate.ts", "package.json", "tsconfig.json", ".migration-guard.json"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: dir });
  const loaded = await loadConfig(configPath);
  const pkg = await createMigrationRun(loaded, {
    goal: "method symbol=calculate extract-lines=2-3 extract-name=calculateResult",
    sourceRoot: dir,
    targetRoot: dir,
    mode: "manual",
    adapter: "method-refactor"
  });
  return { dir, sourcePath, source, loaded, pkg };
}

async function createVerifiedPipeline(root: string) {
  const eligibility = await createMethodExtractionEligibility(root, "calculate", { startLine: 2, endLine: 3 });
  const contract = await createMethodExtractionContract(eligibility);
  const patch = await createMethodExtractionPatchPlan(contract, "calculateResult");
  const testPlan = await createMethodExtractionTestPlan(contract, patch);
  const verification = await verifyMethodExtractionTemporarily(patch, testPlan, { timeoutMs: 30_000 });
  assert.equal(verification.status, "passed", verification.reason);
  return { patch, testPlan, verification };
}
