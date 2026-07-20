import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathExists } from "./files.js";
import { sha256 } from "./hash.js";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan
} from "./methodExtraction.js";
import { createMethodExtractionTestPlan } from "./methodExtractionTest.js";
import { renderMethodExtractionVerification, verifyMethodExtractionTemporarily } from "./methodExtractionVerification.js";

test("temporary extraction verification compares behavior and fully restores the workspace", async () => {
  const fixture = await createVerificationFixture();
  try {
    const pipeline = await createPipeline(fixture.dir);
    const report = await verifyMethodExtractionTemporarily(pipeline.patch, pipeline.testPlan, {
      commands: ["node -e \"process.exit(0)\""],
      timeoutMs: 30_000
    });
    assert.equal(report.status, "passed", report.reason);
    assert.equal(report.behavior.equal, true);
    assert.match(report.behavior.baseline ?? "", /"status":"returned"/);
    assert.equal(report.restoration.reversePatchPassed, true);
    assert.equal(report.restoration.sourceRestored, true);
    assert.equal(report.restoration.testRemoved, true);
    assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.source);
    assert.equal(await pathExists(path.join(fixture.dir, pipeline.testPlan.generatedTest!.targetPath)), false);
    assert.match(renderMethodExtractionVerification(report), /Status: passed/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("temporary extraction verification rejects failed checks and restores source and test", async () => {
  const fixture = await createVerificationFixture();
  try {
    const pipeline = await createPipeline(fixture.dir);
    const report = await verifyMethodExtractionTemporarily(pipeline.patch, pipeline.testPlan, {
      commands: ["node -e \"process.exit(2)\""],
      timeoutMs: 30_000
    });
    assert.equal(report.status, "failed");
    assert.match(report.reason, /Verification command failed/);
    assert.equal(report.passed, false);
    assert.equal(report.restoration.sourceRestored, true);
    assert.equal(report.restoration.testRemoved, true);
    assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.source);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("temporary extraction verification detects behavior drift and hash mismatch", async () => {
  const fixture = await createVerificationFixture();
  try {
    const pipeline = await createPipeline(fixture.dir);
    const changedPatch = pipeline.patch.patch!.replace("+  return result;", "+  return result + 1;");
    const driftPatch = {
      ...pipeline.patch,
      patch: changedPatch,
      patchHash: sha256(changedPatch)
    };
    const driftTestPlan = { ...pipeline.testPlan, patchHash: driftPatch.patchHash };
    const report = await verifyMethodExtractionTemporarily(driftPatch, driftTestPlan, { timeoutMs: 30_000 });
    assert.equal(report.status, "failed");
    assert.match(report.reason, /behavior changed/);
    assert.equal(report.behavior.equal, false);
    assert.equal(report.restoration.sourceRestored, true);
    assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.source);

    const mismatched = await verifyMethodExtractionTemporarily(
      { ...pipeline.patch, patchHash: "0".repeat(64) },
      pipeline.testPlan
    );
    assert.equal(mismatched.status, "blocked");
    assert.match(mismatched.reason, /hash/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createVerificationFixture(): Promise<{ dir: string; sourcePath: string; source: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-extraction-verification-"));
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
  return { dir, sourcePath, source };
}

async function createPipeline(root: string) {
  const eligibility = await createMethodExtractionEligibility(root, "calculate", { startLine: 2, endLine: 3 });
  const contract = await createMethodExtractionContract(eligibility);
  const patch = await createMethodExtractionPatchPlan(contract, "calculateResult");
  const testPlan = await createMethodExtractionTestPlan(contract, patch);
  assert.equal(patch.ready, true, patch.diagnostics.join("\n"));
  assert.equal(testPlan.ready, true);
  return { eligibility, contract, patch, testPlan };
}
