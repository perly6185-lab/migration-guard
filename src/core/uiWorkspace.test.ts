import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { archiveUiWorkspace, collectActiveUiWorkspaceOverview, createUiWorkspace, listUiWorkspaces, previewUiWorkspace, resolveActiveUiWorkspace, selectUiWorkspace } from "./uiWorkspace.js";
import { createUiActionJob, createUiJobRunner, readUiJob } from "./uiJobService.js";

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
  const hostConfig = path.join(hostRoot, ".migration-guard.json");
  await writeFile(hostConfig, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard", checks: [], probes: [] }));
  return {
    root,
    target,
    host: await loadConfig(hostConfig),
    input: { name: "Target refactor", sourceRoot: source, targetRoot: target, goal: "Preserve behavior while refactoring" }
  };
}
