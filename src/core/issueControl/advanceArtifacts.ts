import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type {
  IssueControlAdvanceReport,
  IssueControlAdvanceSchedulerReport,
  IssueControlSyncGateReport
} from "../issueControl.js";
import {
  renderIssueControlAdvance,
  renderIssueControlAdvanceScheduler,
  renderIssueControlSyncGate
} from "./advanceRender.js";

async function writeReport<T extends { id: string; outputPath?: string; markdownPath?: string }>(
  loaded: LoadedConfig,
  report: T,
  render: (report: T) => string
): Promise<T> {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, render(report));
  return report;
}

export function writeIssueControlAdvanceReport(loaded: LoadedConfig, report: IssueControlAdvanceReport): Promise<IssueControlAdvanceReport> {
  return writeReport(loaded, report, renderIssueControlAdvance);
}

export function writeIssueControlAdvanceSchedulerReport(loaded: LoadedConfig, report: IssueControlAdvanceSchedulerReport): Promise<IssueControlAdvanceSchedulerReport> {
  return writeReport(loaded, report, renderIssueControlAdvanceScheduler);
}

export function writeIssueControlSyncGateReport(loaded: LoadedConfig, report: IssueControlSyncGateReport): Promise<IssueControlSyncGateReport> {
  return writeReport(loaded, report, renderIssueControlSyncGate);
}
