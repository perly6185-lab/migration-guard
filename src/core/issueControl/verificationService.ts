import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { writeCompareArtifactFile } from "../artifactV2.js";
import { compareSnapshots } from "../compare.js";
import { pathExists, writeTextFile } from "../files.js";
import { renderCompareReport } from "../markdown.js";
import { captureSnapshot, latestBaselinePath, loadSnapshot, saveSnapshot } from "../snapshot.js";
import type { IssueControlSuperviseVerification } from "../issueControl.js";

interface SnapshotCompareOptions {
  artifactName: (runId: string) => string;
  passedReason: string;
  failedReason: string;
  missingBaselineReason: (baselinePath: string) => string;
}

export async function runIssueControlSnapshotCompare(
  loaded: LoadedConfig,
  options: SnapshotCompareOptions
): Promise<IssueControlSuperviseVerification> {
  const baselinePath = latestBaselinePath(loaded);
  if (!await pathExists(baselinePath)) {
    return { status: "blocked", reason: options.missingBaselineReason(baselinePath), baselineSnapshotPath: baselinePath };
  }
  const baseline = await loadSnapshot(baselinePath);
  const run = await captureSnapshot(loaded, "run");
  const runSnapshotPath = await saveSnapshot(loaded, run);
  const compare = compareSnapshots(baseline, run, loaded.config.compare);
  const compareReportPath = path.join(loaded.artifactsDir, "issue-control", `${options.artifactName(run.id)}.json`);
  const compareMarkdownPath = compareReportPath.replace(/\.json$/, ".md");
  await writeCompareArtifactFile(compareReportPath, compare, baseline, run);
  await writeTextFile(compareMarkdownPath, renderCompareReport(compare));
  return {
    status: compare.passed ? "passed" : "failed",
    reason: compare.passed ? options.passedReason : options.failedReason,
    baselineSnapshotPath: baselinePath,
    runSnapshotPath,
    compareReportPath,
    compareMarkdownPath,
    differenceCount: compare.differences.length,
    differenceAreas: [...new Set(compare.differences.map((difference) => difference.area))]
  };
}
