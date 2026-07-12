import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import {
  loadMigrationRunIndex,
  loadRunPackage,
  migrationRunDir,
  migrationRunsDir,
  type MigrationRunIndex,
  type MigrationRunIndexEntry,
  type MigrationRunPackage
} from "./migrationRun.js";
import { assessRefactorReadiness } from "./refactorReadiness.js";
import type {
  LoadedConfig,
  MigrationTaskStatus,
  ProposedPatch,
  RefactorReadinessReport
} from "../types.js";
import type { IssueControlSuperviseProgressLedger } from "./issueControl.js";

export type DashboardBlockerScope = "git" | "issue" | "progress" | "proposal" | "readiness" | "task";
export type DashboardBlockerSeverity = "warning" | "blocked" | "failed";

export interface DashboardOptions {
  runId?: string;
  checkTargetGit?: boolean;
}

export interface DashboardReport {
  version: 1;
  id: string;
  createdAt: string;
  runId: string;
  run: {
    goal: string;
    status: string;
    mode: string;
    targetRoot: string;
    latestCheckpointId?: string;
    updatedAt: string;
  };
  runs: {
    source: "index" | "scan";
    latestRunId?: string;
    runCount: number;
    items: MigrationRunIndexEntry[];
  };
  taskSummary: Record<string, number>;
  readyTasks: DashboardTaskSummary[];
  proposalSummary: Record<string, number>;
  stuckProposals: DashboardProposalSummary[];
  readiness?: {
    status: RefactorReadinessReport["status"];
    blockerCount: number;
    warningCount: number;
  };
  progress?: {
    sourceLedgerPath?: string;
    status: IssueControlSuperviseProgressLedger["status"];
    selectedCount: number;
    unresolvedCount: number;
    unreachedSelectedCount: number;
  };
  git?: {
    checked: boolean;
    clean?: boolean;
    status?: string;
    error?: string;
  };
  blockers: DashboardBlocker[];
  summary: {
    taskCount: number;
    readyTaskCount: number;
    proposalCount: number;
    stuckProposalCount: number;
    blockerCount: number;
    warningCount: number;
  };
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface DashboardTaskSummary {
  taskId: string;
  title: string;
  status: MigrationTaskStatus;
  risk: "low" | "medium" | "high";
  owner: "engine" | "ai" | "human";
  issueId?: string;
}

export interface DashboardProposalSummary {
  proposalId: string;
  title: string;
  state: ProposedPatch["applyState"];
  risk: ProposedPatch["risk"];
  taskId?: string;
  actionId?: string;
  lastVerificationPath?: string;
  lastRollbackPath?: string;
}

export interface DashboardBlocker {
  id: string;
  scope: DashboardBlockerScope;
  severity: DashboardBlockerSeverity;
  runId: string;
  title: string;
  reason: string;
  taskId?: string;
  issueId?: string;
  proposalId?: string;
  evidence: string[];
  nextAction?: string;
}

export interface DashboardBlockersReport {
  version: 1;
  id: string;
  createdAt: string;
  runId: string;
  blockerCount: number;
  warningCount: number;
  blockers: DashboardBlocker[];
  recommendedNextActions: string[];
  sourceDashboardPath?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface RunsListReport {
  version: 1;
  id: string;
  createdAt: string;
  source: "index" | "scan";
  latestRunId?: string;
  runCount: number;
  runs: RunsListItem[];
  outputPath?: string;
  markdownPath?: string;
}

export interface RunsListItem {
  runId: string;
  goal: string;
  status: string;
  mode: string;
  updatedAt: string;
  latestCheckpointId?: string;
  taskSummary: Record<string, number>;
  issueSummary: Record<string, number>;
  failedCount: number;
  blockedCount: number;
  readinessStatus?: RefactorReadinessReport["status"];
  readinessBlockers?: number;
  readinessWarnings?: number;
}

const STUCK_PROPOSAL_STATES = new Set<ProposedPatch["applyState"]>([
  "verification-failed",
  "applied",
  "applied-with-failed-checks",
  "rollback-failed"
]);

export async function collectDashboard(
  loaded: LoadedConfig,
  options: DashboardOptions = {}
): Promise<DashboardReport> {
  const pkg = await loadRunPackage(loaded, options.runId ?? "latest");
  const proposals = await loadRunProposals(loaded, pkg.run.id);
  const readiness = await assessRefactorReadiness(loaded, pkg, {
    checkTargetGit: false
  }).catch(() => undefined);
  const progress = await loadLatestIssueControlProgress(loaded).catch(() => undefined);
  const git = options.checkTargetGit === false
    ? { checked: false }
    : await readTargetGitStatus(loaded, pkg).catch((error: unknown) => ({
      checked: true,
      clean: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  const runs = await loadDashboardRunIndex(loaded);
  const blockers = buildDashboardBlockers(pkg, proposals, readiness, progress?.ledger, progress?.path, git);
  const stuckProposals = proposals
    .filter((proposal) => STUCK_PROPOSAL_STATES.has(proposal.applyState))
    .map(toDashboardProposalSummary);
  const readyTasks = pkg.graph.tasks
    .filter((task) => task.status === "ready")
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      risk: task.risk,
      owner: task.owner,
      issueId: task.issueId
    }));
  const warnings = blockers.filter((blocker) => blocker.severity === "warning").length;
  const blocking = blockers.length - warnings;
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `dashboard-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    runId: pkg.run.id,
    run: {
      goal: pkg.run.goal,
      status: pkg.run.status,
      mode: pkg.run.mode,
      targetRoot: pkg.run.targetRoot,
      latestCheckpointId: pkg.run.latestCheckpointId,
      updatedAt: pkg.run.updatedAt
    },
    runs,
    taskSummary: countBy(pkg.graph.tasks.map((task) => task.status)),
    readyTasks,
    proposalSummary: countBy(proposals.map((proposal) => proposal.applyState)),
    stuckProposals,
    readiness: readiness
      ? {
        status: readiness.status,
        blockerCount: readiness.summary.blockerCount,
        warningCount: readiness.summary.warningCount
      }
      : undefined,
    progress: progress
      ? {
        sourceLedgerPath: progress.path,
        status: progress.ledger.status,
        selectedCount: progress.ledger.summary.selectedCount,
        unresolvedCount: progress.ledger.summary.unresolvedCount,
        unreachedSelectedCount: progress.ledger.summary.unreachedSelectedCount
      }
      : undefined,
    git,
    blockers,
    summary: {
      taskCount: pkg.graph.tasks.length,
      readyTaskCount: readyTasks.length,
      proposalCount: proposals.length,
      stuckProposalCount: stuckProposals.length,
      blockerCount: blocking,
      warningCount: warnings
    },
    recommendedNextActions: createDashboardNextActions(blockers)
  };
}

export async function writeDashboardReport(
  loaded: LoadedConfig,
  report: DashboardReport
): Promise<DashboardReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const jsonPath = path.join(dir, `${report.id}.json`);
  const markdownPath = path.join(dir, `${report.id}.md`);
  const withPaths = {
    ...report,
    outputPath: jsonPath,
    markdownPath
  };
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderDashboard(withPaths));
  return withPaths;
}

export async function collectDashboardBlockers(
  loaded: LoadedConfig,
  options: DashboardOptions = {}
): Promise<DashboardBlockersReport> {
  const dashboard = await collectDashboard(loaded, options);
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `blockers-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    runId: dashboard.runId,
    blockerCount: dashboard.summary.blockerCount,
    warningCount: dashboard.summary.warningCount,
    blockers: dashboard.blockers,
    recommendedNextActions: dashboard.recommendedNextActions,
    sourceDashboardPath: dashboard.outputPath
  };
}

export async function writeDashboardBlockersReport(
  loaded: LoadedConfig,
  report: DashboardBlockersReport
): Promise<DashboardBlockersReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const jsonPath = path.join(dir, `${report.id}.json`);
  const markdownPath = path.join(dir, `${report.id}.md`);
  const withPaths = {
    ...report,
    outputPath: jsonPath,
    markdownPath
  };
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderDashboardBlockers(withPaths));
  return withPaths;
}

export async function collectRunsList(loaded: LoadedConfig): Promise<RunsListReport> {
  const runs = await loadDashboardRunIndex(loaded);
  const items: RunsListItem[] = [];
  for (const run of runs.items) {
    const pkg = await loadRunPackage(loaded, run.runId).catch(() => undefined);
    const readiness = pkg
      ? await assessRefactorReadiness(loaded, pkg, { checkTargetGit: false }).catch(() => undefined)
      : undefined;
    const failedCount = (run.taskSummary.failed ?? 0) + (run.issueSummary.failed ?? 0);
    const blockedCount = (run.taskSummary.blocked ?? 0) + (run.issueSummary.blocked ?? 0) + (readiness?.summary.blockerCount ?? 0);
    items.push({
      runId: run.runId,
      goal: run.goal,
      status: run.status,
      mode: run.mode,
      updatedAt: run.updatedAt,
      latestCheckpointId: run.latestCheckpointId,
      taskSummary: run.taskSummary,
      issueSummary: run.issueSummary,
      failedCount,
      blockedCount,
      readinessStatus: readiness?.status,
      readinessBlockers: readiness?.summary.blockerCount,
      readinessWarnings: readiness?.summary.warningCount
    });
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `runs-list-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    source: runs.source,
    latestRunId: runs.latestRunId,
    runCount: runs.runCount,
    runs: items
  };
}

export async function writeRunsListReport(
  loaded: LoadedConfig,
  report: RunsListReport
): Promise<RunsListReport> {
  const dir = path.join(loaded.artifactsDir, "reports");
  const jsonPath = path.join(dir, `${report.id}.json`);
  const markdownPath = path.join(dir, `${report.id}.md`);
  const withPaths = {
    ...report,
    outputPath: jsonPath,
    markdownPath
  };
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderRunsList(withPaths));
  return withPaths;
}

export function renderDashboard(report: DashboardReport): string {
  return [
    `# Migration Guard Dashboard: ${report.runId}`,
    "",
    `- Run status: ${report.run.status}`,
    `- Goal: ${report.run.goal}`,
    `- Mode: ${report.run.mode}`,
    `- Target: ${report.run.targetRoot}`,
    `- Latest checkpoint: ${report.run.latestCheckpointId ?? "none"}`,
    `- Readiness: ${report.readiness?.status ?? "unknown"}`,
    `- Target git clean: ${report.git?.checked === false ? "not checked" : report.git?.clean ? "yes" : "no"}`,
    `- Runs tracked: ${report.runs.runCount} (${report.runs.source})`,
    `- Tasks: ${formatCounts(report.taskSummary)}`,
    `- Proposals: ${formatCounts(report.proposalSummary)}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    "",
    "## Ready Tasks",
    "",
    ...(report.readyTasks.length > 0
      ? renderTaskTable(report.readyTasks)
      : ["- none"]),
    "",
    "## Stuck Proposals",
    "",
    ...(report.stuckProposals.length > 0
      ? renderProposalTable(report.stuckProposals)
      : ["- none"]),
    "",
    "## Progress",
    "",
    report.progress
      ? `- ${report.progress.status}: selected ${report.progress.selectedCount}, unresolved ${report.progress.unresolvedCount}, unreached ${report.progress.unreachedSelectedCount}`
      : "- no issue-control progress ledger found",
    report.progress?.sourceLedgerPath ? `- Ledger: ${report.progress.sourceLedgerPath}` : undefined,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length > 0
      ? renderBlockerTable(report.blockers)
      : ["- none"]),
    "",
    "## Runs",
    "",
    ...(report.runs.items.length > 0
      ? renderRunsTable(report.runs.items)
      : ["- none"]),
    "",
    "## Recommended Next Actions",
    "",
    ...(report.recommendedNextActions.length > 0
      ? report.recommendedNextActions.map((action) => `- ${action}`)
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function renderDashboardBlockers(report: DashboardBlockersReport): string {
  return [
    `# Migration Guard Blockers: ${report.runId}`,
    "",
    `- Blockers: ${report.blockerCount}`,
    `- Warnings: ${report.warningCount}`,
    `- Source dashboard: ${report.sourceDashboardPath ?? "none"}`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length > 0
      ? renderBlockerTable(report.blockers)
      : ["- none"]),
    "",
    "## Recommended Next Actions",
    "",
    ...(report.recommendedNextActions.length > 0
      ? report.recommendedNextActions.map((action) => `- ${action}`)
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderRunsList(report: RunsListReport): string {
  return [
    `# Migration Guard Runs: ${report.id}`,
    "",
    `- Source: ${report.source}`,
    `- Latest run: ${report.latestRunId ?? "none"}`,
    `- Runs: ${report.runCount}`,
    "",
    "## Runs",
    "",
    ...(report.runs.length > 0
      ? [
        "| Run | Status | Readiness | Failed | Blocked | Checkpoint | Updated | Goal |",
        "| --- | --- | --- | ---: | ---: | --- | --- | --- |",
        ...report.runs.map((run) => [
          `| ${run.runId}`,
          run.status,
          run.readinessStatus ?? "unknown",
          run.failedCount,
          run.blockedCount,
          run.latestCheckpointId ?? "none",
          run.updatedAt,
          `${escapeCell(run.goal)} |`
        ].join(" | "))
      ]
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

async function loadDashboardRunIndex(loaded: LoadedConfig): Promise<DashboardReport["runs"]> {
  const index = await loadMigrationRunIndex(loaded);
  if (index) {
    return {
      source: "index",
      latestRunId: index.latestRunId,
      runCount: index.runCount,
      items: index.runs
    };
  }
  const scanned = await scanRunIndex(loaded);
  return {
    source: "scan",
    latestRunId: scanned.latestRunId,
    runCount: scanned.runCount,
    items: scanned.runs
  };
}

async function scanRunIndex(loaded: LoadedConfig): Promise<MigrationRunIndex> {
  const dir = migrationRunsDir(loaded);
  if (!await pathExists(dir)) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      runCount: 0,
      runs: []
    };
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const runs: MigrationRunIndexEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const pkg = await loadRunPackage(loaded, entry.name);
      runs.push({
        runId: pkg.run.id,
        goal: pkg.run.goal,
        status: pkg.run.status,
        mode: pkg.run.mode,
        adapter: pkg.run.adapter,
        targetRoot: pkg.run.targetRoot,
        createdAt: pkg.run.createdAt,
        updatedAt: pkg.run.updatedAt,
        latestCheckpointId: pkg.run.latestCheckpointId,
        latestBaselineId: pkg.run.latestBaselineId,
        latestVerificationId: pkg.run.latestVerificationId,
        taskSummary: countBy(pkg.graph.tasks.map((task) => task.status)),
        issueSummary: countBy(pkg.issues.map((issue) => issue.status)),
        estimate: {
          taskCount: pkg.run.estimate.taskCount,
          riskLevel: pkg.run.estimate.riskLevel,
          confidence: pkg.run.estimate.confidence
        }
      });
    } catch {
      // Ignore partial run directories; the dashboard is an observer.
    }
  }
  const sorted = runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    latestRunId: sorted[0]?.runId,
    runCount: sorted.length,
    runs: sorted
  };
}

async function loadRunProposals(loaded: LoadedConfig, runId: string): Promise<ProposedPatch[]> {
  const proposalsDir = path.join(migrationRunDir(loaded, runId), "proposals");
  if (!await pathExists(proposalsDir)) {
    return [];
  }
  const entries = await fs.readdir(proposalsDir, { withFileTypes: true });
  const proposals: ProposedPatch[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const filePath = path.join(proposalsDir, entry.name, "proposal.json");
    if (await pathExists(filePath)) {
      proposals.push(await readJsonFile<ProposedPatch>(filePath));
    }
  }
  return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function loadLatestIssueControlProgress(
  loaded: LoadedConfig
): Promise<{ path: string; ledger: IssueControlSuperviseProgressLedger } | undefined> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  if (!await pathExists(dir)) {
    return undefined;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^issue-control-supervise-progress-.*\.json$/.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));
  const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) {
    return undefined;
  }
  return {
    path: latest.filePath,
    ledger: await readJsonFile<IssueControlSuperviseProgressLedger>(latest.filePath)
  };
}

async function readTargetGitStatus(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): Promise<NonNullable<DashboardReport["git"]>> {
  const result = await runShellCommand("git status --short", {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  return {
    checked: true,
    clean: result.exitCode === 0 && !result.timedOut && !result.error && output.length === 0,
    status: output,
    error: result.error
  };
}

function buildDashboardBlockers(
  pkg: MigrationRunPackage,
  proposals: ProposedPatch[],
  readiness: RefactorReadinessReport | undefined,
  progress: IssueControlSuperviseProgressLedger | undefined,
  progressPath: string | undefined,
  git: DashboardReport["git"]
): DashboardBlocker[] {
  const taskBlockers = pkg.graph.tasks
    .filter((task) => task.status === "blocked" || task.status === "failed")
    .map((task): DashboardBlocker => ({
      id: `task:${task.id}`,
      scope: "task",
      severity: task.status === "failed" ? "failed" : "blocked",
      runId: pkg.run.id,
      taskId: task.id,
      issueId: task.issueId,
      title: task.title,
      reason: task.result ?? `Task is ${task.status}.`,
      evidence: task.verificationCommands,
      nextAction: task.status === "failed"
        ? `Inspect task ${task.id} failure evidence, replan, then rerun.`
        : `Unblock task ${task.id} dependencies before continuing.`
    }));
  const issueBlockers = pkg.issues
    .filter((issue) => issue.status === "blocked" || issue.status === "failed")
    .map((issue): DashboardBlocker => ({
      id: `issue:${issue.id}`,
      scope: "issue",
      severity: issue.status === "failed" ? "failed" : "blocked",
      runId: pkg.run.id,
      issueId: issue.id,
      taskId: issue.taskId,
      title: issue.title,
      reason: issue.body || `Issue is ${issue.status}.`,
      evidence: issue.externalUrl ? [issue.externalUrl] : [],
      nextAction: `Resolve issue ${issue.id}, then refresh dashboard.`
    }));
  const proposalBlockers = proposals
    .filter((proposal) => STUCK_PROPOSAL_STATES.has(proposal.applyState))
    .map((proposal): DashboardBlocker => ({
      id: `proposal:${proposal.id}`,
      scope: "proposal",
      severity: proposal.applyState === "applied" ? "blocked" : "failed",
      runId: pkg.run.id,
      taskId: proposal.taskId,
      proposalId: proposal.id,
      title: proposal.title,
      reason: `Proposal is ${proposal.applyState}.`,
      evidence: [
        proposal.lastVerificationPath,
        proposal.lastRollbackPath,
        proposal.patchPath
      ].filter((item): item is string => Boolean(item)),
      nextAction: proposal.applyState === "applied"
        ? `Rollback or finalize proposal ${proposal.id} before large-batch work.`
        : `Run proposal repair or replan for ${proposal.id}.`
    }));
  const readinessBlockers = (readiness?.criteria ?? [])
    .filter((criterion) => criterion.status === "blocked")
    .map((criterion): DashboardBlocker => ({
      id: `readiness:${criterion.id}`,
      scope: "readiness",
      severity: "blocked",
      runId: pkg.run.id,
      title: criterion.id,
      reason: criterion.summary,
      evidence: criterion.evidence ?? [],
      nextAction: criterion.nextAction
    }));
  const progressBlockers = (progress?.items ?? [])
    .filter((item) => item.state === "failed" || item.state === "blocked")
    .map((item): DashboardBlocker => ({
      id: `progress:${item.issueId ?? item.issueNumber}`,
      scope: "progress",
      severity: item.state === "failed" ? "failed" : "blocked",
      runId: item.runId ?? pkg.run.id,
      issueId: item.issueId,
      title: item.title,
      reason: item.reason,
      evidence: [progressPath, ...item.artifactPaths].filter((entry): entry is string => Boolean(entry)),
      nextAction: "Inspect the supervise progress ledger and recovery artifacts before continuing."
    }));
  const gitBlocker: DashboardBlocker[] = git?.checked !== false && git?.clean === false
    ? [{
      id: "git:target-dirty",
      scope: "git",
      severity: "blocked",
      runId: pkg.run.id,
      title: "Target repository is not clean",
      reason: git.error ?? git.status ?? "git status reported uncommitted changes.",
      evidence: git.status ? [git.status] : [],
      nextAction: "Commit, stash, clean, or rollback target changes before unattended or large-batch work."
    }]
    : [];
  return [
    ...gitBlocker,
    ...taskBlockers,
    ...issueBlockers,
    ...proposalBlockers,
    ...readinessBlockers,
    ...progressBlockers
  ];
}

function toDashboardProposalSummary(proposal: ProposedPatch): DashboardProposalSummary {
  return {
    proposalId: proposal.id,
    title: proposal.title,
    state: proposal.applyState,
    risk: proposal.risk,
    taskId: proposal.taskId,
    actionId: proposal.actionId,
    lastVerificationPath: proposal.lastVerificationPath,
    lastRollbackPath: proposal.lastRollbackPath
  };
}

function createDashboardNextActions(blockers: DashboardBlocker[]): string[] {
  const seen = new Set<string>();
  return blockers
    .map((blocker) => blocker.nextAction)
    .filter((action): action is string => Boolean(action))
    .filter((action) => {
      if (seen.has(action)) {
        return false;
      }
      seen.add(action);
      return true;
    })
    .slice(0, 10);
}

function renderTaskTable(tasks: DashboardTaskSummary[]): string[] {
  return [
    "| Task | Status | Risk | Owner | Issue | Title |",
    "| --- | --- | --- | --- | --- | --- |",
    ...tasks.map((task) => [
      `| ${task.taskId}`,
      task.status,
      task.risk,
      task.owner,
      task.issueId ?? "none",
      `${escapeCell(task.title)} |`
    ].join(" | "))
  ];
}

function renderProposalTable(proposals: DashboardProposalSummary[]): string[] {
  return [
    "| Proposal | State | Risk | Task | Action | Title |",
    "| --- | --- | --- | --- | --- | --- |",
    ...proposals.map((proposal) => [
      `| ${proposal.proposalId}`,
      proposal.state,
      proposal.risk,
      proposal.taskId ?? "none",
      proposal.actionId ?? "none",
      `${escapeCell(proposal.title)} |`
    ].join(" | "))
  ];
}

function renderBlockerTable(blockers: DashboardBlocker[]): string[] {
  return [
    "| Severity | Scope | Id | Title | Reason | Next action |",
    "| --- | --- | --- | --- | --- | --- |",
    ...blockers.map((blocker) => [
      `| ${blocker.severity}`,
      blocker.scope,
      blocker.id,
      escapeCell(blocker.title),
      escapeCell(blocker.reason),
      `${escapeCell(blocker.nextAction ?? "none")} |`
    ].join(" | "))
  ];
}

function renderRunsTable(runs: MigrationRunIndexEntry[]): string[] {
  return [
    "| Run | Status | Mode | Checkpoint | Tasks | Updated | Goal |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map((run) => [
      `| ${run.runId}`,
      run.status,
      run.mode,
      run.latestCheckpointId ?? "none",
      formatCounts(run.taskSummary),
      run.updatedAt,
      `${escapeCell(run.goal)} |`
    ].join(" | "))
  ];
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}:${value}`).join(" ")
    : "none";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
