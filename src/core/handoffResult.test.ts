import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createHandoffContract, writeHandoffContract } from "./handoff.js";
import { applyHandoffResultImport, planHandoffResultImport, type HandoffResultManifest } from "./handoffResult.js";
import { sha256 } from "./hash.js";
import { createMigrationRun } from "./migrationRun.js";
import { createAddFilePatch } from "./patchModel.js";

const execFileAsync = promisify(execFile);

test("handoff result import plans, applies with confirmation and is idempotent", async () => {
  const fixture = await resultFixture("accepted.txt");
  try {
    const plan = await planHandoffResultImport(fixture.loaded, fixture.manifestPath, fixture.runId);
    assert.equal(plan.passed, true, plan.blockers.join("; "));
    await assert.rejects(access(path.join(fixture.root, "accepted.txt")));
    await assert.rejects(applyHandoffResultImport(fixture.loaded, fixture.manifestPath, "0".repeat(64), fixture.runId), /confirmation mismatched/);
    const applied = await applyHandoffResultImport(fixture.loaded, fixture.manifestPath, plan.planHash, fixture.runId);
    assert.equal(applied.status, "applied");
    assert.equal((await readFile(path.join(fixture.root, "accepted.txt"), "utf8")).replace(/\r\n/g, "\n"), "accepted\n");
    const repeated = await applyHandoffResultImport(fixture.loaded, fixture.manifestPath, plan.planHash, fixture.runId);
    assert.equal(repeated.idempotent, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("handoff result import blocks patch tampering and paths outside the handoff budget", async () => {
  const fixture = await resultFixture("allowed.txt");
  try {
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as HandoffResultManifest;
    const patchPath = path.resolve(path.dirname(fixture.manifestPath), manifest.patch.path);
    await writeFile(patchPath, createAddFilePatch("outside.txt", "outside"));
    let plan = await planHandoffResultImport(fixture.loaded, fixture.manifestPath, fixture.runId);
    assert.match(plan.blockers.join(" "), /Patch hash does not match/);
    manifest.patch.sha256 = sha256(await readFile(patchPath, "utf8"));
    manifest.changedFiles = ["outside.txt"];
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
    plan = await planHandoffResultImport(fixture.loaded, fixture.manifestPath, fixture.runId);
    assert.match(plan.blockers.join(" "), /outside handoff scope/);
    await assert.rejects(access(path.join(fixture.root, "outside.txt")));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

async function resultFixture(allowedFile: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-result-"));
  const configPath = path.join(root, ".migration-guard.json");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard", checks: [], probes: [] }));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["add", "package.json", ".migration-guard.json"], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Migration Guard", "-c", "user.email=guard@example.test", "commit", "-m", "initial"], { cwd: root });
  const loaded = await loadConfig(configPath);
  const pkg = await createMigrationRun(loaded, { goal: "Import bounded result", sourceRoot: root, targetRoot: root, mode: "dry-run", issueProvider: "local" });
  const resultDir = path.join(loaded.artifactsDir, "external-result");
  await mkdir(resultDir, { recursive: true });
  const handoff = await createHandoffContract({ id: "handoff-result-test", goal: pkg.run.goal, task: { id: "task-external", title: "External edit", description: "Add one file", source: "task" }, permissions: { granted: ["target-edit"], denied: ["github-mutation", "release-mutation"] }, scope: { root, allowedPaths: [allowedFile], maxChangedFiles: 1 }, forbiddenActions: ["push commits"], evidence: [], suggestedCommands: ["npm test"], acceptanceCriteria: ["tests pass"], budget: { maxChangedFiles: 1, maxCommands: 1 }, lineage: { runId: pkg.run.id, taskId: "task-external" } });
  const written = await writeHandoffContract(root, handoff, resultDir);
  const patchPath = path.join(resultDir, "result.patch");
  const patch = createAddFilePatch(allowedFile, "accepted");
  await writeFile(patchPath, patch);
  const manifestPath = path.join(resultDir, "result.json");
  const manifest: HandoffResultManifest = { schema: "migration-guard.ai-result", version: 1, id: "result-test", createdAt: new Date().toISOString(), handoff: { id: written.id, contractHash: written.contractHash, path: path.relative(resultDir, written.output!.jsonPath) }, patch: { path: "result.patch", sha256: sha256(patch) }, changedFiles: [allowedFile], commands: [{ command: "npm test", claimedStatus: "passed" }], declaration: "completed", agent: { provider: "fixture", model: "test" } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, loaded, runId: pkg.run.id, manifestPath };
}
