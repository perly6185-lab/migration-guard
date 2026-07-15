import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { saveRunPackage, type MigrationRunPackage } from "./migrationRun.js";
import { startUiServer } from "./uiServer.js";
import { readUiJob } from "./uiJobStore.js";

test("ui server exposes read-only dashboard data and guarded dry-run actions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }), "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/migration-guard"
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);
    await saveRunPackage(loaded, createUiRunPackage(dir, targetRoot));
    await mkdir(path.join(loaded.artifactsDir, "migration-runs", "run-ui", "verifications"), { recursive: true });
    await writeFile(path.join(loaded.artifactsDir, "migration-runs", "run-ui", "verifications", "run-ui-compare.json"), JSON.stringify({
      id: "compare-run-ui",
      baselineId: "baseline-ui",
      currentId: "current-ui",
      createdAt: "2026-07-12T00:01:00.000Z",
      passed: true,
      differences: [{
        area: "check",
        name: "unit",
        severity: "warn",
        message: "stdout changed while still passing"
      }]
    }), "utf8");
    await mkdir(path.join(loaded.artifactsDir, "compare"), { recursive: true });
    await writeFile(path.join(loaded.artifactsDir, "compare", "global-compare.json"), JSON.stringify({
      id: "compare-global",
      passed: false,
      differences: [{
        area: "probe",
        name: "global",
        severity: "error",
        message: "should not appear in run-scoped diffs"
      }]
    }), "utf8");
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4999"
      }
    });
    const handle = await startUiServer(loaded, { port: 0, fetchImpl });
    try {
      const html = await (await fetch(`${handle.url}/`)).text();
      assert.match(html, /Migration Guard/);
      assert.match(html, /Guarded Actions/);
      assert.match(html, /Run selector/);
      assert.match(html, /Project Workflow/);
      assert.match(html, /Auto advance/);
      assert.match(html, /maybeAutoAdvance/);
      assert.match(html, /Project Portfolio/);
      assert.match(html, /Capture Baseline/);
      assert.match(html, /Create Checkpoint/);
      assert.match(html, /Recovery Center/);
      assert.match(html, /Project History/);
      assert.match(html, /Review plan/);
      assert.match(html, /Task Board/);
      assert.match(html, /data-workflow-task-action/);
      assert.match(html, /data-safe-task/);
      assert.match(html, /Execute task/);
      assert.match(html, /Run Detail/);
      assert.match(html, /Diff status filter/);
      assert.match(html, /issueMaxIterations/);
      assert.match(html, /data-diff-decision/);
      assert.match(html, /data-diff-batch-decision/);
      assert.match(html, /Recent Jobs/);
      assert.match(html, /Job status filter/);
      assert.match(html, /Job run filter/);
      assert.match(html, /Job Detail/);
      assert.match(html, /jobDuration/);
      assert.match(html, /Duration/);
      assert.match(html, /Deliverables/);
      assert.match(html, /data-requires-workspace/);
      assert.match(html, /data-job-retry/);
      assert.match(html, /New refactoring project/);
      assert.match(html, /dialog-close/);
      assert.match(html, /background:#fff/);
      assert.match(html, /Check project/);
      assert.match(html, /workspacePreviewRevision/);
      assert.match(html, /data-work-view="workspace"/);
      assert.match(html, /data-work-view="monitoring"/);
      assert.match(html, /data-stage="execute"/);
      assert.match(html, /Current step/);
      assert.match(html, /Source repository directory/);
      assert.match(html, /Refactored target directory/);
      assert.match(html, /data-job-cancel/);
      assert.match(html, /jobGcPlan/);
      const securityResponse = await fetch(`${handle.url}/`);
      assert.equal(securityResponse.headers.get("x-frame-options"), "DENY");
      assert.match(securityResponse.headers.get("content-security-policy") ?? "", /default-src/);

      const missingCsrf = await fetch(`${handle.url}/api/jobs/actions/readiness`, { method: "POST" });
      assert.equal(missingCsrf.status, 403);
      assert.match(await missingCsrf.text(), /CSRF/);

      const dashboard = await fetchJson<{ runId: string; summary: { readyTaskCount: number } }>(
        `${handle.url}/api/dashboard?run=run-ui`
      );
      assert.equal(dashboard.runId, "run-ui");
      assert.equal(dashboard.summary.readyTaskCount, 1);

      const blockers = await fetchJson<{ runId: string }>(`${handle.url}/api/blockers?run=run-ui`);
      assert.equal(blockers.runId, "run-ui");

      const runs = await fetchJson<{ runCount: number; runs: Array<{ runId: string }> }>(`${handle.url}/api/runs`);
      assert.equal(runs.runCount, 1);
      assert.equal(runs.runs[0]?.runId, "run-ui");

      const portfolio = await fetchJson<{ projects: unknown[] }>(`${handle.url}/api/workspaces/portfolio`);
      assert.deepEqual(portfolio.projects, []);

      const capabilities = await fetchJson<UiActionCapabilities>(`${handle.url}/api/actions/capabilities?run=run-ui`);
      assert.equal(capabilities.runId, "run-ui");
      assert.equal(findAction(capabilities, "readiness").enabled, true);
      assert.equal(findAction(capabilities, "verify").writesArtifacts, true);
      assert.equal(findAction(capabilities, "scan").enabled, true);
      assert.equal(findAction(capabilities, "baseline").enabled, true);
      assert.equal(findAction(capabilities, "checkpoint").enabled, true);
      assert.equal(findAction(capabilities, "issue-control-dry-run").enabled, true);
      assert.equal(findAction(capabilities, "issue-control-dry-run").dryRunOnly, true);

      const diffs = await fetchJson<Array<{ path: string; differenceCount: number; coverage?: { decided: number } }>>(`${handle.url}/api/diffs?run=run-ui`);
      assert.equal(diffs.length, 1);
      assert.match(diffs[0]?.path ?? "", /run-ui-compare\.json$/);
      assert.equal(diffs[0]?.differenceCount, 1);
      assert.equal(diffs[0]?.coverage?.decided, 0);

      const artifactResponse = await fetch(`${handle.url}/api/artifact?path=${encodeURIComponent(diffs[0]?.path ?? "")}`);
      assert.equal(artifactResponse.status, 200);
      assert.match(await artifactResponse.text(), /compare-run-ui/);
      const downloadResponse = await fetch(`${handle.url}/api/artifact?download=1&path=${encodeURIComponent(diffs[0]?.path ?? "")}`);
      assert.match(downloadResponse.headers.get("content-disposition") ?? "", /attachment/);

      const outsideArtifact = await fetch(`${handle.url}/api/artifact?path=${encodeURIComponent(path.join(dir, "package.json"))}`);
      assert.equal(outsideArtifact.status, 403);
      assert.match(await outsideArtifact.text(), /inside artifactsDir/);

      const oversizedArtifactPath = path.join(loaded.artifactsDir, "oversized.txt");
      await writeFile(oversizedArtifactPath, "x".repeat(loaded.config.output.maxOutputBytes + 1), "utf8");
      const oversizedArtifact = await fetch(`${handle.url}/api/artifact?path=${encodeURIComponent(oversizedArtifactPath)}`);
      assert.equal(oversizedArtifact.status, 413);
      assert.match(await oversizedArtifact.text(), /too large/);

      const sensitiveArtifactPath = path.join(loaded.artifactsDir, ".env");
      await writeFile(sensitiveArtifactPath, "TOKEN=secret", "utf8");
      const sensitiveArtifact = await fetch(`${handle.url}/api/artifact?path=${encodeURIComponent(sensitiveArtifactPath)}`);
      assert.equal(sensitiveArtifact.status, 403);
      assert.match(await sensitiveArtifact.text(), /sensitive artifact/);

      const readiness = await postJson<{ status: string }>(`${handle.url}/api/actions/readiness`);
      assert.ok(["go", "hold", "blocked"].includes(readiness.status));

      const missingRunReadiness = await postStatusJson<{ error: string }>(
        `${handle.url}/api/actions/readiness?run=missing-run`
      );
      assert.equal(missingRunReadiness.status, 409);
      assert.match(missingRunReadiness.body.error, /Run is unavailable/);

      const createdJob = await postStatusJson<UiJobCreateResponse>(`${handle.url}/api/jobs/actions/readiness`, {
        run: "run-ui"
      });
      assert.equal(createdJob.status, 202);
      assert.equal(createdJob.body.jobId, createdJob.body.job.id);
      assert.equal(createdJob.body.job.action, "readiness");
      const finishedJob = await waitForJob(handle.url, createdJob.body.jobId);
      assert.equal(finishedJob.status, "succeeded", finishedJob.error);
      assert.equal(finishedJob.runId, "run-ui");
      assert.ok(finishedJob.artifactPaths.some((artifactPath) => /refactor-readiness\.json$/.test(artifactPath)));
      assert.deepEqual(finishedJob.events.map((event) => event.type), ["queued", "started", "succeeded"]);
      assert.ok(finishedJob.events.at(-1)?.artifactPaths?.some((artifactPath) => /refactor-readiness\.json$/.test(artifactPath)));
      const jobFile = await readUiJob(loaded, createdJob.body.jobId);
      assert.deepEqual(jobFile.artifactPaths, finishedJob.artifactPaths);
      assert.deepEqual(jobFile.events, finishedJob.events);
      const jobDetail = await fetchJson<UiJobDetailReport>(`${handle.url}/api/jobs/${encodeURIComponent(createdJob.body.jobId)}/detail`);
      assert.equal(jobDetail.retryRootId, createdJob.body.jobId);
      assert.deepEqual(jobDetail.retryChain.map((job) => job.id), [createdJob.body.jobId]);
      assert.ok(jobDetail.artifacts.some((artifact) => artifact.kind === "json" && /refactor-readiness\.json$/.test(artifact.path)));
      const jobsReport = await fetchJson<UiJobsReport>(`${handle.url}/api/jobs`);
      assert.equal(jobsReport.totalCount, 1);
      assert.equal(jobsReport.activeCount, 0);
      assert.ok(jobsReport.jobs.some((job) => job.id === createdJob.body.jobId));
      assert.ok(jobsReport.jobs.find((job) => job.id === createdJob.body.jobId)?.events.length);
      const filteredJobs = await fetchJson<UiJobsReport>(`${handle.url}/api/jobs?status=succeeded&run=run-ui&limit=1`);
      assert.equal(filteredJobs.filters.status, "succeeded");
      assert.equal(filteredJobs.filters.runId, "run-ui");
      assert.equal(filteredJobs.filters.limit, 1);
      assert.equal(filteredJobs.jobs.length, 1);
      assert.equal(filteredJobs.jobs[0]?.id, createdJob.body.jobId);
      const activeJobs = await fetchJson<UiJobsReport>(`${handle.url}/api/jobs?status=active`);
      assert.equal(activeJobs.jobs.length, 0);
      const invalidJobs = await fetch(`${handle.url}/api/jobs?status=paused`);
      assert.equal(invalidJobs.status, 400);
      assert.match(await invalidJobs.text(), /Invalid job status filter/);
      const retrySucceeded = await postStatusJson<{ error: string }>(
        `${handle.url}/api/jobs/${encodeURIComponent(createdJob.body.jobId)}/retry`
      );
      assert.equal(retrySucceeded.status, 409);
      assert.match(retrySucceeded.body.error, /Only failed jobs/);

      const duplicateJob = await postStatusJson<UiJobCreateResponse>(`${handle.url}/api/jobs/actions/issue-control-dry-run`, {
        repo: "perly6185-lab/migration-guard",
        maxIterations: 2
      });
      assert.equal(duplicateJob.status, 202);
      const duplicateBlocked = await postStatusJson<{ error: string }>(`${handle.url}/api/jobs/actions/issue-control-dry-run`, {
        repo: "perly6185-lab/migration-guard",
        maxIterations: 2
      });
      assert.equal(duplicateBlocked.status, 409);
      assert.match(duplicateBlocked.body.error, /active issue-control-dry-run job/);
      await waitForJob(handle.url, duplicateJob.body.jobId);

      const concurrentCreates = await Promise.all(Array.from({ length: 6 }, () => postStatusJson<UiJobCreateResponse | { error: string }>(
        `${handle.url}/api/jobs/actions/issue-control-dry-run`,
        { repo: "perly6185-lab/migration-guard", labels: "concurrent", maxIterations: 2 }
      )));
      assert.equal(concurrentCreates.filter((result) => result.status === 202).length, 1);
      assert.equal(concurrentCreates.filter((result) => result.status === 409).length, 5);
      const concurrentJob = concurrentCreates.find((result) => result.status === 202)?.body as UiJobCreateResponse | undefined;
      assert.ok(concurrentJob?.jobId);
      await waitForJob(handle.url, concurrentJob.jobId);

      const cancelJobCreate = await postStatusJson<UiJobCreateResponse>(`${handle.url}/api/jobs/actions/readiness`, {
        run: "run-ui"
      });
      assert.equal(cancelJobCreate.status, 202);
      const cancelledJob = await postStatusJson<UiJob>(
        `${handle.url}/api/jobs/${encodeURIComponent(cancelJobCreate.body.jobId)}/cancel`
      );
      assert.equal(cancelledJob.status, 200);
      assert.equal(cancelledJob.body.status, "cancelled");
      assert.deepEqual(cancelledJob.body.events.map((event) => event.type), ["queued", "cancelled"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const stillCancelled = await fetchJson<UiJob>(`${handle.url}/api/jobs/${encodeURIComponent(cancelJobCreate.body.jobId)}`);
      assert.equal(stillCancelled.status, "cancelled");

      const batchDecision = await postJson<{ decisions: Array<{ classification: string }>; coverage: { decided: number }; policy: { status: string } }>(
        `${handle.url}/api/actions/diff-decision-batch`,
        {
          run: "run-ui",
          compare: diffs[0]?.path ?? "",
          severity: "warn",
          as: "unknown",
          reason: "batch review pending",
          approvedBy: "ui-test"
        }
      );
      assert.equal(batchDecision.decisions.length, 1);
      assert.equal(batchDecision.coverage.decided, 1);

      const decision = await postJson<{ decision: { classification: string }; coverage: { decided: number }; policy: { status: string } }>(
        `${handle.url}/api/actions/diff-decision`,
        {
          run: "run-ui",
          compare: diffs[0]?.path ?? "",
          area: "check",
          name: "unit",
          severity: "warn",
          message: "stdout changed while still passing",
          as: "intentional",
          reason: "stdout noise accepted",
          approvedBy: "ui-test"
        }
      );
      assert.equal(decision.decision.classification, "intentional");
      assert.equal(decision.coverage.decided, 1);
      assert.equal(decision.policy.status, "accepted");

      const decidedDiffs = await fetchJson<Array<{
        coverage?: { decided: number };
        differences: Array<{ decision?: { classification: string; reason: string } }>;
      }>>(`${handle.url}/api/diffs?run=run-ui`);
      assert.equal(decidedDiffs[0]?.coverage?.decided, 1);
      assert.equal(decidedDiffs[0]?.differences[0]?.decision?.classification, "intentional");
      assert.equal(decidedDiffs[0]?.differences[0]?.decision?.reason, "stdout noise accepted");

      const dryRun = await postJson<{ mode: string; summary: { issueCount: number } }>(
        `${handle.url}/api/actions/issue-control-dry-run`
      );
      assert.equal(dryRun.mode, "dry-run");
      assert.equal(dryRun.summary.issueCount, 0);

      const gcPlan = await postStatusJson<UiJobGcReport>(`${handle.url}/api/jobs/gc`, {
        keepLatest: 0,
        status: "cancelled"
      });
      assert.equal(gcPlan.status, 200);
      assert.equal(gcPlan.body.apply, false);
      assert.ok(gcPlan.body.candidates.some((candidate) => candidate.id === cancelJobCreate.body.jobId));
      const gcApply = await postStatusJson<UiJobGcReport>(`${handle.url}/api/jobs/gc`, {
        keepLatest: 0,
        status: "cancelled",
        apply: true
      });
      assert.equal(gcApply.status, 200);
      assert.equal(gcApply.body.deletedCount, 1);
      const deletedJob = await fetch(`${handle.url}/api/jobs/${encodeURIComponent(cancelJobCreate.body.jobId)}`);
      assert.equal(deletedJob.status, 404);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ui action capabilities disable issue dry-run when GitHub repo is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-capabilities-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }), "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard"
    }), "utf8");

    const loaded = await loadConfig(configPath);
    await saveRunPackage(loaded, createUiRunPackage(dir, targetRoot));
    const fetchImpl: typeof fetch = async () => {
      throw new Error("GitHub offline");
    };
    const handle = await startUiServer(loaded, { port: 0, fetchImpl });
    try {
      const capabilities = await fetchJson<UiActionCapabilities>(`${handle.url}/api/actions/capabilities?run=run-ui`);
      const issueDryRun = findAction(capabilities, "issue-control-dry-run");
      assert.equal(issueDryRun.enabled, false);
      assert.match(issueDryRun.reason ?? "", /GitHub repo is required/);
      assert.deepEqual(issueDryRun.requiresConfig, ["issueSync.githubRepo"]);

      const blockedDryRun = await postStatusJson<{ error: string; action: { id: string } }>(
        `${handle.url}/api/actions/issue-control-dry-run`
      );
      assert.equal(blockedDryRun.status, 409);
      assert.equal(blockedDryRun.body.action.id, "issue-control-dry-run");
      assert.match(blockedDryRun.body.error, /GitHub repo is required/);

      const blockedDryRunJob = await postStatusJson<{ error: string; action: { id: string } }>(
        `${handle.url}/api/jobs/actions/issue-control-dry-run`
      );
      assert.equal(blockedDryRunJob.status, 409);
      assert.equal(blockedDryRunJob.body.action.id, "issue-control-dry-run");
      assert.match(blockedDryRunJob.body.error, /GitHub repo is required/);

      const withRepo = await fetchJson<UiActionCapabilities>(
        `${handle.url}/api/actions/capabilities?run=run-ui&repo=owner/repo&maxIterations=2`
      );
      const enabledDryRun = findAction(withRepo, "issue-control-dry-run");
      assert.equal(enabledDryRun.enabled, true);
      assert.equal(enabledDryRun.defaults?.repo, "owner/repo");
      assert.equal(enabledDryRun.defaults?.maxIterations, 2);

      const invalidIterations = await postStatusJson<{ error: string }>(
        `${handle.url}/api/actions/issue-control-dry-run?repo=owner/repo&maxIterations=99`
      );
      assert.equal(invalidIterations.status, 409);
      assert.match(invalidIterations.body.error, /Max iterations/);

      const failedJobCreate = await postStatusJson<UiJobCreateResponse>(`${handle.url}/api/jobs/actions/issue-control-dry-run`, {
        repo: "owner/repo",
        maxIterations: 2
      });
      assert.equal(failedJobCreate.status, 202);
      const failedJob = await waitForJob(handle.url, failedJobCreate.body.jobId);
      assert.equal(failedJob.status, "failed");
      assert.match(failedJob.error ?? "", /GitHub offline/);

      const retryJobCreate = await postStatusJson<UiJobCreateResponse>(
        `${handle.url}/api/jobs/${encodeURIComponent(failedJob.id)}/retry`
      );
      assert.equal(retryJobCreate.status, 202);
      assert.equal(retryJobCreate.body.job.retryOf, failedJob.id);
      assert.match(retryJobCreate.body.job.events[0]?.message ?? "", /Queued retry/);
      const retriedJob = await waitForJob(handle.url, retryJobCreate.body.jobId);
      assert.equal(retriedJob.status, "failed");
      assert.equal(retriedJob.retryOf, failedJob.id);
      const retryDetail = await fetchJson<UiJobDetailReport>(`${handle.url}/api/jobs/${encodeURIComponent(retriedJob.id)}/detail`);
      assert.equal(retryDetail.retryRootId, failedJob.id);
      assert.deepEqual(retryDetail.retryChain.map((job) => job.id), [failedJob.id, retriedJob.id]);
      const failedDetail = await fetchJson<UiJobDetailReport>(`${handle.url}/api/jobs/${encodeURIComponent(failedJob.id)}/detail`);
      assert.ok(failedDetail.retryChildren.some((job) => job.id === retriedJob.id));
      const failedJobs = await fetchJson<UiJobsReport>(`${handle.url}/api/jobs?status=failed&limit=10`);
      assert.ok(failedJobs.jobs.some((job) => job.id === failedJob.id));
      assert.ok(failedJobs.jobs.some((job) => job.retryOf === failedJob.id));
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ui server recovers orphan queued and running jobs on startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-orphans-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }), "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await saveRunPackage(loaded, createUiRunPackage(dir, targetRoot));
    const jobsDir = path.join(loaded.artifactsDir, "ui-jobs");
    await mkdir(jobsDir, { recursive: true });
    const now = "2026-07-12T00:03:00.000Z";
    await writeFile(path.join(jobsDir, "orphan-queued.json"), JSON.stringify({
      version: 1,
      id: "orphan-queued",
      action: "readiness",
      status: "queued",
      createdAt: now,
      updatedAt: now,
      runId: "run-ui",
      params: { run: "run-ui" },
      artifactPaths: [],
      events: [{ at: now, type: "queued", message: "Queued before restart." }]
    }), "utf8");
    await writeFile(path.join(jobsDir, "orphan-running.json"), JSON.stringify({
      version: 1,
      id: "orphan-running",
      action: "readiness",
      status: "running",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      runId: "run-ui",
      params: { run: "run-ui" },
      artifactPaths: [],
      events: [{ at: now, type: "started", message: "Started before restart." }]
    }), "utf8");

    const handle = await startUiServer(loaded, { port: 0 });
    try {
      const queued = await fetchJson<UiJob>(`${handle.url}/api/jobs/orphan-queued`);
      assert.equal(queued.status, "cancelled");
      assert.equal(queued.events.at(-1)?.type, "recovered");
      assert.equal(queued.recoveryReason, "claim-missing");
      const running = await fetchJson<UiJob>(`${handle.url}/api/jobs/orphan-running`);
      assert.equal(running.status, "failed");
      assert.match(running.error ?? "", /server restart/);
      assert.equal(running.events.at(-1)?.type, "recovered");
      assert.equal(running.recoveryReason, "claim-missing");
      assert.equal((await readdir(path.join(jobsDir, "recovery-plans"))).length, 2);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json() as T;
}

async function postJson<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, await postOptions(url, body));
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json() as T;
}

async function postStatusJson<T>(url: string, body?: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, await postOptions(url, body));
  return {
    status: response.status,
    body: await response.json() as T
  };
}

async function postOptions(url: string, body?: Record<string, unknown>): Promise<RequestInit> {
  const csrfToken = await fetchJson<{ csrfToken: string }>(`${new URL(url).origin}/api/session`).then((session) => session.csrfToken);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-migration-guard-csrf": csrfToken
    },
    body: JSON.stringify(body ?? {})
  };
}

async function waitForJob(baseUrl: string, jobId: string): Promise<UiJob> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await fetchJson<UiJob>(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for UI job: ${jobId}`);
}

interface UiActionCapabilities {
  runId?: string;
  actions: Array<{
    id: string;
    enabled: boolean;
    reason?: string;
    writesArtifacts: boolean;
    dryRunOnly: boolean;
    requiresConfig?: string[];
    defaults?: Record<string, unknown>;
  }>;
}

interface UiJob {
  id: string;
  retryOf?: string;
  ownerId?: string;
  attempt?: number;
  heartbeatAt?: string;
  leaseDurationMs?: number;
  recoveryReason?: string;
  action: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  runId?: string;
  artifactPaths: string[];
  events: Array<{
    at: string;
    type: "queued" | "started" | "succeeded" | "failed" | "cancelled" | "recovered";
    message: string;
    artifactPaths?: string[];
  }>;
  error?: string;
}

interface UiJobCreateResponse {
  jobId: string;
  jobPath: string;
  job: UiJob;
}

interface UiJobsReport {
  filters: {
    status: string;
    runId?: string;
    limit: number;
  };
  totalCount: number;
  activeCount: number;
  jobs: UiJob[];
}

interface UiJobDetailReport {
  retryRootId: string;
  job: UiJob;
  retryChain: UiJob[];
  retryChildren: UiJob[];
  artifacts: Array<{
    path: string;
    kind: string;
  }>;
}

interface UiJobGcReport {
  apply: boolean;
  deletedCount: number;
  candidates: Array<{
    id: string;
    status: string;
  }>;
}

function findAction(capabilities: UiActionCapabilities, id: string): UiActionCapabilities["actions"][number] {
  const action = capabilities.actions.find((candidate) => candidate.id === id);
  assert.ok(action, `Missing action capability: ${id}`);
  return action;
}

function createUiRunPackage(dir: string, targetRoot: string): MigrationRunPackage {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    run: {
      version: 1,
      id: "run-ui",
      goal: "serve local board",
      sourceRoot: path.join(dir, "source"),
      targetRoot,
      artifactsDir: path.join(dir, ".migration-guard", "migration-runs", "run-ui"),
      status: "running",
      mode: "manual",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 1,
        testFiles: 1,
        taskCount: 1,
        riskLevel: "low",
        confidence: "medium",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    },
    graph: {
      version: 1,
      runId: "run-ui",
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-ui",
        title: "Expose local board",
        description: "Serve read-only board data.",
        type: "code-change",
        status: "ready",
        priority: 10,
        risk: "low",
        owner: "engine",
        dependsOn: [],
        affectedFiles: ["src/core/uiServer.ts"],
        verificationCommands: ["npm test"],
        acceptanceCriteria: ["dashboard endpoint responds"],
        issueId: "issue-ui",
        createdAt: now,
        updatedAt: now
      }]
    },
    issues: [{
      id: "issue-ui",
      runId: "run-ui",
      taskId: "task-ui",
      type: "task",
      title: "Expose local board",
      body: "Serve read-only board data.",
      status: "ready",
      risk: "low",
      owner: "engine",
      affectedFiles: ["src/core/uiServer.ts"],
      createdAt: now,
      updatedAt: now
    }]
  };
}
