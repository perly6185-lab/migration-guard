import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { createAddFilePatch } from "./patch.js";
import type { MigrationIssue, MigrationRun, MigrationTaskGraph, ProposalBatchReport, ProposalRepairAcceptanceReport, ProposalVerificationReport, ProposedPatch } from "../types.js";

const execFileAsync = promisify(execFile);

test("CLI repair loop replans, retries, verifies, and accepts a controlled failed proposal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-cli-repair-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "subject.ts"), "export const subject = 'before';\n", "utf8");
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      checks: [],
      probes: []
    }, null, 2)}\n`, "utf8");

    const runId = "run-cli-repair";
    const runDir = path.join(dir, ".migration-guard", "migration-runs", runId);
    await writeRunPackage(runDir, dir, runId);
    await writeFailingProposal(runDir, runId);

    const batch = await runCliJson<ProposalBatchReport>(dir, [
      "proposal",
      "batch",
      "apply",
      "--config",
      configPath,
      "--run",
      runId,
      "--limit",
      "1",
      "--json"
    ], { expectExitCode: 1 });
    assert.equal(batch.passed, false);
    assert.equal(batch.firstFailedProposalId, "patch-cli-fail");
    assert.equal(batch.results[0]?.firstFailedCheck?.failureCategory, "command-failed");

    const replan = await runCliJson<{ briefPath: string; contextPath: string; report: ProposalVerificationReport }>(dir, [
      "proposal",
      "replan",
      "--config",
      configPath,
      "--run",
      runId,
      "--proposal",
      "patch-cli-fail",
      "--json"
    ]);
    assert.match(await readFile(replan.briefPath, "utf8"), /AI Repair Acceptance Checklist/);
    const replanContext = JSON.parse(await readFile(replan.contextPath, "utf8")) as {
      failure?: { latestFailedOutput?: { stderr?: string } };
      acceptanceChecklist?: string[];
    };
    assert.match(replanContext.failure?.latestFailedOutput?.stderr ?? "", /controlled failure/);
    assert.ok(replanContext.acceptanceChecklist?.some((item) => item.includes("stdout/stderr evidence")));

    const retry = await runCliJson<{ proposal: ProposedPatch }>(dir, [
      "proposal",
      "retry",
      "--config",
      configPath,
      "--run",
      runId,
      "--proposal",
      "patch-cli-fail",
      "--json"
    ]);
    assert.equal(retry.proposal.retryOfProposalId, "patch-cli-fail");
    assert.equal(retry.proposal.retrySourceFailureCategory, "command-failed");
    assert.match(await readFile(retry.proposal.patchPath, "utf8"), /Retry proposal scaffold/);

    await replaceRetryWithPassingPatch(retry.proposal);
    const verification = await runCliJson<ProposalVerificationReport>(dir, [
      "proposal",
      "verify",
      "--config",
      configPath,
      "--run",
      runId,
      "--proposal",
      retry.proposal.id,
      "--checks",
      "--json"
    ]);
    assert.equal(verification.passed, true);
    assert.equal(verification.checks.length, 1);
    assert.match(verification.checks[0]?.stdout ?? "", /repair-ok/);

    const acceptance = await runCliJson<{ acceptanceReport: ProposalRepairAcceptanceReport }>(dir, [
      "proposal",
      "accept",
      "--config",
      configPath,
      "--run",
      runId,
      "--proposal",
      retry.proposal.id,
      "--notes",
      "cli smoke acceptance",
      "--json"
    ]);
    assert.equal(acceptance.acceptanceReport.accepted, true);
    assert.equal(acceptance.acceptanceReport.sourceProposalId, "patch-cli-fail");
    assert.equal(acceptance.acceptanceReport.retryProposalId, retry.proposal.id);
    assert.ok(acceptance.acceptanceReport.checklist.every((item) => item.status === "accepted"));

    const report = await runCliText(dir, [
      "report",
      "--config",
      configPath,
      "--run",
      runId
    ]);
    assert.match(report.stdout, /Recent Repair Acceptances/);
    assert.match(report.stdout, /repair:accepted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeRunPackage(runDir: string, root: string, runId: string): Promise<void> {
  const run: MigrationRun = {
    version: 1,
    id: runId,
    goal: "Phase 73 CLI repair loop smoke",
    sourceRoot: root,
    targetRoot: root,
    artifactsDir: runDir,
    status: "planned",
    mode: "dry-run",
    issueProvider: "local",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    estimate: {
      sourceFiles: 1,
      testFiles: 0,
      taskCount: 0,
      riskLevel: "low",
      confidence: "high",
      estimatedVerificationRounds: 1,
      notes: [],
      updatedAt: "2026-07-08T00:00:00.000Z"
    }
  };
  const graph: MigrationTaskGraph = {
    version: 1,
    runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    tasks: []
  };
  const issues: MigrationIssue[] = [];
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "task-graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "issues.json"), `${JSON.stringify(issues, null, 2)}\n`, "utf8");
}

async function writeFailingProposal(runDir: string, runId: string): Promise<void> {
  const proposalDir = path.join(runDir, "proposals", "patch-cli-fail");
  const generatedFile = "scripts/migration-guard/cli-fail.mjs";
  const proposal: ProposedPatch = {
    version: 1,
    artifactSchemaVersion: 1,
    id: "patch-cli-fail",
    runId,
    createdAt: "2026-07-08T00:01:00.000Z",
    title: "Controlled CLI failure",
    summary: "Adds a generated check that fails so the CLI repair loop can replan.",
    risk: "low",
    patchPath: path.join(proposalDir, "patch.diff"),
    affectedFiles: ["src/subject.ts"],
    generatedFiles: [generatedFile],
    recommendedChecks: [`node ${generatedFile}`],
    checkPlan: [{
      command: `node ${generatedFile}`,
      kind: "unit-test",
      phase: "pre-preview",
      critical: true
    }],
    patchKind: "action-probe",
    applyState: "proposed"
  };
  await mkdir(proposalDir, { recursive: true });
  await writeFile(proposal.patchPath, createAddFilePatch(generatedFile, "console.error('controlled failure');\nprocess.exit(1);\n"), "utf8");
  await writeFile(path.join(proposalDir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

async function replaceRetryWithPassingPatch(proposal: ProposedPatch): Promise<void> {
  const proposalPath = path.join(path.dirname(proposal.patchPath), "proposal.json");
  const generatedFile = `scripts/migration-guard/${proposal.id}-repair.mjs`;
  proposal.generatedFiles = [generatedFile];
  proposal.recommendedChecks = [`node ${generatedFile}`];
  proposal.checkPlan = [{
    command: `node ${generatedFile}`,
    kind: "unit-test",
    phase: "pre-preview",
    critical: true
  }];
  await writeFile(proposal.patchPath, createAddFilePatch(generatedFile, "console.log('repair-ok');\n"), "utf8");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

async function runCliJson<T>(
  cwd: string,
  args: string[],
  options: { expectExitCode?: number } = {}
): Promise<T> {
  const result = await runCliText(cwd, args, options);
  return JSON.parse(result.stdout) as T;
}

async function runCliText(
  cwd: string,
  args: string[],
  options: { expectExitCode?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const expectedExitCode = options.expectExitCode ?? 0;
  try {
    const result = await execFileAsync(process.execPath, [path.resolve("dist", "cli.js"), ...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 10
    });
    assert.equal(expectedExitCode, 0);
    return result;
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(failed.code, expectedExitCode, failed.stderr);
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? ""
    };
  }
}
