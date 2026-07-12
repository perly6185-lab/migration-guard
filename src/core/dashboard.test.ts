import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  collectDashboard,
  collectDashboardBlockers,
  renderDashboard,
  renderDashboardBlockers,
  writeDashboardReport
} from "./dashboard.js";
import { loadMigrationRunIndex, saveRunPackage, type MigrationRunPackage } from "./migrationRun.js";
import { writeJsonFile } from "./files.js";
import type { ProposedPatch } from "../types.js";
import type { IssueControlSuperviseProgressLedger } from "./issueControl.js";

test("dashboard aggregates run index, ready tasks, proposals, progress and blockers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-dashboard-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const pkg = createDashboardRunPackage(dir, targetRoot);
    await saveRunPackage(loaded, pkg);
    const index = await loadMigrationRunIndex(loaded);

    assert.equal(index?.runCount, 1);
    assert.equal(index?.runs[0]?.runId, "run-dashboard");
    assert.equal(index?.runs[0]?.taskSummary.ready, 1);

    await writeDashboardProposal(loaded.artifactsDir);
    await writeDashboardProgressLedger(loaded.artifactsDir);

    const report = await collectDashboard(loaded, {
      runId: "run-dashboard",
      checkTargetGit: false
    });
    const blockerIds = report.blockers.map((blocker) => blocker.id);

    assert.equal(report.runs.source, "index");
    assert.equal(report.readyTasks[0]?.taskId, "task-ready");
    assert.equal(report.proposalSummary["verification-failed"], 1);
    assert.equal(report.stuckProposals[0]?.proposalId, "patch-dashboard");
    assert.ok(blockerIds.includes("task:task-blocked"));
    assert.ok(blockerIds.includes("proposal:patch-dashboard"));
    assert.ok(blockerIds.includes("progress:issue-progress"));
    assert.match(renderDashboard(report), /Migration Guard Dashboard/);

    const written = await writeDashboardReport(loaded, report);
    assert.match(written.outputPath ?? "", /dashboard-/);
    assert.match(written.markdownPath ?? "", /dashboard-/);

    const blockers = await collectDashboardBlockers(loaded, {
      runId: "run-dashboard",
      checkTargetGit: false
    });
    assert.equal(blockers.runId, "run-dashboard");
    assert.ok(blockers.blockerCount > 0);
    assert.match(renderDashboardBlockers(blockers), /proposal:patch-dashboard/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createDashboardRunPackage(dir: string, targetRoot: string): MigrationRunPackage {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    run: {
      version: 1,
      id: "run-dashboard",
      goal: "dashboard aggregation",
      sourceRoot: path.join(dir, "source"),
      targetRoot,
      artifactsDir: path.join(dir, ".migration-guard", "migration-runs", "run-dashboard"),
      status: "blocked",
      mode: "manual",
      issueProvider: "local",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 2,
        testFiles: 1,
        taskCount: 3,
        riskLevel: "medium",
        confidence: "medium",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    },
    graph: {
      version: 1,
      runId: "run-dashboard",
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-ready",
        title: "Ready task",
        description: "ready",
        type: "code-change",
        status: "ready",
        priority: 10,
        risk: "low",
        owner: "engine",
        dependsOn: [],
        affectedFiles: ["src/a.ts"],
        verificationCommands: ["npm test"],
        acceptanceCriteria: ["passes"],
        issueId: "issue-ready",
        createdAt: now,
        updatedAt: now
      }, {
        id: "task-blocked",
        title: "Blocked task",
        description: "blocked",
        type: "code-change",
        status: "blocked",
        priority: 20,
        risk: "medium",
        owner: "human",
        dependsOn: [],
        affectedFiles: ["src/b.ts"],
        verificationCommands: ["npm test"],
        acceptanceCriteria: ["unblocked"],
        issueId: "issue-blocked",
        result: "Needs baseline evidence.",
        createdAt: now,
        updatedAt: now
      }]
    },
    issues: [{
      id: "issue-ready",
      runId: "run-dashboard",
      taskId: "task-ready",
      type: "task",
      title: "Ready task issue",
      body: "ready",
      status: "ready",
      risk: "low",
      owner: "engine",
      affectedFiles: [],
      createdAt: now,
      updatedAt: now
    }, {
      id: "issue-blocked",
      runId: "run-dashboard",
      taskId: "task-blocked",
      type: "task",
      title: "Blocked task issue",
      body: "blocked",
      status: "blocked",
      risk: "medium",
      owner: "human",
      affectedFiles: [],
      createdAt: now,
      updatedAt: now
    }]
  };
}

async function writeDashboardProposal(artifactsDir: string): Promise<void> {
  const proposal: ProposedPatch = {
    version: 1,
    id: "patch-dashboard",
    runId: "run-dashboard",
    taskId: "task-ready",
    createdAt: "2026-07-12T00:01:00.000Z",
    title: "Dashboard failed proposal",
    summary: "failed",
    risk: "medium",
    patchPath: path.join(artifactsDir, "migration-runs", "run-dashboard", "proposals", "patch-dashboard", "patch.diff"),
    affectedFiles: ["src/a.ts"],
    recommendedChecks: ["npm test"],
    applyState: "verification-failed",
    lastVerificationPath: path.join(artifactsDir, "migration-runs", "run-dashboard", "proposals", "patch-dashboard", "verification.json")
  };
  await writeJsonFile(path.join(artifactsDir, "migration-runs", "run-dashboard", "proposals", "patch-dashboard", "proposal.json"), proposal);
}

async function writeDashboardProgressLedger(artifactsDir: string): Promise<void> {
  const ledger: IssueControlSuperviseProgressLedger = {
    version: 1,
    id: "issue-control-supervise-progress-test",
    createdAt: "2026-07-12T00:02:00.000Z",
    sourceSuperviseId: "issue-control-supervise-test",
    provider: "github",
    repo: "perly6185-lab/migration-guard",
    mode: "execute",
    status: "blocked",
    trustTier: "supervised",
    riskBudget: 3,
    summary: {
      issueCount: 1,
      selectedCount: 1,
      reachedCount: 1,
      unreachedSelectedCount: 0,
      recoveredCount: 0,
      continuedCount: 0,
      unresolvedCount: 1
    },
    failureCategory: "missing-baseline",
    items: [{
      issueNumber: 17,
      issueId: "issue-progress",
      runId: "run-dashboard",
      title: "Progress blocked",
      action: "execute-task",
      selected: true,
      reached: true,
      iterationIndex: 1,
      state: "blocked",
      status: "blocked",
      reason: "No baseline snapshot found.",
      artifactPaths: ["progress-artifact.json"],
      events: []
    }]
  };
  await writeJsonFile(path.join(artifactsDir, "issue-control", "issue-control-supervise-progress-test.json"), ledger);
}
