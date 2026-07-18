import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type { IssueControlPullReport } from "../issueControl.js";
import { renderIssueControlPull } from "./basicRender.js";

export async function writeIssueControlPullReport(loaded: LoadedConfig, report: IssueControlPullReport): Promise<IssueControlPullReport> {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlPull(report));
  return report;
}
