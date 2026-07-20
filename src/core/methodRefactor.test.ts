import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { executeTask } from "./executor.js";
import { createMigrationRun } from "./migrationRun.js";
import type { MigrationActionPlan } from "../types.js";
import {
  createMethodRefactorActionPlan,
  createMethodRefactorInventory,
  createMethodRefactorPlan,
  extractMethodCallDepthFromGoal,
  extractMethodSymbolFromGoal
} from "./methodRefactor.js";

test("method refactor inventory and plan target a single TypeScript class method", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest", build: "tsc" }
    }));
    await writeFile(path.join(dir, "src", "userService.ts"), [
      "export class UserService {",
      "  async createUser(input: UserInput): Promise<User> {",
      "    if (!input.email) throw new Error('email');",
      "    return saveUser(input);",
      "  }",
      "}",
      "",
      "export function saveUser(input: UserInput): User {",
      "  return { id: 'u1', email: input.email };",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "userService.test.ts"), [
      "import { UserService } from './userService';",
      "test('create user', async () => {",
      "  await new UserService().createUser({ email: 'a@example.com' });",
      "});"
    ].join("\n"));

    const inventory = await createMethodRefactorInventory(dir, "UserService.createUser");
    assert.equal(inventory.matchStatus, "matched");
    assert.equal(inventory.matches[0]?.file, "src/userService.ts");
    assert.equal(inventory.matches[0]?.symbol, "UserService.createUser");

    const plan = await createMethodRefactorPlan(dir, "UserService.createUser");
    assert.equal(plan.selected.symbol, "UserService.createUser");
    assert.equal(plan.callDepth.applied, 0);
    assert.equal(plan.callGraph.nodes.length, 1);
    assert.equal(plan.impact.referenceCount, 1);
    assert.equal(plan.impact.risk, "high");
    assert.deepEqual(plan.recommendedChecks, ["npm run test", "npm run build"]);
    assert.ok(plan.contract.sideEffectHints.includes("persistence"));

    const actionPlan = createMethodRefactorActionPlan("run-method", "method symbol=UserService.createUser", plan);
    assert.equal(actionPlan.actions.length, 1);
    assert.equal(actionPlan.actions[0]?.id, "method-action-userservice-createuser");
    assert.equal(actionPlan.actions[0]?.patchTemplate, "method-contract-probe");
    assert.deepEqual(actionPlan.actions[0]?.affectedFiles, ["src/userService.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor plan expands local TypeScript call chains up to six layers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-chain-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest", build: "tsc" }
    }));
    await writeFile(path.join(dir, "src", "controller.ts"), [
      "export class HttpController {",
      "  handle(request: Request): Response {",
      "    return this.level1(request);",
      "  }",
      "",
      "  level1(request: Request): Response {",
      "    return level2(request);",
      "  }",
      "}",
      "",
      "export function level2(request: Request): Response {",
      "  return level3(request);",
      "}",
      "",
      "export function level3(request: Request): Response {",
      "  return level4(request);",
      "}",
      "",
      "export function level4(request: Request): Response {",
      "  return level5(request);",
      "}",
      "",
      "export function level5(request: Request): Response {",
      "  return level6(request);",
      "}",
      "",
      "export function level6(request: Request): Response {",
      "  return finalize(request);",
      "}",
      "",
      "export function finalize(request: Request): Response {",
      "  return request as Response;",
      "}"
    ].join("\n"));

    assert.equal(extractMethodCallDepthFromGoal("method symbol=HttpController.handle call-depth=6"), 6);
    const plan = await createMethodRefactorPlan(dir, "HttpController.handle", { callDepth: 6 });
    assert.equal(plan.callDepth.applied, 6);
    assert.equal(plan.callDepth.max, 6);
    assert.deepEqual(plan.callGraph.nodes.map((node) => `${node.depth}:${node.candidate.symbol}`), [
      "0:HttpController.handle",
      "1:HttpController.level1",
      "2:level2",
      "3:level3",
      "4:level4",
      "5:level5",
      "6:level6"
    ]);
    assert.equal(plan.callGraph.edges.length, 6);
    assert.equal(plan.callGraph.unresolvedCalls.length, 0);
    assert.equal(plan.callGraph.truncated, false);
    assert.ok(!plan.callGraph.nodes.some((node) => node.candidate.symbol === "finalize"));

    const actionPlan = createMethodRefactorActionPlan("run-method", "method symbol=HttpController.handle call-depth=6", plan);
    assert.equal(actionPlan.actions.length, 7);
    assert.deepEqual(actionPlan.actions.map((action) => action.id), [
      "method-action-httpcontroller-handle",
      "method-action-httpcontroller-level1",
      "method-action-level2",
      "method-action-level3",
      "method-action-level4",
      "method-action-level5",
      "method-action-level6"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor call graph prefers a unique same-file function over an unrelated duplicate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "method-refactor-same-file-resolution-"));
  try {
    await mkdir(path.join(dir, "bench"));
    await writeFile(path.join(dir, "main.ts"), [
      "export function entry(): string {",
      "  return helper();",
      "}",
      "export function helper(): string {",
      "  return 'main';",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "bench", "fixture.ts"), "export function helper(): string { return 'bench'; }\n");
    const plan = await createMethodRefactorPlan(dir, "entry", { callDepth: 1 });
    assert.deepEqual(plan.callGraph.nodes.map((node) => node.candidate.symbol), ["entry", "helper"]);
    assert.equal(plan.callGraph.nodes[1]?.candidate.file, "main.ts");
    assert.equal(plan.callGraph.unresolvedCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor call depth is capped at the supported six layers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-depth-cap-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "service.ts"), [
      "export function entry() {",
      "  return next();",
      "}",
      "export function next() {",
      "  return true;",
      "}"
    ].join("\n"));

    const plan = await createMethodRefactorPlan(dir, "entry", { callDepth: 9 });
    assert.equal(plan.callDepth.requested, 9);
    assert.equal(plan.callDepth.applied, 6);
    assert.equal(extractMethodCallDepthFromGoal("method symbol=entry depth=9"), 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor executor writes layered plan and actions without changing target source", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-executor-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  const sourcePath = path.join(targetRoot, "service.ts");
  try {
    await mkdir(targetRoot, { recursive: true });
    const source = [
      "export function entry() {",
      "  return first();",
      "}",
      "export function first() {",
      "  return second();",
      "}",
      "export function second() {",
      "  return third();",
      "}",
      "export function third() {",
      "  return true;",
      "}"
    ].join("\n");
    await writeFile(sourcePath, source, "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard"
    }), "utf8");

    const loaded = await loadConfig(configPath);
    const pkg = await createMigrationRun(loaded, {
      goal: "method symbol=entry call-depth=2 extract-lines=2-2 extract-name=entryCore: preserve behavior",
      sourceRoot: targetRoot,
      targetRoot,
      mode: "manual",
      adapter: "method-refactor"
    });
    const planTask = pkg.graph.tasks.find((task) => task.executor === "method-refactor:plan")!;
    planTask.status = "ready";
    await executeTask(loaded, pkg, planTask.id, { createCheckpoint: false });
    const actionsTask = pkg.graph.tasks.find((task) => task.executor === "method-refactor:actions")!;
    actionsTask.status = "ready";
    await executeTask(loaded, pkg, actionsTask.id, { createCheckpoint: false });

    const adapterDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    const plan = JSON.parse(await readFile(path.join(adapterDir, "method-refactor-plan.json"), "utf8"));
    const actions = JSON.parse(await readFile(path.join(adapterDir, "method-refactor-action-plan.json"), "utf8")) as MigrationActionPlan;
    const markdown = await readFile(path.join(adapterDir, "method-refactor-plan.md"), "utf8");
    const eligibility = JSON.parse(await readFile(path.join(adapterDir, "method-extraction-eligibility.json"), "utf8"));
    const eligibilityMarkdown = await readFile(path.join(adapterDir, "method-extraction-eligibility.md"), "utf8");
    const contract = JSON.parse(await readFile(path.join(adapterDir, "method-extraction-contract.json"), "utf8"));
    const contractMarkdown = await readFile(path.join(adapterDir, "method-extraction-contract.md"), "utf8");
    const patchPlan = JSON.parse(await readFile(path.join(adapterDir, "method-extraction-patch.json"), "utf8"));
    const extractionPatch = await readFile(path.join(adapterDir, "method-extraction-patch.diff"), "utf8");
    const testPlan = JSON.parse(await readFile(path.join(adapterDir, "method-extraction-test-plan.json"), "utf8"));
    const testPlanMarkdown = await readFile(path.join(adapterDir, "method-extraction-test-plan.md"), "utf8");
    const verification = JSON.parse(await readFile(path.join(adapterDir, "method-extraction-verification.json"), "utf8"));
    const verificationMarkdown = await readFile(path.join(adapterDir, "method-extraction-verification.md"), "utf8");
    assert.equal(plan.callDepth.applied, 2);
    assert.deepEqual(plan.callGraph.nodes.map((node: { depth: number; candidate: { symbol: string } }) => `${node.depth}:${node.candidate.symbol}`), [
      "0:entry",
      "1:first",
      "2:second"
    ]);
    assert.deepEqual(actions.actions.map((action) => action.id), [
      "method-action-entry",
      "method-action-first",
      "method-action-second"
    ]);
    assert.match(markdown, /Call depth: 2\/6 \(requested 2\)/);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.selected.symbol, "entry");
    assert.equal(eligibility.selectedStatements.length, 1);
    assert.match(eligibility.sourceHash, /^[a-f0-9]{64}$/);
    assert.match(eligibilityMarkdown, /Status: eligible/);
    assert.equal(contract.eligible, true);
    assert.equal(contract.reasonCode, "contract-eligible");
    assert.deepEqual(contract.inputs, []);
    assert.match(contract.eligibilityHash, /^[a-f0-9]{64}$/);
    assert.match(contractMarkdown, /Status: eligible/);
    assert.equal(patchPlan.ready, true);
    assert.equal(patchPlan.extractedName, "entryCore");
    assert.match(patchPlan.patchHash, /^[a-f0-9]{64}$/);
    assert.match(extractionPatch, /return entryCore\(\);/);
    assert.equal(testPlan.ready, false);
    assert.equal(testPlan.reasonCode, "unknown-test-framework");
    assert.equal(testPlan.coverage.structuralOnly, true);
    assert.match(testPlanMarkdown, /Status: blocked/);
    assert.equal(verification.status, "blocked");
    assert.equal(verification.temporaryApply.testWritten, false);
    assert.match(verificationMarkdown, /Status: blocked/);
    assert.equal(await readFile(sourcePath, "utf8"), source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor inventory supports Python methods and goal symbol extraction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-python-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "service.py"), [
      "class UserService:",
      "    def create_user(self, input):",
      "        if not input.get('email'):",
      "            raise ValueError('email')",
      "        return input"
    ].join("\n"));

    assert.equal(extractMethodSymbolFromGoal("method symbol=UserService.create_user: simplify"), "UserService.create_user");
    const inventory = await createMethodRefactorInventory(dir, "UserService.create_user");
    assert.equal(inventory.matchStatus, "matched");
    assert.equal(inventory.matches[0]?.language, "python");
    assert.equal(inventory.matches[0]?.line, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method refactor plan rejects missing symbols", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-refactor-missing-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "service.ts"), "export function ok() { return true; }\n");
    await assert.rejects(() => createMethodRefactorPlan(dir, "missing"), /Method symbol not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
