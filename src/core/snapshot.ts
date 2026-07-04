import path from "node:path";
import { stableStringify } from "./normalize.js";
import { runChecks, runProbes } from "./probes.js";
import { scanProject } from "./scan.js";
import { sha256 } from "./hash.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import type { LoadedConfig, Snapshot, SnapshotKind } from "../types.js";

export async function captureSnapshot(loaded: LoadedConfig, kind: SnapshotKind): Promise<Snapshot> {
  const scan = await scanProject(loaded);
  const checks = await runChecks(loaded);
  const probes = await runProbes(loaded);

  return {
    version: 1,
    kind,
    id: createSnapshotId(kind),
    createdAt: new Date().toISOString(),
    root: loaded.targetRoot,
    configHash: sha256(stableStringify(loaded.config)),
    scan,
    checks,
    probes
  };
}

export async function saveSnapshot(loaded: LoadedConfig, snapshot: Snapshot): Promise<string> {
  const folder = snapshot.kind === "baseline" ? "baselines" : "runs";
  const snapshotPath = path.join(loaded.artifactsDir, folder, `${snapshot.id}.json`);
  const latestPath = path.join(loaded.artifactsDir, snapshot.kind === "baseline" ? "latest-baseline.json" : "latest-run.json");

  await writeJsonFile(snapshotPath, snapshot);
  await writeJsonFile(latestPath, snapshot);

  return snapshotPath;
}

export async function loadSnapshot(filePath: string): Promise<Snapshot> {
  return readJsonFile<Snapshot>(filePath);
}

export function latestBaselinePath(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "latest-baseline.json");
}

export function latestRunPath(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "latest-run.json");
}

function createSnapshotId(kind: SnapshotKind): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${kind}-${timestamp}`;
}
