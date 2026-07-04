import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { appendEvidence, createId, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type { LoadedConfig, MigrationCheckpoint } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export async function createCheckpoint(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  taskId?: string,
  note?: string
): Promise<MigrationCheckpoint> {
  const id = createId("cp");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "checkpoints", id);
  const patchPath = path.join(dir, "patch.diff");
  const status = await runShellCommand("git status --short", {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const diff = await runShellCommand("git diff --binary", {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const checkpoint: MigrationCheckpoint = {
    version: 1,
    id,
    runId: pkg.run.id,
    taskId,
    createdAt: new Date().toISOString(),
    root: pkg.run.targetRoot,
    patchPath,
    gitStatus: status.exitCode === 0 ? status.stdout : status.stderr || status.error || "git status unavailable",
    note
  };

  await writeTextFile(patchPath, diff.exitCode === 0 ? diff.stdout : "");
  await writeJsonFile(path.join(dir, "metadata.json"), checkpoint);
  pkg.run.latestCheckpointId = id;
  await saveRunPackage(loaded, pkg);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId,
    type: "checkpoint-created",
    message: `Created checkpoint ${id}`,
    data: {
      patchPath,
      note
    }
  });

  return checkpoint;
}

export async function listCheckpoints(loaded: LoadedConfig, runId: string): Promise<MigrationCheckpoint[]> {
  const dir = path.join(migrationRunDir(loaded, runId), "checkpoints");
  if (!await pathExists(dir)) {
    return [];
  }

  const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
  const checkpoints: MigrationCheckpoint[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const metadataPath = path.join(dir, entry.name, "metadata.json");
    if (await pathExists(metadataPath)) {
      checkpoints.push(await readJsonFile<MigrationCheckpoint>(metadataPath));
    }
  }

  return checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function rollbackToCheckpoint(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  checkpointId: string
): Promise<string> {
  const metadataPath = path.join(migrationRunDir(loaded, pkg.run.id), "checkpoints", checkpointId, "metadata.json");
  const checkpoint = await readJsonFile<MigrationCheckpoint>(metadataPath);
  const patchExists = await pathExists(checkpoint.patchPath);

  if (!patchExists) {
    throw new Error(`Checkpoint patch not found: ${checkpoint.patchPath}`);
  }

  const patch = await import("node:fs/promises").then((fs) => fs.readFile(checkpoint.patchPath, "utf8"));
  if (patch.trim().length === 0) {
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: checkpoint.taskId,
      type: "rollback",
      message: `Checkpoint ${checkpointId} had an empty patch; no file changes were applied.`
    });
    return "Checkpoint patch is empty; nothing to roll back.";
  }

  const check = await runShellCommand(`git apply -R --check "${checkpoint.patchPath}"`, {
    cwd: checkpoint.root,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  if (check.exitCode !== 0) {
    throw new Error(`Rollback check failed:\n${check.stderr || check.stdout || check.error || "unknown error"}`);
  }

  const apply = await runShellCommand(`git apply -R "${checkpoint.patchPath}"`, {
    cwd: checkpoint.root,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  if (apply.exitCode !== 0) {
    throw new Error(`Rollback failed:\n${apply.stderr || apply.stdout || apply.error || "unknown error"}`);
  }

  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: checkpoint.taskId,
    type: "rollback",
    message: `Rolled back checkpoint ${checkpointId}`,
    data: {
      patchPath: checkpoint.patchPath
    }
  });

  return `Rolled back checkpoint ${checkpointId}.`;
}
