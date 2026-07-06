import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { applyProposalBatch, applyProposedPatch, createAddFilePatch, createProposalBatchPlan, proposeActionPatch, rollbackProposedPatch, verifyProposedPatch } from "./patch.js";
import { syncIssues } from "./issueSync.js";
import { writeCiHandoffReport } from "./migrationRun.js";
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
    assert.equal(apply.report?.checkPlan?.[0]?.kind, "other");
    assert.equal(apply.report?.timeline.length, 2);
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

test("proposal batch apply reports stop reason and skipped proposals after failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-batch-failure-"));

  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    const loaded = makeLoadedConfig(dir);
    const pkg = makeRunPackage(dir);
    await writeBatchProposal(loaded, pkg, "patch-a-fail", "low", "scripts/migration-guard/a-fail.mjs", "console.error(\"a-fail\");\nprocess.exit(1);\n");
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
    assert.equal(failureIssue.migrationGuard?.gate?.firstFailedCheck?.failureCategory, "command-failed");
    assert.ok(failureIssue.migrationGuard?.gate?.firstFailedCheck?.remediationHints?.some((hint) => hint.includes("stdout/stderr")));
    assert.match(failureIssue.migrationGuard?.batch?.stopReason ?? "", /patch-a-fail/);
    assert.equal(failureIssue.migrationGuard?.batch?.skippedProposals?.[0], "patch-b-skip");
    assert.match(failureIssue.migrationGuard?.batch?.nextCommand ?? "", /proposal replan/);
    const githubDryRunPath = await syncIssues(loaded, pkg, "github", { dryRun: true });
    assert.match(githubDryRunPath, /github-dry-run-issues\.json$/);
    const issueSyncDir = path.dirname(githubDryRunPath);
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
    const livePath = await syncIssues(loaded, pkg, "github", {
      live: true,
      repo: "owner/repo",
      token: "secret-token",
      liveConfirm: pkg.run.id,
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
    const livePlan = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan.json"), "utf8")) as { repo: string; willCreate: number; willUpdate: number; willSkip: number; mutationCount: number; maxLiveMutations?: number; issues: Array<{ action?: string; bodyHash?: string; existingNumber?: number }> };
    assert.equal(livePlan.repo, "owner/repo");
    assert.equal(livePlan.willCreate, 1);
    assert.equal(livePlan.willUpdate, 1);
    assert.equal(livePlan.willSkip, 1);
    assert.equal(livePlan.mutationCount, 2);
    assert.equal(livePlan.maxLiveMutations, 3);
    assert.equal(livePlan.issues[0]?.action, "skip");
    assert.equal(livePlan.issues[0]?.existingNumber, 98);
    assert.equal(livePlan.issues[1]?.action, "update");
    assert.equal(livePlan.issues[2]?.action, "create");
    assert.ok(livePlan.issues.every((issue) => typeof issue.bodyHash === "string" && issue.bodyHash.length === 64));
    const liveSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-sync.json"), "utf8")) as { repo: string; createdCount: number; updatedCount: number; skippedCount: number; failedCount: number; planPath?: string; rateLimit?: Array<{ request?: string; remaining?: number }>; issues: Array<{ url?: string; action?: string }> };
    assert.equal(liveSummary.repo, "owner/repo");
    assert.equal(liveSummary.createdCount, 1);
    assert.equal(liveSummary.updatedCount, 1);
    assert.equal(liveSummary.skippedCount, 1);
    assert.equal(liveSummary.failedCount, 0);
    assert.match(liveSummary.planPath ?? "", /github-live-plan\.json$/);
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
    const livePlanSummary = JSON.parse(await readFile(path.join(issueSyncDir, "github-live-plan-summary.json"), "utf8")) as { mutationCount: number; rateLimit?: Array<{ remaining?: number }> };
    assert.equal(livePlanSummary.mutationCount, pkg.issues.length - 1);
    assert.equal(livePlanSummary.rateLimit?.[0]?.remaining, 4997);
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
  content: string
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
    affectedFiles: [],
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
