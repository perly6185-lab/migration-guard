import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { acceptProposalRepair, applyProposalBatch, applyProposedPatch, createAddFilePatch, createProposalBatchPlan, createProposalRetry, excludeProposal, listProposals, proposeActionPatch, renderProposalList, renderProposalVerificationReport, replanProposal, rollbackProposedPatch, verifyProposedPatch } from "./patch.js";
import { syncIssues } from "./issueSync.js";
import { renderRunReport, renderRunStatus, resolveRunNextAction, writeCiHandoffReport, writeRunReport } from "./migrationRun.js";
import { createGitHubIssues } from "./githubIssueAdapter.js";
import type { LoadedConfig, MigrationIssue, MigrationRun, MigrationTaskGraph, ProposalVerificationReport, ProposedPatch } from "../types.js";
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
    await writeFile(path.join(dir, "probe-status.mjs"), [
      "import { existsSync } from \"node:fs\";",
      "console.log(existsSync(\"scripts/migration-guard/probe.mjs\") ? \"present\" : \"missing\");",
      ""
    ].join("\n"), "utf8");
    loaded.config.probes = [{
      type: "command",
      name: "generated-probe-presence",
      command: "node probe-status.mjs"
    }];
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

    const verify = await verifyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    assert.equal(verify.passed, true);
    assert.equal(verify.applied, false);
    assert.equal(verify.temporaryApply?.applied, true);
    assert.equal(verify.temporaryApply?.rolledBack, true);
    assert.equal(verify.temporaryApply?.passed, true);
    assert.equal(verify.checks.length, 1);
    assert.match(verify.checks[0]?.stdout ?? "", /probe-ok/);
    assert.match(renderProposalVerificationReport(verify), /Temporary apply: applied, rolled back/);
    assert.equal((await readProposal(proposalPath)).applyState, "verified");
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "probe.mjs")));

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true, behaviorDiff: true });
    assert.equal(apply.report?.passed, true);
    assert.equal(apply.report?.checks.length, 1);
    assert.equal(apply.report?.checkPlan?.[0]?.kind, "other");
    assert.equal(apply.report?.timeline.length, 2);
    assert.match(apply.report?.checks[0]?.stdout ?? "", /probe-ok/);
    assert.equal(apply.report?.behaviorDiff?.passed, false);
    assert.ok((apply.report?.behaviorDiff?.differenceCount ?? 0) > 0);
    assert.match(apply.report?.behaviorDiff?.compareReportPath ?? "", /behavior-diff-.*-compare\.json$/);
    await access(apply.report?.behaviorDiff?.beforeSnapshotPath ?? "");
    await access(apply.report?.behaviorDiff?.afterSnapshotPath ?? "");
    await access(apply.report?.behaviorDiff?.compareMarkdownPath ?? "");
    assert.match(renderProposalVerificationReport(apply.report as ProposalVerificationReport), /Behavior diff: failed/);
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
    const failedReportPath = (await readProposal(proposalPath)).lastVerificationPath;
    assert.ok(failedReportPath);
    const failedReport = await readVerificationReport(failedReportPath);
    assert.ok(failedReport.replanIssueId);
    assert.ok(failedReport.replanTaskId);
    assert.equal(pkg.issues.some((issue) => issue.id === failedReport.replanIssueId), true);
    assert.equal(pkg.graph.tasks.some((task) => task.id === failedReport.replanTaskId), true);
    assert.equal(failedReport.checks[0]?.failureCategory, "command-failed");
    assert.ok(failedReport.checks[0]?.remediationHints?.some((hint) => hint.includes("stdout/stderr")));
    assert.match(pkg.issues.find((issue) => issue.id === failedReport.replanIssueId)?.body ?? "", /Remediation hints/);
    assert.match(pkg.graph.tasks.find((task) => task.id === failedReport.replanTaskId)?.description ?? "", /Remediation hints/);
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "failing-probe.mjs")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyProposedPatch treats no-op successful checks as failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-no-op-check-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-no-op");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const generatedFile = "scripts/migration-guard/no-op-probe.mjs";
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-no-op",
      runId: pkg.run.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      title: "Add no-op probe",
      summary: "Adds a probe that reports a package-manager no-op.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: [generatedFile],
      recommendedChecks: [`node ${generatedFile}`],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch(generatedFile, "console.log('None of the selected packages has a \"type-check\" script');\n"), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    const report = await verifyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    assert.equal(report.passed, false);
    assert.equal(report.temporaryApply?.rolledBack, true);
    assert.equal(report.checks[0]?.exitCode, 0);
    assert.equal(report.checks[0]?.failureCategory, "no-op");
    assert.ok(report.checks[0]?.remediationHints?.some((hint) => hint.includes("did not run a real check")));
    assert.equal((await readProposal(proposalPath)).applyState, "verification-failed");
    await assert.rejects(access(path.join(dir, generatedFile)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyProposedPatch retries flake-suspected checks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-flake-retry-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-flaky");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const command = "node scripts/migration-guard/flaky-probe.mjs";
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-flaky",
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      title: "Add flaky probe",
      summary: "Adds a probe that passes on retry.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: ["scripts/migration-guard/flaky-probe.mjs"],
      recommendedChecks: [command],
      checkPlan: [{
        command,
        kind: "unit-test",
        phase: "pre-preview",
        retry: {
          maxAttempts: 2,
          delayMs: 1,
          retryOn: ["flake-suspected"]
        },
        critical: true
      }],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch("scripts/migration-guard/flaky-probe.mjs", [
      "import { existsSync, writeFileSync } from \"node:fs\";",
      "const marker = \".flaky-marker\";",
      "if (!existsSync(marker)) {",
      "  writeFileSync(marker, \"1\", \"utf8\");",
      "  console.error(\"Error: [vitest-pool]: Failed to start forks worker\");",
      "  process.exit(1);",
      "}",
      "console.log(\"flaky-ok\");",
      ""
    ].join("\n")), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    const check = apply.report?.checks[0];
    assert.equal(apply.report?.passed, true);
    assert.equal(check?.passed, true);
    assert.equal(check?.attemptCount, 2);
    assert.equal(check?.flakeSuspected, true);
    assert.equal(check?.attempts?.[0]?.failureCategory, "flake-suspected");
    assert.match(check?.stdout ?? "", /flaky-ok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyProposedPatch fail-fast policy stops after the first critical failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-fail-fast-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-fail-fast");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const generatedFile = "scripts/migration-guard/fail-fast-probe.mjs";
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-fail-fast",
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      title: "Add fail-fast probe",
      summary: "Adds a probe script used to assert gate policy behavior.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: [generatedFile],
      recommendedChecks: [
        `node ${generatedFile} fail`,
        `node ${generatedFile} marker`
      ],
      checkPlan: [
        {
          command: `node ${generatedFile} fail`,
          kind: "unit-test",
          phase: "pre-preview",
          critical: true
        },
        {
          command: `node ${generatedFile} marker`,
          kind: "unit-test",
          phase: "pre-preview",
          critical: true
        }
      ],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch(generatedFile, [
      "import { writeFileSync } from \"node:fs\";",
      "if (process.argv[2] === \"marker\") {",
      "  writeFileSync(\"second-check-ran.txt\", \"1\", \"utf8\");",
      "  process.exit(0);",
      "}",
      "console.error(\"first check failed\");",
      "process.exit(1);",
      ""
    ].join("\n")), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    await assert.rejects(
      applyProposedPatch(loaded, pkg, proposal.id, {
        runChecks: true,
        gatePolicy: { mode: "fail-fast" }
      }),
      /verification failed/
    );
    const failedReportPath = (await readProposal(proposalPath)).lastVerificationPath;
    assert.ok(failedReportPath);
    const failedReport = await readVerificationReport(failedReportPath);
    assert.equal(failedReport.gatePolicy?.mode, "fail-fast");
    assert.equal(failedReport.checks.length, 1);
    await assert.rejects(access(path.join(dir, "second-check-ran.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposal batch plan and apply execute ready proposals in order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-batch-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    await writeBatchProposal(loaded, pkg, "patch-b", "medium", "scripts/migration-guard/b.mjs", "console.log(\"b-ok\");\n");
    await writeBatchProposal(loaded, pkg, "patch-a", "low", "scripts/migration-guard/a.mjs", "console.log(\"a-ok\");\n");

    const plan = await createProposalBatchPlan(loaded, pkg, { limit: 2 });
    assert.deepEqual(plan.proposals.map((proposal) => proposal.proposalId), ["patch-a", "patch-b"]);

    const report = await applyProposalBatch(loaded, pkg, { limit: 2, runChecks: true });
    assert.equal(report.passed, true);
    assert.deepEqual(report.results.map((result) => result.proposalId), ["patch-a", "patch-b"]);
    assert.equal(report.results.every((result) => result.passed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposal reject and ignore states exclude proposals from batch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-batch-exclusion-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    await writeBatchProposal(loaded, pkg, "patch-ignore", "low", "scripts/migration-guard/ignore.mjs", "console.log(\"ignore\");\n");
    await writeBatchProposal(loaded, pkg, "patch-reject", "low", "scripts/migration-guard/reject.mjs", "console.log(\"reject\");\n");
    await writeBatchProposal(loaded, pkg, "patch-keep", "low", "scripts/migration-guard/keep.mjs", "console.log(\"keep\");\n");

    const ignored = await excludeProposal(loaded, pkg, "patch-ignore", "ignored", "fixture probe superseded", "patch-keep");
    const rejected = await excludeProposal(loaded, pkg, "patch-reject", "rejected", "wrong probe shape");
    assert.equal(ignored.applyState, "ignored");
    assert.equal(rejected.applyState, "rejected");
    assert.equal(ignored.exclusion?.reason, "fixture probe superseded");
    assert.equal(ignored.exclusion?.supersededBy, "patch-keep");

    const plan = await createProposalBatchPlan(loaded, pkg, { limit: 5 });
    assert.deepEqual(plan.proposals.map((proposal) => proposal.proposalId), ["patch-keep"]);
    assert.equal(plan.excludedCount, 2);
    assert.deepEqual(plan.excluded?.map((proposal) => proposal.proposalId).sort(), ["patch-ignore", "patch-reject"]);
    assert.equal(plan.excluded?.find((proposal) => proposal.proposalId === "patch-ignore")?.supersededBy, "patch-keep");
    assert.deepEqual((await listProposals(loaded, pkg, { state: "ignored" })).map((proposal) => proposal.id), ["patch-ignore"]);
    assert.match(renderProposalList(await listProposals(loaded, pkg, { state: "ignored" })), /superseded-by:patch-keep/);
    await assert.rejects(() => applyProposedPatch(loaded, pkg, "patch-ignore"), /ignored/);
    await assert.rejects(() => verifyProposedPatch(loaded, pkg, "patch-reject"), /rejected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposal batch apply reports stop reason and skipped proposals after failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-batch-failure-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const compareDir = path.join(loaded.artifactsDir, "compare");
    await mkdir(compareDir, { recursive: true });
    await writeFile(path.join(compareDir, "latest-compare.json"), `${JSON.stringify({
      passed: false,
      baselineId: "baseline-drift",
      currentId: "run-drift",
      createdAt: "2026-07-06T00:00:00.000Z",
      differences: [
        {
          severity: "error",
          area: "probe",
          name: "renderer-output",
          message: "Probe output changed.",
          before: "before-hash",
          after: "after-hash"
        },
        {
          severity: "warn",
          area: "check",
          name: "a-fail",
          message: "Check stdout changed while still passing."
        },
        {
          severity: "info",
          area: "scan",
          name: "source-files",
          message: "Source file count changed."
        }
      ]
    }, null, 2)}\n`, "utf8");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "export function a() {\n  return \"a\";\n}\n", "utf8");
    await writeBatchProposal(loaded, pkg, "patch-a-fail", "low", "scripts/migration-guard/a-fail.mjs", "console.error(\"a-fail\");\nprocess.exit(1);\n", ["src/a.ts"]);
    await writeBatchProposal(loaded, pkg, "patch-b-skip", "low", "scripts/migration-guard/b-skip.mjs", "console.log(\"b-ok\");\n");

    const report = await applyProposalBatch(loaded, pkg, { limit: 2, runChecks: true });
    assert.equal(report.passed, false);
    assert.equal(report.results.length, 1);
    assert.equal(report.gatePolicy?.mode, "fail-fast");
    assert.equal(report.executedCount, 1);
    assert.equal(report.skippedCount, 1);
    assert.equal(report.results[0]?.proposalId, "patch-a-fail");
    assert.equal(report.results[0]?.firstFailedCheck?.failureCategory, "command-failed");
    assert.ok(report.results[0]?.firstFailedCheck?.remediationHints?.some((hint) => hint.includes("stdout/stderr")));
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.proposalId, "patch-b-skip");
    assert.equal(report.firstFailedProposalId, "patch-a-fail");
    assert.equal(report.firstFailedVerificationPath, report.results[0]?.verificationPath);
    assert.match(report.stopReason ?? "", /patch-a-fail/);
    assert.match(report.nextCommand ?? "", /proposal replan/);
    assert.ok(report.recommendedNextActions?.some((action) => action.includes("proposal replan")));
    const failedVerification = await readVerificationReport(report.firstFailedVerificationPath ?? "");
    assert.equal(failedVerification.behaviorDrift?.baselineId, "baseline-drift");
    assert.equal(failedVerification.behaviorDrift?.differences.length, 2);
    assert.equal(failedVerification.behaviorDrift?.differences[0]?.area, "probe");
    assert.equal(failedVerification.behaviorDrift?.differences[1]?.relatedFailedCommand, "node scripts/migration-guard/a-fail.mjs");
    assert.doesNotMatch(renderProposalVerificationReport(failedVerification), /source-files/);
    const nextBeforeReplan = await resolveRunNextAction(loaded, pkg);
    assert.match(nextBeforeReplan.action, /Create a replan brief/);
    assert.match(nextBeforeReplan.command ?? "", /proposal replan/);
    assert.ok(nextBeforeReplan.evidence?.some((item) => item.includes("proposal-batch-report-")));
    assert.match(renderRunStatus(pkg, nextBeforeReplan), /Next action: Create a replan brief/);

    const replan = await replanProposal(loaded, pkg, "patch-a-fail");
    assert.match(replan.briefPath, /replan-brief\.md$/);
    assert.match(replan.contextPath, /replan-context\.json$/);
    await access(replan.briefPath);
    await access(replan.contextPath);
    const replanBrief = await readFile(replan.briefPath, "utf8");
    assert.match(replanBrief, /First failed check/);
    assert.match(replanBrief, /Retry Commands/);
    assert.match(replanBrief, /Behavior Drift/);
    assert.match(replanBrief, /probe\/renderer-output/);
    assert.match(replanBrief, /Source Snippet Index/);
    assert.match(replanBrief, /AI Repair Acceptance Checklist/);
    const replanContext = JSON.parse(await readFile(replan.contextPath, "utf8")) as {
      proposal?: { id?: string; sourceSnippets?: Array<{ file?: string; excerpt?: string }>; checkPlan?: unknown[] };
      failure?: { firstFailedCheck?: { failureCategory?: string }; latestFailedOutput?: { stderr?: string }; issueId?: string; taskId?: string; behaviorDrift?: { differences?: unknown[] } };
      acceptanceChecklist?: string[];
      commands?: { retryVerify?: string };
    };
    assert.equal(replanContext.proposal?.id, "patch-a-fail");
    assert.equal(replanContext.proposal?.sourceSnippets?.[0]?.file, "src/a.ts");
    assert.match(replanContext.proposal?.sourceSnippets?.[0]?.excerpt ?? "", /export function a/);
    assert.equal(replanContext.proposal?.checkPlan?.length, 1);
    assert.equal(replanContext.failure?.firstFailedCheck?.failureCategory, "command-failed");
    assert.match(replanContext.failure?.latestFailedOutput?.stderr ?? "", /a-fail/);
    assert.equal(replanContext.failure?.issueId, replan.report.replanIssueId);
    assert.equal(replanContext.failure?.taskId, replan.task.id);
    assert.equal(replanContext.failure?.behaviorDrift?.differences?.length, 2);
    assert.ok(replanContext.acceptanceChecklist?.some((item) => item.includes("failure classification")));
    assert.match(replanContext.commands?.retryVerify ?? "", /proposal verify/);
    const nextAfterReplan = await resolveRunNextAction(loaded, pkg);
    assert.match(nextAfterReplan.action, /Create a retry proposal/);
    assert.match(nextAfterReplan.command ?? "", /proposal retry/);
    assert.ok(nextAfterReplan.evidence?.includes(replan.briefPath));
    const retry = await createProposalRetry(loaded, pkg, "patch-a-fail");
    assert.equal(retry.reused, false);
    assert.equal(retry.proposal.retryOfProposalId, "patch-a-fail");
    assert.equal(retry.proposal.retrySourceFailureCategory, "command-failed");
    assert.equal(retry.proposal.patchKind, "replan-retry");
    assert.equal(retry.proposal.replanBriefPath, replan.briefPath);
    assert.equal(retry.report.retryProposalId, retry.proposal.id);
    await access(retry.proposal.patchPath);
    const retryPatch = await readFile(retry.proposal.patchPath, "utf8");
    assert.match(retryPatch, /Retry proposal scaffold/);
    assert.equal(pkg.graph.tasks.find((task) => task.id === replan.task.id)?.status, "done");
    assert.equal(pkg.issues.find((issue) => issue.taskId === replan.task.id)?.status, "done");
    const retryAgain = await createProposalRetry(loaded, pkg, "patch-a-fail");
    assert.equal(retryAgain.reused, true);
    assert.equal(retryAgain.proposal.id, retry.proposal.id);
    const nextAfterRetry = await resolveRunNextAction(loaded, pkg);
    assert.match(nextAfterRetry.action, /Verify retry proposal/);
    assert.match(nextAfterRetry.command ?? "", /proposal verify/);
    assert.ok(nextAfterRetry.evidence?.includes(retry.proposal.patchPath));
    const retryProposalPath = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", retry.proposal.id, "proposal.json");
    const retryProposalForVerify = JSON.parse(await readFile(retryProposalPath, "utf8")) as typeof retry.proposal;
    retryProposalForVerify.recommendedChecks = ["node -e \"console.log('retry-ok')\""];
    retryProposalForVerify.checkPlan = [{
      command: "node -e \"console.log('retry-ok')\"",
      kind: "unit-test",
      phase: "pre-preview",
      critical: true
    }];
    await writeFile(retryProposalPath, `${JSON.stringify(retryProposalForVerify, null, 2)}\n`, "utf8");
    const retryVerification = await verifyProposedPatch(loaded, pkg, retry.proposal.id, { runChecks: true });
    assert.equal(retryVerification.passed, true);
    assert.equal(retryVerification.checks.length, 1);
    const acceptance = await acceptProposalRepair(loaded, pkg, retry.proposal.id, { notes: "unit acceptance" });
    assert.equal(acceptance.acceptanceReport.accepted, true);
    assert.equal(acceptance.acceptanceReport.sourceProposalId, "patch-a-fail");
    assert.equal(acceptance.acceptanceReport.retryProposalId, retry.proposal.id);
    assert.equal(acceptance.acceptanceReport.retryVerificationPath, retryVerification.outputPath);
    assert.ok(acceptance.acceptanceReport.checklist.some((item) => item.text.includes("Latest retry verification passed")));
    await access(acceptance.acceptanceReport.outputPath);
    const acceptedRetry = JSON.parse(await readFile(retryProposalPath, "utf8")) as { lastAcceptancePath?: string };
    assert.equal(acceptedRetry.lastAcceptancePath, acceptance.acceptanceReport.outputPath);
    const runReport = await renderRunReport(loaded, pkg);
    assert.match(runReport, /## Next Action/);
    assert.match(runReport, /Recent Repair Acceptances/);
    assert.match(runReport, /repair:accepted/);
    assert.match(runReport, /replan-brief/);
    assert.match(runReport, /behavior-drift:2/);
    const manualIssue: MigrationIssue = {
      id: "issue-manual-live-create",
      runId: pkg.run.id,
      type: "task",
      title: "Manual live create coverage",
      body: "Covers the GitHub create branch in live sync tests.",
      status: "ready",
      risk: "low",
      owner: "engine",
      affectedFiles: [],
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z"
    };
    pkg.issues.push(manualIssue);
    const issueSyncPath = await syncIssues(loaded, pkg, "local");
    const exportedIssues = JSON.parse(await readFile(issueSyncPath, "utf8")) as Array<{
      body: string;
      migrationGuard?: {
        gate?: { proposalId: string; firstFailedCheck?: { failureCategory?: string; remediationHints?: string[] } };
        batch?: { stopReason?: string; nextCommand?: string; skippedProposals?: string[] };
      };
    }>;
    const failureIssue = exportedIssues.find((issue) => issue.migrationGuard?.gate?.proposalId === "patch-a-fail");
    assert.ok(failureIssue);
    assert.match(failureIssue.body, /Proposal gate context/);
    assert.match(failureIssue.body, /Proposal batch context/);
    assert.match(failureIssue.body, /Behavior drift: 2 check\/probe difference/);
    assert.equal(failureIssue.migrationGuard?.gate?.firstFailedCheck?.failureCategory, "command-failed");
    assert.ok(failureIssue.migrationGuard?.gate?.firstFailedCheck?.remediationHints?.some((hint) => hint.includes("stdout/stderr")));
    assert.match(failureIssue.migrationGuard?.batch?.stopReason ?? "", /patch-a-fail/);
    assert.equal(failureIssue.migrationGuard?.batch?.skippedProposals?.[0], "patch-b-skip");
    assert.match(failureIssue.migrationGuard?.batch?.nextCommand ?? "", /proposal replan/);
    const githubDryRunPath = await syncIssues(loaded, pkg, "github", { dryRun: true });
    assert.match(githubDryRunPath, /github-dry-run-issues\.json$/);
    const issueSyncDir = path.dirname(githubDryRunPath);
    const singleDryRunPath = await syncIssues(loaded, pkg, "github", {
      dryRun: true,
      onlyIssue: manualIssue.id
    });
    const singleDryRun = JSON.parse(await readFile(singleDryRunPath, "utf8")) as Array<{ migrationGuard?: { issueId?: string } }>;
    assert.equal(singleDryRun.length, 1);
    assert.equal(singleDryRun[0]?.migrationGuard?.issueId, manualIssue.id);
    await assert.rejects(syncIssues(loaded, pkg, "github", { dryRun: true, onlyIssue: "issue-missing" }), /Issue not found/);
    const mapping = JSON.parse(await readFile(path.join(issueSyncDir, "github-dry-run-mapping.json"), "utf8")) as { tokenEnv?: string; fields?: { title?: string } };
    assert.equal(mapping.tokenEnv, "GITHUB_TOKEN");
    assert.equal(mapping.fields?.title, "title");
    const prComment = await readFile(path.join(issueSyncDir, "github-pr-comment.md"), "utf8");
    assert.match(prComment, /Migration Guard/);
    assert.match(prComment, /patch-a-fail/);
    assert.match(prComment, /Next command/);
    await assert.rejects(syncIssues(loaded, pkg, "github"), /Live github issue sync is not implemented|--dry-run/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true }), /--live-confirm/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, liveConfirm: pkg.run.id }), /--repo owner\/name/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, repo: "owner/repo", token: "secret-token" }), /--live-confirm/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, repo: "owner/repo", token: "secret-token", liveConfirm: "wrong-run" }), /confirmation mismatch/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, repo: "bad-repo", liveConfirm: pkg.run.id }), /Invalid GitHub repo/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, repo: "owner/repo", token: "", liveConfirm: pkg.run.id }), /GITHUB_TOKEN/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, repo: "owner/repo", token: "secret-token", liveConfirm: pkg.run.id }), /--live-plan-confirm/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { live: true, dryRun: true, repo: "owner/repo", token: "token", liveConfirm: pkg.run.id }), /cannot be used together/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { livePlan: true }), /--repo owner\/name/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { livePlan: true, repo: "owner/repo", token: "" }), /GITHUB_TOKEN/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { livePlan: true, dryRun: true, repo: "owner/repo", token: "token" }), /cannot be used together/);
    await assert.rejects(syncIssues(loaded, pkg, "github", { livePlan: true, live: true, repo: "owner/repo", token: "token", liveConfirm: pkg.run.id }), /cannot be used together/);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("?state=open")) {
        const liveExport = JSON.parse(await readFile(path.join(issueSyncDir, "github-issues.json"), "utf8")) as Array<{ body: string }>;
        return new Response(JSON.stringify([{
          number: 98,
          html_url: "https://github.com/owner/repo/issues/98",
          body: liveExport[0]?.body
        }, {
          number: 99,
          html_url: "https://github.com/owner/repo/issues/99",
          body: `${liveExport[1]?.body ?? ""}\nchanged on GitHub\n`
        }]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": "1783312000",
            "x-ratelimit-used": "1",
            "x-ratelimit-resource": "core"
          }
        });
      }
      return new Response(JSON.stringify({
        html_url: `https://github.com/owner/repo/issues/${requests.length}`,
        number: requests.length
      }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1783312000",
          "x-ratelimit-used": "2",
          "x-ratelimit-resource": "core"
        }
      });
    };
    const confirmPlanRequests: Array<{ url: string; init?: RequestInit }> = [];
    const confirmPlanMockFetch: typeof fetch = async (input, init) => {
      confirmPlanRequests.push({ url: String(input), init });
      if (!String(input).includes("?state=open")) {
        throw new Error("live-plan confirmation must not create or update issues");
      }
      const planExport = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-issues.json"), "utf8")) as Array<{ body: string }>;
      return new Response(JSON.stringify([{
        number: 98,
        html_url: "https://github.com/owner/repo/issues/98",
        body: planExport[0]?.body
      }, {
        number: 99,
        html_url: "https://github.com/owner/repo/issues/99",
        body: `${planExport[1]?.body ?? ""}\nchanged on GitHub\n`
      }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const confirmPlanOutput = await syncIssues(loaded, pkg, "github", {
      livePlan: true,
      repo: "owner/repo",
      token: "secret-token",
      fetchImpl: confirmPlanMockFetch
    });
    assert.match(confirmPlanOutput, /github-live-plan-issues\.json$/);
    assert.equal(confirmPlanRequests.length, 1);
    const confirmPlan = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan.json"), "utf8")) as { planHash?: string; mutationCount?: number };
    assert.equal(confirmPlan.mutationCount, 2);
    assert.match(confirmPlan.planHash ?? "", /^[a-f0-9]{64}$/);
    const confirmPlanSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-summary.json"), "utf8")) as { planHash?: string };
    assert.equal(confirmPlanSummary.planHash, confirmPlan.planHash);
    const mismatchRequests: Array<{ url: string; init?: RequestInit }> = [];
    const mismatchMockFetch: typeof fetch = async (input, init) => {
      mismatchRequests.push({ url: String(input), init });
      if (!String(input).includes("?state=open")) {
        throw new Error("mutation should not run when plan confirmation mismatches");
      }
      const planExport = JSON.parse(await readFile(path.join(issueSyncDir, "github-issues.json"), "utf8")) as Array<{ body: string }>;
      return new Response(JSON.stringify([{
        number: 98,
        html_url: "https://github.com/owner/repo/issues/98",
        body: planExport[0]?.body
      }, {
        number: 99,
        html_url: "https://github.com/owner/repo/issues/99",
        body: `${planExport[1]?.body ?? ""}\nchanged on GitHub\n`
      }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    await assert.rejects(syncIssues(loaded, pkg, "github", {
      live: true,
      repo: "owner/repo",
      token: "secret-token",
      liveConfirm: pkg.run.id,
      livePlanConfirm: "0".repeat(64),
      fetchImpl: mismatchMockFetch
    }), /plan confirmation mismatch/);
    assert.equal(mismatchRequests.length, 1);
    const livePath = await syncIssues(loaded, pkg, "github", {
      live: true,
      repo: "owner/repo",
      token: "secret-token",
      liveConfirm: pkg.run.id,
      livePlanConfirm: confirmPlan.planHash,
      labels: ["team:migration", "migration-guard"],
      fetchImpl: mockFetch
    });
    assert.match(livePath, /github-issues\.json$/);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.url, "https://api.github.com/repos/owner/repo/issues?state=open&per_page=100");
    assert.equal((requests[0]?.init?.headers as Record<string, string>)?.authorization, "Bearer secret-token");
    assert.equal(requests[1]?.url, "https://api.github.com/repos/owner/repo/issues/99");
    assert.equal(requests[1]?.init?.method, "PATCH");
    assert.equal(requests[2]?.init?.method, "POST");
    const firstPayload = JSON.parse(String(requests[1]?.init?.body)) as { title: string; body: string; labels: string[] };
    assert.ok(firstPayload.title);
    assert.ok(Array.isArray(firstPayload.labels));
    assert.ok(firstPayload.labels.includes("team:migration"));
    assert.equal(firstPayload.labels.filter((label) => label === "migration-guard").length, 1);
    assert.doesNotMatch(await readFile(path.join(issueSyncDir, "github-live-sync.json"), "utf8"), /secret-token/);
    assert.doesNotMatch(await readFile(path.join(issueSyncDir, "github-live-plan.json"), "utf8"), /secret-token/);
    const livePlan = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan.json"), "utf8")) as { repo: string; willCreate: number; willUpdate: number; willSkip: number; mutationCount: number; planHash?: string; maxLiveMutations?: number; issues: Array<{ action?: string; bodyHash?: string; existingNumber?: number }> };
    assert.equal(livePlan.repo, "owner/repo");
    assert.equal(livePlan.willCreate, 1);
    assert.equal(livePlan.willUpdate, 1);
    assert.equal(livePlan.willSkip, 1);
    assert.equal(livePlan.mutationCount, 2);
    assert.equal(livePlan.planHash, confirmPlan.planHash);
    assert.equal(livePlan.maxLiveMutations, 3);
    assert.equal(livePlan.issues[0]?.action, "skip");
    assert.equal(livePlan.issues[0]?.existingNumber, 98);
    assert.equal(livePlan.issues[1]?.action, "update");
    assert.equal(livePlan.issues[2]?.action, "create");
    assert.ok(livePlan.issues.every((issue) => typeof issue.bodyHash === "string" && issue.bodyHash.length === 64));
    const liveSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-sync.json"), "utf8")) as { repo: string; createdCount: number; updatedCount: number; skippedCount: number; failedCount: number; planPath?: string; planHash?: string; livePlanConfirm?: string; rateLimit?: Array<{ request?: string; remaining?: number }>; issues: Array<{ url?: string; action?: string }> };
    assert.equal(liveSummary.repo, "owner/repo");
    assert.equal(liveSummary.createdCount, 1);
    assert.equal(liveSummary.updatedCount, 1);
    assert.equal(liveSummary.skippedCount, 1);
    assert.equal(liveSummary.failedCount, 0);
    assert.match(liveSummary.planPath ?? "", /github-live-plan\.json$/);
    assert.equal(liveSummary.planHash, confirmPlan.planHash);
    assert.equal(liveSummary.livePlanConfirm, confirmPlan.planHash);
    assert.equal(liveSummary.issues[0]?.action, "skipped");
    assert.equal(liveSummary.issues[1]?.action, "updated");
    assert.equal(liveSummary.issues[2]?.action, "created");
    assert.match(liveSummary.issues[1]?.url ?? "", /https:\/\/github\.com\/owner\/repo\/issues\//);
    assert.equal(liveSummary.rateLimit?.[0]?.request, "GET open issues");
    assert.equal(liveSummary.rateLimit?.[0]?.remaining, 4999);
    const limitRequests: Array<{ url: string; init?: RequestInit }> = [];
    const limitMockFetch: typeof fetch = async (input, init) => {
      limitRequests.push({ url: String(input), init });
      if (!String(input).includes("?state=open")) {
        throw new Error("mutation should not run when max-live-mutations is exceeded");
      }
      const liveExport = JSON.parse(await readFile(path.join(issueSyncDir, "github-issues.json"), "utf8")) as Array<{ body: string }>;
      return new Response(JSON.stringify([{
        number: 98,
        html_url: "https://github.com/owner/repo/issues/98",
        body: liveExport[0]?.body
      }, {
        number: 99,
        html_url: "https://github.com/owner/repo/issues/99",
        body: `${liveExport[1]?.body ?? ""}\nchanged on GitHub\n`
      }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    await assert.rejects(syncIssues(loaded, pkg, "github", {
      live: true,
      repo: "owner/repo",
      token: "secret-token",
      liveConfirm: pkg.run.id,
      livePlanConfirm: confirmPlan.planHash,
      maxLiveMutations: 0,
      fetchImpl: limitMockFetch
    }), /mutation limit exceeded/);
    assert.equal(limitRequests.length, 1);
    const limitedPlan = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan.json"), "utf8")) as { maxLiveMutations?: number; mutationCount: number };
    assert.equal(limitedPlan.maxLiveMutations, 0);
    assert.equal(limitedPlan.mutationCount, 2);
    const livePlanRequests: Array<{ url: string; init?: RequestInit }> = [];
    const livePlanMockFetch: typeof fetch = async (input, init) => {
      livePlanRequests.push({ url: String(input), init });
      if (!String(input).includes("?state=open")) {
        throw new Error("live-plan must not create or update issues");
      }
      const planExport = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-issues.json"), "utf8")) as Array<{ body: string }>;
      return new Response(JSON.stringify([{
        number: 98,
        html_url: "https://github.com/owner/repo/issues/98",
        body: planExport[0]?.body
      }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4997"
        }
      });
    };
    const livePlanOutput = await syncIssues(loaded, pkg, "github", {
      livePlan: true,
      repo: "owner/repo",
      token: "secret-token",
      labels: ["team:plan"],
      fetchImpl: livePlanMockFetch
    });
    assert.match(livePlanOutput, /github-live-plan-issues\.json$/);
    assert.equal(livePlanRequests.length, 1);
    const livePlanExport = JSON.parse(await readFile(livePlanOutput, "utf8")) as Array<{ labels?: string[] }>;
    assert.ok(livePlanExport[0]?.labels?.includes("team:plan"));
    const livePlanSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-summary.json"), "utf8")) as { mutationCount: number; planHash?: string; rateLimit?: Array<{ remaining?: number }> };
    assert.equal(livePlanSummary.mutationCount, pkg.issues.length - 1);
    assert.match(livePlanSummary.planHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(livePlanSummary.rateLimit?.[0]?.remaining, 4997);
    const singlePlanRequests: Array<{ url: string; init?: RequestInit }> = [];
    const singlePlanMockFetch: typeof fetch = async (input, init) => {
      singlePlanRequests.push({ url: String(input), init });
      if (!String(input).includes("?state=open")) {
        throw new Error("single issue live-plan must not create or update issues");
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const singlePlanPath = await syncIssues(loaded, pkg, "github", {
      livePlan: true,
      repo: "owner/repo",
      token: "secret-token",
      onlyIssue: manualIssue.id,
      fetchImpl: singlePlanMockFetch
    });
    assert.match(singlePlanPath, /github-live-plan-issues\.json$/);
    assert.equal(singlePlanRequests.length, 1);
    const singlePlanExport = JSON.parse(await readFile(singlePlanPath, "utf8")) as Array<{ migrationGuard?: { issueId?: string } }>;
    assert.equal(singlePlanExport.length, 1);
    assert.equal(singlePlanExport[0]?.migrationGuard?.issueId, manualIssue.id);
    const singlePlanSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-summary.json"), "utf8")) as { mutationCount: number; willCreate: number; willUpdate: number; willSkip: number; planHash?: string };
    assert.equal(singlePlanSummary.mutationCount, 1);
    assert.equal(singlePlanSummary.willCreate, 1);
    assert.equal(singlePlanSummary.willUpdate, 0);
    assert.equal(singlePlanSummary.willSkip, 0);
    assert.match(singlePlanSummary.planHash ?? "", /^[a-f0-9]{64}$/);
    const singleLiveRequests: Array<{ url: string; init?: RequestInit }> = [];
    const singleLiveMockFetch: typeof fetch = async (input, init) => {
      singleLiveRequests.push({ url: String(input), init });
      if (String(input).includes("?state=open")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        html_url: "https://github.com/owner/repo/issues/123",
        number: 123
      }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    };
    const singleLivePath = await syncIssues(loaded, pkg, "github", {
      live: true,
      repo: "owner/repo",
      token: "secret-token",
      liveConfirm: pkg.run.id,
      livePlanConfirm: singlePlanSummary.planHash,
      maxLiveMutations: 1,
      onlyIssue: manualIssue.id,
      fetchImpl: singleLiveMockFetch
    });
    assert.match(singleLivePath, /github-issues\.json$/);
    assert.equal(singleLiveRequests.length, 2);
    assert.equal(singleLiveRequests[0]?.init?.method, "GET");
    assert.equal(singleLiveRequests[1]?.init?.method, "POST");
    const singleLiveSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-sync.json"), "utf8")) as { createdCount: number; updatedCount: number; skippedCount: number; failedCount: number; issues: Array<{ action?: string }> };
    assert.equal(singleLiveSummary.createdCount, 1);
    assert.equal(singleLiveSummary.updatedCount, 0);
    assert.equal(singleLiveSummary.skippedCount, 0);
    assert.equal(singleLiveSummary.failedCount, 0);
    assert.equal(singleLiveSummary.issues.length, 1);
    assert.equal(singleLiveSummary.issues[0]?.action, "created");
    assert.match(pkg.issues.find((issue) => issue.id === manualIssue.id)?.externalUrl ?? "", /issues\/123/);
    const ciHandoffPath = await writeCiHandoffReport(loaded, pkg);
    const ciHandoff = await readFile(ciHandoffPath, "utf8");
    assert.match(ciHandoff, /Latest failed batch/);
    assert.match(ciHandoff, /Next command: migration-guard proposal replan/);
    const stepSummary = await readFile(path.join(path.dirname(ciHandoffPath), "github-step-summary.md"), "utf8");
    assert.match(stepSummary, /Migration Guard CI Summary/);
    assert.match(stepSummary, /Skipped proposals: patch-b-skip/);
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "a-fail.mjs")));
    await assert.rejects(access(path.join(dir, "scripts", "migration-guard", "b-skip.mjs")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub issue adapter retries transient mutation failures", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("?state=open")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999"
        }
      });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({ message: "temporary failure" }), {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4998"
        }
      });
    }
    return new Response(JSON.stringify({
      html_url: "https://github.com/owner/repo/issues/1",
      number: 1
    }), {
      status: 201,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4997"
      }
    });
  };

  const result = await createGitHubIssues({
    repo: "owner/repo",
    token: "secret-token",
    issues: [{
      title: "Retry me",
      body: "---\nmg_issue_id: issue-retry\n---\n\nbody\n",
      labels: ["migration-guard"]
    }],
    retry: {
      maxAttempts: 2,
      delayMs: 1
    },
    fetchImpl: mockFetch
  });

  assert.equal(requests.length, 3);
  assert.equal(result.createdCount, 1);
  assert.equal(result.issues[0]?.action, "created");
  assert.equal(result.issues[0]?.attemptCount, 2);
  assert.deepEqual(result.rateLimit.map((item) => item.status), [200, 502, 201]);
  assert.equal(result.rateLimit.at(-1)?.remaining, 4997);
});

test("configured proposal gate policy and retry defaults are used when CLI options are absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-configured-gate-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    loaded.config.proposalGate.defaultPolicy = "fail-fast";
    loaded.config.proposalGate.retry = {
      "unit-test": {
        maxAttempts: 3,
        delayMs: 1,
        retryOn: ["flake-suspected"]
      }
    };
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-configured");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const generatedFile = "scripts/migration-guard/configured-probe.mjs";
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-configured",
      runId: pkg.run.id,
      createdAt: "2026-07-06T00:00:00.000Z",
      title: "Add configured probe",
      summary: "Asserts config-driven gate defaults.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: [generatedFile],
      recommendedChecks: [
        `node ${generatedFile} fail`,
        `node ${generatedFile} marker`
      ],
      checkPlan: [
        {
          command: `node ${generatedFile} fail`,
          kind: "unit-test",
          phase: "pre-preview",
          critical: true
        },
        {
          command: `node ${generatedFile} marker`,
          kind: "unit-test",
          phase: "pre-preview",
          critical: true
        }
      ],
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch(generatedFile, [
      "import { writeFileSync } from \"node:fs\";",
      "if (process.argv[2] === \"marker\") {",
      "  writeFileSync(\"configured-second-check-ran.txt\", \"1\", \"utf8\");",
      "  process.exit(0);",
      "}",
      "console.error(\"Error: [vitest-pool]: Failed to start forks worker\");",
      "process.exit(1);",
      ""
    ].join("\n")), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    await assert.rejects(
      applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true }),
      /verification failed/
    );
    const failedReportPath = (await readProposal(proposalPath)).lastVerificationPath;
    assert.ok(failedReportPath);
    const report = await readVerificationReport(failedReportPath);
    assert.equal(report.gatePolicy?.mode, "fail-fast");
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.retry?.maxAttempts, 3);
    assert.equal(report.checks[0]?.attemptCount, 3);
    assert.equal(report.checks[0]?.failureCategory, "flake-suspected");
    await assert.rejects(access(path.join(dir, "configured-second-check-ran.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyProposedPatch manages preview server for proposal checks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-managed-preview-"));
  const port = 19000 + Math.floor(Math.random() * 20000);

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", "patch-preview");
    const patchPath = path.join(proposalDir, "patch.diff");
    const proposalPath = path.join(proposalDir, "proposal.json");
    const proposal: ProposedPatch = {
      version: 1,
      id: "patch-preview",
      runId: pkg.run.id,
      createdAt: "2026-07-05T00:00:00.000Z",
      title: "Add preview probe",
      summary: "Adds a probe script that needs a managed preview URL.",
      risk: "low",
      patchPath,
      affectedFiles: [],
      generatedFiles: ["scripts/migration-guard/preview-probe.mjs"],
      recommendedChecks: ["node scripts/migration-guard/preview-probe.mjs"],
      preview: {
        command: `node preview-server.mjs ${port}`,
        url: `http://127.0.0.1:${port}/`,
        timeoutMs: 30000
      },
      patchKind: "action-probe",
      applyState: "proposed"
    };

    await writeFile(path.join(dir, "preview-server.mjs"), [
      "import http from \"node:http\";",
      "const port = Number(process.argv[2]);",
      "const server = http.createServer((_request, response) => {",
      "  response.writeHead(200, { \"content-type\": \"text/plain\" });",
      "  response.end(\"preview-ready\");",
      "});",
      "server.listen(port, \"127.0.0.1\");",
      ""
    ].join("\n"), "utf8");
    await mkdir(proposalDir, { recursive: true });
    await writeFile(patchPath, createAddFilePatch("scripts/migration-guard/preview-probe.mjs", [
      `const expectedUrl = "http://127.0.0.1:${port}/";`,
      "if (process.env.MG_PREVIEW_URL !== expectedUrl) {",
      "  console.error(`unexpected preview url: ${process.env.MG_PREVIEW_URL}`);",
      "  process.exit(1);",
      "}",
      "const response = await fetch(expectedUrl);",
      "const body = await response.text();",
      "if (!response.ok || body !== \"preview-ready\") {",
      "  console.error(`unexpected preview response: ${response.status} ${body}`);",
      "  process.exit(1);",
      "}",
      "console.log(\"preview-ok\");",
      ""
    ].join("\n")), "utf8");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    const report = apply.report;
    assert.ok(report);
    assert.equal(report.passed, true);
    assert.equal(report.preview?.ready, true);
    assert.equal(report.preview?.stopped, true);
    assert.ok(report.preview?.outputPath);
    await access(report.preview.outputPath);
    assert.equal(report.checkPlan?.[0]?.kind, "ui-probe");
    assert.equal(report.checkPlan?.[0]?.phase, "preview");
    assert.equal(report.timeline.some((event) => event.type === "preview" && event.status === "passed"), true);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.kind, "ui-probe");
    assert.equal(report.checks[0]?.phase, "preview");
    assert.match(report.checks[0]?.stdout ?? "", /preview-ok/);
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
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "", "utf8");
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify({
      scripts: {
        web: "pnpm --filter @md/web"
      }
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(dir, "apps", "web", "vite.config.ts"), "const base = isNetlify ? `/` : `/docs/`\nexport default { base }\n", "utf8");
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
    assert.deepEqual(proposal.checkPlan?.map((check) => `${check.kind}/${check.phase}`), [
      "type-check/pre-preview",
      "ui-probe/preview"
    ]);
    assert.equal(proposal.preview?.command, "pnpm web dev --host 127.0.0.1");
    assert.equal(proposal.preview?.url, "http://127.0.0.1:5173/docs/");
    assert.match(patch, /await import\("playwright"\)/);
    assert.match(patch, /MG_PREVIEW_URL/);
    assert.match(patch, /tmpdir\(\), "migration-guard-ui-probes"/);
    assert.match(patch, /runFetchProbe/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposeActionPatch generated probes can inspect affected directories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-directory-probe-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    const sourceDir = path.join(dir, "packages", "mcp-server", "src");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(actionPlanDir, { recursive: true });
    await writeFile(path.join(sourceDir, "index.ts"), "export function renderMarkdown(value: string) {\n  return value;\n}\n", "utf8");
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-mcp-render",
          title: "Guard MCP renderer",
          summary: "Add directory-backed renderer probe.",
          risk: "medium",
          affectedFiles: ["packages/mcp-server/src"],
          recommendedChecks: [],
          patchMode: "dry-run-only",
          patchTemplate: "renderer-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    const proposal = await proposeActionPatch(loaded, pkg, "action-mcp-render");
    const patch = await readFile(proposal.patchPath, "utf8");
    assert.match(patch, /collectReadableFiles/);

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    assert.equal(apply.report?.passed, true);
    assert.match(apply.report?.checks[0]?.stdout ?? "", /packages\/mcp-server\/src\/index\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ui smoke probes allow TypeScript support directories alongside Vue directories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-mixed-probe-"));

  try {
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    await mkdir(actionPlanDir, { recursive: true });
    await mkdir(path.join(dir, "apps", "web", "src", "components", "editor"), { recursive: true });
    await mkdir(path.join(dir, "apps", "web", "src", "composables"), { recursive: true });
    await mkdir(path.join(dir, "apps", "web", "src", "lib", "markdown"), { recursive: true });
    await writeFile(path.join(dir, "apps", "web", "src", "components", "editor", "EditorPanel.vue"), "<template><main /></template>\n<script setup></script>\n", "utf8");
    await writeFile(path.join(dir, "apps", "web", "src", "composables", "useEditorDocumentActions.ts"), "export function useEditorDocumentActions() {\n  return {};\n}\n", "utf8");
    await writeFile(path.join(dir, "apps", "web", "src", "lib", "markdown", "headings.ts"), "export const headingLevels = [1, 2, 3];\n", "utf8");
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-08T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-md-web-editor-shell",
          title: "Guard mixed web editor shell",
          summary: "Add UI probe over Vue and TS support directories.",
          risk: "high",
          affectedFiles: [
            "apps/web/src/components/editor",
            "apps/web/src/composables",
            "apps/web/src/lib/markdown"
          ],
          recommendedChecks: [],
          patchMode: "manual-approval-required",
          patchTemplate: "ui-smoke-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    const proposal = await proposeActionPatch(loaded, pkg, "action-md-web-editor-shell");
    const patch = await readFile(proposal.patchPath, "utf8");

    assert.match(patch, /checkMode: vueFiles\.length > 0 \? "vue-sfc" : "ts-support"/);
    assert.match(patch, /missing-module-signal/);
    assert.match(patch, /missing-structure-signal/);
    assert.match(patch, /missing-template/);
    assert.match(patch, /missing-script/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposeActionPatch uses TS structural probes for shared package actions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-shared-probe-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    const sharedDirs = [
      "packages/shared/src/configs",
      "packages/shared/src/types",
      "packages/shared/src/editor",
      "packages/shared/src/utils"
    ];
    await mkdir(actionPlanDir, { recursive: true });
    for (const sharedDir of sharedDirs) {
      await mkdir(path.join(dir, sharedDir), { recursive: true });
    }
    await writeFile(path.join(dir, "packages/shared/src/configs/index.ts"), "export const sharedConfig = { theme: \"default\" };\n", "utf8");
    await writeFile(path.join(dir, "packages/shared/src/types/index.ts"), "export interface SharedDoc { id: string }\n", "utf8");
    await writeFile(path.join(dir, "packages/shared/src/editor/index.ts"), "export function createEditorState() { return {}; }\n", "utf8");
    await writeFile(path.join(dir, "packages/shared/src/utils/index.ts"), "export type SharedValue = string;\n", "utf8");
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-md-shared-contracts",
          title: "Guard shared contracts",
          summary: "Add TS structural probe for shared contracts.",
          risk: "medium",
          affectedFiles: sharedDirs,
          recommendedChecks: [],
          patchMode: "dry-run-only",
          patchTemplate: "ts-structural-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    const proposal = await proposeActionPatch(loaded, pkg, "action-md-shared-contracts");
    const patch = await readFile(proposal.patchPath, "utf8");
    assert.equal(proposal.templateSelection?.template, "ts-structural-probe");
    assert.match(patch, /ts-structural-probe/);
    assert.doesNotMatch(patch, /missing-template/);
    assert.doesNotMatch(patch, /missing-script/);

    const apply = await applyProposedPatch(loaded, pkg, proposal.id, { runChecks: true });
    assert.equal(apply.report?.passed, true);
    assert.match(apply.report?.checks[0]?.stdout ?? "", /has-typescript-module-signal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run status and report surface action check readiness risks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-readiness-report-"));

  try {
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    await mkdir(actionPlanDir, { recursive: true });
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-safe",
          title: "Safe action",
          summary: "Has a ready command.",
          risk: "low",
          affectedFiles: ["apps/web/src/App.vue"],
          recommendedChecks: ["pnpm type-check"],
          checkReadiness: [
            {
              command: "pnpm type-check",
              status: "ready",
              reason: "root package has script type-check"
            }
          ],
          patchMode: "dry-run-only",
          patchTemplate: "ui-smoke-probe"
        },
        {
          id: "action-no-op-risk",
          title: "No-op risk action",
          summary: "Has a known no-op command.",
          risk: "medium",
          affectedFiles: ["packages/mcp-server/src"],
          recommendedChecks: [
            "pnpm --filter @md/mcp-server type-check",
            "node scripts/migration-guard/unknown.mjs"
          ],
          checkReadiness: [
            {
              command: "pnpm --filter @md/mcp-server type-check",
              status: "no-op-risk",
              reason: "package @md/mcp-server has no script type-check"
            },
            {
              command: "node scripts/migration-guard/unknown.mjs",
              status: "unknown",
              reason: "static readiness could not classify this command"
            }
          ],
          patchMode: "dry-run-only",
          patchTemplate: "renderer-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    const next = await resolveRunNextAction(loaded, pkg);
    assert.match(next.action, /Fix no-op-risk action checks/);
    assert.equal(next.command, "migration-guard actions --run latest");
    assert.equal(next.actionCheckReadiness?.noOpRiskCount, 1);

    const status = renderRunStatus(pkg, next);
    assert.match(status, /Action check readiness: actions:2 checks:3 tracked:3 ready:1 no-op-risk:1 unknown:1/);
    assert.match(status, /Action check handoff: .*action-check-readiness-handoff\.md/);
    assert.match(status, /Action check risk: action-no-op-risk pnpm --filter @md\/mcp-server type-check/);

    const report = await renderRunReport(loaded, pkg);
    assert.match(report, /## Action Check Readiness/);
    assert.match(report, /Handoff JSON: .*action-check-readiness-handoff\.json/);
    assert.match(report, /Handoff Markdown: .*action-check-readiness-handoff\.md/);
    assert.match(report, /Status counts: ready:1, no-op-risk:1, unknown:1/);
    assert.match(report, /package @md\/mcp-server has no script type-check/);
    assert.match(report, /Unknown checks:/);

    await writeRunReport(loaded, pkg);
    const handoffJsonPath = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "reports", "action-check-readiness-handoff.json");
    const handoffMarkdownPath = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "reports", "action-check-readiness-handoff.md");
    const handoff = JSON.parse(await readFile(handoffJsonPath, "utf8")) as {
      blockedBeforeProposal?: boolean;
      summary?: { attentionItemCount?: number; noOpRiskCount?: number; unknownCount?: number; replanTaskCount?: number };
      items?: Array<{ status?: string; command?: string; recommendedAction?: string }>;
    };
    const handoffMarkdown = await readFile(handoffMarkdownPath, "utf8");
    assert.equal(handoff.blockedBeforeProposal, true);
    assert.equal(handoff.summary?.attentionItemCount, 2);
    assert.equal(handoff.summary?.noOpRiskCount, 1);
    assert.equal(handoff.summary?.unknownCount, 1);
    assert.equal(handoff.summary?.replanTaskCount, 0);
    assert.ok(handoff.items?.some((item) => item.status === "no-op-risk" && item.command === "pnpm --filter @md/mcp-server type-check"));
    assert.ok(handoff.items?.some((item) => item.status === "unknown" && item.recommendedAction?.includes("Inspect the command manually")));
    assert.match(handoffMarkdown, /# Action Check Readiness Handoff/);
    assert.match(handoffMarkdown, /Fix no-op-risk recommended checks/);

    await writeFile(loaded.path, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
    await rm(handoffJsonPath, { force: true });
    await rm(handoffMarkdownPath, { force: true });
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("dist", "cli.js"),
      "actions",
      "handoff",
      "--config",
      loaded.path,
      "--run",
      pkg.run.id,
      "--create-replans",
      "--repair-briefs",
      "--json"
    ]);
    const cliHandoff = JSON.parse(stdout) as {
      blockedBeforeProposal?: boolean;
      jsonPath?: string;
      markdownPath?: string;
      summary?: { attentionItemCount?: number; replanTaskCount?: number; repairBriefCount?: number };
      items?: Array<{ status?: string; taskId?: string; issueId?: string; affectedFiles?: string[]; repairBriefPath?: string; repairContextPath?: string }>;
    };
    const taskGraph = JSON.parse(await readFile(path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "task-graph.json"), "utf8")) as MigrationTaskGraph;
    const issues = JSON.parse(await readFile(path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "issues.json"), "utf8")) as MigrationIssue[];
    const readinessTasks = taskGraph.tasks.filter((task) => task.id.startsWith("task-readiness-replan-"));
    const readinessIssues = issues.filter((issue) => issue.taskId?.startsWith("task-readiness-replan-"));
    assert.equal(cliHandoff.blockedBeforeProposal, true);
    assert.equal(cliHandoff.summary?.attentionItemCount, 2);
    assert.equal(cliHandoff.summary?.replanTaskCount, 2);
    assert.equal(cliHandoff.summary?.repairBriefCount, 2);
    assert.equal(cliHandoff.jsonPath, handoffJsonPath);
    assert.equal(cliHandoff.markdownPath, handoffMarkdownPath);
    assert.equal(readinessTasks.length, 2);
    assert.equal(readinessIssues.length, 2);
    assert.ok(cliHandoff.items?.every((item) => item.taskId && item.issueId));
    assert.ok(cliHandoff.items?.every((item) => item.affectedFiles?.includes("packages/mcp-server/src")));
    assert.ok(cliHandoff.items?.every((item) => item.repairBriefPath && item.repairContextPath));
    assert.ok(readinessTasks.every((task) => task.type === "replan" && task.status === "ready"));
    assert.ok(readinessTasks.every((task) => task.issueId && issues.some((issue) => issue.id === task.issueId)));
    const firstBriefPath = cliHandoff.items?.[0]?.repairBriefPath ?? "";
    const firstContextPath = cliHandoff.items?.[0]?.repairContextPath ?? "";
    const firstBrief = await readFile(firstBriefPath, "utf8");
    const firstContext = JSON.parse(await readFile(firstContextPath, "utf8")) as {
      item?: { taskId?: string; issueId?: string; status?: string };
      commands?: { refreshHandoff?: string; proposeAction?: string };
      paths?: { brief?: string; context?: string };
    };
    assert.match(firstBrief, /# Readiness Repair Brief:/);
    assert.match(firstBrief, /Do not use `--allow-no-op-risk` as the default repair/);
    assert.match(firstBrief, /migration-guard actions handoff --run latest --create-replans --repair-briefs --json/);
    assert.equal(firstContext.item?.taskId, cliHandoff.items?.[0]?.taskId);
    assert.equal(firstContext.item?.issueId, cliHandoff.items?.[0]?.issueId);
    assert.match(firstContext.commands?.proposeAction ?? "", /migration-guard action propose/);
    assert.equal(firstContext.paths?.brief, firstBriefPath);
    assert.equal(firstContext.paths?.context, firstContextPath);
    await access(handoffJsonPath);
    await access(handoffMarkdownPath);

    const { stdout: secondStdout } = await execFileAsync(process.execPath, [
      path.resolve("dist", "cli.js"),
      "actions",
      "handoff",
      "--config",
      loaded.path,
      "--run",
      pkg.run.id,
      "--create-replans",
      "--repair-briefs",
      "--json"
    ]);
    const secondHandoff = JSON.parse(secondStdout) as { summary?: { replanTaskCount?: number; repairBriefCount?: number } };
    const secondTaskGraph = JSON.parse(await readFile(path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "task-graph.json"), "utf8")) as MigrationTaskGraph;
    assert.equal(secondHandoff.summary?.replanTaskCount, 2);
    assert.equal(secondHandoff.summary?.repairBriefCount, 2);
    assert.equal(secondTaskGraph.tasks.filter((task) => task.id.startsWith("task-readiness-replan-")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposeActionPatch blocks no-op-risk action checks unless explicitly allowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-no-op-action-"));

  try {
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    const actionPlanDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "adapter");
    await mkdir(actionPlanDir, { recursive: true });
    await writeFile(path.join(actionPlanDir, "pnpm-vite-vue-action-plan.json"), `${JSON.stringify({
      version: 1,
      runId: pkg.run.id,
      createdAt: "2026-07-07T00:00:00.000Z",
      goal: pkg.run.goal,
      actions: [
        {
          id: "action-no-op-risk",
          title: "No-op risk action",
          summary: "Has a known no-op command.",
          risk: "medium",
          affectedFiles: ["packages/mcp-server/src"],
          recommendedChecks: ["pnpm --filter @md/mcp-server type-check"],
          checkReadiness: [
            {
              command: "pnpm --filter @md/mcp-server type-check",
              status: "no-op-risk",
              reason: "package @md/mcp-server has no script type-check"
            }
          ],
          patchMode: "dry-run-only",
          patchTemplate: "renderer-probe"
        }
      ]
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      proposeActionPatch(loaded, pkg, "action-no-op-risk"),
      /no-op-risk recommended check/
    );

    const proposal = await proposeActionPatch(loaded, pkg, "action-no-op-risk", { allowNoOpRisk: true });
    assert.equal(proposal.actionId, "action-no-op-risk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readProposal(proposalPath: string): Promise<ProposedPatch> {
  return JSON.parse(await readFile(proposalPath, "utf8")) as ProposedPatch;
}

async function readVerificationReport(reportPath: string): Promise<ProposalVerificationReport> {
  return JSON.parse(await readFile(reportPath, "utf8")) as ProposalVerificationReport;
}

async function writeBatchProposal(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  id: string,
  risk: ProposedPatch["risk"],
  generatedFile: string,
  content: string,
  affectedFiles: string[] = []
): Promise<void> {
  const proposalDir = path.join(loaded.artifactsDir, "migration-runs", pkg.run.id, "proposals", id);
  const patchPath = path.join(proposalDir, "patch.diff");
  const proposal: ProposedPatch = {
    version: 1,
    id,
    runId: pkg.run.id,
    createdAt: id,
    title: `Batch proposal ${id}`,
    summary: `Adds ${generatedFile}.`,
    risk,
    patchPath,
    affectedFiles,
    generatedFiles: [generatedFile],
    recommendedChecks: [`node ${generatedFile}`],
    patchKind: "action-probe",
    applyState: "proposed"
  };
  await mkdir(proposalDir, { recursive: true });
  await writeFile(patchPath, createAddFilePatch(generatedFile, content), "utf8");
  await writeFile(path.join(proposalDir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
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
      proposalGate: {
        defaultPolicy: "collect-all",
        batchPolicy: "fail-fast",
        retry: {
          "unit-test": {
            maxAttempts: 2,
            delayMs: 1000,
            retryOn: ["flake-suspected"]
          },
          "ui-probe": {
            maxAttempts: 2,
            delayMs: 1000,
            retryOn: ["flake-suspected", "timeout"]
          }
        }
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
