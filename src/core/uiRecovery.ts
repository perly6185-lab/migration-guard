import path from "node:path";
import { listCheckpoints, planRollbackToCheckpoint, rollbackToCheckpoint, type CheckpointRollbackPlan } from "./checkpoint.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { loadRunPackage, migrationRunDir } from "./migrationRun.js";
import { UiHttpError } from "./uiHttpError.js";
import type { LoadedConfig, MigrationCheckpoint } from "../types.js";

export interface UiRecoveryReport {
  version: 1;
  runId: string;
  checkpoints: MigrationCheckpoint[];
}

export interface UiRecoveryPlanArtifact extends CheckpointRollbackPlan {
  createdAt: string;
  outputPath: string;
}

export async function collectUiRecovery(loaded: LoadedConfig, runSelector = "latest"): Promise<UiRecoveryReport> {
  const pkg = await loadRunPackage(loaded, runSelector);
  return { version: 1, runId: pkg.run.id, checkpoints: (await listCheckpoints(loaded, pkg.run.id)).reverse() };
}

export async function writeUiRecoveryPlan(loaded: LoadedConfig, runSelector: string, checkpointId: string): Promise<UiRecoveryPlanArtifact> {
  const pkg = await loadRunPackage(loaded, runSelector);
  const plan = await planRollbackToCheckpoint(loaded, pkg, checkpointId);
  const outputPath = recoveryPlanPath(loaded, pkg.run.id, plan.planHash);
  const artifact = { ...plan, createdAt: new Date().toISOString(), outputPath };
  await writeJsonFile(outputPath, artifact);
  return artifact;
}

export async function applyUiRecoveryPlan(loaded: LoadedConfig, runSelector: string, planHash: string): Promise<{ version: 1; status: "applied"; message: string; plan: UiRecoveryPlanArtifact; outputPath: string }> {
  if (!/^[a-f0-9]{64}$/.test(planHash)) throw new UiHttpError("Invalid recovery plan hash.", 400);
  const pkg = await loadRunPackage(loaded, runSelector);
  const planPath = recoveryPlanPath(loaded, pkg.run.id, planHash);
  const plan = await readJsonFile<UiRecoveryPlanArtifact>(planPath).catch(() => undefined);
  if (!plan || plan.runId !== pkg.run.id || plan.planHash !== planHash) throw new UiHttpError("Recovery plan not found for this run.", 404);
  if (!plan.passed) throw new UiHttpError("Recovery plan has blockers and cannot be applied from the UI.", 409);
  const current = await planRollbackToCheckpoint(loaded, pkg, plan.checkpointId);
  if (current.planHash !== plan.planHash) throw new UiHttpError("Recovery state changed; create and review a fresh plan.", 409);
  const message = await rollbackToCheckpoint(loaded, pkg, plan.checkpointId, { planHash: plan.planHash });
  const outputPath = path.join(path.dirname(planPath), `${planHash}.applied.json`);
  const result = { version: 1 as const, status: "applied" as const, message, plan, outputPath };
  await writeJsonFile(outputPath, result);
  return result;
}

function recoveryPlanPath(loaded: LoadedConfig, runId: string, planHash: string): string {
  return path.join(migrationRunDir(loaded, runId), "recovery-plans", `${planHash}.json`);
}
