import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    assert.equal(plan.testCommand, "npm test -- \"service.migration-guard-contract.test.ts\"");
    assert.equal(plan.reasonCode, "test-ready");
    assert.equal(plan.coverage.structuralOnly, false);
    assert.match(plan.generatedTest?.content ?? "", /new Service\(\)\.run/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan prefers a non-watch Vitest script", async () => {
  const dir = await createFixture("vitest");
  try {
    const packageJsonPath = path.join(dir, "package.json");
    await writeFile(packageJsonPath, JSON.stringify({ scripts: { test: "vitest", "test:run": "vitest run" }, devDependencies: { vitest: "latest" } }));
    await writeFile(path.join(dir, "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const result = input + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "calculate", { startLine: 2, endLine: 2 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.testCommand, "npm run test:run -- \"calculate.migration-guard-contract.test.ts\"");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan can use a focused Vitest fast script", async () => {
  const dir = await createFixture("node scripts/test-parallel.mjs");
  try {
    const packageJsonPath = path.join(dir, "package.json");
    await writeFile(packageJsonPath, JSON.stringify({
      scripts: {
        test: "node scripts/test-parallel.mjs",
        "test:fast": "vitest run --config vitest.unit.config.ts"
      },
      devDependencies: { vitest: "latest" }
    }));
    await writeFile(path.join(dir, "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const result = input + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "calculate", { startLine: 2, endLine: 2 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.testCommand, "npm run test:fast -- \"calculate.migration-guard-contract.test.ts\"");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan discovers the nearest pnpm workspace test package", async () => {
  const dir = await createFixture("workspace-check");
  try {
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(path.join(dir, "packages", "core", "src"), { recursive: true });
    await writeFile(path.join(dir, "packages", "core", "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "latest" } }));
    await writeFile(path.join(dir, "packages", "core", "src", "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const result = input + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "calculate", { startLine: 2, endLine: 2 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.framework, "vitest");
    assert.equal(plan.testCommand, "pnpm --dir \"packages/core\" run test \"src/calculate.migration-guard-contract.test.ts\"");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction test plan keeps node-test workspace paths root-relative", async () => {
  const dir = await createFixture("workspace-node-test");
  try {
    await mkdir(path.join(dir, "packages", "core", "src"), { recursive: true });
    await writeFile(path.join(dir, "packages", "core", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await writeFile(path.join(dir, "packages", "core", "src", "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const result = input + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    const pipeline = await extractionPipeline(dir, "calculate", { startLine: 2, endLine: 2 }, "calculateResult");
    const plan = await createMethodExtractionTestPlan(pipeline.contract, pipeline.patch);
    assert.equal(plan.framework, "node-test");
    assert.equal(plan.testCommand, "node --test \"packages/core/src/calculate.migration-guard-contract.test.ts\"");
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
