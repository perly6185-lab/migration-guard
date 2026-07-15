import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { archiveUiWorkspace, collectActiveUiWorkspaceOverview, collectUiWorkspacePortfolio, createUiWorkspace, listUiWorkspaces, previewUiWorkspace, resolveActiveUiWorkspace, selectUiWorkspace } from "./uiWorkspace.js";
import { createUiActionJob, createUiJobRunner, readUiJob } from "./uiJobService.js";
import { applyUiRecoveryPlan, collectUiRecovery, writeUiRecoveryPlan } from "./uiRecovery.js";
import { executeUiTaskPlan, writeUiTaskExecutionPlan } from "./uiTaskExecution.js";
import { loadRunPackage, saveRunPackage } from "./migrationRun.js";

const execFileAsync = promisify(execFile);

test("workspace preview rejects identical or nested source and target roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-workspace-preview-"));
  try {
    const nested = path.join(root, "nested");
    await mkdir(nested);
    const preview = await previewUiWorkspace({ name: "Unsafe", sourceRoot: root, targetRoot: nested, goal: "Refactor" });
    assert.equal(preview.valid, false);
    assert.match(preview.errors.join(" "), /cannot contain one another/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace creation writes detected config, initial run and atomic registry", async () => {
  const fixture = await workspaceFixture();
  try {
    const workspace = await createUiWorkspace(fixture.host, fixture.input);
    assert.equal(workspace.status, "active");
    assert.equal(workspace.packageManager, "npm");
    await access(path.join(fixture.target, ".migration-guard.json"));
    await access(path.join(fixture.target, ".migration-guard", "migration-runs", workspace.activeRunId, "run.json"));
    const registry = await listUiWorkspaces(fixture.host);
    assert.equal(registry.activeWorkspaceId, workspace.id);
    assert.equal(registry.workspaces.length, 1);
    assert.equal((await resolveActiveUiWorkspace(fixture.host)).loaded.targetRoot, fixture.target);
    await assert.rejects(createUiWorkspace(fixture.host, fixture.input), /already registered/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("workspace selection and archive preserve project files", async () => {
  const fixture = await workspaceFixture();
  try {
    const workspace = await createUiWorkspace(fixture.host, fixture.input);
    assert.equal((await selectUiWorkspace(fixture.host, workspace.id)).id, workspace.id);
    const archived = await archiveUiWorkspace(fixture.host, workspace.id);
    assert.equal(archived.status, "archived");
    assert.equal((await listUiWorkspaces(fixture.host)).activeWorkspaceId, undefined);
    await access(path.join(fixture.target, "package.json"));
    await assert.rejects(selectUiWorkspace(fixture.host, workspace.id), /Archived projects/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("workspace workflow jobs persist scan, baseline and checkpoint progress", async () => {
  const fixture = await workspaceFixture();
  try {
    const workspace = await createUiWorkspace(fixture.host, fixture.input);
    const loaded = (await resolveActiveUiWorkspace(fixture.host)).loaded;
    const runner = createUiJobRunner(0);
    for (const action of ["scan", "baseline", "checkpoint"] as const) {
      const params = new URLSearchParams(action === "checkpoint" ? { run: workspace.activeRunId } : {});
      const created = await createUiActionJob(loaded, { jobRunner: runner }, action, params);
      await runner.wait(created.jobId);
      assert.equal((await readUiJob(loaded, created.jobId)).status, "succeeded");
    }
    const overview = await collectActiveUiWorkspaceOverview(fixture.host);
    assert.equal(overview.progress.find((step) => step.id === "scan")?.complete, true);
    assert.equal(overview.progress.find((step) => step.id === "baseline")?.complete, true);
    assert.equal(overview.progress.find((step) => step.id === "checkpoint")?.complete, true);
    assert.equal(overview.progress.find((step) => step.id === "execute")?.complete, false);
    assert.equal(overview.progress.find((step) => step.id === "report")?.complete, false);
    const recovery = await collectUiRecovery(loaded, workspace.activeRunId);
    assert.equal(recovery.checkpoints.length, 1);
    const plan = await writeUiRecoveryPlan(loaded, workspace.activeRunId, recovery.checkpoints[0]?.id ?? "");
    assert.equal(plan.passed, true);
    assert.equal((await applyUiRecoveryPlan(loaded, workspace.activeRunId, plan.planHash)).status, "applied");
    await assert.rejects(applyUiRecoveryPlan(loaded, workspace.activeRunId, "invalid"), /Invalid recovery plan hash/);
    const pkg = await loadRunPackage(loaded, workspace.activeRunId);
    const task = pkg.graph.tasks.find((candidate) => candidate.status === "ready");
    assert.ok(task);
    const taskPlan = await writeUiTaskExecutionPlan(loaded, workspace.activeRunId, task.id);
    assert.equal(taskPlan.passed, true, taskPlan.blockers.join("; "));
    const driftPath = path.join(fixture.target, "state-drift.txt");
    await writeFile(driftPath, "changed after review");
    await assert.rejects(executeUiTaskPlan(loaded, workspace.activeRunId, task.id, taskPlan.planHash), /state changed/);
    await rm(driftPath);
    const refreshedPlan = await writeUiTaskExecutionPlan(loaded, workspace.activeRunId, task.id);
    const taskResult = await executeUiTaskPlan(loaded, workspace.activeRunId, task.id, refreshedPlan.planHash);
    assert.equal(taskResult.status, "accepted");
    const completed = await loadRunPackage(loaded, workspace.activeRunId);
    for (const executionTask of completed.graph.tasks.filter((candidate) => candidate.type === "code-change" || candidate.type === "adapter" || candidate.type === "replan")) {
      executionTask.status = "done";
    }
    completed.run.finalReportPath = path.join(completed.run.artifactsDir, "final-report.md");
    await writeFile(completed.run.finalReportPath, "# Final report\n");
    await saveRunPackage(loaded, completed);
    const finalOverview = await collectActiveUiWorkspaceOverview(fixture.host);
    assert.equal(finalOverview.progress.find((step) => step.id === "execute")?.complete, true);
    assert.equal(finalOverview.progress.find((step) => step.id === "report")?.complete, true);
    const portfolio = await collectUiWorkspacePortfolio(fixture.host);
    assert.equal(portfolio.projects[0]?.stage, "report");
    assert.ok(portfolio.projects[0]?.readiness);
    assert.ok(Number.isInteger(portfolio.projects[0]?.blockerCount));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("workspace task plans block high-risk execution before mutation", async () => {
  const fixture = await workspaceFixture();
  try {
    const workspace = await createUiWorkspace(fixture.host, fixture.input);
    const loaded = (await resolveActiveUiWorkspace(fixture.host)).loaded;
    const pkg = await loadRunPackage(loaded, workspace.activeRunId);
    const task = pkg.graph.tasks.find((candidate) => candidate.status === "ready");
    assert.ok(task);
    task.risk = "high";
    await saveRunPackage(loaded, pkg);
    const plan = await writeUiTaskExecutionPlan(loaded, workspace.activeRunId, task.id);
    assert.equal(plan.passed, false);
    assert.match(plan.blockers.join(" "), /High-risk tasks/);
    await assert.rejects(executeUiTaskPlan(loaded, workspace.activeRunId, task.id, plan.planHash), /has blockers/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

async function workspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-workspace-"));
  const hostRoot = path.join(root, "host");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await Promise.all([mkdir(hostRoot), mkdir(source), mkdir(target)]);
  await mkdir(path.join(source, ".git"));
  await writeFile(path.join(target, "package.json"), JSON.stringify({ name: "target", scripts: { test: "node --test", build: "node -e \"\"" } }));
  await execFileAsync("git", ["init"], { cwd: target });
  await execFileAsync("git", ["add", "package.json"], { cwd: target });
  await execFileAsync("git", ["-c", "user.name=Migration Guard", "-c", "user.email=guard@example.test", "commit", "-m", "initial"], { cwd: target });
  const hostConfig = path.join(hostRoot, ".migration-guard.json");
  await writeFile(hostConfig, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard", checks: [], probes: [] }));
  return {
    root,
    target,
    host: await loadConfig(hostConfig),
    input: { name: "Target refactor", sourceRoot: source, targetRoot: target, goal: "Preserve behavior while refactoring" }
  };
}
