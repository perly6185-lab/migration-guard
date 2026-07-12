import { promises as fs } from "node:fs";
import path from "node:path";
import { compareSnapshots } from "./compare.js";
import { runShellCommand } from "./exec.js";
import { ensureDir, pathExists, writeJsonFile, writeTextFile } from "./files.js";
import { autoIssueControl, type IssueControlAutoReport, type IssueControlPullOptions } from "./issueControl.js";
import { renderCompareReport } from "./markdown.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";
import type { LoadedConfig } from "../types.js";

export interface BootstrapMd2Options {
  sourceRoot: string;
  targetRoot: string;
  execute?: boolean;
}

export interface BootstrapMd2VerifyOptions {
  sourceRoot?: string;
  targetRoot?: string;
  pnpmCommand?: string;
  runIssueAuto?: boolean;
  issueAuto?: Pick<IssueControlPullOptions, "repo" | "state" | "labels" | "fetchImpl" | "retry">;
}

export interface BootstrapMd2Manifest {
  version: 1;
  id: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  sourceRoot: string;
  targetRoot: string;
  targetGit: {
    isRepository: boolean;
    hasCommits: boolean;
    statusBefore: string;
    statusAfter?: string;
  };
  summary: {
    plannedFileCount: number;
    copiedFileCount: number;
    skippedFileCount: number;
    plannedBytes: number;
    copiedBytes: number;
  };
  plannedFiles: BootstrapFileEntry[];
  copiedFiles: BootstrapFileEntry[];
  skippedFiles: BootstrapSkippedEntry[];
  recommendedNextCommands: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface BootstrapFileEntry {
  path: string;
  bytes: number;
}

export interface BootstrapSkippedEntry {
  path: string;
  reason: string;
}

export interface BootstrapMd2VerifyReport {
  version: 1;
  id: string;
  createdAt: string;
  sourceRoot?: string;
  targetRoot: string;
  compareMode: "source-to-target" | "target-stability";
  status: "passed" | "blocked" | "failed";
  summary: {
    ready: boolean;
    checkCount: number;
    blockerCount: number;
    warningCount: number;
    differenceCount: number;
  };
  checks: BootstrapMd2VerifyCheck[];
  packageManager: {
    declared?: string;
    lockfile?: string;
    pnpmAvailable: boolean;
    pnpmVersion?: string;
  };
  baselineSnapshotPath?: string;
  runSnapshotPath?: string;
  compareReportPath?: string;
  compareMarkdownPath?: string;
  issueAutoPath?: string;
  issueAutoMarkdownPath?: string;
  issueAutoStatus?: IssueControlAutoReport["status"];
  error?: string;
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface BootstrapMd2VerifyCheck {
  name: string;
  status: "passed" | "blocked" | "failed" | "warning" | "skipped";
  message: string;
  evidence?: string;
}

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".migration-guard",
  ".wxt",
  ".output",
  ".turbo"
]);

export async function bootstrapMd2Target(loaded: LoadedConfig, options: BootstrapMd2Options): Promise<BootstrapMd2Manifest> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  validateBootstrapRoots(sourceRoot, targetRoot);
  const targetGit = await readTargetGitState(loaded, targetRoot);
  if (!targetGit.isRepository) {
    throw new Error(`Bootstrap target must be a git repository: ${targetRoot}`);
  }
  if (targetGit.statusBefore.trim().length > 0) {
    throw new Error(`Bootstrap target must be clean before import. Current status:\n${targetGit.statusBefore}`);
  }

  const collected = await collectBootstrapFiles(sourceRoot);
  const copiedFiles: BootstrapFileEntry[] = [];
  if (options.execute) {
    for (const file of collected.plannedFiles) {
      const from = path.join(sourceRoot, file.path);
      const to = path.join(targetRoot, file.path);
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
      copiedFiles.push(file);
    }
  }
  const statusAfter = options.execute
    ? await gitOutput(loaded, targetRoot, "git status --short")
    : undefined;
  const now = new Date().toISOString();
  const manifest: BootstrapMd2Manifest = {
    version: 1,
    id: `md2-bootstrap-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    sourceRoot,
    targetRoot,
    targetGit: {
      ...targetGit,
      statusAfter
    },
    summary: {
      plannedFileCount: collected.plannedFiles.length,
      copiedFileCount: copiedFiles.length,
      skippedFileCount: collected.skippedFiles.length,
      plannedBytes: sumBytes(collected.plannedFiles),
      copiedBytes: sumBytes(copiedFiles)
    },
    plannedFiles: collected.plannedFiles,
    copiedFiles,
    skippedFiles: collected.skippedFiles,
    recommendedNextCommands: [
      `pnpm --dir ${targetRoot} install`,
      "node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --verify --labels team:migration",
      "node dist/cli.js issue-control auto --config configs/md2-fast.migration-guard.json --labels team:migration"
    ]
  };
  return writeBootstrapManifest(loaded, manifest);
}

export async function verifyBootstrapMd2Target(
  loaded: LoadedConfig,
  options: BootstrapMd2VerifyOptions = {}
): Promise<BootstrapMd2VerifyReport> {
  const targetRoot = path.resolve(options.targetRoot ?? loaded.targetRoot);
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : undefined;
  const verifyLoaded = {
    ...loaded,
    targetRoot
  };
  const now = new Date().toISOString();
  const report: BootstrapMd2VerifyReport = {
    version: 1,
    id: `md2-bootstrap-verify-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    sourceRoot,
    targetRoot,
    compareMode: sourceRoot ? "source-to-target" : "target-stability",
    status: "blocked",
    summary: {
      ready: false,
      checkCount: 0,
      blockerCount: 0,
      warningCount: 0,
      differenceCount: 0
    },
    checks: [],
    packageManager: {
      pnpmAvailable: false
    },
    recommendedNextActions: []
  };

  try {
    await collectBootstrapVerifyReadiness(verifyLoaded, report, options);
    refreshBootstrapVerifySummary(report);
    if (!report.summary.ready) {
      report.status = "blocked";
      report.recommendedNextActions = createBootstrapVerifyNextActions(report);
      return writeBootstrapVerifyReport(loaded, report);
    }

    const baselineLoaded = sourceRoot
      ? {
          ...loaded,
          targetRoot: sourceRoot
        }
      : verifyLoaded;
    const baseline = await captureSnapshot(baselineLoaded, "baseline");
    report.baselineSnapshotPath = await saveSnapshot(verifyLoaded, baseline);
    const run = await captureSnapshot(verifyLoaded, "run");
    report.runSnapshotPath = await saveSnapshot(verifyLoaded, run);
    const compare = compareSnapshots(baseline, run, verifyLoaded.config.compare);
    const comparePaths = await writeBootstrapCompareArtifacts(verifyLoaded, compare);
    report.compareReportPath = comparePaths.jsonPath;
    report.compareMarkdownPath = comparePaths.markdownPath;
    report.summary.differenceCount = compare.differences.length;

    if (!compare.passed) {
      report.status = "failed";
      report.checks.push({
        name: "bootstrap-compare",
        status: "failed",
        message: sourceRoot
          ? "Source baseline and target verification snapshots differ."
          : "Baseline and verification snapshots differ."
      });
      refreshBootstrapVerifySummary(report);
      report.recommendedNextActions = createBootstrapVerifyNextActions(report);
      return writeBootstrapVerifyReport(loaded, report);
    }

    report.checks.push({
      name: "bootstrap-compare",
      status: "passed",
      message: sourceRoot
        ? "Source baseline and target verification snapshots matched."
        : "Baseline and verification snapshots matched."
    });

    if (options.runIssueAuto) {
      const auto = await autoIssueControl(verifyLoaded, {
        ...options.issueAuto,
        execute: false,
        maxIterations: 1
      });
      report.issueAutoPath = auto.outputPath;
      report.issueAutoMarkdownPath = auto.markdownPath;
      report.issueAutoStatus = auto.status;
      report.checks.push({
        name: "issue-control-auto",
        status: auto.status === "failed" ? "failed" : auto.status === "blocked" ? "blocked" : "passed",
        message: `issue-control auto dry-run finished with status ${auto.status}.`,
        evidence: auto.outputPath
      });
    }

    refreshBootstrapVerifySummary(report);
    report.status = report.summary.blockerCount > 0
      ? "blocked"
      : report.checks.some((check) => check.status === "failed")
        ? "failed"
        : "passed";
    report.recommendedNextActions = createBootstrapVerifyNextActions(report);
    return writeBootstrapVerifyReport(loaded, report);
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    report.checks.push({
      name: "bootstrap-verify",
      status: "failed",
      message: report.error
    });
    refreshBootstrapVerifySummary(report);
    report.recommendedNextActions = createBootstrapVerifyNextActions(report);
    return writeBootstrapVerifyReport(loaded, report);
  }
}

export function renderBootstrapMd2Manifest(manifest: BootstrapMd2Manifest): string {
  return [
    `# MD2 Bootstrap: ${manifest.id}`,
    "",
    `- Mode: ${manifest.mode}`,
    `- Source: ${manifest.sourceRoot}`,
    `- Target: ${manifest.targetRoot}`,
    `- Target git repository: ${manifest.targetGit.isRepository ? "yes" : "no"}`,
    `- Target has commits: ${manifest.targetGit.hasCommits ? "yes" : "no"}`,
    `- Planned files: ${manifest.summary.plannedFileCount}`,
    `- Copied files: ${manifest.summary.copiedFileCount}`,
    `- Skipped files: ${manifest.summary.skippedFileCount}`,
    `- Planned bytes: ${manifest.summary.plannedBytes}`,
    `- Copied bytes: ${manifest.summary.copiedBytes}`,
    "",
    "## Target Git Status Before",
    "",
    manifest.targetGit.statusBefore.trim() || "clean",
    "",
    "## Target Git Status After",
    "",
    manifest.targetGit.statusAfter?.trim() || (manifest.mode === "dry-run" ? "not executed" : "clean"),
    "",
    "## Recommended Next Commands",
    "",
    ...manifest.recommendedNextCommands.map((command) => `- \`${command}\``),
    "",
    "## Sample Planned Files",
    "",
    ...(manifest.plannedFiles.slice(0, 25).map((file) => `- ${file.path} (${file.bytes} bytes)`)),
    manifest.plannedFiles.length > 25 ? `- ... ${manifest.plannedFiles.length - 25} more` : "",
    "",
    "## Sample Skipped Files",
    "",
    ...(manifest.skippedFiles.slice(0, 25).map((file) => `- ${file.path}: ${file.reason}`)),
    manifest.skippedFiles.length > 25 ? `- ... ${manifest.skippedFiles.length - 25} more` : "",
    "",
    "## Artifacts",
    "",
    `- JSON: ${manifest.outputPath ?? "none"}`,
    `- Markdown: ${manifest.markdownPath ?? "none"}`
  ].filter((line) => line !== "").join("\n");
}

export function renderBootstrapMd2VerifyReport(report: BootstrapMd2VerifyReport): string {
  return [
    `# MD2 Bootstrap Verify: ${report.id}`,
    "",
    `- Status: ${report.status}`,
    `- Compare mode: ${report.compareMode}`,
    `- Source: ${report.sourceRoot ?? "target self-check"}`,
    `- Target: ${report.targetRoot}`,
    `- Ready: ${report.summary.ready ? "yes" : "no"}`,
    `- Checks: ${report.summary.checkCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    `- Differences: ${report.summary.differenceCount}`,
    `- Package manager: ${report.packageManager.declared ?? report.packageManager.lockfile ?? "unknown"}`,
    `- pnpm available: ${report.packageManager.pnpmAvailable ? "yes" : "no"}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Message | Evidence |",
    "| --- | --- | --- | --- |",
    ...report.checks.map((check) => [
      `| ${check.name}`,
      check.status,
      escapeCell(check.message),
      `${escapeCell(check.evidence ?? "none")} |`
    ].join(" | ")),
    "",
    "## Recommended Next Actions",
    "",
    ...(report.recommendedNextActions.length > 0
      ? report.recommendedNextActions.map((action) => `- ${action}`)
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- Baseline: ${report.baselineSnapshotPath ?? "none"}`,
    `- Run: ${report.runSnapshotPath ?? "none"}`,
    `- Compare JSON: ${report.compareReportPath ?? "none"}`,
    `- Compare Markdown: ${report.compareMarkdownPath ?? "none"}`,
    `- Issue auto JSON: ${report.issueAutoPath ?? "none"}`,
    `- Issue auto Markdown: ${report.issueAutoMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

async function writeBootstrapManifest(loaded: LoadedConfig, manifest: BootstrapMd2Manifest): Promise<BootstrapMd2Manifest> {
  const dir = path.join(loaded.artifactsDir, "bootstrap");
  const outputPath = path.join(dir, `${manifest.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  manifest.outputPath = outputPath;
  manifest.markdownPath = markdownPath;
  await writeJsonFile(outputPath, manifest);
  await writeTextFile(markdownPath, renderBootstrapMd2Manifest(manifest));
  return manifest;
}

async function writeBootstrapVerifyReport(
  loaded: LoadedConfig,
  report: BootstrapMd2VerifyReport
): Promise<BootstrapMd2VerifyReport> {
  const dir = path.join(loaded.artifactsDir, "bootstrap");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderBootstrapMd2VerifyReport(report));
  return report;
}

async function collectBootstrapVerifyReadiness(
  loaded: LoadedConfig,
  report: BootstrapMd2VerifyReport,
  options: BootstrapMd2VerifyOptions
): Promise<void> {
  if (!await pathExists(loaded.targetRoot)) {
    report.checks.push({
      name: "target-root",
      status: "blocked",
      message: "Bootstrap target root does not exist.",
      evidence: loaded.targetRoot
    });
    return;
  }
  report.checks.push({
    name: "target-root",
    status: "passed",
    message: "Bootstrap target root exists.",
    evidence: loaded.targetRoot
  });

  const packageJsonPath = path.join(loaded.targetRoot, "package.json");
  if (!await pathExists(packageJsonPath)) {
    report.checks.push({
      name: "package-json",
      status: "blocked",
      message: "blocked: package.json is required before bootstrap verification can run.",
      evidence: packageJsonPath
    });
    return;
  }
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { packageManager?: string };
  report.packageManager.declared = packageJson.packageManager;
  report.checks.push({
    name: "package-json",
    status: "passed",
    message: "package.json exists.",
    evidence: packageJsonPath
  });

  const pnpmLockPath = path.join(loaded.targetRoot, "pnpm-lock.yaml");
  if (await pathExists(pnpmLockPath)) {
    report.packageManager.lockfile = "pnpm-lock.yaml";
  }
  if (packageJson.packageManager?.startsWith("pnpm@") || report.packageManager.lockfile === "pnpm-lock.yaml") {
    report.checks.push({
      name: "package-manager-evidence",
      status: "passed",
      message: "pnpm package manager evidence was found.",
      evidence: packageJson.packageManager ?? report.packageManager.lockfile
    });
  } else {
    report.checks.push({
      name: "package-manager-evidence",
      status: "warning",
      message: "No pnpm packageManager field or pnpm-lock.yaml was found; verify may still run, but install workflow is ambiguous."
    });
  }

  const pnpmCommand = options.pnpmCommand ?? "pnpm --version";
  const pnpm = await runShellCommand(pnpmCommand, {
    cwd: loaded.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  report.packageManager.pnpmAvailable = pnpm.exitCode === 0;
  report.packageManager.pnpmVersion = pnpm.stdout.trim() || undefined;
  report.checks.push({
    name: "pnpm-cli",
    status: pnpm.exitCode === 0 ? "passed" : "blocked",
    message: pnpm.exitCode === 0 ? "pnpm is available." : "blocked: install pnpm before bootstrap verification can run.",
    evidence: pnpm.exitCode === 0 ? pnpm.stdout.trim() : pnpm.stderr.trim() || pnpm.error
  });

  const nodeModulesPath = path.join(loaded.targetRoot, "node_modules");
  report.checks.push({
    name: "node-modules",
    status: await pathExists(nodeModulesPath) ? "passed" : "blocked",
    message: await pathExists(nodeModulesPath)
      ? "node_modules exists."
      : "blocked: install required before bootstrap verification can run.",
    evidence: nodeModulesPath
  });
}

async function writeBootstrapCompareArtifacts(
  loaded: LoadedConfig,
  report: ReturnType<typeof compareSnapshots>
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = path.join(loaded.artifactsDir, "compare", `${Date.now()}.json`);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  await writeJsonFile(jsonPath, report);
  await writeTextFile(markdownPath, renderCompareReport(report));
  return { jsonPath, markdownPath };
}

function refreshBootstrapVerifySummary(report: BootstrapMd2VerifyReport): void {
  report.summary.checkCount = report.checks.length;
  report.summary.blockerCount = report.checks.filter((check) => check.status === "blocked").length;
  report.summary.warningCount = report.checks.filter((check) => check.status === "warning").length;
  report.summary.ready = report.summary.blockerCount === 0
    && !report.checks.some((check) => check.status === "failed");
}

function createBootstrapVerifyNextActions(report: BootstrapMd2VerifyReport): string[] {
  if (report.checks.some((check) => check.name === "package-json" && check.status === "blocked")) {
    return ["Run issue-control bootstrap with --execute, then rerun bootstrap --verify."];
  }
  if (report.checks.some((check) => check.name === "pnpm-cli" && check.status === "blocked")) {
    return ["Install pnpm on the operator machine, then rerun bootstrap --verify."];
  }
  if (report.checks.some((check) => check.name === "node-modules" && check.status === "blocked")) {
    return [`Run pnpm --dir ${report.targetRoot} install, then rerun bootstrap --verify.`];
  }
  if (report.status === "failed") {
    return ["Inspect the compare or bootstrap verification report, fix the failed item, then rerun bootstrap --verify."];
  }
  if (report.issueAutoStatus === "blocked") {
    return ["Review the issue-control auto dry-run selection and refresh or label md2 issues before the next automated iteration."];
  }
  if (report.status === "passed") {
    return ["Review the bootstrap verify report, then continue with issue-control auto dry-run or the next md2 refactor issue."];
  }
  return ["Inspect this bootstrap verification report before continuing."];
}

function validateBootstrapRoots(sourceRoot: string, targetRoot: string): void {
  if (sourceRoot === targetRoot) {
    throw new Error("Bootstrap source and target must be different directories.");
  }
  if (isNestedPath(sourceRoot, targetRoot)) {
    throw new Error("Bootstrap target must not be inside the source directory.");
  }
}

async function readTargetGitState(loaded: LoadedConfig, targetRoot: string): Promise<BootstrapMd2Manifest["targetGit"]> {
  if (!await pathExists(targetRoot)) {
    throw new Error(`Bootstrap target does not exist: ${targetRoot}`);
  }
  const repo = await runShellCommand("git rev-parse --is-inside-work-tree", {
    cwd: targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const hasCommits = await runShellCommand("git rev-parse --verify HEAD", {
    cwd: targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  return {
    isRepository: repo.exitCode === 0 && repo.stdout.trim() === "true",
    hasCommits: hasCommits.exitCode === 0,
    statusBefore: await gitOutput(loaded, targetRoot, "git status --short")
  };
}

async function gitOutput(loaded: LoadedConfig, cwd: string, command: string): Promise<string> {
  const result = await runShellCommand(command, {
    cwd,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  return result.exitCode === 0 ? result.stdout : result.stderr || result.error || "";
}

async function collectBootstrapFiles(sourceRoot: string): Promise<{
  plannedFiles: BootstrapFileEntry[];
  skippedFiles: BootstrapSkippedEntry[];
}> {
  if (!await pathExists(sourceRoot)) {
    throw new Error(`Bootstrap source does not exist: ${sourceRoot}`);
  }
  const plannedFiles: BootstrapFileEntry[] = [];
  const skippedFiles: BootstrapSkippedEntry[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(sourceRoot, absolute).replace(/\\/g, "/");
      const skipReason = skipReasonFor(relative, entry);
      if (skipReason) {
        skippedFiles.push({ path: relative, reason: skipReason });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        plannedFiles.push({ path: relative, bytes: stat.size });
      }
    }
  }

  await visit(sourceRoot);
  return {
    plannedFiles: plannedFiles.sort((a, b) => a.path.localeCompare(b.path)),
    skippedFiles: skippedFiles.sort((a, b) => a.path.localeCompare(b.path))
  };
}

function skipReasonFor(relative: string, entry: import("node:fs").Dirent): string | undefined {
  const parts = relative.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return "excluded path";
  }
  if (parts.some((part) => part === ".env" || part.startsWith(".env."))) {
    return "environment file";
  }
  if (entry.isSymbolicLink()) {
    return "symbolic link";
  }
  return undefined;
}

function isNestedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sumBytes(files: BootstrapFileEntry[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
