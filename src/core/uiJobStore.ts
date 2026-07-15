import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { readJsonFile, writeJsonFile } from "./files.js";
import { decodeCoreArtifact, uiJobArtifactMetadata, writeCoreArtifactFile } from "./artifactV2.js";
import { UiHttpError } from "./uiHttpError.js";
import type { UiJob, UiJobClaim, UiJobRecoveryReason } from "./uiJobTypes.js";
import type { LoadedConfig } from "../types.js";

export async function readUiJob(loaded: LoadedConfig, jobId: string): Promise<UiJob> {
  const filePath = uiJobPath(loaded, jobId);
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new UiHttpError("job not found", 404);
  }
  const job = validateUiJob(await readStoredUiJob(filePath));
  const claim = await readJsonFile<UiJobClaim>(`${filePath}.claim`).catch(() => undefined);
  return claim ? {
    ...job,
    ownerPid: claim.ownerPid,
    ownerId: claim.ownerId,
    attempt: claim.attempt,
    commandFingerprint: claim.commandFingerprint,
    fencingToken: claim.fencingToken,
    heartbeatAt: claim.heartbeatAt,
    leaseDurationMs: claim.leaseDurationMs
  } : job;
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

const processOwnerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;

export async function claimUiJob(
  loaded: LoadedConfig,
  jobId: string,
  commandFingerprint: string,
  leaseDurationMs = 30000
): Promise<UiJobClaim | undefined> {
  const jobPath = uiJobPath(loaded, jobId);
  if (!await fs.stat(jobPath).catch(() => undefined)) return undefined;
  const claimPath = `${jobPath}.claim`;
  await fs.mkdir(path.dirname(claimPath), { recursive: true });
  try {
    const handle = await fs.open(claimPath, "wx");
    const now = new Date().toISOString();
    const job = await readUiJob(loaded, jobId);
    const claim: UiJobClaim = {
      version: 2,
      ownerId: processOwnerId,
      ownerPid: process.pid,
      hostname: os.hostname(),
      fencingToken: randomUUID(),
      attempt: Math.max(1, job.attempt ?? 1),
      commandFingerprint,
      acquiredAt: now,
      heartbeatAt: now,
      leaseDurationMs
    };
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    await handle.close();
    return claim;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return undefined;
    throw error;
  }
}

export async function heartbeatUiJobClaim(loaded: LoadedConfig, jobId: string, expected: UiJobClaim): Promise<UiJobClaim> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  const claim = await readJsonFile<UiJobClaim>(claimPath);
  assertUiJobClaimOwner(claim, expected);
  const updated = { ...claim, heartbeatAt: new Date().toISOString() };
  await writeJsonFile(claimPath, updated);
  return updated;
}

export async function inspectUiJobClaim(loaded: LoadedConfig, jobId: string): Promise<{ claimed: boolean; expired?: boolean; claim?: UiJobClaim }> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  if (!await fs.stat(claimPath).catch(() => undefined)) return { claimed: false };
  const claim = await readJsonFile<UiJobClaim>(claimPath);
  return { claimed: true, expired: Date.now() - Date.parse(claim.heartbeatAt) > claim.leaseDurationMs, claim };
}

export async function assertUiJobClaim(loaded: LoadedConfig, jobId: string, expected: UiJobClaim): Promise<void> {
  assertUiJobClaimOwner(await readJsonFile<UiJobClaim>(`${uiJobPath(loaded, jobId)}.claim`), expected);
}

export async function releaseUiJobClaim(loaded: LoadedConfig, jobId: string, expected?: UiJobClaim): Promise<void> {
  const claimPath = `${uiJobPath(loaded, jobId)}.claim`;
  if (expected) assertUiJobClaimOwner(await readJsonFile<UiJobClaim>(claimPath), expected);
  await fs.rm(claimPath, { force: true });
}

export function classifyUiJobClaim(claim: Partial<UiJobClaim> | undefined, now = Date.now()): UiJobRecoveryReason | undefined {
  if (!claim) return "claim-missing";
  if (claim.hostname !== os.hostname()) return "host-mismatch";
  if (typeof claim.ownerPid === "number" && !isProcessAlive(claim.ownerPid)) return "process-dead";
  const heartbeatAge = now - Date.parse(String(claim.heartbeatAt));
  if (!Number.isFinite(heartbeatAge)) return "heartbeat-stale";
  if (heartbeatAge > Number(claim.leaseDurationMs ?? 0)) return "lease-expired";
  return undefined;
}

function assertUiJobClaimOwner(actual: UiJobClaim, expected: UiJobClaim): void {
  if (actual.ownerId !== expected.ownerId || actual.fencingToken !== expected.fencingToken) {
    throw new UiHttpError("UI job claim fencing token is no longer current", 409);
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
