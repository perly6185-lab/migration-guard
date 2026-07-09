import { promises as fs } from "node:fs";
import path from "node:path";
import { compareSnapshots } from "./compare.js";
import { runShellCommand } from "./exec.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { renderCompareReport } from "./markdown.js";
import { latestBaselinePath, latestRunPath, loadSnapshot } from "./snapshot.js";
import type { CheckResult, CompareReport, LoadedConfig, ProbeResult, Snapshot } from "../types.js";

export interface OneShotReportOptions {
  baselinePath?: string;
  currentPath?: string;
  compareReportPath?: string;
  maxSourceFileDelta?: number;
  checkTargetGit?: boolean;
}

export interface OneShotCriterion {
  id: string;
  title: string;
  status: "passed" | "blocked" | "warning";
  summary: string;
  evidence?: string[];
  nextAction?: string;
}

export interface OneShotReport {
  version: 1;
  id: string;
  createdAt: string;
  status: "go" | "hold";
  baselineId: string;
  currentId: string;
  baselinePath: string;
  currentPath: string;
  compareReportPath?: string;
  summary: {
    checkCount: number;
    passedChecks: number;
    criticalCheckFailures: number;
    probeCount: number;
    passedProbes: number;
    probeFailures: number;
    comparePassed: boolean;
    differenceCount: number;
    sourceFileDelta: number;
    maxSourceFileDelta: number;
    targetClean?: boolean;
    blockerCount: number;
    warningCount: number;
  };
  criteria: OneShotCriterion[];
  compareMarkdown: string;
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

interface TargetGitStatus {
  clean: boolean;
  output: string;
  error?: string;
}

const DEFAULT_MAX_SOURCE_FILE_DELTA = 0;

export async function collectOneShotReport(
  loaded: LoadedConfig,
  options: OneShotReportOptions = {}
): Promise<OneShotReport> {
  const baselinePath = path.resolve(loaded.baseDir, options.baselinePath ?? latestBaselinePath(loaded));
  const currentPath = path.resolve(loaded.baseDir, options.currentPath ?? latestRunPath(loaded));
  const baseline = await loadSnapshot(baselinePath);
  const current = await loadSnapshot(currentPath);
  const compareArtifact = options.compareReportPath
    ? {
        path: path.resolve(loaded.baseDir, options.compareReportPath),
        report: await readJsonFile<CompareReport>(path.resolve(loaded.baseDir, options.compareReportPath))
      }
    : await findLatestCompareReport(loaded, baseline.id, current.id);
  const compareReport = compareArtifact?.report ?? compareSnapshots(baseline, current, loaded.config.compare);
  const maxSourceFileDelta = options.maxSourceFileDelta ?? DEFAULT_MAX_SOURCE_FILE_DELTA;
  const targetStatus = options.checkTargetGit === false ? undefined : await readTargetGitStatus(loaded);
  const criteria = createOneShotCriteria({
    baseline,
    current,
    baselinePath,
    currentPath,
    compareReport,
    compareReportPath: compareArtifact?.path,
    maxSourceFileDelta,
    targetStatus
  });
  const blockerCount = criteria.filter((criterion) => criterion.status === "blocked").length;
  const warningCount = criteria.filter((criterion) => criterion.status === "warning").length;
  const criticalCheckFailures = current.checks.filter((check) => check.critical && check.status !== "passed").length;
  const probeFailures = current.probes.filter((probe) => probe.status !== "passed").length;

  return {
    version: 1,
    id: `one-shot-report-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    createdAt: new Date().toISOString(),
    status: blockerCount === 0 ? "go" : "hold",
    baselineId: baseline.id,
    currentId: current.id,
    baselinePath,
    currentPath,
    compareReportPath: compareArtifact?.path,
    summary: {
      checkCount: current.checks.length,
      passedChecks: current.checks.filter((check) => check.status === "passed").length,
      criticalCheckFailures,
      probeCount: current.probes.length,
      passedProbes: current.probes.filter((probe) => probe.status === "passed").length,
      probeFailures,
      comparePassed: compareReport.passed,
      differenceCount: compareReport.differences.length,
      sourceFileDelta: current.scan.sourceFiles - baseline.scan.sourceFiles,
      maxSourceFileDelta,
      targetClean: targetStatus?.clean,
      blockerCount,
      warningCount
    },
    criteria,
    compareMarkdown: renderCompareReport(compareReport),
    recommendedNextActions: criteria
      .filter((criterion) => criterion.status === "blocked" && criterion.nextAction)
      .map((criterion) => criterion.nextAction as string)
  };
}

export async function writeOneShotReport(loaded: LoadedConfig, report: OneShotReport): Promise<OneShotReport> {
  const dir = path.join(loaded.artifactsDir, "one-shot");
  const jsonPath = path.join(dir, `${report.id}.json`);
  const markdownPath = path.join(dir, `${report.id}.md`);
  const withPaths = {
    ...report,
    outputPath: jsonPath,
    markdownPath
  };

  await ensureDir(dir);
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderOneShotReport(withPaths));
  return withPaths;
}

export function renderOneShotReport(report: OneShotReport): string {
  const lines = [
    `# One-Shot Report: ${report.id}`,
    "",
    `- Status: ${report.status}`,
    `- Baseline: ${report.baselineId}`,
    `- Current: ${report.currentId}`,
    `- Checks: ${report.summary.passedChecks}/${report.summary.checkCount} passed`,
    `- Critical check failures: ${report.summary.criticalCheckFailures}`,
    `- Probes: ${report.summary.passedProbes}/${report.summary.probeCount} passed`,
    `- Probe failures: ${report.summary.probeFailures}`,
    `- Compare passed: ${report.summary.comparePassed ? "yes" : "no"}`,
    `- Differences: ${report.summary.differenceCount}`,
    `- Source file delta: ${report.summary.sourceFileDelta} (budget ${report.summary.maxSourceFileDelta})`,
    `- Target clean: ${report.summary.targetClean === undefined ? "not checked" : report.summary.targetClean ? "yes" : "no"}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    "",
    "## Criteria",
    "",
    ...report.criteria.flatMap((criterion) => [
      `- ${criterion.status} ${criterion.id}: ${criterion.summary}`,
      ...(criterion.evidence ?? []).map((item) => `  evidence: ${item}`),
      criterion.nextAction ? `  next: ${criterion.nextAction}` : undefined
    ].filter((line): line is string => Boolean(line))),
    "",
    "## Recommended Next Actions",
    "",
    ...(report.recommendedNextActions.length > 0
      ? report.recommendedNextActions.map((action) => `- ${action}`)
      : ["- none"]),
    "",
    "## Compare",
    "",
    report.compareMarkdown
  ];

  if (report.outputPath || report.markdownPath || report.compareReportPath) {
    lines.push("", "## Artifacts", "");
    if (report.outputPath) {
      lines.push(`- JSON: ${report.outputPath}`);
    }
    if (report.markdownPath) {
      lines.push(`- Markdown: ${report.markdownPath}`);
    }
    if (report.compareReportPath) {
      lines.push(`- Compare JSON: ${report.compareReportPath}`);
    }
  }

  return lines.join("\n");
}

function createOneShotCriteria(input: {
  baseline: Snapshot;
  current: Snapshot;
  baselinePath: string;
  currentPath: string;
  compareReport: CompareReport;
  compareReportPath?: string;
  maxSourceFileDelta: number;
  targetStatus?: TargetGitStatus;
}): OneShotCriterion[] {
  return [
    {
      id: "baseline",
      title: "Baseline snapshot available",
      status: "passed",
      summary: `${input.baseline.id} is available`,
      evidence: [input.baselinePath]
    },
    {
      id: "current-run",
      title: "Current verification run available",
      status: "passed",
      summary: `${input.current.id} is available`,
      evidence: [input.currentPath]
    },
    createCheckCriterion(input.current.checks),
    createProbeCriterion(input.current.probes),
    createCompareCriterion(input.compareReport, input.compareReportPath),
    createSourceFileBudgetCriterion(input.baseline, input.current, input.maxSourceFileDelta),
    createTargetCleanCriterion(input.targetStatus)
  ];
}

function createCheckCriterion(checks: CheckResult[]): OneShotCriterion {
  const criticalFailures = checks.filter((check) => check.critical && check.status !== "passed");
  if (criticalFailures.length === 0) {
    return {
      id: "critical-checks",
      title: "Critical checks pass",
      status: "passed",
      summary: `${checks.filter((check) => check.status === "passed").length}/${checks.length} check(s) passed`
    };
  }
  return {
    id: "critical-checks",
    title: "Critical checks pass",
    status: "blocked",
    summary: `${criticalFailures.length} critical check(s) failed`,
    evidence: criticalFailures.map((check) => `${check.name}:${check.status}`),
    nextAction: "Fix failing critical checks, then rerun migration-guard verify."
  };
}

function createProbeCriterion(probes: ProbeResult[]): OneShotCriterion {
  const failures = probes.filter((probe) => probe.status !== "passed");
  if (failures.length === 0) {
    return {
      id: "behavior-probes",
      title: "Behavior probes pass",
      status: "passed",
      summary: `${probes.length}/${probes.length} probe(s) passed`
    };
  }
  return {
    id: "behavior-probes",
    title: "Behavior probes pass",
    status: "blocked",
    summary: `${failures.length} probe(s) failed`,
    evidence: failures.map((probe) => `${probe.name}:${probe.status}`),
    nextAction: "Investigate probe drift, classify intentional differences, or fix the target change before continuing."
  };
}

function createCompareCriterion(report: CompareReport, compareReportPath?: string): OneShotCriterion {
  if (report.passed) {
    const riskDifferences = report.differences.filter((difference) => difference.severity !== "info");
    return {
      id: "compare",
      title: "Baseline/current compare passes",
      status: riskDifferences.length === 0 ? "passed" : "warning",
      summary: report.differences.length === 0
        ? "no differences detected"
        : `${report.differences.length} passing difference(s), ${riskDifferences.length} warning/error-severity item(s)`,
      evidence: compareReportPath ? [compareReportPath] : undefined
    };
  }
  return {
    id: "compare",
    title: "Baseline/current compare passes",
    status: "blocked",
    summary: `${report.differences.length} difference(s) caused compare to fail`,
    evidence: [
      compareReportPath,
      ...report.differences.slice(0, 5).map((difference) => `${difference.severity}:${difference.area}/${difference.name}:${difference.message}`)
    ].filter((item): item is string => Boolean(item)),
    nextAction: "Inspect the compare report, classify intentional drift, or fix accidental behavior changes."
  };
}

function createSourceFileBudgetCriterion(
  baseline: Snapshot,
  current: Snapshot,
  maxSourceFileDelta: number
): OneShotCriterion {
  const delta = current.scan.sourceFiles - baseline.scan.sourceFiles;
  const withinBudget = Math.abs(delta) <= maxSourceFileDelta;
  if (withinBudget) {
    return {
      id: "source-file-budget",
      title: "Source file delta stays within budget",
      status: "passed",
      summary: `source file delta ${delta} is within budget ${maxSourceFileDelta}`
    };
  }
  return {
    id: "source-file-budget",
    title: "Source file delta stays within budget",
    status: "blocked",
    summary: `source file delta ${delta} exceeds budget ${maxSourceFileDelta}`,
    nextAction: "Reduce the one-shot scope or rerun with an explicit source-file budget that matches the planned change."
  };
}

function createTargetCleanCriterion(targetStatus?: TargetGitStatus): OneShotCriterion {
  if (!targetStatus) {
    return {
      id: "target-clean",
      title: "Target repository clean",
      status: "warning",
      summary: "target git status was not checked",
      nextAction: "Run one-shot report without --skip-target-git before merge closure."
    };
  }
  if (targetStatus.clean) {
    return {
      id: "target-clean",
      title: "Target repository clean",
      status: "passed",
      summary: "target repository is clean",
      evidence: [targetStatus.output || "git status --short --branch returned no working tree changes"]
    };
  }
  return {
    id: "target-clean",
    title: "Target repository clean",
    status: "blocked",
    summary: "target repository has uncommitted changes or git status failed",
    evidence: [targetStatus.output || targetStatus.error || "no git status output"],
    nextAction: "Commit, rollback, or stash target changes before treating one-shot evidence as closed."
  };
}

async function findLatestCompareReport(
  loaded: LoadedConfig,
  baselineId: string,
  currentId: string
): Promise<{ path: string; report: CompareReport } | undefined> {
  const compareDir = path.join(loaded.artifactsDir, "compare");
  if (!await pathExists(compareDir)) {
    return undefined;
  }
  const entries = await fs.readdir(compareDir, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const filePath = path.join(compareDir, entry.name);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));

  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const report = await readJsonFile<CompareReport>(candidate.filePath).catch(() => undefined);
    if (report?.baselineId === baselineId && report.currentId === currentId) {
      return { path: candidate.filePath, report };
    }
  }
  return undefined;
}

async function readTargetGitStatus(loaded: LoadedConfig): Promise<TargetGitStatus> {
  const result = await runShellCommand("git status --short --branch", {
    cwd: loaded.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    clean: result.exitCode === 0 && !result.timedOut && !result.error && lines.every((line) => line.startsWith("## ")),
    output,
    error: result.error
  };
}
