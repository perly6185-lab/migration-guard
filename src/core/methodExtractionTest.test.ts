import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan
} from "./methodExtraction.js";
import { createMethodExtractionTestPlan, renderMethodExtractionTestPlan } from "./methodExtractionTest.js";

test("method extraction test plan generates executable function characterization coverage", async () => {
  const dir = await createFixture("node --test");
  try {
    await writeFile(path.join(dir, "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const doubled = input * 2;",
      "  const result = doubled + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "calculate.test.ts"), "// existing coverage\n");

    const pipeline = await extractionPipeline(dir, "calculate", { startLine: 2, endLine: 3 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.ready, true);
    assert.equal(plan.framework, "node-test");
    assert.deepEqual(plan.existingTests, ["calculate.test.ts"]);
    assert.deepEqual(plan.generatedTest?.inputFixtures, { input: "7" });
    assert.equal(plan.coverage.structuralOnly, false);
    assert.equal(plan.coverage.thrownOrRejected, true);
    assert.match(plan.generatedTest?.content ?? "", /await calculate\(7\)/);
    assert.match(plan.generatedTest?.content ?? "", /status: "returned"/);
    assert.match(plan.generatedTest?.content ?? "", /status: "threw"/);
    assert.match(plan.generatedTest?.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(renderMethodExtractionTestPlan(plan), /Status: ready/);
    const transpiled = ts.transpileModule(plan.generatedTest!.content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext },
      reportDiagnostics: true
    });
    assert.deepEqual(transpiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan detects Vitest and constructs safe exported class instances", async () => {
  const dir = await createFixture("vitest run");
  try {
    await writeFile(path.join(dir, "service.ts"), [
      "export class Service {",
      "  run(input: number): number {",
      "    const result = input + 1;",
      "    return result;",
      "  }",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "Service.run", { startLine: 3, endLine: 3 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.ready, true);
    assert.equal(plan.framework, "vitest");
    assert.equal(plan.reasonCode, "test-ready");
    assert.equal(plan.coverage.structuralOnly, false);
    assert.match(plan.generatedTest?.content ?? "", /new Service\(\)\.run/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan blocks exported classes with required constructor dependencies", async () => {
  const dir = await createFixture("node --test");
  try {
    await writeFile(path.join(dir, "service.ts"), [
      "export class Service {",
      "  constructor(private readonly offset: number) {}",
      "  run(input: number): number {",
      "    const result = input + this.offset;",
      "    return result;",
      "  }",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "Service.run", { startLine: 4, endLine: 4 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.ready, false);
    assert.equal(plan.reasonCode, "unsupported-method-construction");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan blocks unknown runners and unsupported fixtures", async () => {
  const unknownDir = await createFixture("custom-test-runner");
  const typedDir = await createFixture("node --test");
  try {
    const source = [
      "export interface Input { value: number }",
      "export function calculate(input: Input): number {",
      "  const result = input.value + 1;",
      "  return result;",
      "}"
    ].join("\n");
    await writeFile(path.join(unknownDir, "calculate.ts"), source);
    await writeFile(path.join(typedDir, "calculate.ts"), source);
    const unknownPipeline = await extractionPipeline(unknownDir, "calculate", { startLine: 3, endLine: 3 }, "calculateResult");
    assert.equal((await createMethodExtractionTestPlan(unknownPipeline.contract, unknownPipeline.patch)).reasonCode, "unknown-test-framework");
    const typedPipeline = await extractionPipeline(typedDir, "calculate", { startLine: 3, endLine: 3 }, "calculateResult");
    assert.equal((await createMethodExtractionTestPlan(typedPipeline.contract, typedPipeline.patch)).reasonCode, "unsupported-input-type");
  } finally {
    await rm(unknownDir, { recursive: true, force: true });
    await rm(typedDir, { recursive: true, force: true });
  }
});

async function createFixture(testCommand: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-extraction-test-plan-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: testCommand } }));
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["**/*.ts"]
  }));
  return dir;
}

async function extractionPipeline(
  root: string,
  symbol: string,
  range: { startLine: number; endLine: number },
  extractedName: string
) {
  const eligibility = await createMethodExtractionEligibility(root, symbol, range);
  const contract = await createMethodExtractionContract(eligibility);
  const patch = await createMethodExtractionPatchPlan(contract, extractedName);
  assert.equal(eligibility.eligible, true);
  assert.equal(contract.eligible, true);
  assert.equal(patch.ready, true, patch.diagnostics.join("\n"));
  return { eligibility, contract, patch };
}
