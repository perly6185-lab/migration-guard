import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { pathExists } from "./files.js";
import { collectArtifactGcReport } from "./artifactGc.js";
import { collectArtifactMigrationReport } from "./artifactMigration.js";

test("loadConfig lets environment variables override config variables", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-config-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const previous = process.env.MG_TEST_TARGET;
  process.env.MG_TEST_TARGET = "from-env";

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "${MG_TEST_TARGET}",
      artifactsDir: ".migration-guard",
      variables: {
        MG_TEST_TARGET: "from-config"
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    assert.equal(loaded.targetRoot, path.join(dir, "from-env"));
  } finally {
    if (previous === undefined) {
      delete process.env.MG_TEST_TARGET;
    } else {
      process.env.MG_TEST_TARGET = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig applies named profiles after base config defaults", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-profile-"));
  const configPath = path.join(dir, ".migration-guard.json");

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "project",
      artifactsDir: ".migration-guard",
      output: {
        maxOutputBytes: 1000
      },
      variables: {
        BASE: "base"
      },
      profiles: {
        ci: {
          artifactsDir: ".migration-guard/ci",
          output: {
            maxOutputBytes: 2000
          },
          proposalGate: {
            batchPolicy: "collect-all"
          },
          variables: {
            BASE: "profile",
            EXTRA: "yes"
          }
        }
      }
    }), "utf8");

    const loaded = await loadConfig(configPath, dir, "ci");

    assert.equal(loaded.profile, "ci");
    assert.equal(loaded.targetRoot, path.join(dir, "project"));
    assert.equal(loaded.artifactsDir, path.join(dir, ".migration-guard", "ci"));
    assert.equal(loaded.config.output.maxOutputBytes, 2000);
    assert.equal(loaded.config.proposalGate.defaultPolicy, "collect-all");
    assert.equal(loaded.config.proposalGate.batchPolicy, "collect-all");
    assert.equal(loaded.config.variables?.BASE, "profile");
    assert.equal(loaded.config.variables?.EXTRA, "yes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported schema versions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-schema-"));
  const configPath = path.join(dir, ".migration-guard.json");

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 999,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");

    await assert.rejects(() => loadConfig(configPath), /Unsupported config schemaVersion 999/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact GC plans old migration runs and only deletes with apply", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-artifact-gc-"));
  const configPath = path.join(dir, ".migration-guard.json");

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const runsDir = path.join(loaded.artifactsDir, "migration-runs");
    const runIds = ["run-old", "run-middle", "run-new"];
    for (const [index, runId] of runIds.entries()) {
      const runDir = path.join(runsDir, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "run.json"), JSON.stringify({
        id: runId,
        createdAt: `2026-07-0${index + 1}T00:00:00.000Z`
      }), "utf8");
    }
    await writeFile(path.join(runsDir, "latest.json"), JSON.stringify({ id: "run-new" }), "utf8");

    const dryRun = await collectArtifactGcReport(loaded, { keepRuns: 1 });
    assert.deepEqual(dryRun.candidates.map((candidate) => candidate.id), ["run-middle", "run-old"]);
    assert.equal(await pathExists(path.join(runsDir, "run-old")), true);

    const applied = await collectArtifactGcReport(loaded, { keepRuns: 1, apply: true });
    assert.deepEqual(applied.deleted.map((candidate) => candidate.id), ["run-middle", "run-old"]);
    assert.equal(await pathExists(path.join(runsDir, "run-new")), true);
    assert.equal(await pathExists(path.join(runsDir, "run-old")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact migration backfills proposal, batch, verification, and replan artifacts only with apply", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-artifact-migrate-"));
  const configPath = path.join(dir, ".migration-guard.json");

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const runDir = path.join(loaded.artifactsDir, "migration-runs", "run-old");
    const proposalDir = path.join(runDir, "proposals", "patch-old");
    const batchDir = path.join(runDir, "proposal-batches", "proposal-batch-old");
    const replanDir = path.join(runDir, "replans", "patch-old");
    await mkdir(proposalDir, { recursive: true });
    await mkdir(batchDir, { recursive: true });
    await mkdir(replanDir, { recursive: true });

    const proposalPath = path.join(proposalDir, "proposal.json");
    await writeFile(proposalPath, JSON.stringify({
      version: 1,
      id: "patch-old",
      runId: "run-old",
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "Old ignored proposal",
      summary: "Old shape",
      risk: "low",
      patchPath: "patch.diff",
      affectedFiles: [],
      recommendedChecks: [],
      applyState: "ignored"
    }), "utf8");
    await writeFile(path.join(proposalDir, "verification-1.json"), JSON.stringify({
      version: 1,
      id: "verification-1",
      runId: "run-old",
      proposalId: "patch-old",
      mode: "verify",
      createdAt: "2026-07-01T00:00:00.000Z",
      patchPath: "patch.diff",
      applied: false,
      passed: false,
      patchCheck: {},
      checks: [],
      outputPath: "verification-1.json"
    }), "utf8");
    await writeFile(path.join(batchDir, "batch-plan.json"), JSON.stringify({
      version: 1,
      id: "proposal-batch-old",
      runId: "run-old",
      createdAt: "2026-07-01T00:00:00.000Z",
      proposals: [],
      outputPath: "batch-plan.json"
    }), "utf8");
    await writeFile(path.join(batchDir, "proposal-batch-report-1.json"), JSON.stringify({
      version: 1,
      id: "proposal-batch-report-1",
      runId: "run-old",
      createdAt: "2026-07-01T00:00:00.000Z",
      planId: "proposal-batch-old",
      passed: true,
      executedCount: 0,
      skippedCount: 0,
      results: [],
      outputPath: "proposal-batch-report-1.json"
    }), "utf8");
    await writeFile(path.join(replanDir, "replan-context.json"), JSON.stringify({
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      run: { id: "run-old", goal: "old", status: "blocked", targetRoot: dir },
      proposal: { id: "patch-old" },
      failure: {
        firstFailedCheck: {
          stdout: "old stdout",
          stderr: "old stderr"
        }
      },
      commands: {},
      paths: {}
    }), "utf8");

    const dryRun = await collectArtifactMigrationReport(loaded);
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.scannedCount, 5);
    assert.equal(dryRun.migratedCount, 5);
    assert.match(dryRun.planHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(proposalPath, "utf8")).artifactSchemaVersion, undefined);

    await assert.rejects(
      () => collectArtifactMigrationReport(loaded, { apply: true }),
      /requires --apply-confirm/
    );
    const applied = await collectArtifactMigrationReport(loaded, { apply: true, applyConfirm: dryRun.planHash });
    assert.equal(applied.applied, true);
    assert.equal(applied.planHash, dryRun.planHash);
    assert.equal(applied.migratedCount, 5);

    const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
    assert.equal(proposal.artifactSchemaVersion, 1);
    assert.equal(proposal.exclusion.state, "ignored");
    assert.deepEqual(proposal.generatedFiles, []);

    const batchReport = JSON.parse(await readFile(path.join(batchDir, "proposal-batch-report-1.json"), "utf8"));
    assert.equal(batchReport.artifactSchemaVersion, 1);
    assert.equal(batchReport.excludedCount, 0);
    assert.deepEqual(batchReport.excluded, []);
    assert.deepEqual(batchReport.skipped, []);

    const replanContext = JSON.parse(await readFile(path.join(replanDir, "replan-context.json"), "utf8"));
    assert.equal(replanContext.artifactSchemaVersion, 1);
    assert.deepEqual(replanContext.proposal.sourceSnippets, []);
    assert.equal(replanContext.failure.latestFailedOutput.stderr, "old stderr");
    assert.ok(replanContext.acceptanceChecklist.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
