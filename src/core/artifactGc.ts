import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile } from "./files.js";
import type { LoadedConfig } from "../types.js";

export interface ArtifactGcOptions {
  keepRuns?: number;
  apply?: boolean;
}

export interface ArtifactGcCandidate {
  id: string;
  path: string;
  createdAt?: string;
  reason: string;
}

export interface ArtifactGcReport {
  version: 1;
  artifactsDir: string;
  migrationRunsDir: string;
  keepRuns: number;
  applied: boolean;
  latestRunId?: string;
  kept: ArtifactGcCandidate[];
  candidates: ArtifactGcCandidate[];
  deleted: ArtifactGcCandidate[];
}

interface RunArtifact {
  id: string;
  path: string;
  createdAt?: string;
  mtimeMs: number;
}

export async function collectArtifactGcReport(
  loaded: LoadedConfig,
  options: ArtifactGcOptions = {}
): Promise<ArtifactGcReport> {
  const keepRuns = options.keepRuns ?? 5;
  if (!Number.isInteger(keepRuns) || keepRuns < 0) {
    throw new Error(`Invalid keepRuns: ${keepRuns}. Expected a non-negative integer.`);
  }

  const artifactsDir = path.resolve(loaded.artifactsDir);
  const migrationRunsDir = path.join(artifactsDir, "migration-runs");
  const latestRunId = await readLatestRunId(migrationRunsDir);
  const runs = await listRunArtifacts(migrationRunsDir);
  const protectedRunIds = new Set(runs.slice(0, keepRuns).map((run) => run.id));
  if (latestRunId) {
    protectedRunIds.add(latestRunId);
  }

  const kept: ArtifactGcCandidate[] = [];
  const candidates: ArtifactGcCandidate[] = [];
  for (const run of runs) {
    const candidate = {
      id: run.id,
      path: run.path,
      createdAt: run.createdAt,
      reason: protectedRunIds.has(run.id)
        ? run.id === latestRunId
          ? "latest run pointer"
          : `within newest ${keepRuns} run(s)`
        : `older than newest ${keepRuns} run(s)`
    };
    if (protectedRunIds.has(run.id)) {
      kept.push(candidate);
    } else {
      candidates.push(candidate);
    }
  }

  const deleted: ArtifactGcCandidate[] = [];
  if (options.apply) {
    for (const candidate of candidates) {
      assertInsideDirectory(migrationRunsDir, candidate.path);
      await fs.rm(candidate.path, { recursive: true, force: true });
      deleted.push(candidate);
    }
  }

  return {
    version: 1,
    artifactsDir,
    migrationRunsDir,
    keepRuns,
    applied: Boolean(options.apply),
    latestRunId,
    kept,
    candidates,
    deleted
  };
}

export function renderArtifactGcReport(report: ArtifactGcReport): string {
  return [
    "Artifact GC",
    `Artifacts: ${report.artifactsDir}`,
    `Migration runs: ${report.migrationRunsDir}`,
    `Mode: ${report.applied ? "apply" : "dry-run"}`,
    `Keep runs: ${report.keepRuns}`,
    report.latestRunId ? `Latest run: ${report.latestRunId}` : "Latest run: none",
    `Candidates: ${report.candidates.length}`,
    `Deleted: ${report.deleted.length}`,
    "",
    report.candidates.length > 0
      ? [
        "Candidates:",
        ...report.candidates.map((candidate) => `- ${candidate.id} (${candidate.reason}) ${candidate.path}`)
      ].join("\n")
      : "Candidates: none"
  ].join("\n");
}

async function readLatestRunId(migrationRunsDir: string): Promise<string | undefined> {
  const latestPath = path.join(migrationRunsDir, "latest.json");
  if (!await pathExists(latestPath)) {
    return undefined;
  }
  const latest = await readJsonFile<{ id?: string; runId?: string }>(latestPath).catch(() => undefined);
  return latest?.id ?? latest?.runId;
}

async function listRunArtifacts(migrationRunsDir: string): Promise<RunArtifact[]> {
  if (!await pathExists(migrationRunsDir)) {
    return [];
  }

  const entries = await fs.readdir(migrationRunsDir, { withFileTypes: true });
  const runs: RunArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) {
      continue;
    }
    const runPath = path.join(migrationRunsDir, entry.name);
    const stat = await fs.stat(runPath);
    const runJson = await readJsonFile<{ id?: string; createdAt?: string }>(path.join(runPath, "run.json")).catch(() => undefined);
    runs.push({
      id: runJson?.id ?? entry.name,
      path: runPath,
      createdAt: runJson?.createdAt,
      mtimeMs: stat.mtimeMs
    });
  }

  return runs.sort((a, b) => compareRunArtifacts(a, b));
}

function compareRunArtifacts(a: RunArtifact, b: RunArtifact): number {
  const aTime = Date.parse(a.createdAt ?? "");
  const bTime = Date.parse(b.createdAt ?? "");
  const normalizedATime = Number.isFinite(aTime) ? aTime : a.mtimeMs;
  const normalizedBTime = Number.isFinite(bTime) ? bTime : b.mtimeMs;
  return normalizedBTime - normalizedATime || b.id.localeCompare(a.id);
}

function assertInsideDirectory(parentDir: string, candidatePath: string): void {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove artifact outside ${parentDir}: ${candidatePath}`);
  }
}

