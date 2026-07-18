import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSelfRefactorInventory, createSelfRefactorDriver, createSelfRefactorPlan, validateSelfRefactorPlan } from "./selfRefactor.js";

test("self-refactor inventory captures modules, exports, limits and cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-inventory-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), 'import { b } from "./b.js";\nexport function a() { return b; }\n');
    await writeFile(path.join(root, "src", "b.ts"), 'import { a } from "./a.js";\nexport const b = a;\n');
    await writeFile(path.join(root, "src", "types.ts"), 'import type { a } from "./a.js";\nexport interface Example { value: typeof a; }\n');
    await writeFile(path.join(root, "src", "exports.ts"), 'export { a as renamed } from "./a.js";\nexport default 1;\nvoid import("./b.js");\n');
    const inventory = await collectSelfRefactorInventory(root, 1);
    assert.deepEqual(inventory.modules.map((item) => item.path), ["src/a.ts", "src/b.ts", "src/exports.ts", "src/types.ts"]);
    assert.deepEqual(inventory.modules[0]?.runtimeExports, ["a"]);
    assert.equal(inventory.policy.oversizedFiles.length, 4);
    assert.ok(inventory.cycles.length > 0);
    assert.deepEqual(inventory.modules.find((item) => item.path === "src/types.ts")?.imports, []);
    assert.deepEqual(inventory.modules.find((item) => item.path === "src/exports.ts")?.runtimeExports, ["default", "renamed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("self-refactor plan is bounded and bound to its inventory", async () => {
  const inventory = await collectSelfRefactorInventory(process.cwd());
  const plan = createSelfRefactorPlan(inventory, "issueControl", "Split one responsibility");
  assert.match(plan.inventoryHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.tasks.length, 3);
  assert.ok(plan.tasks[1]?.requiredChecks.includes("npm test"));
  assert.throws(() => createSelfRefactorPlan(inventory, "missing-module", "split"), /did not match/);
});

test("self-refactor driver refuses a dirty worktree before packaging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-driver-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: root });
    await assert.rejects(() => createSelfRefactorDriver(root), /clean Git worktree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("self-refactor plan validation rejects injected commands", () => {
  assert.throws(() => validateSelfRefactorPlan({ version: 1, status: "planned", id: "bad", root: ".", inventoryHash: "a".repeat(64), tasks: [{ id: "bad", affectedPaths: [], requiredChecks: ["curl example.test"], acceptance: [] }] }), /disallowed check command/);
});
