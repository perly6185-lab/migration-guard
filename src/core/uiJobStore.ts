import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { readJsonFile, writeJsonFile } from "./files.js";
import { decodeCoreArtifact, uiJobArtifactMetadata, writeCoreArtifactFile } from "./artifactV2.js";
import { UiHttpError } from "./uiHttpError.js";
import type { UiJob } from "./uiJobTypes.js";
import type { LoadedConfig } from "../types.js";

export async function readUiJob(loaded: LoadedConfig, jobId: string): Promise<UiJob> {
  const filePath = uiJobPath(loaded, jobId);
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new UiHttpError("job not found", 404);
  }
  return validateUiJob(await readStoredUiJob(filePath));
}

export async function readAllUiJobs(loaded: LoadedConfig): Promise<UiJob[]> {
  const dir = uiJobsDir(loaded);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const jobs: UiJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      jobs.push(validateUiJob(await readStoredUiJob(path.join(dir, entry.name))));
    } catch {
      // Ignore partially written or incompatible job files; they should not block the board.
    }
  }
  return jobs;
}

export async function updateUiJob(
  loaded: LoadedConfig,
  jobId: string,
  updater: (job: UiJob) => UiJob
): Promise<UiJob> {
  const updated = updater(await readUiJob(loaded, jobId));
  await writeUiJob(loaded, updated);
  return updated;
}

export async function writeUiJob(loaded: LoadedConfig, job: UiJob): Promise<void> {
  const claim = await readJsonFile<{ ownerPid?: number; heartbeatAt?: string; leaseDurationMs?: number }>(`${uiJobPath(loaded, job.id)}.claim`).catch(() => undefined);
  await writeCoreArtifactFile(uiJobPath(loaded, job.id), "ui-job", job, uiJobArtifactMetadata(job, claim));
}

export function uiJobsDir(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "ui-jobs");
}

export function uiJobPath(loaded: LoadedConfig, jobId: string): string {
  return path.join(uiJobsDir(loaded), `${safeUiJobId(jobId)}.json`);
}

export async function claimUiJob(loaded: LoadedConfig, jobId: string): Promise<boolean> {
  const jobPath = uiJobPath(loaded, jobId);
  if (!await fs.stat(jobPath).catch(() => undefined)) return false;
  const claimPath = `${jobPath}.claim`;
  await fs.mkdir(path.dirname(claimPath), { recursive: true });
  try {
    const handle = await fs.open(claimPath, "wx");
    const now = new Date().toISOString();
    await handle.writeFile(`${JSON.stringify({ version: 1, ownerPid: process.pid, hostname: os.hostname(), acquiredAt: now, heartbeatAt: now, leaseDurationMs: 30000 }, null, 2)}\n`, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }
}

export async function heartbeatUiJobClaim(loaded: LoadedConfig, jobId: string): Promise<void> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  const claim = await readJsonFile<{ version: 1; ownerPid: number; hostname: string; acquiredAt: string; heartbeatAt: string; leaseDurationMs: number }>(claimPath);
  if (claim.ownerPid !== process.pid || claim.hostname !== os.hostname()) throw new UiHttpError("UI job claim is owned by another process", 409);
  await writeJsonFile(claimPath, { ...claim, heartbeatAt: new Date().toISOString() });
}

export async function inspectUiJobClaim(loaded: LoadedConfig, jobId: string): Promise<{ claimed: boolean; expired?: boolean; claim?: Record<string, unknown> }> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  if (!await fs.stat(claimPath).catch(() => undefined)) return { claimed: false };
  const claim = await readJsonFile<{ heartbeatAt: string; leaseDurationMs: number } & Record<string, unknown>>(claimPath);
  return { claimed: true, expired: Date.now() - Date.parse(claim.heartbeatAt) > claim.leaseDurationMs, claim };
}

export async function releaseUiJobClaim(loaded: LoadedConfig, jobId: string): Promise<void> {
  await fs.rm(`${uiJobPath(loaded, jobId)}.claim`, { force: true });
}

export async function isUiJobClaimed(loaded: LoadedConfig, jobId: string): Promise<boolean> {
  return Boolean(await fs.stat(`${uiJobPath(loaded, jobId)}.claim`).catch(() => undefined));
}

function validateUiJob(value: UiJob): UiJob {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new UiHttpError(`Unsupported UI job schema version: ${String((value as { version?: unknown })?.version)}`, 409);
  }
  return value;
}

async function readStoredUiJob(filePath: string): Promise<UiJob> {
  const value = await readJsonFile<unknown>(filePath);
  try {
    return decodeCoreArtifact<UiJob>("ui-job", value);
  } catch (error) {
    if (value && typeof value === "object" && !Array.isArray(value) && "version" in value) {
      throw new UiHttpError(`Unsupported UI job schema version: ${String((value as { version?: unknown }).version)}`, 409);
    }
    throw new UiHttpError(error instanceof Error ? error.message : String(error), 409);
  }
}

function safeUiJobId(jobId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) {
    throw new UiHttpError("Invalid job id", 400);
  }
  return jobId;
}
