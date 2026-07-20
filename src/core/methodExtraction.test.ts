import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan,
  extractMethodExtractionNameFromGoal,
  extractMethodExtractionRangeFromGoal,
  renderMethodExtractionContract,
  renderMethodExtractionEligibility,
  renderMethodExtractionPatchPlan
} from "./methodExtraction.js";

const execFileAsync = promisify(execFile);

test("method extraction eligibility resolves class methods and exact statement ranges", async () => {
  const dir = await fixtureDir("method-extraction-method");
  try {
    await writeFile(path.join(dir, "service.ts"), [
      "export class Worker {",
      "  run(input: number): number {",
      "    const doubled = input * 2;",
      "    const result = doubled + 1;",
      "    return result;",
      "  }",
      "}"
    ].join("\n"));

    const range = extractMethodExtractionRangeFromGoal("method symbol=Worker.run extract-lines=3-4");
    assert.deepEqual(range, { startLine: 3, endLine: 4 });
    const result = await createMethodExtractionEligibility(dir, "Worker.run", range!);
    assert.equal(result.eligible, true);
    assert.equal(result.reasonCode, "eligible");
    assert.equal(result.selected?.kind, "method");
    assert.equal(result.selected?.file, "service.ts");
    assert.equal(result.selectedStatements.length, 2);
    assert.equal(result.selectedStatements[0]?.kind, "FirstStatement");
    assert.match(renderMethodExtractionEligibility(result), /Status: eligible/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction eligibility resolves overload implementations and arrow functions", async () => {
  const dir = await fixtureDir("method-extraction-functions");
  try {
    await writeFile(path.join(dir, "functions.ts"), [
      "export function parse(value: string): string;",
      "export function parse(value: number): string;",
      "export function parse(value: string | number): string {",
      "  const normalized = String(value);",
      "  return normalized;",
      "}",
      "export const compute = (input: number) => {",
      "  const next = input + 1;",
      "  return next;",
      "};"
    ].join("\n"));

    const overloaded = await createMethodExtractionEligibility(dir, "parse", { startLine: 4, endLine: 4 });
    assert.equal(overloaded.eligible, true);
    assert.equal(overloaded.selected?.line, 3);
    const arrow = await createMethodExtractionEligibility(dir, "compute", { startLine: 8, endLine: 8 });
    assert.equal(arrow.eligible, true);
    assert.equal(arrow.selected?.kind, "arrow-function");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction eligibility parses TSX and rejects partial or unsafe control flow", async () => {
  const dir = await fixtureDir("method-extraction-tsx");
  try {
    await writeFile(path.join(dir, "view.tsx"), [
      "export function View() {",
      "  const label = 'ready';",
      "  if (label) {",
      "    breakTarget: for (const item of [label]) {",
      "      break breakTarget;",
      "    }",
      "  }",
      "  return <span>{label}</span>;",
      "}"
    ].join("\n"));

    const partial = await createMethodExtractionEligibility(dir, "View", { startLine: 4, endLine: 5 });
    assert.equal(partial.eligible, false);
    assert.equal(partial.reasonCode, "partial-statement-range");
    const unsafe = await createMethodExtractionEligibility(dir, "View", { startLine: 3, endLine: 7 });
    assert.equal(unsafe.eligible, false);
    assert.equal(unsafe.reasonCode, "unsupported-control-flow");
    assert.ok(unsafe.findings.some((finding) => finding.message.includes("break")));
    assert.ok(unsafe.findings.some((finding) => finding.message.includes("labeled statement")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction eligibility reports missing, ambiguous, no-body and invalid ranges", async () => {
  const dir = await fixtureDir("method-extraction-blockers");
  try {
    await writeFile(path.join(dir, "blocked.ts"), [
      "declare function external(value: string): string;",
      "class Left { run() { return 1; } }",
      "class Right { run() { return 2; } }"
    ].join("\n"));

    assert.equal((await createMethodExtractionEligibility(dir, "missing", { startLine: 1, endLine: 1 })).reasonCode, "symbol-not-found");
    assert.equal((await createMethodExtractionEligibility(dir, "run", { startLine: 2, endLine: 2 })).reasonCode, "symbol-ambiguous");
    assert.equal((await createMethodExtractionEligibility(dir, "external", { startLine: 1, endLine: 1 })).reasonCode, "no-body");
    assert.equal((await createMethodExtractionEligibility(dir, "Left.run", { startLine: 0, endLine: 1 })).reasonCode, "invalid-range");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction contract derives inputs, outputs, this, async and exceptions", async () => {
  const dir = await fixtureDir("method-extraction-contract");
  try {
    await writeFile(path.join(dir, "job.ts"), [
      "export class Job {",
      "  async run(input: number): Promise<number> {",
      "    let total = 0;",
      "    const doubled = input * 2;",
      "    total = doubled;",
      "    await this.save(total);",
      "    if (total < 0) throw new Error('negative');",
      "    return total;",
      "  }",
      "  private async save(value: number): Promise<void> {}",
      "}"
    ].join("\n"));

    const eligibility = await createMethodExtractionEligibility(dir, "Job.run", { startLine: 4, endLine: 7 });
    const contract = await createMethodExtractionContract(eligibility);
    assert.equal(contract.eligible, true);
    assert.deepEqual(contract.inputs.map((input) => input.name), ["input", "total"]);
    assert.deepEqual(contract.outputs.map((output) => `${output.name}:${output.mode}`), ["total:reassigned-output"]);
    assert.equal(contract.captures.this, true);
    assert.equal(contract.controlFlow.async, true);
    assert.deepEqual(contract.controlFlow.awaitLines, [6]);
    assert.deepEqual(contract.controlFlow.throwLines, [7]);
    assert.match(renderMethodExtractionContract(contract), /total: number \(reassigned-output/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction contract returns selected declarations consumed after the range", async () => {
  const dir = await fixtureDir("method-extraction-declared-output");
  try {
    await writeFile(path.join(dir, "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const doubled = input * 2;",
      "  const result = doubled + 1;",
      "  return result;",
      "}"
    ].join("\n"));

    const eligibility = await createMethodExtractionEligibility(dir, "calculate", { startLine: 2, endLine: 3 });
    const contract = await createMethodExtractionContract(eligibility);
    assert.equal(contract.eligible, true);
    assert.deepEqual(contract.inputs.map((input) => `${input.name}:${input.type}`), ["input:number"]);
    assert.deepEqual(contract.outputs.map((output) => `${output.name}:${output.type}:${output.mode}`), [
      "result:number:declared-output"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction contract blocks nested closures, incompatible exits and source drift", async () => {
  const dir = await fixtureDir("method-extraction-contract-blockers");
  const sourcePath = path.join(dir, "blocked.ts");
  try {
    const source = [
      "export function closure(input: number): number {",
      "  const nested = () => input + 1;",
      "  return nested();",
      "}",
      "export function early(input: number): number {",
      "  return input;",
      "  console.log(input);",
      "}"
    ].join("\n");
    await writeFile(sourcePath, source);

    const closureEligibility = await createMethodExtractionEligibility(dir, "closure", { startLine: 2, endLine: 2 });
    assert.equal((await createMethodExtractionContract(closureEligibility)).reasonCode, "unsafe-nested-closure");
    const returnEligibility = await createMethodExtractionEligibility(dir, "early", { startLine: 6, endLine: 6 });
    assert.equal((await createMethodExtractionContract(returnEligibility)).reasonCode, "incompatible-exit");
    const driftEligibility = await createMethodExtractionEligibility(dir, "closure", { startLine: 2, endLine: 2 });
    await writeFile(sourcePath, `${source}\n// changed\n`);
    assert.equal((await createMethodExtractionContract(driftEligibility)).reasonCode, "source-drift");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction patch atomically extracts a class-method range", async () => {
  const dir = await fixtureDir("method-extraction-patch-method");
  const sourcePath = path.join(dir, "job.ts");
  try {
    await writeFile(sourcePath, [
      "export class Job {",
      "  async run(input: number): Promise<number> {",
      "    let total = 0;",
      "    const doubled = input * 2;",
      "    total = doubled;",
      "    await this.save(total);",
      "    return total;",
      "  }",
      "  private async save(value: number): Promise<void> {}",
      "}"
    ].join("\n"));

    assert.equal(extractMethodExtractionNameFromGoal("extract-name=calculateTotal"), "calculateTotal");
    const eligibility = await createMethodExtractionEligibility(dir, "Job.run", { startLine: 4, endLine: 6 });
    const contract = await createMethodExtractionContract(eligibility);
    const plan = await createMethodExtractionPatchPlan(contract, "calculateTotal");
    assert.equal(plan.ready, true, plan.diagnostics.join("\n"));
    assert.match(plan.patch ?? "", /total = await this\.calculateTotal\(input, total\);/);
    assert.match(plan.patch ?? "", /private async calculateTotal\(input: number, total: number\)/);
    assert.match(plan.patchHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(renderMethodExtractionPatchPlan(plan), /Status: ready/);

    const patchPath = path.join(dir, "extraction.diff");
    await writeFile(patchPath, plan.patch!);
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["apply", patchPath], { cwd: dir });
    const applied = await readFile(sourcePath, "utf8");
    assert.match(applied, /total = await this\.calculateTotal\(input, total\);/);
    assert.match(applied, /return total;\r?\n  }\r?\n\r?\n  private async calculateTotal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction patch returns a declared output from a sibling function", async () => {
  const dir = await fixtureDir("method-extraction-patch-function");
  try {
    await writeFile(path.join(dir, "calculate.ts"), [
      "export function calculate(input: number): number {",
      "  const doubled = input * 2;",
      "  const result = doubled + 1;",
      "  return result;",
      "}"
    ].join("\n"));
    const eligibility = await createMethodExtractionEligibility(dir, "calculate", { startLine: 2, endLine: 3 });
    const contract = await createMethodExtractionContract(eligibility);
    const plan = await createMethodExtractionPatchPlan(contract, "calculateResult");
    assert.equal(plan.ready, true, plan.diagnostics.join("\n"));
    assert.match(plan.patch ?? "", /const result = calculateResult\(input\);/);
    assert.match(plan.patch ?? "", /function calculateResult\(input: number\)/);
    assert.match(plan.patch ?? "", /return result;/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method extraction patch blocks invalid names, arrows and multiple outputs", async () => {
  const dir = await fixtureDir("method-extraction-patch-blockers");
  try {
    await writeFile(path.join(dir, "blocked.ts"), [
      "export const arrow = (input: number) => {",
      "  const result = input + 1;",
      "  return result;",
      "};",
      "export function pair(input: number): number {",
      "  const left = input + 1;",
      "  const right = input + 2;",
      "  return left + right;",
      "}"
    ].join("\n"));
    const arrowEligibility = await createMethodExtractionEligibility(dir, "arrow", { startLine: 2, endLine: 2 });
    const arrowContract = await createMethodExtractionContract(arrowEligibility);
    assert.equal((await createMethodExtractionPatchPlan(arrowContract, "extractArrow")).reasonCode, "unsupported-declaration");
    assert.equal((await createMethodExtractionPatchPlan(arrowContract, "not-valid-name")).reasonCode, "invalid-extracted-name");
    const pairEligibility = await createMethodExtractionEligibility(dir, "pair", { startLine: 6, endLine: 7 });
    const pairContract = await createMethodExtractionContract(pairEligibility);
    assert.deepEqual(pairContract.outputs.map((output) => output.name), ["left", "right"]);
    assert.equal((await createMethodExtractionPatchPlan(pairContract, "calculatePair")).reasonCode, "unsupported-output-shape");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixtureDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `migration-guard-${name}-`));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", jsx: "preserve", strict: true },
    include: ["**/*.ts", "**/*.tsx"]
  }));
  return dir;
}
