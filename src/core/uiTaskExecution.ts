import path from "node:path";
import { promises as fs } from "node:fs";
import { compareSnapshots } from "./compare.js";
import { runShellCommand } from "./exec.js";
import { executeTask } from "./executor.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import { updateHealthDebtLedger } from "./healthDebt.js";
import { loadRunPackage, migrationRunDir } from "./migrationRun.js";
import { stableStringify } from "./normalize.js";
import { captureSnapshot, latestBaselinePath, loadSnapshot, saveSnapshot } from "./snapshot.js";
import { writeCompareArtifactFile } from "./artifactV2.js";
import { UiHttpError } from "./uiHttpError.js";
import type { LoadedConfig, MigrationTask } from "../types.js";

export interface UiTaskExecutionPlan {
  version: 1;
  runId: string;
  task: MigrationTask;
  targetRoot: string;
  affectedPaths: string[];
  baselinePath: string;
  baselineAvailable: boolean;
  gitHead?: string;
  gitStatusFingerprint: string;
  passed: boolean;
  blockers: string[];
  warnings: string[];
  planHash: string;
  createdAt: string;
  outputPath: string;
}

export async function writeUiTaskExecutionPlan(loaded: LoadedConfig, runSelector: string, taskId: string): Promise<UiTaskExecutionPlan> {
  const plan = await collectPlan(loaded, runSelector, taskId);
  const outputPath = taskPlanPath(loaded, plan.runId, plan.planHash);
  const artifact = { ...plan, createdAt: new Date().toISOString(), outputPath };
  await writeJsonFile(outputPath, artifact);
  return artifact;
}

export async function executeUiTaskPlan(loaded: LoadedConfig, runSelector: string, taskId: string, planHash: string): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(planHash)) throw new UiHttpError("Invalid task execution plan hash.", 400);
  const pkg = await loadRunPackage(loaded, runSelector);
  const stored = await readJsonFile<UiTaskExecutionPlan>(taskPlanPath(loaded, pkg.run.id, planHash)).catch(() => undefined);
  if (!stored || stored.task.id !== taskId || stored.runId !== pkg.run.id) throw new UiHttpError("Task execution plan not found for this task and run.", 404);
  if (!stored.passed) throw new UiHttpError("Task execution plan has blockers.", 409);
  const current = await collectPlan(loaded, pkg.run.id, taskId);
  if (current.planHash !== stored.planHash) throw new UiHttpError("Task or repository state changed; create and review a fresh plan.", 409);
  const task = await executeTask(loaded, pkg, taskId, { createCheckpoint: true });
  if (task.status !== "done") return { status: "failed", task, checkpointId: pkg.run.latestCheckpointId };
  const snapshot = await captureSnapshot(loaded, "run");
  const snapshotPath = await saveSnapshot(loaded, snapshot);
  const baseline = await loadSnapshot(stored.baselinePath);
  const compare = compareSnapshots(baseline, snapshot, loaded.config.compare);
  const debt = await updateHealthDebtLedger(loaded, compare);
  const comparePath = path.join(loaded.artifactsDir, "compare", `${Date.now()}.json`);
  await writeCompareArtifactFile(comparePath, compare, baseline, snapshot, debt);
  return {
    status: compare.passed ? "accepted" : "verification-failed",
    task,
    checkpointId: pkg.run.latestCheckpointId,
    snapshotPath,
    comparePath,
    comparePassed: compare.passed,
    differences: compare.differences.length,
    health: compare.checkHealth
  };
}

async function collectPlan(loaded: LoadedConfig, runSelector: string, taskId: string): Promise<Omit<UiTaskExecutionPlan, "createdAt" | "outputPath">> {
  const pkg = await loadRunPackage(loaded, runSelector);
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new UiHttpError("Task not found.", 404);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!['ready', 'failed', 'replanned'].includes(task.status)) blockers.push(`Task status is ${task.status}; expected ready, failed or replanned.`);
  if (task.risk === "high") blockers.push("High-risk tasks require CLI or human-supervised execution.");
  if (task.owner !== "engine") warnings.push(`Task owner is ${task.owner}; verify the executor boundary before applying.`);
  const affectedPaths = task.affectedFiles.map((value) => value.replace(/\\/g, "/"));
  if (affectedPaths.length > 50) blockers.push("Task affects more than 50 declared paths.");
  for (const value of affectedPaths) {
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) blockers.push(`Unsafe affected path: ${value || "<empty>"}`);
  }
  const baselinePath = latestBaselinePath(loaded);
  const baselineAvailable = Boolean(await fs.stat(baselinePath).catch(() => undefined));
  if (!baselineAvailable) blockers.push("A behavior baseline is required before task execution.");
  const git = await gitState(loaded, pkg.run.targetRoot);
  if (git.status.trim()) warnings.push("Target Git worktree is dirty; checkpoint will preserve the reviewed state.");
  const payload = {
    version: 1 as const,
    runId: pkg.run.id,
    task,
    targetRoot: pkg.run.targetRoot,
    affectedPaths,
    baselinePath,
    baselineAvailable,
    gitHead: git.head,
    gitStatusFingerprint: sha256(git.status),
    passed: blockers.length === 0,
    blockers,
    warnings
  };
  return { ...payload, planHash: sha256(stableStringify(payload)) };
}

async function gitState(loaded: LoadedConfig, root: string): Promise<{ head?: string; status: string }> {
  const [head, status] = await Promise.all([
    runShellCommand("git rev-parse --verify HEAD", { cwd: root, timeoutMs: 30000, maxOutputBytes: loaded.config.output.maxOutputBytes }),
    runShellCommand("git status --porcelain=v1 --untracked-files=all", { cwd: root, timeoutMs: 30000, maxOutputBytes: loaded.config.output.maxOutputBytes })
  ]);
  return {
    head: head.exitCode === 0 ? head.stdout.trim() || undefined : undefined,
    status: status.exitCode === 0 ? excludeArtifactStatus(status.stdout, root, loaded.artifactsDir) : "git-status-unavailable"
  };
}

function excludeArtifactStatus(status: string, root: string, artifactsDir: string): string {
  const relativeArtifacts = path.relative(root, artifactsDir).replace(/\\/g, "/");
  if (!relativeArtifacts || relativeArtifacts.startsWith("..") || path.isAbsolute(relativeArtifacts)) return status;
  return status.split(/\r?\n/).filter((line) => {
    const changedPath = line.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/");
    return changedPath !== relativeArtifacts && !changedPath.startsWith(`${relativeArtifacts}/`);
  }).filter(Boolean).join("\n");
}

function taskPlanPath(loaded: LoadedConfig, runId: string, planHash: string): string {
  return path.join(migrationRunDir(loaded, runId), "task-execution-plans", `${planHash}.json`);
}
