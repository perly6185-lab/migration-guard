import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { pathExists } from "./files.js";
import { collectArtifactGcReport } from "./artifactGc.js";
import { collectArtifactMigrationReport, renderArtifactMigrationReport } from "./artifactMigration.js";

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
      issueSync: {
        githubRepo: "owner/base"
      },
      profiles: {
        ci: {
          artifactsDir: ".migration-guard/ci",
          output: {
            maxOutputBytes: 2000
          },
          issueSync: {
            githubRepo: "owner/ci"
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
    assert.equal(loaded.config.issueSync?.githubRepo, "owner/ci");
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
    assert.equal(dryRun.schema.frozenAtPhase, 72);
    assert.ok(dryRun.schema.kinds.some((kind) => kind.kind === "proposal-replan-context"));
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
    assert.equal(batchReport.executedCount, 0);
    assert.equal(batchReport.skippedCount, 0);
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

test("artifact migration freezes v1 schema and refuses unsupported future artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-artifact-freeze-"));
  const configPath = path.join(dir, ".migration-guard.json");

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", "run-future", "proposals", "patch-future");
    await mkdir(proposalDir, { recursive: true });
    await writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify({
      version: 1,
      artifactSchemaVersion: 999,
      id: "patch-future",
      runId: "run-future",
      createdAt: "2026-07-08T00:00:00.000Z",
      title: "Future artifact",
      summary: "Uses an unsupported schema marker.",
      risk: "low",
      patchPath: "patch.diff",
      affectedFiles: [],
      generatedFiles: [],
      recommendedChecks: [],
      applyState: "proposed"
    }), "utf8");

    const dryRun = await collectArtifactMigrationReport(loaded);
    assert.equal(dryRun.scannedCount, 1);
    assert.equal(dryRun.migratedCount, 0);
    assert.equal(dryRun.unsupportedCount, 1);
    assert.equal(dryRun.schema.currentArtifactSchemaVersion, 1);
    assert.match(dryRun.entries[0]?.message ?? "", /unsupported artifactSchemaVersion 999/);
    assert.match(renderArtifactMigrationReport(dryRun), /Unsupported:/);
    assert.match(renderArtifactMigrationReport(dryRun), /Schema kinds: proposal/);

    await assert.rejects(
      () => collectArtifactMigrationReport(loaded, { apply: true }),
      /unsupported artifact/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact migration wraps v1 snapshot, compare, and UI job artifacts in v2 envelopes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-core-artifact-migrate-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }), "utf8");
    const loaded = await loadConfig(configPath);
    const baselinePath = path.join(loaded.artifactsDir, "baselines", "baseline-old.json");
    const comparePath = path.join(loaded.artifactsDir, "compare", "compare-old.json");
    const jobPath = path.join(loaded.artifactsDir, "ui-jobs", "job-old.json");
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await mkdir(path.dirname(comparePath), { recursive: true });
    await mkdir(path.dirname(jobPath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify({ version: 1, kind: "baseline", id: "baseline-old" }), "utf8");
    await writeFile(comparePath, JSON.stringify({ passed: true, baselineId: "baseline-old", currentId: "run-old", createdAt: "2026-07-14T00:00:00.000Z", differences: [] }), "utf8");
    await writeFile(jobPath, JSON.stringify({ version: 1, id: "job-old", action: "readiness", status: "queued" }), "utf8");

    const dryRun = await collectArtifactMigrationReport(loaded);
    assert.equal(dryRun.scannedCount, 3);
    assert.equal(dryRun.migratedCount, 3);
    assert.deepEqual(dryRun.entries.map((entry) => entry.kind).sort(), ["compare", "snapshot", "ui-job"]);
    const applied = await collectArtifactMigrationReport(loaded, { apply: true, applyConfirm: dryRun.planHash });
    assert.equal(applied.migratedCount, 3);
    for (const filePath of [baselinePath, comparePath, jobPath]) {
      const stored = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(stored.artifactSchemaVersion, 2);
      assert.match(stored.payloadHash, /^[a-f0-9]{64}$/);
    }
    const repeated = await collectArtifactMigrationReport(loaded);
    assert.equal(repeated.migratedCount, 0);
    assert.equal(repeated.unchangedCount, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
