import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type { IssueControlAutoReport, IssueControlRunReport } from "../issueControl.js";
import { renderIssueControlAuto, renderIssueControlRun } from "./executionRender.js";

async function writeReport<T extends { id: string; outputPath?: string; markdownPath?: string }>(loaded: LoadedConfig, report: T, render: (value: T) => string): Promise<T> {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, render(report));
  return report;
}

export function writeIssueControlRunReport(loaded: LoadedConfig, report: IssueControlRunReport): Promise<IssueControlRunReport> {
  return writeReport(loaded, report, renderIssueControlRun);
}

export function writeIssueControlAutoReport(loaded: LoadedConfig, report: IssueControlAutoReport): Promise<IssueControlAutoReport> {
  return writeReport(loaded, report, renderIssueControlAuto);
}
