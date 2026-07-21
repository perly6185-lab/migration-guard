import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createMigrationRun } from "./migrationRun.js";
import { createMethodRefactorPlan } from "./methodRefactor.js";
import {
  applyNextMethodExtractionLayer,
  createMethodExtractionExecutionLedger,
  extractMethodExtractionLayersFromGoal,
  prepareNextMethodExtractionLayer,
  readMethodExtractionExecutionLedger,
  renderMethodExtractionExecutionLedger,
  writeMethodExtractionExecutionLedger
} from "./methodExtractionChain.js";

const execFileAsync = promisify(execFile);

test("layered method extraction executes deepest-to-root and persists resumable evidence", async () => {
  const fixture = await createChainFixture();
  try {
    const plan = await createMethodRefactorPlan(fixture.dir, "entry", { callDepth: 2 });
    const specs = extractMethodExtractionLayersFromGoal(fixture.goal);
    const ledger = createMethodExtractionExecutionLedger(fixture.pkg.run.id, plan, specs);
    assert.deepEqual(ledger.steps.map((step) => `${step.depth}:${step.symbol}`), ["2:level2", "1:level1", "0:entry"]);
    await writeMethodExtractionExecutionLedger(fixture.loaded, ledger);

    for (const expectedSymbol of ["level2", "level1", "entry"]) {
      await prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, []);
      assert.ok(ledger.steps.every((step) => step.anchor), "all layers must be anchored before the first mutation");
      const ready = ledger.steps.find((step) => step.status === "ready");
      assert.equal(ready?.symbol, expectedSymbol);
      await applyNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, ready!.patchHash!, []);
    }

    assert.equal(ledger.state, "completed");
    assert.ok(ledger.steps.every((step) => step.status === "applied" && step.sourceHashAfter));
    assert.match(await readFile(path.join(fixture.dir, "level2.ts"), "utf8"), /function level2Core/);
    assert.match(await readFile(path.join(fixture.dir, "level1.ts"), "utf8"), /function level1Core/);
    assert.match(await readFile(path.join(fixture.dir, "entry.ts"), "utf8"), /function entryCore/);
    const persisted = await readMethodExtractionExecutionLedger(fixture.loaded, fixture.pkg.run.id);
    assert.equal(persisted.state, "completed");
    assert.match(renderMethodExtractionExecutionLedger(persisted), /State: completed/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("layered method extraction stops and rolls back only the failing middle layer", async () => {
  const fixture = await createChainFixture();
  try {
    const plan = await createMethodRefactorPlan(fixture.dir, "entry", { callDepth: 2 });
    const ledger = createMethodExtractionExecutionLedger(
      fixture.pkg.run.id,
      plan,
      extractMethodExtractionLayersFromGoal(fixture.goal)
    );
    await writeMethodExtractionExecutionLedger(fixture.loaded, ledger);
    await prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, []);
    await applyNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, ledger.steps[0]!.patchHash!, []);
    const level2Applied = await readFile(path.join(fixture.dir, "level2.ts"), "utf8");

    await prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, []);
    await applyNextMethodExtractionLayer(
      fixture.loaded,
      fixture.pkg,
      ledger,
      ledger.steps[1]!.patchHash!,
      ["node -e \"process.exit(4)\""]
    );

    assert.equal(ledger.state, "stopped");
    assert.equal(ledger.steps[0]?.status, "applied");
    assert.equal(ledger.steps[1]?.status, "rolled-back");
    assert.equal(ledger.steps[2]?.status, "pending");
    assert.equal(await readFile(path.join(fixture.dir, "level2.ts"), "utf8"), level2Applied);
    assert.doesNotMatch(await readFile(path.join(fixture.dir, "level1.ts"), "utf8"), /function level1Core/);
    assert.doesNotMatch(await readFile(path.join(fixture.dir, "entry.ts"), "utf8"), /function entryCore/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("layered method extraction rejects ledger tampering and applied-source drift", async () => {
  const fixture = await createChainFixture();
  try {
    const plan = await createMethodRefactorPlan(fixture.dir, "entry", { callDepth: 2 });
    const ledger = createMethodExtractionExecutionLedger(fixture.pkg.run.id, plan, extractMethodExtractionLayersFromGoal(fixture.goal));
    const tampered = structuredClone(ledger);
    tampered.steps[0]!.endLine += 1;
    await assert.rejects(
      prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, tampered, []),
      /plan hash mismatch/
    );
    await prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, []);
    await applyNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, "0".repeat(64), []);
    assert.equal(ledger.state, "ready");
    assert.equal(ledger.steps[0]?.status, "ready");
    await applyNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, ledger.steps[0]!.patchHash!, []);
    await writeFile(path.join(fixture.dir, "level2.ts"), `${await readFile(path.join(fixture.dir, "level2.ts"), "utf8")}\n// drift\n`);
    await assert.rejects(
      prepareNextMethodExtractionLayer(fixture.loaded, fixture.pkg, ledger, []),
      /Source drift detected/
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createChainFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-method-extraction-chain-execution-"));
  await writeFile(path.join(dir, "level2.ts"), [
    "export function level2(input: number): number {",
    "  const result = input + 1;",
    "  return result;",
    "}"
  ].join("\n"));
  await writeFile(path.join(dir, "level1.ts"), [
    "import { level2 } from './level2.ts';",
    "export function level1(input: number): number {",
    "  const result = level2(input);",
    "  return result;",
    "}"
  ].join("\n"));
  await writeFile(path.join(dir, "entry.ts"), [
    "import { level1 } from './level1.ts';",
    "export function entry(input: number): number {",
    "  const result = level1(input);",
    "  return result;",
    "}"
  ].join("\n"));
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
  const goal = [
    "method symbol=entry call-depth=2",
    "extract-layer=entry@3-3@entryCore",
    "extract-layer=level1@3-3@level1Core",
    "extract-layer=level2@2-2@level2Core"
  ].join(" ");
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "migration-guard@example.invalid"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Migration Guard Test"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: dir });
  const loaded = await loadConfig(configPath);
  const pkg = await createMigrationRun(loaded, { goal, sourceRoot: dir, targetRoot: dir, mode: "manual", adapter: "method-refactor" });
  return { dir, goal, loaded, pkg };
}
