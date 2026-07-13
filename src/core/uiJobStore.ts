import path from "node:path";
import { promises as fs } from "node:fs";
import { readJsonFile, writeJsonFile } from "./files.js";
import { UiHttpError } from "./uiHttpError.js";
import type { UiJob } from "./uiJobTypes.js";
import type { LoadedConfig } from "../types.js";

export async function readUiJob(loaded: LoadedConfig, jobId: string): Promise<UiJob> {
  const filePath = uiJobPath(loaded, jobId);
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new UiHttpError("job not found", 404);
  }
  return validateUiJob(await readJsonFile<UiJob>(filePath));
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
      jobs.push(validateUiJob(await readJsonFile<UiJob>(path.join(dir, entry.name))));
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
  await writeJsonFile(uiJobPath(loaded, job.id), job);
}

export function uiJobsDir(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "ui-jobs");
}

export function uiJobPath(loaded: LoadedConfig, jobId: string): string {
  return path.join(uiJobsDir(loaded), `${safeUiJobId(jobId)}.json`);
}

export async function claimUiJob(loaded: LoadedConfig, jobId: string): Promise<boolean> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  await fs.mkdir(path.dirname(claimPath), { recursive: true });
  try {
    const handle = await fs.open(claimPath, "wx");
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
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

function safeUiJobId(jobId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) {
    throw new UiHttpError("Invalid job id", 400);
  }
  return jobId;
}
