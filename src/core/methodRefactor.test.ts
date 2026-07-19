import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createMethodRefactorActionPlan,
  createMethodRefactorInventory,
  createMethodRefactorPlan,
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
