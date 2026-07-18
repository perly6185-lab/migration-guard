import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type { IssueControlAdvanceLoopReport, IssueControlAdvanceLoopState } from "../issueControl.js";
import { renderIssueControlAdvanceLoop, renderIssueControlAdvanceLoopState } from "./advanceRender.js";

export interface AdvanceLoopStatePaths {
  outputPath: string;
  markdownPath: string;
}

type CreateAdvanceLoopState = (
  report: IssueControlAdvanceLoopReport,
  previousState: IssueControlAdvanceLoopState | undefined,
  paths: AdvanceLoopStatePaths
) => Promise<IssueControlAdvanceLoopState>;

export async function writeIssueControlAdvanceLoopReport(
  loaded: LoadedConfig,
  report: IssueControlAdvanceLoopReport,
  previousState: IssueControlAdvanceLoopState | undefined,
  createState: CreateAdvanceLoopState
): Promise<IssueControlAdvanceLoopReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  const statePaths = {
    outputPath: path.join(dir, "issue-control-advance-loop-state.json"),
    markdownPath: path.join(dir, "issue-control-advance-loop-state.md")
  };
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  report.loopStatePath = statePaths.outputPath;
  report.loopStateMarkdownPath = statePaths.markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlAdvanceLoop(report));
  const state = await createState(report, previousState, statePaths);
  await writeJsonFile(statePaths.outputPath, state);
  await writeTextFile(statePaths.markdownPath, renderIssueControlAdvanceLoopState(state));
  return report;
}
