import path from "node:path";
import { pathExists, readJsonFile } from "./files.js";
import { migrationRunDir } from "./migrationRun.js";
import type { LoadedConfig, MigrationActionPlan } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export function actionPlanPath(loaded: LoadedConfig, pkg: MigrationRunPackage): string {
  if (pkg.run.adapter === "md-monorepo") {
    return path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "md-monorepo-action-plan.json");
  }
  return path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "pnpm-vite-vue-action-plan.json");
}

export async function loadActionPlan(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<MigrationActionPlan> {
  const filePath = actionPlanPath(loaded, pkg);
  if (!await pathExists(filePath)) {
    throw new Error(`No action plan found for run ${pkg.run.id}. Run or resume a supported adapter migration first.`);
  }
  const raw = await readJsonFile<Partial<MigrationActionPlan>>(filePath);
  return {
    version: 1,
    runId: raw.runId ?? pkg.run.id,
    createdAt: raw.createdAt ?? pkg.run.updatedAt,
    goal: raw.goal ?? pkg.run.goal,
    actions: raw.actions ?? []
  };
}

export function renderActionPlan(plan: MigrationActionPlan): string {
  const lines = [
    `Run: ${plan.runId}`,
    `Goal: ${plan.goal}`,
    `Actions: ${plan.actions.length}`
  ];

  for (const action of plan.actions) {
    lines.push(
      `- ${action.id} [${action.risk}/${action.patchMode}] ${action.title}`,
      `  files: ${action.affectedFiles.join(", ") || "none"}`,
      `  checks: ${action.recommendedChecks.join(", ") || "none"}`
    );
    for (const readiness of action.checkReadiness ?? []) {
      lines.push(`  check-readiness: ${readiness.status} ${readiness.command} (${readiness.reason})`);
    }
  }

  return lines.join("\n");
}
