import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type { IssueControlRecoveryExecution, IssueControlRecoveryPlan } from "../issueControl.js";
import { renderIssueControlRecoveryExecution, renderIssueControlRecoveryPlan } from "./recoveryRender.js";

export async function writeIssueControlRecoveryPlan(
  loaded: LoadedConfig,
  plan: IssueControlRecoveryPlan
): Promise<IssueControlRecoveryPlan> {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${plan.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  plan.outputPath = outputPath;
  plan.markdownPath = markdownPath;
  await writeJsonFile(outputPath, plan);
  await writeTextFile(markdownPath, renderIssueControlRecoveryPlan(plan));
  return plan;
}

export async function writeIssueControlRecoveryExecution(
  loaded: LoadedConfig,
  execution: IssueControlRecoveryExecution
): Promise<IssueControlRecoveryExecution> {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${execution.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  execution.outputPath = outputPath;
  execution.markdownPath = markdownPath;
  await writeJsonFile(outputPath, execution);
  await writeTextFile(markdownPath, renderIssueControlRecoveryExecution(execution));
  return execution;
}
