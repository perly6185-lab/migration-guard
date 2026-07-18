import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSelfRefactorStructure, createSelfRefactorPromotionHandoff, crossValidateSelfRefactor, evaluateSelfRefactorScope, normalizeSelfRefactorInitContract, rollbackSelfRefactorCheckpoint, runSelfRefactorStep, selfRefactorRunReportHash } from "./selfRefactorExecution.js";
import { collectSelfRefactorInventory, createSelfRefactorPlan, selfRefactorPlanHash } from "./selfRefactor.js";

test("self-refactor promotion requires passing hash-bound cross-validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-promote-"));
  try {
    const reportPath = path.join(root, "cross.json");
    await writeFile(path.join(root, "candidate.tgz"), "candidate");
    const core = {
      version: 1, id: "cross-1", createdAt: new Date().toISOString(), status: "passed",
      driverId: "driver-1", driverHash: "a".repeat(64), driverEvidenceHash: "d".repeat(64), runId: "run-1", runHash: "e".repeat(64), candidatePath: path.join(root, "candidate.tgz"),
      candidateHash: createHash("sha256").update("candidate").digest("hex"), checks: ["driver-tarball-hash", "passing-run-evidence", "candidate-tarball-hash", "cli-help-compatible", "init-contract-compatible", "candidate-package-surface"].map((id) => ({ id, passed: true, evidence: "test" }))
    };
    const report = { ...core, reportHash: createHash("sha256").update(JSON.stringify(core)).digest("hex") };
    await writeFile(reportPath, JSON.stringify(report));
    await assert.rejects(() => createSelfRefactorPromotionHandoff({ artifactsDir: root, crossValidationPath: reportPath, confirmation: "wrong" }), /confirmation/);
    const handoff = await createSelfRefactorPromotionHandoff({ artifactsDir: root, crossValidationPath: reportPath, confirmation: report.reportHash });
    assert.equal(handoff.status, "ready-for-review");
    assert.equal(handoff.publish, "manual");
    assert.match(handoff.outputPath ?? "", /self-refactor-promotion/);
    assert.match(await readFile((handoff.outputPath ?? "").replace(/\.json$/, ".md"), "utf8"), /Publish: manual/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cross-validation hashes are stable evidence inputs", () => {
  const core = { driver: "a".repeat(64), candidate: "b".repeat(64), checks: ["help"] };
  assert.equal(createHash("sha256").update(JSON.stringify(core)).digest("hex"), createHash("sha256").update(JSON.stringify(core)).digest("hex"));
});

test("installed init contracts ignore fixture roots but retain behavior", () => {
  const contract = (root: string, command = "node --test") => JSON.stringify({
    targetRoot: root,
    sources: [{ path: `${root}\\package.json`, reason: "package manifest" }],
    config: { targetRoot: ".", checks: [{ name: "test", command }] }
  });
  assert.equal(
    normalizeSelfRefactorInitContract(contract("C:\\temp\\driver"), "C:\\temp\\driver"),
    normalizeSelfRefactorInitContract(contract("C:\\temp\\candidate"), "C:\\temp\\candidate")
  );
  assert.notEqual(
    normalizeSelfRefactorInitContract(contract("C:\\temp\\driver"), "C:\\temp\\driver"),
    normalizeSelfRefactorInitContract(contract("C:\\temp\\candidate", "npm test"), "C:\\temp\\candidate")
  );
});

test("self-refactor dry-run binds plan, driver and Git checkpoint without running checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-run-"));
  try {
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "tracked.ts"), "export const base = true;\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "base"], { cwd: root });
    const tarballPath = path.join(root, "driver.tgz");
    await writeFile(tarballPath, "driver");
    const driverHash = createHash("sha256").update("driver").digest("hex");
    const driverPath = path.join(root, "driver.json");
    const driverCore = { version: 1, id: "driver-1", createdAt: new Date().toISOString(), workspace: root, commit: "a".repeat(40), packageVersion: "1.0.0", tarballPath, tarballHash: driverHash, workingTreeClean: true };
    await writeFile(driverPath, JSON.stringify({ ...driverCore, evidenceHash: createHash("sha256").update(JSON.stringify(driverCore)).digest("hex") }));
    const planPath = path.join(root, "plan.json");
    const plan = createSelfRefactorPlan(await collectSelfRefactorInventory(root), "tracked", "test");
    await writeFile(planPath, JSON.stringify(plan));
    const report = await runSelfRefactorStep({ root, artifactsDir: path.join(root, ".artifacts"), planPath, driverEvidencePath: driverPath, taskId: "lock-contracts" });
    assert.equal(report.status, "planned");
    assert.deepEqual(report.checks, []);
    assert.match(report.checkpoint.patchHash, /^[a-f0-9]{64}$/);
    assert.match(report.checkpoint.gitStatus, /driver\.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("self-refactor cross-validation installs immutable driver and candidate tarballs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-cross-"));
  try {
    const packageRoot = path.join(root, "package");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "migration-guard", version: "1.0.0", type: "module", bin: { "migration-guard": "dist/cli.js" }, files: ["dist"] }));
    await writeFile(path.join(packageRoot, "dist", "cli.js"), '#!/usr/bin/env node\nconsole.log("fixture help");\n');
    const { spawnSync } = await import("node:child_process");
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: packageRoot, shell: process.platform === "win32", encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const filename = JSON.parse(packed.stdout)[0].filename as string;
    const tarballPath = path.join(packageRoot, filename);
    const tarballHash = createHash("sha256").update(await readFile(tarballPath)).digest("hex");
    const driverPath = path.join(root, "driver.json");
    const driverCore = { version: 1, id: "driver-fixture", createdAt: new Date().toISOString(), workspace: packageRoot, commit: "a".repeat(40), packageVersion: "1.0.0", tarballPath, tarballHash, workingTreeClean: true };
    await writeFile(driverPath, JSON.stringify({ ...driverCore, evidenceHash: createHash("sha256").update(JSON.stringify(driverCore)).digest("hex") }));
    const runCore = { version: 1, id: "run-fixture", createdAt: new Date().toISOString(), mode: "execute", status: "passed", planId: "plan", planHash: "c".repeat(64), driverId: driverCore.id, driverHash: tarballHash, driverEvidenceHash: createHash("sha256").update(JSON.stringify(driverCore)).digest("hex"), checkpoint: {}, checks: [], driverVerification: { passed: true }, changedPaths: [], scope: { passed: true, maxChangedFiles: 1, violations: [] } };
    const runReportPath = path.join(root, "run.json");
    await writeFile(runReportPath, JSON.stringify({ ...runCore, reportHash: selfRefactorRunReportHash(runCore as never) }));
    const report = await crossValidateSelfRefactor({ artifactsDir: path.join(root, "artifacts"), driverEvidencePath: driverPath, candidatePath: tarballPath, runReportPath });
    assert.equal(report.status, "passed");
    assert.equal(report.checks.find((check) => check.id === "cli-help-compatible")?.passed, true);
    const target = path.join(root, "target");
    await mkdir(path.join(target, "src"), { recursive: true });
    spawnSync("git", ["init"], { cwd: target });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: target });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: target });
    await writeFile(path.join(target, "src", "target.ts"), "const value = 1;\n");
    spawnSync("git", ["add", "."], { cwd: target });
    spawnSync("git", ["commit", "-m", "base"], { cwd: target });
    const plan = createSelfRefactorPlan(await collectSelfRefactorInventory(target), "target", "bounded edit");
    plan.tasks[0]!.requiredChecks = ["git diff --check"];
    const planPath = path.join(root, "execute-plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    const editScript = path.join(root, "edit.mjs");
    await writeFile(editScript, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(target, "src", "target.ts"))}, "const value = 2;\\n");\n`);
    const execution = await runSelfRefactorStep({ root: target, artifactsDir: path.join(root, "execution-artifacts"), planPath, driverEvidencePath: driverPath, taskId: "lock-contracts", execute: true, confirmation: selfRefactorPlanHash(plan), editCommand: `"${process.execPath}" "${editScript}"` });
    assert.equal(execution.status, "passed");
    assert.deepEqual(execution.changedPaths, ["src/target.ts"]);
    assert.equal(execution.scope.passed, true);
    assert.equal(execution.structure?.passed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("self-refactor rollback restores tracked and untracked checkpoint state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-rollback-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-rollback-evidence-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const { spawnSync } = await import("node:child_process");
    await mkdir(path.join(root, "src"), { recursive: true });
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 1;\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "base"], { cwd: root });
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2;\n");
    await writeFile(path.join(root, "src", "untracked.ts"), "export const extra = true;\n");
    const tarballPath = path.join(evidenceRoot, "driver.tgz");
    await writeFile(tarballPath, "driver");
    const tarballHash = createHash("sha256").update("driver").digest("hex");
    const driverCore = { version: 1, id: "driver", createdAt: new Date().toISOString(), workspace: root, commit: "a".repeat(40), packageVersion: "1.0.0", tarballPath, tarballHash, workingTreeClean: true };
    const driverPath = path.join(evidenceRoot, "driver.json");
    await writeFile(driverPath, JSON.stringify({ ...driverCore, evidenceHash: createHash("sha256").update(JSON.stringify(driverCore)).digest("hex") }));
    const plan = createSelfRefactorPlan(await collectSelfRefactorInventory(root), "tracked", "rollback test");
    const planPath = path.join(evidenceRoot, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    const run = await runSelfRefactorStep({ root, artifactsDir: evidenceRoot, planPath, driverEvidencePath: driverPath, taskId: "lock-contracts" });
    await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 3;\n");
    await rm(path.join(root, "src", "untracked.ts"));
    await writeFile(path.join(root, "src", "later.ts"), "later\n");
    const rollback = await rollbackSelfRefactorCheckpoint(run.checkpoint.metadataPath, run.checkpoint.checkpointHash);
    assert.equal(rollback.restored, true);
    assert.match(await readFile(path.join(root, "src", "tracked.ts"), "utf8"), /value = 2/);
    assert.match(await readFile(path.join(root, "src", "untracked.ts"), "utf8"), /extra/);
    await assert.rejects(() => readFile(path.join(root, "src", "later.ts"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); await rm(evidenceRoot, { recursive: true, force: true }); }
});

test("self-refactor scope and structure gates reject out-of-budget drift", () => {
  assert.deepEqual(evaluateSelfRefactorScope(["src/core/issueControl/new.ts"], ["src/core/issueControl"], 1), { passed: true, maxChangedFiles: 1, violations: [] });
  const outside = evaluateSelfRefactorScope(["src/cli.ts", "package.json"], ["src/core/issueControl"], 1);
  assert.equal(outside.passed, false);
  assert.ok(outside.violations.includes("src/cli.ts"));
  const before = { version: 1 as const, root: ".", createdAt: "before", modules: [{ path: "src/a.ts", lines: 800, runtimeExports: ["a"], imports: [], sourceHash: "a".repeat(64) }], cycles: [], policy: { maxFileLines: 700, oversizedFiles: ["src/a.ts"] } };
  const after = { ...before, createdAt: "after", modules: [{ path: "src/a.ts", lines: 801, runtimeExports: ["changed"], imports: ["src/a.ts"], sourceHash: "b".repeat(64) }], cycles: [["src/a.ts", "src/a.ts"]] };
  const structure = compareSelfRefactorStructure(before, after);
  assert.equal(structure.passed, false);
  assert.deepEqual(structure.exportDrift, ["src/a.ts"]);
  assert.deepEqual(structure.oversizedGrowth, ["src/a.ts"]);
  assert.equal(structure.newCycles.length, 1);
});

test("self-refactor run rejects stale inventory and unconfirmed execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-self-stale-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "target.ts"), "export const value = 1;\n");
    const plan = createSelfRefactorPlan(await collectSelfRefactorInventory(root), "target", "test");
    const planPath = path.join(root, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(path.join(root, "src", "target.ts"), "export const value = 2;\n");
    await assert.rejects(() => runSelfRefactorStep({ root, artifactsDir: path.join(root, ".artifacts"), planPath, driverEvidencePath: "missing" }), /inventory changed/);
    await writeFile(path.join(root, "src", "target.ts"), "export const value = 1;\n");
    await assert.rejects(() => runSelfRefactorStep({ root, artifactsDir: path.join(root, ".artifacts"), planPath, driverEvidencePath: "missing", execute: true, confirmation: `${selfRefactorPlanHash(plan)}x` }), /reviewed plan hash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
