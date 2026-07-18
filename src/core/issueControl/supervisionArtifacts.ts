import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeJsonFile, writeTextFile } from "../files.js";
import type {
  IssueControlProgressStatusReport,
  IssueControlSuperviseProgressLedger,
  IssueControlSuperviseReport
} from "../issueControl.js";

interface SupervisionArtifactDependencies {
  createProgressLedger: (report: IssueControlSuperviseReport) => IssueControlSuperviseProgressLedger;
  renderProgressLedger: (ledger: IssueControlSuperviseProgressLedger) => string;
  renderSupervise: (report: IssueControlSuperviseReport) => string;
}

function reportPaths(loaded: LoadedConfig, id: string): { outputPath: string; markdownPath: string } {
  const outputPath = path.join(loaded.artifactsDir, "issue-control", `${id}.json`);
  return { outputPath, markdownPath: outputPath.replace(/\.json$/, ".md") };
}

export async function writeIssueControlSuperviseReport(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  dependencies: SupervisionArtifactDependencies
): Promise<IssueControlSuperviseReport> {
  const { outputPath, markdownPath } = reportPaths(loaded, report.id);
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  const progressLedger = await writeIssueControlSuperviseProgressLedger(
    loaded,
    dependencies.createProgressLedger(report),
    dependencies.renderProgressLedger
  );
  report.progressLedgerPath = progressLedger.outputPath;
  report.progressLedgerMarkdownPath = progressLedger.markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, dependencies.renderSupervise(report));
  return report;
}

async function writeIssueControlSuperviseProgressLedger(
  loaded: LoadedConfig,
  ledger: IssueControlSuperviseProgressLedger,
  render: (ledger: IssueControlSuperviseProgressLedger) => string
): Promise<IssueControlSuperviseProgressLedger> {
  const { outputPath, markdownPath } = reportPaths(loaded, ledger.id);
  ledger.outputPath = outputPath;
  ledger.markdownPath = markdownPath;
  await writeJsonFile(outputPath, ledger);
  await writeTextFile(markdownPath, render(ledger));
  return ledger;
}

export async function writeIssueControlProgressStatusReport(
  loaded: LoadedConfig,
  report: IssueControlProgressStatusReport,
  render: (report: IssueControlProgressStatusReport) => string
): Promise<IssueControlProgressStatusReport> {
  const { outputPath, markdownPath } = reportPaths(loaded, report.id);
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, render(report));
  return report;
}
