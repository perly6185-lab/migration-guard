import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { appendEvidence, createId, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type { LoadedConfig, MigrationCheckpoint } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export interface RollbackToCheckpointOptions {
  force?: boolean;
  strategy?: "auto" | "patch" | "reset";
  planHash?: string;
}

export interface CheckpointRollbackPlan {
  version: 1;
  runId: string;
  checkpointId: string;
  root: string;
  strategy: "patch" | "reset";
  patchPath: string;
  gitHead?: string;
  passed: boolean;
  blockers: string[];
  warnings: string[];
  currentHead?: string;
  currentStatusFingerprint: string;
  planHash: string;
}

interface GitCheckpointState {
  head?: string;
  branch?: string;
  status: string;
  statusFingerprint: string;
  stashSnapshot?: string;
  stashRef?: string;
  untrackedFiles: string[];
}

interface RollbackPrecheck {
  passed: boolean;
  blockers: string[];
  warnings: string[];
  current: GitCheckpointState;
}

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
  const gitState = await readGitCheckpointState(loaded, pkg.run.targetRoot, status.exitCode === 0 ? status.stdout : "");
  const diffCommand = gitState.head ? "git diff --binary HEAD" : "git diff --binary";
  const diff = await runShellCommand(diffCommand, {
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
    gitHead: gitState.head,
    gitBranch: gitState.branch,
    gitStatusFingerprint: gitState.statusFingerprint,
    gitStashSnapshot: gitState.stashSnapshot,
    gitStashRef: gitState.stashRef,
    untrackedFiles: gitState.untrackedFiles,
    sideEffects: await collectCheckpointSideEffects(pkg.run.targetRoot),
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
      gitHead: checkpoint.gitHead,
      gitBranch: checkpoint.gitBranch,
      gitStatusFingerprint: checkpoint.gitStatusFingerprint,
      untrackedFiles: checkpoint.untrackedFiles,
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
  checkpointId: string,
  options: RollbackToCheckpointOptions = {}
): Promise<string> {
  const metadataPath = path.join(migrationRunDir(loaded, pkg.run.id), "checkpoints", checkpointId, "metadata.json");
  const checkpoint = await readJsonFile<MigrationCheckpoint>(metadataPath);
  const patchExists = await pathExists(checkpoint.patchPath);

  if (!patchExists) {
    throw new Error(`Checkpoint patch not found: ${checkpoint.patchPath}`);
  }

  const plan = await planRollbackToCheckpoint(loaded, pkg, checkpointId, options.strategy);
  if (options.planHash && options.planHash !== plan.planHash) {
    throw new Error("Rollback plan changed; review a fresh plan before applying.");
  }
  const precheck = await checkRollbackSafety(loaded, checkpoint);
  if (!precheck.passed && !options.force) {
    throw new Error([
      "Rollback precheck failed.",
      ...precheck.blockers.map((blocker) => `- ${blocker}`),
      "Rerun with --force only after reviewing these changes."
    ].join("\n"));
  }

  const patch = await import("node:fs/promises").then((fs) => fs.readFile(checkpoint.patchPath, "utf8"));
  if (checkpoint.gitHead && options.strategy !== "patch") {
    const reset = await runShellCommand(`git reset --hard ${checkpoint.gitHead}`, {
      cwd: checkpoint.root,
      timeoutMs: 30000,
      maxOutputBytes: loaded.config.output.maxOutputBytes
    });
    if (reset.exitCode !== 0) {
      throw new Error(`Rollback reset failed:\n${reset.stderr || reset.stdout || reset.error || "unknown error"}`);
    }
    if (patch.trim().length > 0) {
      const check = await runShellCommand(`git apply --check "${checkpoint.patchPath}"`, {
        cwd: checkpoint.root,
        timeoutMs: 30000,
        maxOutputBytes: loaded.config.output.maxOutputBytes
      });
      if (check.exitCode !== 0) {
        throw new Error(`Rollback checkpoint restore check failed:\n${check.stderr || check.stdout || check.error || "unknown error"}`);
      }
      const apply = await runShellCommand(`git apply "${checkpoint.patchPath}"`, {
        cwd: checkpoint.root,
        timeoutMs: 30000,
        maxOutputBytes: loaded.config.output.maxOutputBytes
      });
      if (apply.exitCode !== 0) {
        throw new Error(`Rollback checkpoint restore failed:\n${apply.stderr || apply.stdout || apply.error || "unknown error"}`);
      }
    }
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: checkpoint.taskId,
      type: "rollback",
      message: `Rolled back checkpoint ${checkpointId} with git reset strategy`,
      data: {
        patchPath: checkpoint.patchPath,
        gitHead: checkpoint.gitHead,
        forced: Boolean(options.force),
        precheck
      }
    });
    return `Rolled back checkpoint ${checkpointId} to ${checkpoint.gitHead}.`;
  }

  if (patch.trim().length === 0) {
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: checkpoint.taskId,
      type: "rollback",
      message: `Checkpoint ${checkpointId} had an empty patch; no file changes were applied.`,
      data: {
        forced: Boolean(options.force),
        precheck
      }
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
      patchPath: checkpoint.patchPath,
      forced: Boolean(options.force),
      precheck
    }
  });

  return `Rolled back checkpoint ${checkpointId}.`;
}

export async function planRollbackToCheckpoint(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  checkpointId: string,
  strategy: RollbackToCheckpointOptions["strategy"] = "auto"
): Promise<CheckpointRollbackPlan> {
  const metadataPath = path.join(migrationRunDir(loaded, pkg.run.id), "checkpoints", checkpointId, "metadata.json");
  const checkpoint = await readJsonFile<MigrationCheckpoint>(metadataPath);
  if (!await pathExists(checkpoint.patchPath)) throw new Error(`Checkpoint patch not found: ${checkpoint.patchPath}`);
  const precheck = await checkRollbackSafety(loaded, checkpoint);
  const selectedStrategy: "patch" | "reset" = checkpoint.gitHead && strategy !== "patch" ? "reset" : "patch";
  const payload = {
    version: 1 as const,
    runId: pkg.run.id,
    checkpointId,
    root: checkpoint.root,
    strategy: selectedStrategy,
    patchPath: checkpoint.patchPath,
    gitHead: checkpoint.gitHead,
    passed: precheck.passed,
    blockers: precheck.blockers,
    warnings: precheck.warnings,
    currentHead: precheck.current.head,
    currentStatusFingerprint: precheck.current.statusFingerprint
  };
  return { ...payload, planHash: fingerprint(JSON.stringify(payload)) };
}

async function readGitCheckpointState(
  loaded: LoadedConfig,
  root: string,
  knownStatus?: string
): Promise<GitCheckpointState> {
  const status = excludeManagedArtifactStatus(knownStatus ?? await gitOutput(loaded, root, "git status --short") ?? "", root, loaded.artifactsDir);
  const untracked = splitLines(await gitOutput(loaded, root, "git ls-files --others --exclude-standard"))
    .filter((file) => !isManagedArtifactPath(file, root, loaded.artifactsDir));
  return {
    head: await gitOutput(loaded, root, "git rev-parse --verify HEAD"),
    branch: await gitOutput(loaded, root, "git branch --show-current"),
    status,
    statusFingerprint: fingerprint(status),
    stashSnapshot: await gitOutput(loaded, root, "git stash create migration-guard-checkpoint"),
    stashRef: await gitOutput(loaded, root, "git rev-parse --verify refs/stash"),
    untrackedFiles: untracked
  };
}

function excludeManagedArtifactStatus(status: string, root: string, artifactsDir: string): string {
  return status.split(/\r?\n/).filter((line) => {
    const changedPath = line.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/");
    return changedPath && !isManagedArtifactPath(changedPath, root, artifactsDir);
  }).join("\n");
}

function isManagedArtifactPath(filePath: string, root: string, artifactsDir: string): boolean {
  const relativeArtifacts = path.relative(root, artifactsDir).replace(/\\/g, "/");
  if (!relativeArtifacts || relativeArtifacts.startsWith("..") || path.isAbsolute(relativeArtifacts)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === relativeArtifacts || normalized.startsWith(`${relativeArtifacts}/`);
}

async function checkRollbackSafety(
  loaded: LoadedConfig,
  checkpoint: MigrationCheckpoint
): Promise<RollbackPrecheck> {
  const current = await readGitCheckpointState(loaded, checkpoint.root);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (checkpoint.gitHead && current.head && current.head !== checkpoint.gitHead) {
    blockers.push(`checkpoint HEAD ${checkpoint.gitHead} differs from current HEAD ${current.head}`);
  }
  const checkpointUntracked = new Set(checkpoint.untrackedFiles ?? []);
  const newUntracked = current.untrackedFiles.filter((file) => !checkpointUntracked.has(file));
  if (newUntracked.length > 0) {
    blockers.push(`new untracked files are outside checkpoint state: ${newUntracked.join(", ")}`);
  }
  if (checkpoint.gitStatusFingerprint && current.statusFingerprint !== checkpoint.gitStatusFingerprint) {
    warnings.push("current git status differs from checkpoint git status");
  }
  const sideEffectBlockers = await compareCheckpointSideEffects(checkpoint);
  blockers.push(...sideEffectBlockers);
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    current
  };
}

async function compareCheckpointSideEffects(checkpoint: MigrationCheckpoint): Promise<string[]> {
  const sideEffects = checkpoint.sideEffects;
  if (!sideEffects) {
    return [];
  }
  const blockers: string[] = [];
  for (const expected of sideEffects.lockfiles) {
    const filePath = path.join(checkpoint.root, expected.path);
    const exists = await pathExists(filePath);
    if (exists !== expected.exists) {
      blockers.push(`lockfile ${expected.path} existence changed since checkpoint`);
      continue;
    }
    if (exists && expected.sha256) {
      const currentHash = await fileSha256(filePath);
      if (currentHash !== expected.sha256) {
        blockers.push(`lockfile ${expected.path} changed since checkpoint`);
      }
    }
  }
  if (sideEffects.nodeModules) {
    const exists = await pathExists(path.join(checkpoint.root, sideEffects.nodeModules.path));
    if (exists !== sideEffects.nodeModules.exists) {
      blockers.push(`${sideEffects.nodeModules.path} existence changed since checkpoint`);
    }
  }
  return blockers;
}

async function collectCheckpointSideEffects(root: string): Promise<NonNullable<MigrationCheckpoint["sideEffects"]>> {
  const lockfileNames = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "npm-shrinkwrap.json"
  ];
  const lockfiles = [];
  for (const name of lockfileNames) {
    const filePath = path.join(root, name);
    const exists = await pathExists(filePath);
    lockfiles.push({
      path: name,
      exists,
      sha256: exists ? await fileSha256(filePath) : undefined
    });
  }
  return {
    lockfiles,
    nodeModules: {
      path: "node_modules",
      exists: await pathExists(path.join(root, "node_modules"))
    }
  };
}

async function gitOutput(
  loaded: LoadedConfig,
  root: string,
  command: string
): Promise<string | undefined> {
  const result = await runShellCommand(command, {
    cwd: root,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function fingerprint(value?: string): string {
  return createHash("sha256").update(value ?? "").digest("hex");
}

function splitLines(value?: string): string[] {
  return value?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
}
