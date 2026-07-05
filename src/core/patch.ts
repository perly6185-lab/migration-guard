import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { loadActionPlan } from "./actionPlan.js";
import { appendEvidence, createId, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type {
  LoadedConfig,
  MigrationAction,
  MigrationActionPatchTemplate,
  ProposalCommandCheck,
  ProposalPatchCheck,
  ProposalPreviewConfig,
  ProposalPreviewResult,
  ProposalRollbackReport,
  ProposalVerificationReport,
  ProposedPatch
} from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import { runShellCommand } from "./exec.js";
import { startManagedPreview } from "./preview.js";

export interface ApplyProposedPatchOptions {
  runChecks?: boolean;
  rollbackOnFail?: boolean;
}

export interface ApplyProposedPatchResult {
  message: string;
  proposal: ProposedPatch;
  report?: ProposalVerificationReport;
  rollbackReport?: ProposalRollbackReport;
}

export interface ProposalStatus {
  proposal: ProposedPatch;
  verificationReports: string[];
  rollbackReports: string[];
}

export async function proposePatch(loaded: LoadedConfig, pkg: MigrationRunPackage, taskId: string): Promise<ProposedPatch> {
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const proposed: ProposedPatch = {
    version: 1,
    id,
    runId: pkg.run.id,
    taskId,
    createdAt: new Date().toISOString(),
    title: `Dry-run proposal for ${task.title}`,
    summary: createPatchSummary(task.title, task.affectedFiles),
    risk: task.risk,
    patchPath,
    affectedFiles: task.affectedFiles,
    recommendedChecks: task.verificationCommands,
    patchKind: "task-placeholder",
    applyState: "proposed"
  };
  await writeTextFile(patchPath, createPatchContent(pkg.run.goal, task.title, task.affectedFiles));
  await writeJsonFile(path.join(dir, "proposal.json"), proposed);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId,
    type: "task-updated",
    message: `Created dry-run patch proposal ${id}`,
    data: {
      patchPath
    }
  });
  return proposed;
}

export async function proposeActionPatch(loaded: LoadedConfig, pkg: MigrationRunPackage, actionId: string): Promise<ProposedPatch> {
  const plan = await loadActionPlan(loaded, pkg);
  const action = plan.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const generatedFile = createActionProbePath(action);
  const template = inferPatchTemplate(action);
  const preview = template === "ui-smoke-probe" ? await resolveActionPreview(loaded, action) : undefined;
  if (await pathExists(path.join(pkg.run.targetRoot, generatedFile))) {
    throw new Error(`Generated probe already exists in target: ${generatedFile}`);
  }

  const probeContent = createActionProbeScript(pkg.run.goal, action);
  const patchContent = createAddFilePatch(generatedFile, probeContent);
  const recommendedChecks = [...new Set([...action.recommendedChecks, `node ${generatedFile}`])];
  const proposed: ProposedPatch = {
    version: 1,
    id,
    runId: pkg.run.id,
    actionId: action.id,
    createdAt: new Date().toISOString(),
    title: `Action proposal for ${action.title}`,
    summary: action.summary,
    risk: action.risk,
    patchPath,
    affectedFiles: action.affectedFiles,
    generatedFiles: [generatedFile],
    recommendedChecks,
    preview,
    patchKind: "action-probe",
    applyState: "proposed"
  };

  await writeTextFile(patchPath, patchContent);
  await writeJsonFile(path.join(dir, "proposal.json"), proposed);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "task-updated",
    message: `Created action patch proposal ${id} for ${action.id}`,
    data: {
      actionId: action.id,
      patchPath,
      generatedFiles: proposed.generatedFiles,
      recommendedChecks,
      preview
    }
  });
  return proposed;
}

export async function verifyProposedPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string,
  options: { runChecks?: boolean } = {}
): Promise<ProposalVerificationReport> {
  const proposal = await loadProposal(loaded, pkg, proposalId);
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");
  const patchCheck = await checkPatchApplicability(loaded, pkg, proposal, patchContent);
  const checks = options.runChecks && patchCheck.passed ? await runProposalChecks(loaded, pkg, proposal) : [];
  const report = await writeProposalVerificationReport(loaded, pkg, proposal, "verify", false, patchCheck, checks);
  if (isPreApplyState(proposal.applyState)) {
    proposal.applyState = report.passed ? "verified" : "verification-failed";
    proposal.lastVerificationPath = report.outputPath;
    await writeJsonFile(proposalJsonPath(loaded, pkg, proposal.id), proposal);
  }

  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "proposal",
    message: `Verified proposal ${proposal.id}: ${report.passed ? "passed" : "failed"}`,
    data: {
      proposalId: proposal.id,
      actionId: proposal.actionId,
      outputPath: report.outputPath,
      runChecks: Boolean(options.runChecks)
    }
  });
  return report;
}

export async function applyProposedPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string,
  options: ApplyProposedPatchOptions = {}
): Promise<ApplyProposedPatchResult> {
  const proposalPath = proposalJsonPath(loaded, pkg, proposalId);
  const proposal = await readJsonFile<ProposedPatch>(proposalPath);
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");
  const patchCheck = await checkPatchApplicability(loaded, pkg, proposal, patchContent);

  if (!isGitPatchContent(patchContent)) {
    proposal.applyState = "applied";
    await writeJsonFile(proposalPath, proposal);
    const checkRun = options.runChecks ? await runProposalChecksForApply(loaded, pkg, proposal) : { checks: [] };
    const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", true, patchCheck, checkRun.checks, checkRun.preview);
    proposal.applyState = report.passed ? "applied" : "applied-with-failed-checks";
    proposal.lastVerificationPath = report.outputPath;
    await writeJsonFile(proposalPath, proposal);
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: proposal.taskId,
      type: "proposal",
      message: `Marked non-mutating patch proposal ${proposal.id} as applied`,
      data: {
        patchPath: proposal.patchPath,
        noOp: true,
        outputPath: report.outputPath
      }
    });
    await saveRunPackage(loaded, pkg);
    if (!report.passed) {
      throw new Error(`Proposal ${proposal.id} marked applied, but verification failed. See ${report.outputPath}`);
    }
    return {
      message: `Proposal ${proposal.id} is non-mutating; marked applied.`,
      proposal,
      report
    };
  }

  if (!patchCheck.passed) {
    const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", false, patchCheck, []);
    throw new Error(`Patch check failed. See ${report.outputPath}\n${patchCheck.stderr || patchCheck.stdout || patchCheck.error || "unknown error"}`);
  }

  const apply = await runShellCommand(`git apply "${proposal.patchPath}"`, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });

  if (apply.exitCode !== 0) {
    throw new Error(`Patch apply failed:\n${apply.stderr || apply.stdout || apply.error || "unknown error"}`);
  }

  proposal.applyState = "applied";
  await writeJsonFile(proposalPath, proposal);
  const checkRun = options.runChecks ? await runProposalChecksForApply(loaded, pkg, proposal) : { checks: [] };
  const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", true, patchCheck, checkRun.checks, checkRun.preview);
  proposal.applyState = report.passed ? "applied" : "applied-with-failed-checks";
  proposal.lastVerificationPath = report.outputPath;
  await writeJsonFile(proposalPath, proposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "proposal",
    message: `Applied patch proposal ${proposal.id}: ${report.passed ? "checks passed" : "checks failed"}`,
    data: {
      patchPath: proposal.patchPath,
      outputPath: report.outputPath,
      runChecks: Boolean(options.runChecks)
    }
  });
  await saveRunPackage(loaded, pkg);

  if (!report.passed) {
    if (options.rollbackOnFail) {
      const rollbackReport = await rollbackProposedPatch(loaded, pkg, proposal.id);
      throw new Error(`Proposal ${proposal.id} applied, verification failed, and rollback ${rollbackReport.passed ? "passed" : "failed"}. See ${report.outputPath}`);
    }
    throw new Error(`Proposal ${proposal.id} applied, but verification failed. See ${report.outputPath}`);
  }

  return {
    message: `Applied proposal ${proposal.id}.`,
    proposal,
    report
  };
}

export async function rollbackProposedPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string
): Promise<ProposalRollbackReport> {
  const proposal = await loadProposal(loaded, pkg, proposalId);
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");
  const report = await rollbackPatch(loaded, pkg, proposal, patchContent);
  proposal.applyState = report.passed ? "rolled-back" : "rollback-failed";
  proposal.lastRollbackPath = report.outputPath;
  await writeJsonFile(proposalJsonPath(loaded, pkg, proposal.id), proposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "proposal",
    message: `Rolled back proposal ${proposal.id}: ${report.passed ? "passed" : "failed"}`,
    data: {
      proposalId: proposal.id,
      actionId: proposal.actionId,
      outputPath: report.outputPath
    }
  });
  await saveRunPackage(loaded, pkg);

  if (!report.passed) {
    throw new Error(`Proposal rollback failed. See ${report.outputPath}`);
  }

  return report;
}

export async function getProposalStatus(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string
): Promise<ProposalStatus> {
  const dir = proposalDir(loaded, pkg, proposalId);
  const proposal = await loadProposal(loaded, pkg, proposalId);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const reports = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
  return {
    proposal,
    verificationReports: reports.filter((file) => path.basename(file).startsWith("verification-")).sort(),
    rollbackReports: reports.filter((file) => path.basename(file).startsWith("rollback-")).sort()
  };
}

export function renderProposalVerificationReport(report: ProposalVerificationReport): string {
  const lines = [
    `Proposal: ${report.proposalId}`,
    `Mode: ${report.mode}`,
    `Applied: ${report.applied ? "yes" : "no"}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    `Patch check: ${report.patchCheck.skipped ? "skipped" : report.patchCheck.passed ? "passed" : "failed"}`,
    `Preview: ${report.preview ? report.preview.ready ? `ready ${report.preview.url}` : `failed ${report.preview.url}` : "not managed"}`,
    `Checks: ${report.checks.length}`
  ];

  for (const check of report.checks) {
    lines.push(`- ${check.passed ? "passed" : "failed"} ${check.command}`);
  }

  lines.push(`Wrote ${report.outputPath}`);
  return lines.join("\n");
}

export function renderProposalRollbackReport(report: ProposalRollbackReport): string {
  return [
    `Proposal: ${report.proposalId}`,
    "Mode: rollback",
    `Passed: ${report.passed ? "yes" : "no"}`,
    `Reverse check: ${report.reverseCheck.skipped ? "skipped" : report.reverseCheck.passed ? "passed" : "failed"}`,
    report.reverseApply ? `Reverse apply: ${report.reverseApply.passed ? "passed" : "failed"}` : "Reverse apply: not run",
    `Wrote ${report.outputPath}`
  ].join("\n");
}

export function renderProposalStatus(status: ProposalStatus): string {
  const proposal = status.proposal;
  return [
    `Proposal: ${proposal.id}`,
    `State: ${proposal.applyState}`,
    `Title: ${proposal.title}`,
    `Risk: ${proposal.risk}`,
    `Patch kind: ${proposal.patchKind ?? "unknown"}`,
    `Action: ${proposal.actionId ?? "none"}`,
    `Task: ${proposal.taskId ?? "none"}`,
    `Generated files: ${proposal.generatedFiles?.join(", ") || "none"}`,
    `Recommended checks: ${proposal.recommendedChecks.join(", ") || "none"}`,
    `Preview: ${proposal.preview ? `${proposal.preview.command} -> ${proposal.preview.url}` : "none"}`,
    `Last verification: ${proposal.lastVerificationPath ?? "none"}`,
    `Last rollback: ${proposal.lastRollbackPath ?? "none"}`,
    `Verification reports: ${status.verificationReports.length}`,
    `Rollback reports: ${status.rollbackReports.length}`
  ].join("\n");
}

function createPatchSummary(title: string, affectedFiles: string[]): string {
  if (affectedFiles.length === 0) {
    return `${title}. This first proposal is intentionally empty and records the checks that should run before any source edit.`;
  }
  return `${title}. Review affected files before applying: ${affectedFiles.join(", ")}.`;
}

function proposalDir(loaded: LoadedConfig, pkg: MigrationRunPackage, proposalId: string): string {
  return path.join(migrationRunDir(loaded, pkg.run.id), "proposals", proposalId);
}

function proposalJsonPath(loaded: LoadedConfig, pkg: MigrationRunPackage, proposalId: string): string {
  return path.join(proposalDir(loaded, pkg, proposalId), "proposal.json");
}

async function loadProposal(loaded: LoadedConfig, pkg: MigrationRunPackage, proposalId: string): Promise<ProposedPatch> {
  return readJsonFile<ProposedPatch>(proposalJsonPath(loaded, pkg, proposalId));
}

async function checkPatchApplicability(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  patchContent: string
): Promise<ProposalPatchCheck> {
  const command = `git apply --check "${proposal.patchPath}"`;
  if (!isGitPatchContent(patchContent)) {
    return {
      command,
      cwd: pkg.run.targetRoot,
      skipped: true,
      passed: true,
      exitCode: 0,
      durationMs: 0,
      stdout: "",
      stderr: ""
    };
  }

  const result = await runShellCommand(command, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  return {
    command,
    cwd: result.cwd,
    skipped: false,
    passed: result.exitCode === 0 && !result.timedOut && !result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

async function runProposalChecks(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  env?: Record<string, string>
): Promise<ProposalCommandCheck[]> {
  return runProposalCheckCommands(loaded, pkg, proposal.recommendedChecks, env);
}

async function runProposalCheckCommands(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  commands: string[],
  env?: Record<string, string>
): Promise<ProposalCommandCheck[]> {
  const checks: ProposalCommandCheck[] = [];

  for (const command of commands) {
    const result = await runShellCommand(command, {
      cwd: pkg.run.targetRoot,
      timeoutMs: 120000,
      maxOutputBytes: loaded.config.output.maxOutputBytes,
      env
    });
    checks.push(commandResultToProposalCheck(result));
  }

  return checks;
}

async function runProposalChecksForApply(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch
): Promise<{ checks: ProposalCommandCheck[]; preview?: ProposalPreviewResult }> {
  if (!proposal.preview) {
    return {
      checks: await runProposalChecks(loaded, pkg, proposal)
    };
  }

  const split = splitPreviewChecks(proposal);
  const regularChecks = await runProposalCheckCommands(loaded, pkg, split.regularChecks);
  if (split.previewChecks.length === 0) {
    return { checks: regularChecks };
  }

  const outputPath = path.join(proposalDir(loaded, pkg, proposal.id), `preview-${Date.now()}.json`);
  const session = await startManagedPreview(loaded, proposal.preview, {
    outputPath,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  let preview = session.result;
  if (!preview.ready) {
    preview = await session.stop();
    return {
      checks: regularChecks,
      preview
    };
  }

  let previewChecks: ProposalCommandCheck[] = [];
  try {
    previewChecks = await runProposalCheckCommands(loaded, pkg, split.previewChecks, session.env);
  } finally {
    preview = await session.stop();
  }

  return {
    checks: [...regularChecks, ...previewChecks],
    preview
  };
}

function splitPreviewChecks(proposal: ProposedPatch): { regularChecks: string[]; previewChecks: string[] } {
  const generatedFiles = proposal.generatedFiles ?? [];
  const previewChecks = proposal.recommendedChecks.filter((command) => {
    return command.includes("MG_PREVIEW_URL") || generatedFiles.some((file) => command.includes(file));
  });
  const previewCheckSet = new Set(previewChecks);
  return {
    regularChecks: proposal.recommendedChecks.filter((command) => !previewCheckSet.has(command)),
    previewChecks
  };
}

async function writeProposalVerificationReport(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  mode: ProposalVerificationReport["mode"],
  applied: boolean,
  patchCheck: ProposalPatchCheck,
  checks: ProposalCommandCheck[],
  preview?: ProposalPreviewResult
): Promise<ProposalVerificationReport> {
  const outputPath = path.join(proposalDir(loaded, pkg, proposal.id), `verification-${Date.now()}.json`);
  const report: ProposalVerificationReport = {
    version: 1,
    id: createId("proposal-verification"),
    runId: pkg.run.id,
    proposalId: proposal.id,
    mode,
    createdAt: new Date().toISOString(),
    patchPath: proposal.patchPath,
    applied,
    passed: patchCheck.passed && (preview?.ready ?? true) && checks.every((check) => check.passed),
    patchCheck,
    preview,
    checks,
    outputPath
  };

  await writeJsonFile(outputPath, report);
  return report;
}

async function rollbackPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  patchContent: string
): Promise<ProposalRollbackReport> {
  const reverseCheck = await checkReversePatchApplicability(loaded, pkg, proposal, patchContent);
  let reverseApply: ProposalCommandCheck | undefined;

  if (reverseCheck.passed && !reverseCheck.skipped) {
    const result = await runShellCommand(`git apply -R "${proposal.patchPath}"`, {
      cwd: pkg.run.targetRoot,
      timeoutMs: 30000,
      maxOutputBytes: loaded.config.output.maxOutputBytes
    });
    reverseApply = commandResultToProposalCheck(result);
  }

  const outputPath = path.join(proposalDir(loaded, pkg, proposal.id), `rollback-${Date.now()}.json`);
  const report: ProposalRollbackReport = {
    version: 1,
    id: createId("proposal-rollback"),
    runId: pkg.run.id,
    proposalId: proposal.id,
    createdAt: new Date().toISOString(),
    patchPath: proposal.patchPath,
    passed: reverseCheck.passed && (reverseCheck.skipped || reverseApply?.passed === true),
    reverseCheck,
    reverseApply,
    outputPath
  };
  await writeJsonFile(outputPath, report);
  return report;
}

async function checkReversePatchApplicability(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  patchContent: string
): Promise<ProposalPatchCheck> {
  const command = `git apply -R --check "${proposal.patchPath}"`;
  if (!isGitPatchContent(patchContent)) {
    return {
      command,
      cwd: pkg.run.targetRoot,
      skipped: true,
      passed: true,
      exitCode: 0,
      durationMs: 0,
      stdout: "",
      stderr: ""
    };
  }

  const result = await runShellCommand(command, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  return {
    command,
    cwd: result.cwd,
    skipped: false,
    passed: result.exitCode === 0 && !result.timedOut && !result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

function commandResultToProposalCheck(result: Awaited<ReturnType<typeof runShellCommand>>): ProposalCommandCheck {
  return {
    command: result.command,
    cwd: result.cwd,
    passed: result.exitCode === 0 && !result.timedOut && !result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    error: result.error
  };
}

function createPatchContent(goal: string, title: string, affectedFiles: string[]): string {
  return [
    "# Dry-run patch proposal",
    "#",
    `# Goal: ${goal}`,
    `# Task: ${title}`,
    `# Affected files: ${affectedFiles.join(", ") || "none"}`,
    "#",
    "# This proposal is intentionally non-mutating. It is a placeholder patch that lets the run",
    "# record review intent, recommended checks, and approval before future adapters emit source edits.",
    ""
  ].join("\n");
}

export function createAddFilePatch(filePath: string, content: string): string {
  const normalizedPath = normalizePatchPath(filePath);
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  const lines = normalizedContent.slice(0, -1).split("\n");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
}

function isGitPatchContent(input: string): boolean {
  return input
    .split(/\r?\n/)
    .some((line) => line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ "));
}

async function resolveActionPreview(loaded: LoadedConfig, action: MigrationAction): Promise<ProposalPreviewConfig | undefined> {
  if (action.preview) {
    return {
      timeoutMs: 180000,
      ...action.preview
    };
  }

  const rootPackage = await readPackageJson(path.join(loaded.targetRoot, "package.json"));
  const scripts = readScripts(rootPackage);
  const packageManager = await detectPackageManager(loaded.targetRoot);
  const appDir = inferUiAppDir(action.affectedFiles);
  const command = await inferPreviewCommand(loaded.targetRoot, packageManager, scripts, appDir);
  if (!command) {
    return undefined;
  }

  const base = await inferViteBase(loaded.targetRoot, appDir);
  return {
    command,
    url: createLocalPreviewUrl(base),
    timeoutMs: 180000
  };
}

async function inferPreviewCommand(
  targetRoot: string,
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  rootScripts: Record<string, string>,
  appDir?: string
): Promise<string | undefined> {
  if (packageManager === "pnpm" && appDir?.endsWith("/web") && rootScripts.web) {
    return "pnpm web dev --host 127.0.0.1";
  }

  if (rootScripts.dev) {
    return packageScriptCommand(packageManager, "dev");
  }

  if (appDir) {
    const appPackage = await readPackageJson(path.join(targetRoot, appDir, "package.json"));
    const appScripts = readScripts(appPackage);
    const appName = typeof appPackage?.name === "string" ? appPackage.name : undefined;
    if (appScripts.dev && packageManager === "pnpm" && appName) {
      return `pnpm --filter ${appName} dev --host 127.0.0.1`;
    }
  }

  if (rootScripts.start && /\b(vite|dev)\b/.test(rootScripts.start)) {
    return packageScriptCommand(packageManager, "start");
  }

  return undefined;
}

function packageScriptCommand(packageManager: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${script} --host 127.0.0.1`;
    case "yarn":
      return `yarn ${script} --host 127.0.0.1`;
    case "bun":
      return `bun run ${script} --host 127.0.0.1`;
    case "npm":
    default:
      return `npm run ${script} -- --host 127.0.0.1`;
  }
}

async function inferViteBase(targetRoot: string, appDir?: string): Promise<string> {
  const searchDirs: Array<string | undefined> = appDir ? [appDir, undefined] : [undefined];
  const configNames = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

  for (const searchDir of searchDirs) {
    for (const configName of configNames) {
      const configPath = path.join(targetRoot, searchDir ?? "", configName);
      if (!await pathExists(configPath)) {
        continue;
      }
      const base = inferBaseFromViteConfig(await fs.readFile(configPath, "utf8"));
      if (base) {
        return base;
      }
    }
  }

  return "/";
}

function inferBaseFromViteConfig(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!/\bbase\b/.test(line) || (!line.includes("=") && !line.includes(":"))) {
      continue;
    }
    const quotedValues = [...line.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((match) => match[1]);
    const absoluteBases = quotedValues.filter((value) => value.startsWith("/") && !value.startsWith("//"));
    const nonRootBase = absoluteBases.filter((value) => value !== "/").at(-1);
    const base = nonRootBase ?? absoluteBases.at(-1);
    if (base) {
      return normalizeViteBase(base);
    }
  }

  return undefined;
}

function normalizeViteBase(base: string): string {
  if (!base.startsWith("/") || base === "/") {
    return "/";
  }
  return base.endsWith("/") ? base : `${base}/`;
}

function createLocalPreviewUrl(base: string): string {
  const normalizedBase = normalizeViteBase(base);
  return `http://127.0.0.1:5173${normalizedBase}`;
}

function inferUiAppDir(affectedFiles: string[]): string | undefined {
  for (const file of affectedFiles) {
    const normalized = file.replace(/\\/g, "/");
    const match = normalized.match(/^(apps\/[^/]+)\//);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

async function detectPackageManager(targetRoot: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  if (await pathExists(path.join(targetRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(targetRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(path.join(targetRoot, "bun.lockb")) || await pathExists(path.join(targetRoot, "bun.lock"))) {
    return "bun";
  }
  return "npm";
}

async function readPackageJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!await pathExists(filePath)) {
    return undefined;
  }
  return readJsonFile<Record<string, unknown>>(filePath);
}

function readScripts(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  if (!packageJson || typeof packageJson.scripts !== "object" || packageJson.scripts === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(packageJson.scripts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function createActionProbePath(action: MigrationAction): string {
  return `scripts/migration-guard/${sanitizeFileName(action.id)}.mjs`;
}

function createActionProbeScript(goal: string, action: MigrationAction): string {
  const template = inferPatchTemplate(action);
  if (template === "ui-smoke-probe") {
    return createUiSmokeProbeScript(goal, action);
  }

  const requiredFiles = action.affectedFiles.length > 0 ? action.affectedFiles : ["package.json"];
  const checks = createProbeChecks(template);

  return [
    "import { existsSync, readFileSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "",
    `const action = ${JSON.stringify({
      id: action.id,
      title: action.title,
      goal,
      template,
      requiredFiles
    }, null, 2)};`,
    "",
    "const root = process.cwd();",
    "const results = [];",
    "",
    "for (const relativeFile of action.requiredFiles) {",
    "  const absoluteFile = path.join(root, relativeFile);",
    "  const exists = existsSync(absoluteFile);",
    "  const result = { file: relativeFile, exists, checks: [] };",
    "  if (exists) {",
    "    const text = readFileSync(absoluteFile, \"utf8\");",
    ...checks.map((check) => `    result.checks.push({ name: ${JSON.stringify(check.name)}, passed: ${check.pattern}.test(text) });`),
    "  }",
    "  results.push(result);",
    "}",
    "",
    "const failed = results.flatMap((result) => {",
    "  if (!result.exists) {",
    "    return [`missing:${result.file}`];",
    "  }",
    "  return result.checks.filter((check) => !check.passed).map((check) => `${result.file}:${check.name}`);",
    "});",
    "",
    "console.log(JSON.stringify({",
    "  actionId: action.id,",
    "  title: action.title,",
    "  goal: action.goal,",
    "  template: action.template,",
    "  passed: failed.length === 0,",
    "  results,",
    "  failed",
    "}, null, 2));",
    "",
    "if (failed.length > 0) {",
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n");
}

function createUiSmokeProbeScript(goal: string, action: MigrationAction): string {
  const requiredFiles = action.affectedFiles.length > 0 ? action.affectedFiles : ["package.json"];

  return [
    "import { existsSync, mkdirSync, readFileSync, writeFileSync } from \"node:fs\";",
    "import { tmpdir } from \"node:os\";",
    "import path from \"node:path\";",
    "",
    `const action = ${JSON.stringify({
      id: action.id,
      title: action.title,
      goal,
      template: "ui-smoke-probe",
      requiredFiles
    }, null, 2)};`,
    "",
    "const root = process.cwd();",
    "const url = process.env.MG_PREVIEW_URL ?? \"http://127.0.0.1:5173\";",
    "const outputDir = process.env.MG_UI_PROBE_OUTPUT_DIR ?? path.join(tmpdir(), \"migration-guard-ui-probes\", action.id);",
    "mkdirSync(outputDir, { recursive: true });",
    "",
    "const fileResults = action.requiredFiles.map((relativeFile) => {",
    "  const absoluteFile = path.join(root, relativeFile);",
    "  const exists = existsSync(absoluteFile);",
    "  const text = exists ? readFileSync(absoluteFile, \"utf8\") : \"\";",
    "  return {",
    "    file: relativeFile,",
    "    exists,",
    "    hasTemplate: /<template[\\s>]/i.test(text),",
    "    hasScript: /<script[\\s>]/i.test(text)",
    "  };",
    "});",
    "",
    "let runtimeResult;",
    "try {",
    "  runtimeResult = await runPlaywrightProbe(url, outputDir);",
    "} catch (error) {",
    "  runtimeResult = await runFetchProbe(url, error);",
    "}",
    "",
    "const failed = [];",
    "for (const result of fileResults) {",
    "  if (!result.exists) {",
    "    failed.push(`missing:${result.file}`);",
    "  }",
    "  if (result.exists && !result.hasTemplate) {",
    "    failed.push(`${result.file}:missing-template`);",
    "  }",
    "  if (result.exists && !result.hasScript) {",
    "    failed.push(`${result.file}:missing-script`);",
    "  }",
    "}",
    "if (!runtimeResult.passed) {",
    "  failed.push(`runtime:${runtimeResult.mode}`);",
    "}",
    "",
    "const report = {",
    "  actionId: action.id,",
    "  title: action.title,",
    "  goal: action.goal,",
    "  template: action.template,",
    "  url,",
    "  passed: failed.length === 0,",
    "  fileResults,",
    "  runtimeResult,",
    "  failed",
    "};",
    "const reportPath = path.join(outputDir, `${action.id}.json`);",
    "writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\\n`, \"utf8\");",
    "console.log(JSON.stringify({ ...report, reportPath }, null, 2));",
    "",
    "if (!report.passed) {",
    "  process.exitCode = 1;",
    "}",
    "",
    "async function runPlaywrightProbe(targetUrl, probeOutputDir) {",
    "  const { chromium } = await import(\"playwright\");",
    "  const browser = await chromium.launch({ headless: true });",
    "  try {",
    "    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });",
    "    const response = await page.goto(targetUrl, { waitUntil: \"domcontentloaded\", timeout: 30000 });",
    "    await page.waitForLoadState(\"networkidle\", { timeout: 10000 }).catch(() => undefined);",
    "    const bodyText = await page.locator(\"body\").innerText({ timeout: 5000 }).catch(() => \"\");",
    "    const appCount = await page.locator(\"#app, [data-app], main, body\").count().catch(() => 0);",
    "    const screenshotPath = path.join(probeOutputDir, `${action.id}.png`);",
    "    await page.screenshot({ path: screenshotPath, fullPage: true });",
    "    return {",
    "      mode: \"playwright\",",
    "      passed: Boolean(response && response.ok()) && appCount > 0,",
    "      status: response?.status() ?? null,",
    "      title: await page.title(),",
    "      bodyTextLength: bodyText.length,",
    "      appCount,",
    "      screenshotPath",
    "    };",
    "  } finally {",
    "    await browser.close();",
    "  }",
    "}",
    "",
    "async function runFetchProbe(targetUrl, cause) {",
    "  try {",
    "    const response = await fetch(targetUrl);",
    "    const body = await response.text();",
    "    return {",
    "      mode: \"fetch\",",
    "      passed: response.ok && body.length > 0,",
    "      status: response.status,",
    "      bodyLength: body.length,",
    "      playwrightUnavailable: cause instanceof Error ? cause.message : String(cause)",
    "    };",
    "  } catch (error) {",
    "    return {",
    "      mode: \"fetch\",",
    "      passed: false,",
    "      status: null,",
    "      error: error instanceof Error ? error.message : String(error),",
    "      playwrightUnavailable: cause instanceof Error ? cause.message : String(cause)",
    "    };",
    "  }",
    "}",
    ""
  ].join("\n");
}

function createProbeChecks(template: MigrationActionPatchTemplate): Array<{ name: string; pattern: string }> {
  switch (template) {
    case "renderer-probe":
      return [
        { name: "has-renderer-signal", pattern: "/render|renderer|markdown|Marked|marked/i" },
        { name: "has-export-signal", pattern: "/export\\s+/" }
      ];
    case "api-contract-probe":
      return [
        { name: "has-export-signal", pattern: "/export\\s+/" },
        { name: "has-type-signal", pattern: "/interface|type|enum|schema/i" }
      ];
    case "ui-smoke-probe":
      return [
        { name: "has-template", pattern: "/<template[\\s>]/i" },
        { name: "has-script", pattern: "/<script[\\s>]/i" }
      ];
    default:
      return [{ name: "has-content", pattern: "/\\S/" }];
  }
}

function inferPatchTemplate(action: MigrationAction): MigrationActionPatchTemplate {
  if (action.patchTemplate) {
    return action.patchTemplate;
  }
  if (action.id.includes("renderer")) {
    return "renderer-probe";
  }
  if (action.id.includes("api")) {
    return "api-contract-probe";
  }
  return "ui-smoke-probe";
}

function normalizePatchPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.isAbsolute(filePath) || normalizedPath.split("/").includes("..")) {
    throw new Error(`Unsafe patch path: ${filePath}`);
  }
  return normalizedPath;
}

function sanitizeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "migration-action";
}

function isPreApplyState(state: ProposedPatch["applyState"]): boolean {
  return state === "proposed" || state === "verified" || state === "verification-failed";
}
