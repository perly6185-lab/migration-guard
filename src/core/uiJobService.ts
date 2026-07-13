import path from "node:path";
import { promises as fs } from "node:fs";
import { assessRefactorReadiness, writeRefactorReadinessReport } from "./refactorReadiness.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";
import { superviseIssueControl } from "./issueControl.js";
import { stableStringify } from "./normalize.js";
import { loadRunPackage } from "./migrationRun.js";
import { UiHttpError } from "./uiHttpError.js";
import { resolveArtifactPath } from "./uiArtifacts.js";
import {
  readAllUiJobs,
  readUiJob,
  claimUiJob,
  heartbeatUiJobClaim,
  isUiJobClaimed,
  releaseUiJobClaim,
  uiJobPath,
  updateUiJob,
  writeUiJob
} from "./uiJobStore.js";
import {
  booleanParam,
  boundedIntegerParam,
  positiveIntegerParam,
  trimmedParam
} from "./uiRequest.js";
import type {
  CreateUiActionJobOptions,
  UiActionId,
  UiJob,
  UiJobArtifact,
  UiJobCreateResponse,
  UiJobDetailReport,
  UiJobEvent,
  UiJobGcReport,
  UiJobsReport,
  UiJobStatus
} from "./uiJobTypes.js";
import type { LoadedConfig } from "../types.js";

export interface UiJobRunnerOptions {
  fetchImpl?: typeof fetch;
}

const uiJobCreationLocks = new Map<string, Promise<void>>();

export { readUiJob } from "./uiJobStore.js";

export async function createUiActionJob(
  loaded: LoadedConfig,
  options: UiJobRunnerOptions,
  action: UiActionId,
  searchParams: URLSearchParams,
  createOptions: CreateUiActionJobOptions = {}
): Promise<UiJobCreateResponse> {
  const runId = action === "readiness" ? (await loadRunPackage(loaded, searchParams.get("run") ?? "latest")).run.id : undefined;
  const params = uiJobParams(loaded, action, searchParams);
  if (action === "readiness" && runId) {
    params.run = runId;
  }
  const lockKey = `${loaded.artifactsDir}\n${action}\n${stableStringify(params)}`;
  const job = await withUiJobCreationLock(lockKey, async () => {
    const duplicate = await findActiveDuplicateUiJob(loaded, action, params);
    if (duplicate) {
      throw new UiHttpError(`An active ${action} job already exists: ${duplicate.id}`, 409);
    }
    const now = new Date().toISOString();
    const queuedJob: UiJob = {
      version: 1,
      id: createUiJobId(action, now),
      retryOf: createOptions.retryOf,
      ownerPid: process.pid,
      action,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      runId,
      params,
      artifactPaths: [],
      events: [{
        at: now,
        type: "queued",
        message: createOptions.retryOf
          ? `Queued retry of ${createOptions.retryOf}.`
          : `Queued ${action} job.`
      }]
    };
    await writeUiJob(loaded, queuedJob);
    return queuedJob;
  });
  scheduleUiJobRun(loaded, options, job.id);
  return {
    version: 1,
    jobId: job.id,
    jobPath: uiJobPath(loaded, job.id),
    job
  };
}

async function withUiJobCreationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = uiJobCreationLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  uiJobCreationLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (uiJobCreationLocks.get(key) === queued) {
      uiJobCreationLocks.delete(key);
    }
  }
}

export async function recoverOrphanUiJobs(loaded: LoadedConfig): Promise<void> {
  const recoveredAt = new Date().toISOString();
  for (const job of await readAllUiJobs(loaded)) {
    if (job.status !== "queued" && job.status !== "running") {
      continue;
    }
    if (job.ownerPid && isProcessAlive(job.ownerPid)) {
      continue;
    }
    await releaseUiJobClaim(loaded, job.id).catch(() => undefined);
    const recovered: UiJob = {
      ...job,
      status: job.status === "queued" ? "cancelled" : "failed",
      updatedAt: recoveredAt,
      finishedAt: recoveredAt,
      error: job.status === "running" ? "Recovered after server restart; previous runner is no longer active." : job.error,
      events: appendUiJobEvent(job, {
        at: recoveredAt,
        type: "recovered",
        message: job.status === "queued"
          ? "Cancelled queued job after server restart."
          : "Marked running job failed after server restart."
      })
    };
    await writeUiJob(loaded, recovered);
  }
}

export async function listUiJobs(loaded: LoadedConfig, searchParams: URLSearchParams): Promise<UiJobsReport> {
  const status = uiJobStatusFilterParam(searchParams);
  const runId = await resolveOptionalRunId(loaded, trimmedParam(searchParams, "run"));
  const limit = boundedIntegerParam(searchParams, "limit", 20, 1, 100);
  const jobs = await readAllUiJobs(loaded);
  const sortedJobs = jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filteredJobs = sortedJobs.filter((job) => uiJobMatchesFilters(job, status, runId));
  return {
    version: 1,
    filters: {
      status,
      runId,
      limit
    },
    totalCount: jobs.length,
    activeCount: jobs.filter(isActiveUiJob).length,
    jobs: filteredJobs.slice(0, limit)
  };
}

export async function collectUiJobDetail(loaded: LoadedConfig, jobId: string): Promise<UiJobDetailReport> {
  const job = await readUiJob(loaded, jobId);
  const jobs = await readAllUiJobs(loaded);
  const byId = new Map(jobs.map((candidate) => [candidate.id, candidate]));
  const retryChain = buildUiJobRetryChain(job, byId);
  const retryRootId = retryChain[0]?.id ?? job.id;
  return {
    version: 1,
    job,
    retryRootId,
    retryChain,
    retryChildren: jobs
      .filter((candidate) => candidate.retryOf === job.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    artifacts: job.artifactPaths.map(classifyUiJobArtifact)
  };
}

export async function cancelUiJob(loaded: LoadedConfig, jobId: string): Promise<UiJob> {
  const cancelledAt = new Date().toISOString();
  const updated = await updateUiJob(loaded, jobId, (job) => {
    if (job.status !== "queued") {
      return job;
    }
    return {
      ...job,
      status: "cancelled",
      updatedAt: cancelledAt,
      finishedAt: cancelledAt,
      events: appendUiJobEvent(job, {
        at: cancelledAt,
        type: "cancelled",
        message: "Cancelled before execution."
      })
    };
  });
  if (updated.status !== "cancelled") {
    throw new UiHttpError("Only queued jobs can be cancelled.", 409);
  }
  await waitForUiJobClaimRelease(loaded, jobId);
  return updated;
}

async function waitForUiJobClaimRelease(loaded: LoadedConfig, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!await isUiJobClaimed(loaded, jobId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function gcUiJobs(loaded: LoadedConfig, searchParams: URLSearchParams): Promise<UiJobGcReport> {
  const keepLatest = boundedIntegerParam(searchParams, "keepLatest", 50, 0, 500);
  const status = uiJobGcStatusParam(searchParams);
  const apply = booleanParam(searchParams, "apply");
  const jobs = (await readAllUiJobs(loaded)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const candidates = jobs
    .slice(keepLatest)
    .filter((job) => uiJobMatchesGcStatus(job, status))
    .map((job) => ({
      id: job.id,
      status: job.status,
      updatedAt: job.updatedAt,
      path: uiJobPath(loaded, job.id)
    }));
  let deletedCount = 0;
  if (apply) {
    for (const candidate of candidates) {
      if (await isUiJobClaimed(loaded, candidate.id)) continue;
      await fs.rm(candidate.path, { force: true });
      deletedCount += 1;
    }
  }
  return {
    version: 1,
    apply,
    keepLatest,
    status,
    scannedCount: jobs.length,
    candidateCount: candidates.length,
    deletedCount,
    candidates
  };
}

export function uiActionIdParam(value: string): UiActionId {
  if (value === "readiness" || value === "verify" || value === "issue-control-dry-run") {
    return value;
  }
  throw new UiHttpError(`Unsupported job action: ${value}`, 400);
}

export function uiJobSearchParams(job: UiJob): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(job.params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        searchParams.set(key, value.join(","));
      }
      continue;
    }
    searchParams.set(key, String(value));
  }
  if (job.action === "readiness" && !searchParams.has("run") && job.runId) {
    searchParams.set("run", job.runId);
  }
  return searchParams;
}

function scheduleUiJobRun(
  loaded: LoadedConfig,
  options: UiJobRunnerOptions,
  jobId: string
): void {
  setTimeout(() => {
    void runUiActionJob(loaded, options, jobId);
  }, 250);
}

async function runUiActionJob(
  loaded: LoadedConfig,
  options: UiJobRunnerOptions,
  jobId: string
): Promise<void> {
  if (!await claimUiJob(loaded, jobId)) return;
  const heartbeat = setInterval(() => { void heartbeatUiJobClaim(loaded, jobId).catch(() => undefined); }, 10000);
  heartbeat.unref();
  try {
    const startedAt = new Date().toISOString();
    const runningJob = await updateUiJob(loaded, jobId, (job) => {
      if (job.status !== "queued") {
        return job;
      }
      return {
        ...job,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        events: appendUiJobEvent(job, {
          at: startedAt,
          type: "started",
          message: `Started ${job.action} job.`
        })
      };
    });
    if (runningJob.status !== "running") {
      return;
    }
    const result = await executeUiActionJob(loaded, options, runningJob);
    const finishedAt = new Date().toISOString();
    const artifactPaths = extractArtifactPaths(loaded, result);
    await updateUiJob(loaded, jobId, (job) => ({
      ...job,
      status: "succeeded",
      updatedAt: finishedAt,
      finishedAt,
      result,
      artifactPaths,
      events: appendUiJobEvent(job, {
        at: finishedAt,
        type: "succeeded",
        message: `Finished ${job.action} job successfully.`,
        artifactPaths
      })
    }));
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await updateUiJob(loaded, jobId, (job) => ({
      ...job,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      error: message,
      events: appendUiJobEvent(job, {
        at: finishedAt,
        type: "failed",
        message
      })
    })).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    await releaseUiJobClaim(loaded, jobId).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function executeUiActionJob(
  loaded: LoadedConfig,
  options: UiJobRunnerOptions,
  job: UiJob
): Promise<unknown> {
  if (job.action === "readiness") {
    const pkg = await loadRunPackage(loaded, stringJobParam(job, "run") ?? job.runId ?? "latest");
    return await writeRefactorReadinessReport(loaded, pkg, await assessRefactorReadiness(loaded, pkg));
  }
  if (job.action === "verify") {
    const snapshotPath = await saveSnapshot(loaded, await captureSnapshot(loaded, "run"));
    return { status: "complete", snapshotPath };
  }
  const labels = arrayJobParam(job, "labels");
  const repo = stringJobParam(job, "repo");
  return await superviseIssueControl(loaded, {
    repo,
    labels,
    execute: false,
    fetchImpl: options.fetchImpl,
    maxIterations: numberJobParam(job, "maxIterations") ?? 3
  });
}

function uiJobParams(
  loaded: LoadedConfig,
  action: UiActionId,
  searchParams: URLSearchParams
): UiJob["params"] {
  if (action === "readiness") {
    return {
      run: searchParams.get("run") ?? "latest"
    };
  }
  if (action === "verify") {
    return {
      targetRoot: loaded.targetRoot
    };
  }
  return {
    repo: trimmedParam(searchParams, "repo") ?? loaded.config.issueSync?.githubRepo,
    labels: searchParams.get("labels")?.split(",").map((label) => label.trim()).filter(Boolean) ?? [],
    maxIterations: positiveIntegerParam(searchParams, "maxIterations") ?? 3
  };
}

async function findActiveDuplicateUiJob(
  loaded: LoadedConfig,
  action: UiActionId,
  params: UiJob["params"]
): Promise<UiJob | undefined> {
  const paramsKey = stableStringify(params);
  return (await readAllUiJobs(loaded))
    .filter((job) => job.action === action && isActiveUiJob(job))
    .find((job) => stableStringify(job.params) === paramsKey);
}

function createUiJobId(action: UiActionId, now: string): string {
  const timestamp = now.replace(/[:.]/g, "-");
  const nonce = Math.random().toString(36).slice(2, 8);
  return `ui-${action}-${timestamp}-${nonce}`;
}

function uiJobStatusFilterParam(searchParams: URLSearchParams): "all" | "active" | UiJobStatus {
  const value = trimmedParam(searchParams, "status") ?? "all";
  if (value === "all" || value === "active" || value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new UiHttpError(`Invalid job status filter: ${value}`, 400);
}

function uiJobMatchesFilters(job: UiJob, status: "all" | "active" | UiJobStatus, runId: string | undefined): boolean {
  if (runId && job.runId !== runId) {
    return false;
  }
  if (status === "all") {
    return true;
  }
  if (status === "active") {
    return isActiveUiJob(job);
  }
  return job.status === status;
}

function isActiveUiJob(job: UiJob): boolean {
  return job.status === "queued" || job.status === "running";
}

function isTerminalUiJob(job: UiJob): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}

function uiJobGcStatusParam(searchParams: URLSearchParams): "terminal" | "all" | UiJobStatus {
  const value = trimmedParam(searchParams, "status") ?? "terminal";
  if (value === "terminal" || value === "all" || value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new UiHttpError(`Invalid job GC status: ${value}`, 400);
}

function uiJobMatchesGcStatus(job: UiJob, status: "terminal" | "all" | UiJobStatus): boolean {
  if (status === "all") {
    return true;
  }
  if (status === "terminal") {
    return isTerminalUiJob(job);
  }
  return job.status === status;
}

function buildUiJobRetryChain(job: UiJob, byId: Map<string, UiJob>): UiJob[] {
  const chain: UiJob[] = [job];
  const seen = new Set([job.id]);
  let current = job;
  while (current.retryOf) {
    const parent = byId.get(current.retryOf);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    chain.unshift(parent);
    seen.add(parent.id);
    current = parent;
  }
  return chain;
}

function classifyUiJobArtifact(artifactPath: string): UiJobArtifact {
  const extension = path.extname(artifactPath).toLowerCase();
  const kind = extension === ".json"
    ? "json"
    : extension === ".md"
      ? "markdown"
      : extension === ".log" || extension === ".jsonl"
        ? "log"
        : extension === ".txt"
          ? "text"
          : "other";
  return {
    path: artifactPath,
    kind,
    label: path.basename(artifactPath)
  };
}

function stringJobParam(job: UiJob, key: string): string | undefined {
  const value = job.params[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberJobParam(job: UiJob, key: string): number | undefined {
  const value = job.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayJobParam(job: UiJob, key: string): string[] | undefined {
  const value = job.params[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;
}

function appendUiJobEvent(job: UiJob, event: UiJobEvent): UiJobEvent[] {
  return [...(Array.isArray(job.events) ? job.events : []), event];
}

function extractArtifactPaths(loaded: LoadedConfig, result: unknown): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 4) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && /path$/i.test(key)) {
        try {
          paths.add(resolveArtifactPath(loaded, child));
        } catch {
          // Only expose artifacts from the configured artifact root.
        }
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(result, 0);
  return [...paths].sort();
}

async function resolveOptionalRunId(loaded: LoadedConfig, runSelector: string | undefined): Promise<string | undefined> {
  return runSelector ? (await loadRunPackage(loaded, runSelector)).run.id : undefined;
}
