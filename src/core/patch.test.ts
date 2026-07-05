import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { applyProposedPatch, createAddFilePatch, proposeActionPatch, rollbackProposedPatch, verifyProposedPatch } from "./patch.js";
import type { LoadedConfig, MigrationRun, MigrationTaskGraph, ProposedPatch } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

const execFileAsync = promisify(execFile);

test("createAddFilePatch creates a git-applicable new file patch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-patch-"));
  const patchPath = path.join(dir, "probe.patch");

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await writeFile(patchPath, createAddFilePatch("scripts/migration-guard/probe.mjs", "console.log(\"ok\");\n"), "utf8");

    await execFileAsync("git", ["apply", "--check", patchPath], { cwd: dir });
    await execFileAsync("git", ["apply", patchPath], { cwd: dir });

    assert.equal(
      (await readFile(path.join(dir, "scripts", "migration-guard", "probe.mjs"), "utf8")).replace(/\r\n/g, "\n"),
      "console.log(\"ok\");\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAddFilePatch rejects unsafe paths", () => {
  assert.throws(() => createAddFilePatch("../probe.mjs", "bad"), /Unsafe patch path/);
});

test("proposal verify and apply write verification reports", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-proposal-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-1");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-1",
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      title: "Add probe",
      summary: "Adds a probe script.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: ["scripts/migration-guard/probe.mjs"],
      recommendedChecks: ["node scripts/migration-guard/probe.mjs"],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch("scripts/migration-guard/probe.mjs", "console.log(\"probe-ok\");\n"), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    const verify = await verifyProposedPatch(loaded, pkg, proposal.id);
    assert.equal(verify.passed, true);
    assert.equal(verify.applied, false);
    assert.equal(verify.checks.length, 0);
    assert.equal((await readProposal(proposalPath)).applyState, "verified");

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    assert.equal(apply.report?.passed, true);
    assert.equal(apply.report?.checks.length, 1);
    assert.match(apply.report?.checks[0]?.stdout ?? "", /probe-ok/);
    assert.equal((await readProposal(proposalPath)).applyState, "applied");

    const rollback = await rollbackProposedPatch(loaded, pkg, proposal.id);
    assert.equal(rollback.passed, true);
    assert.equal((await readProposal(proposalPath)).applyState, "rolled-back");
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "probe.mjs")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyProposedPatch can rollback automatically when checks fail", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-rollback-on-fail-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-rollback");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-rollback",
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      title: "Add failing probe",
      summary: "Adds a probe script with a failing recommended check.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: ["scripts/migration-guard/failing-probe.mjs"],
      recommendedChecks: ["node scripts/migration-guard/not-created.mjs"],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch("scripts/migration-guard/failing-probe.mjs", "console.log(\"created\");\n"), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    await assert.rejects(
      applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true, rollbackOnFail: true }),
      /verification failed/
    );
    assert.equal((await readProposal(proposalPath)).applyState, "rolled-back");
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "failing-probe.mjs")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposeActionPatch generates an optional Playwright UI smoke probe", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-probe-"));

  try {
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    const componentPath = path.join(dir, "apps", "web", "src", "App.vue");
    await mkdir(path.dirname(componentPath), { recursive: true });
    await mkdir(actionPlanDir, { recursive: true });
    await writeFile(componentPath, "<template><main /></template>\n<script setup></script>\n", "utf8");
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-large-vue-ui-probe",
          title: "Add UI probe",
          summary: "Add UI smoke coverage.",
          risk: "high",
          affectedFiles: ["apps/web/src/App.vue"],
          recommendedChecks: ["pnpm type-check:web"],
          patchMode: "manual-approval-required",
          patchTemplate: "ui-smoke-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    const proposal = await proposeActionPatch(loaded, pkg, "action-large-vue-ui-probe");
    const patch = await readFile(proposal.patchPath, "utf8");

    assert.equal(proposal.generatedFiles?.[0], "scripts/migration-guard/action-large-vue-ui-probe.mjs");
    assert.ok(proposal.recommendedChecks.includes("node scripts/migration-guard/action-large-vue-ui-probe.mjs"));
    assert.match(patch, /await import\("playwright"\)/);
    assert.match(patch, /MG_PREVIEW_URL/);
    assert.match(patch, /tmpdir\(\), "migration-guard-ui-probes"/);
    assert.match(patch, /runFetchProbe/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readProposal(proposalPath: string): Promise<ProposedPatch> {
  return JSON.parse(await readFile(proposalPath, "utf8")) as ProposedPatch;
}

function makeLoadedConfig(root: string): LoadedConfig {
  return {
    path: path.join(root, ".migration-guard.json"),
    baseDir: root,
    targetRoot: root,
    artifactsDir: path.join(root, ".migration-guard"),
    config: {
      schemaVersion: 1,
      targetRoot: root,
      artifactsDir: path.join(root, ".migration-guard"),
      ignore: [],
      checks: [],
      probes: [],
      output: {
        maxOutputBytes: 262144
      },
      compare: {
        failOnCheckRegression: true,
        failOnProbeDiff: true
      },
      variables: {}
    }
  };
}

function makeRunPackage(root: string): MigrationRunPackage {
  const run: MigrationRun = {
    version: 1,
    id: "run-1",
    goal: "test",
    sourceRoot: root,
    targetRoot: root,
    artifactsDir: path.join(root, ".migration-guard", "migration-runs", "run-1"),
    status: "planned",
    mode: "dry-run",
    issueProvider: "local",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    estimate: {
      sourceFiles: 0,
      testFiles: 0,
      taskCount: 0,
      riskLevel: "low",
      confidence: "high",
      estimatedVerificationRounds: 1,
      notes: [],
      updatedAt: "2026-07-05T00:00:00.000Z"
    }
  };
  const graph: MigrationTaskGraph = {
    version: 1,
    runId: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    tasks: []
  };
  return {
    run,
    graph,
    issues: []
  };
}
