import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessRefactorReadiness, renderRefactorReadinessReport } from "./refactorReadiness.js";
import type {
  LoadedConfig,
  MigrationActionPlan,
  ProposalBatchReport,
  ProposedPatch
} from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

test("refactor readiness holds before action and proposal evidence exists", async () => {
  const { loaded, pkg } = await makeFixture();

  const report = await assessRefactorReadiness(loaded, pkg, { checkTargetGit: false });

  assert.equal(report.status, "hold");
  assert.ok(report.criteria.some((criterion) => criterion.id === "action-plan" && criterion.status === "blocked"));
  assert.ok(report.criteria.some((criterion) => criterion.id === "proposal-floor" && criterion.status === "blocked"));
  assert.match(renderRefactorReadinessReport(report), /Status: hold/);
});

test("refactor readiness goes green with action, template, proposal, and batch evidence", async () => {
  const { loaded, pkg, runDir } = await makeFixture({ confidence: "high" });
  await writeActionPlan(runDir, pkg.run.id);
  await writeProposal(runDir, makeProposal("patch-shared", "ts-structural-probe", "rolled-back"));
  await writeProposal(runDir, makeProposal("patch-renderer", "renderer-probe", "rolled-back"));
  await writeProposal(runDir, makeProposal("patch-api", "api-contract-probe", "rolled-back"));
  await writeBatchReport(runDir, pkg.run.id, ["patch-shared", "patch-renderer", "patch-api"]);

  const report = await assessRefactorReadiness(loaded, pkg, {
    minProposalCount: 3,
    minBatchSize: 3,
    checkTargetGit: false
  });

  assert.equal(report.status, "go");
  assert.equal(report.summary.latestPassingBatchId, "proposal-batch-report-ready");
  assert.ok(report.criteria.some((criterion) => criterion.id === "template-coverage" && criterion.status === "passed"));
  assert.ok(report.criteria.some((criterion) => criterion.id === "passing-batch" && criterion.status === "passed"));
});

async function makeFixture(options: { confidence?: "low" | "medium" | "high" } = {}): Promise<{
  loaded: LoadedConfig;
  pkg: MigrationRunPackage;
  runDir: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-readiness-"));
  const artifactsDir = path.join(root, "artifacts");
  const targetRoot = path.join(root, "target");
  const runDir = path.join(artifactsDir, "migration-runs", "run-readiness");
  const createdAt = "2026-07-08T00:00:00.000Z";
  await mkdir(targetRoot, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const loaded: LoadedConfig = {
    path: path.join(root, ".migration-guard.json"),
    baseDir: root,
    targetRoot,
    artifactsDir,
    config: {
      schemaVersion: 1,
      targetRoot,
      artifactsDir,
      ignore: [],
      checks: [],
      probes: [],
      output: {
        maxOutputBytes: 1024
      },
      compare: {
        failOnCheckRegression: true,
        failOnProbeDiff: true
      },
      proposalGate: {
        defaultPolicy: "collect-all",
        batchPolicy: "fail-fast"
      }
    }
  };
  const pkg: MigrationRunPackage = {
    run: {
      version: 1,
      id: "run-readiness",
      goal: "Readiness fixture",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: runDir,
      status: "running",
      mode: "dry-run",
      adapter: "md-monorepo",
      issueProvider: "local",
      createdAt,
      updatedAt: createdAt,
      estimate: {
        sourceFiles: 100,
        testFiles: 40,
        taskCount: 1,
        riskLevel: "high",
        confidence: options.confidence ?? "medium",
        estimatedVerificationRounds: 2,
        notes: ["fixture"],
        updatedAt: createdAt
      }
    },
    graph: {
      version: 1,
      runId: "run-readiness",
      createdAt,
      updatedAt: createdAt,
      tasks: []
    },
    issues: []
  };
  return { loaded, pkg, runDir };
}

async function writeActionPlan(runDir: string, runId: string): Promise<void> {
  const actionPlan: MigrationActionPlan = {
    version: 1,
    runId,
    createdAt: "2026-07-08T00:00:01.000Z",
    goal: "Readiness fixture",
    actions: [
      makeAction("action-md-shared-contracts", "ts-structural-probe"),
      makeAction("action-md-core-renderer", "renderer-probe"),
      makeAction("action-md-api-contracts", "api-contract-probe")
    ]
  };
  const dir = path.join(runDir, "adapter");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "md-monorepo-action-plan.json"), `${JSON.stringify(actionPlan, null, 2)}\n`, "utf8");
}

function makeAction(id: string, template: NonNullable<ProposedPatch["templateSelection"]>["template"]): MigrationActionPlan["actions"][number] {
  const command = "pnpm test";
  return {
    id,
    title: id,
    summary: id,
    risk: "medium",
    affectedFiles: ["packages/shared/src/index.ts"],
    recommendedChecks: [command],
    checkReadiness: [
      {
        command,
        status: "ready",
        reason: "fixture command"
      }
    ],
    patchMode: "dry-run-only",
    patchTemplate: template,
    templateSelection: {
      template,
      reason: "fixture"
    }
  };
}

async function writeProposal(runDir: string, proposal: ProposedPatch): Promise<void> {
  const dir = path.join(runDir, "proposals", proposal.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

function makeProposal(
  id: string,
  template: NonNullable<ProposedPatch["templateSelection"]>["template"],
  applyState: ProposedPatch["applyState"] = "proposed"
): ProposedPatch {
  return {
    version: 1,
    artifactSchemaVersion: 1,
    id,
    runId: "run-readiness",
    actionId: id.replace("patch-", "action-md-"),
    createdAt: "2026-07-08T00:00:02.000Z",
    title: id,
    summary: id,
    risk: "medium",
    patchPath: `/tmp/${id}.diff`,
    affectedFiles: ["packages/shared/src/index.ts"],
    recommendedChecks: ["pnpm test"],
    templateSelection: {
      template,
      reason: "fixture"
    },
    patchKind: "action-probe",
    applyState
  };
}

async function writeBatchReport(runDir: string, runId: string, proposalIds: string[]): Promise<void> {
  const dir = path.join(runDir, "proposal-batches", "proposal-batch-ready");
  const outputPath = path.join(dir, "proposal-batch-report-ready.json");
  const report: ProposalBatchReport = {
    version: 1,
    artifactSchemaVersion: 1,
    id: "proposal-batch-report-ready",
    runId,
    createdAt: "2026-07-08T00:00:03.000Z",
    planId: "proposal-batch-ready",
    gatePolicy: {
      mode: "fail-fast"
    },
    passed: true,
    executedCount: proposalIds.length,
    skippedCount: 0,
    excludedCount: 0,
    results: proposalIds.map((proposalId) => ({
      proposalId,
      passed: true,
      state: "rolled-back"
    })),
    skipped: [],
    excluded: [],
    outputPath
  };
  await mkdir(dir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
