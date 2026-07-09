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
  metadata?: OneShotWindowMetadata;
  detectGitMetadata?: boolean;
}

export interface OneShotRunbookOptions {
  maxSourceFileDelta?: number;
  metadata?: OneShotWindowMetadata;
  commandPrefix?: string;
}

export interface OneShotWindowMetadata {
  name?: string;
  branch?: string;
  baseBranch?: string;
  prUrl?: string;
  targetCommit?: string;
  mergeCommit?: string;
  mergedAt?: string;
  budget?: string;
  notes?: string[];
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
  metadata: OneShotWindowMetadata;
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
    metadataComplete: boolean;
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

export interface OneShotRunbookStep {
  id: string;
  title: string;
  status: "pending";
  description: string;
  command?: string;
  completionCriteria: string[];
}

export interface OneShotRunbook {
  version: 1;
  id: string;
  createdAt: string;
  targetRoot: string;
  artifactsDir: string;
  configPath: string;
  maxSourceFileDelta: number;
  metadata: OneShotWindowMetadata;
  steps: OneShotRunbookStep[];
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
  const gitMetadata = options.detectGitMetadata === false ? {} : await readTargetGitMetadata(loaded);
  const metadata = mergeOneShotMetadata(gitMetadata, options.metadata);
  const targetStatus = options.checkTargetGit === false ? undefined : await readTargetGitStatus(loaded);
  const criteria = createOneShotCriteria({
    baseline,
    current,
    baselinePath,
    currentPath,
    compareReport,
    compareReportPath: compareArtifact?.path,
    maxSourceFileDelta,
    metadata,
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
    metadata,
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
      metadataComplete: isMetadataComplete(metadata),
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

export function createOneShotRunbook(
  loaded: LoadedConfig,
  options: OneShotRunbookOptions = {}
): OneShotRunbook {
  const maxSourceFileDelta = options.maxSourceFileDelta ?? DEFAULT_MAX_SOURCE_FILE_DELTA;
  const commandPrefix = options.commandPrefix ?? "node dist/cli.js";
  const configArg = `--config ${quoteShellArg(loaded.path)}`;
  const sourceBudgetArg = `--max-source-file-delta ${maxSourceFileDelta}`;
  const metadata = options.metadata ?? {};
  const metadataArgs = createMetadataCommandArgs(metadata);
  const reportCommand = `${commandPrefix} one-shot report ${configArg} ${sourceBudgetArg}${metadataArgs ? ` ${metadataArgs}` : ""} --strict`;
  const closureReportCommand = `${commandPrefix} one-shot report ${configArg} ${sourceBudgetArg} --pr-url <pr-url> --target-commit <target-commit> --merge-commit <merge-commit> --merged-at <iso-time> --budget <budget> --strict`;

  return {
    version: 1,
    id: `one-shot-runbook-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    createdAt: new Date().toISOString(),
    targetRoot: loaded.targetRoot,
    artifactsDir: loaded.artifactsDir,
    configPath: loaded.path,
    maxSourceFileDelta,
    metadata,
    steps: [
      {
        id: "target-prep",
        title: "Prepare target branch",
        status: "pending",
        description: "Start from a clean target repository and create or select the one-shot working branch.",
        command: "git status --short --branch",
        completionCriteria: [
          "target working tree is clean",
          "base branch is current",
          "one-shot branch name and budget are agreed"
        ]
      },
      {
        id: "baseline",
        title: "Capture fresh baseline",
        status: "pending",
        description: "Capture the behavior baseline before one-shot edits.",
        command: `${commandPrefix} baseline ${configArg}`,
        completionCriteria: [
          "latest baseline artifact exists",
          "all configured baseline checks and probes pass"
        ]
      },
      {
        id: "edit-window",
        title: "Apply bounded edits",
        status: "pending",
        description: "Apply only the planned one-shot changes within the file/risk budget.",
        completionCriteria: [
          `absolute source file count delta stays within ${maxSourceFileDelta}`,
          "changes match the declared budget",
          "no unrelated dependency, config, or behavior changes are mixed in"
        ]
      },
      {
        id: "post-edit-verify",
        title: "Run post-edit verification",
        status: "pending",
        description: "Run the full one-shot guard lane and compare against the fresh baseline.",
        command: `${commandPrefix} verify ${configArg}`,
        completionCriteria: [
          "critical checks pass",
          "behavior probes pass",
          "compare artifact is written"
        ]
      },
      {
        id: "pre-pr-report",
        title: "Generate pre-PR one-shot report",
        status: "pending",
        description: "Summarize post-edit evidence before opening or updating the PR.",
        command: reportCommand,
        completionCriteria: [
          "one-shot report status is go",
          "source-file delta is within budget",
          "target repository is clean after commit"
        ]
      },
      {
        id: "pr-merge",
        title: "Open and merge PR",
        status: "pending",
        description: "Open the one-shot PR, review the generated evidence, merge, and record closure metadata.",
        completionCriteria: [
          "PR URL is known",
          "target commit is known",
          "merge commit is known",
          "merge timestamp is known"
        ]
      },
      {
        id: "post-merge-verify",
        title: "Run post-merge verification",
        status: "pending",
        description: "Fast-forward the target main branch and rerun the full one-shot guard lane.",
        command: `${commandPrefix} verify ${configArg}`,
        completionCriteria: [
          "target main is aligned with origin/main",
          "critical checks pass",
          "behavior probes pass",
          "post-merge compare passes"
        ]
      },
      {
        id: "closure-report",
        title: "Generate final closure report",
        status: "pending",
        description: "Write the final one-shot report with complete PR and merge metadata.",
        command: closureReportCommand,
        completionCriteria: [
          "one-shot report status is go",
          "metadata complete is yes",
          "closure-metadata criterion passes"
        ]
      }
    ]
  };
}

export async function writeOneShotRunbook(loaded: LoadedConfig, runbook: OneShotRunbook): Promise<OneShotRunbook> {
  const dir = path.join(loaded.artifactsDir, "one-shot");
  const jsonPath = path.join(dir, `${runbook.id}.json`);
  const markdownPath = path.join(dir, `${runbook.id}.md`);
  const withPaths = {
    ...runbook,
    outputPath: jsonPath,
    markdownPath
  };

  await ensureDir(dir);
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderOneShotRunbook(withPaths));
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
    `- Metadata complete: ${report.summary.metadataComplete ? "yes" : "no"}`,
    `- Target clean: ${report.summary.targetClean === undefined ? "not checked" : report.summary.targetClean ? "yes" : "no"}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    "",
    "## Window",
    "",
    ...renderMetadataLines(report.metadata),
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

export function renderOneShotRunbook(runbook: OneShotRunbook): string {
  const lines = [
    `# One-Shot Runbook: ${runbook.id}`,
    "",
    `- Target: ${runbook.targetRoot}`,
    `- Config: ${runbook.configPath}`,
    `- Artifacts: ${runbook.artifactsDir}`,
    `- Source file delta budget: ${runbook.maxSourceFileDelta}`,
    "",
    "## Window",
    "",
    ...renderMetadataLines(runbook.metadata),
    "",
    "## Steps",
    "",
    ...runbook.steps.flatMap((step, index) => [
      `### ${index + 1}. ${step.title}`,
      "",
      `- Status: ${step.status}`,
      `- ID: ${step.id}`,
      `- Description: ${step.description}`,
      step.command ? `- Command: \`${step.command}\`` : undefined,
      "- Completion criteria:",
      ...step.completionCriteria.map((criterion) => `  - ${criterion}`),
      ""
    ].filter((line): line is string => Boolean(line)))
  ];

  if (runbook.outputPath || runbook.markdownPath) {
    lines.push("## Artifacts", "");
    if (runbook.outputPath) {
      lines.push(`- JSON: ${runbook.outputPath}`);
    }
    if (runbook.markdownPath) {
      lines.push(`- Markdown: ${runbook.markdownPath}`);
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
  metadata: OneShotWindowMetadata;
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
    createClosureMetadataCriterion(input.metadata),
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

function createClosureMetadataCriterion(metadata: OneShotWindowMetadata): OneShotCriterion {
  if (isMetadataComplete(metadata)) {
    return {
      id: "closure-metadata",
      title: "Closure metadata captured",
      status: "passed",
      summary: "branch, PR URL, target commit, merge commit, and merge time are captured",
      evidence: [
        metadata.branch ? `branch:${metadata.branch}` : undefined,
        metadata.prUrl,
        metadata.targetCommit ? `target:${metadata.targetCommit}` : undefined,
        metadata.mergeCommit ? `merge:${metadata.mergeCommit}` : undefined,
        metadata.mergedAt ? `merged:${metadata.mergedAt}` : undefined
      ].filter((item): item is string => Boolean(item))
    };
  }
  return {
    id: "closure-metadata",
    title: "Closure metadata captured",
    status: "warning",
    summary: `missing ${missingMetadataFields(metadata).join(", ")} metadata`,
    nextAction: "Rerun one-shot report with --branch, --pr-url, --target-commit, --merge-commit, and --merged-at when producing final closure evidence."
  };
}

function renderMetadataLines(metadata: OneShotWindowMetadata): string[] {
  const lines = [
    `- Name: ${metadata.name ?? "unspecified"}`,
    `- Branch: ${metadata.branch ?? "unknown"}`,
    `- Base branch: ${metadata.baseBranch ?? "unknown"}`,
    `- PR URL: ${metadata.prUrl ?? "unknown"}`,
    `- Target commit: ${metadata.targetCommit ?? "unknown"}`,
    `- Merge commit: ${metadata.mergeCommit ?? "unknown"}`,
    `- Merged at: ${metadata.mergedAt ?? "unknown"}`,
    `- Budget: ${metadata.budget ?? "unspecified"}`
  ];
  if (metadata.notes && metadata.notes.length > 0) {
    lines.push(...metadata.notes.map((note) => `- Note: ${note}`));
  }
  return lines;
}

function createMetadataCommandArgs(metadata: OneShotWindowMetadata): string {
  return [
    metadata.name ? `--name ${quoteShellArg(metadata.name)}` : undefined,
    metadata.branch ? `--branch ${quoteShellArg(metadata.branch)}` : undefined,
    metadata.baseBranch ? `--base-branch ${quoteShellArg(metadata.baseBranch)}` : undefined,
    metadata.prUrl ? `--pr-url ${quoteShellArg(metadata.prUrl)}` : undefined,
    metadata.targetCommit ? `--target-commit ${quoteShellArg(metadata.targetCommit)}` : undefined,
    metadata.mergeCommit ? `--merge-commit ${quoteShellArg(metadata.mergeCommit)}` : undefined,
    metadata.mergedAt ? `--merged-at ${quoteShellArg(metadata.mergedAt)}` : undefined,
    metadata.budget ? `--budget ${quoteShellArg(metadata.budget)}` : undefined,
    ...(metadata.notes ?? []).map((note) => `--note ${quoteShellArg(note)}`)
  ].filter((item): item is string => Boolean(item)).join(" ");
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function mergeOneShotMetadata(
  detected: OneShotWindowMetadata,
  provided: OneShotWindowMetadata | undefined
): OneShotWindowMetadata {
  return {
    ...detected,
    ...provided,
    notes: provided?.notes ?? detected.notes
  };
}

function isMetadataComplete(metadata: OneShotWindowMetadata): boolean {
  return missingMetadataFields(metadata).length === 0;
}

function missingMetadataFields(metadata: OneShotWindowMetadata): string[] {
  return [
    !metadata.branch ? "branch" : undefined,
    !metadata.prUrl ? "prUrl" : undefined,
    !metadata.targetCommit ? "targetCommit" : undefined,
    !metadata.mergeCommit ? "mergeCommit" : undefined,
    !metadata.mergedAt ? "mergedAt" : undefined
  ].filter((item): item is string => Boolean(item));
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

async function readTargetGitMetadata(loaded: LoadedConfig): Promise<OneShotWindowMetadata> {
  const [branch, head] = await Promise.all([
    runGitMetadataCommand(loaded, "git branch --show-current"),
    runGitMetadataCommand(loaded, "git rev-parse HEAD")
  ]);
  return {
    branch,
    targetCommit: head
  };
}

async function runGitMetadataCommand(loaded: LoadedConfig, command: string): Promise<string | undefined> {
  const result = await runShellCommand(command, {
    cwd: loaded.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value || undefined;
}
