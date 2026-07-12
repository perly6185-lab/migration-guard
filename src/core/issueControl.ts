import { promises as fs } from "node:fs";
import path from "node:path";
import { rollbackToCheckpoint } from "./checkpoint.js";
import { compareSnapshots } from "./compare.js";
import { runShellCommand } from "./exec.js";
import { readGitHubIssues, validateGitHubRepo, type GitHubIssueRemote, type GitHubRetryOptions } from "./githubIssueAdapter.js";
import { executeTask } from "./executor.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { renderCompareReport } from "./markdown.js";
import { loadRunPackage } from "./migrationRun.js";
import { repairProposal } from "./patch.js";
import { selectRepairStrategy, summarizeRepairStrategy, type RepairStrategySummary } from "./repairStrategy.js";
import { captureSnapshot, latestBaselinePath, loadSnapshot, saveSnapshot } from "./snapshot.js";
import type { LoadedConfig, MigrationIssueType } from "../types.js";

export type IssueControlProvider = "github";
export type IssueControlTrustTier = "manual" | "supervised" | "unattended";
export type IssueControlAction =
  | "bootstrap-target"
  | "repair-proposal"
  | "execute-task"
  | "classify-risk"
  | "review-external"
  | "track";

export interface IssueControlPullOptions {
  provider?: IssueControlProvider;
  repo?: string;
  token?: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  fetchImpl?: typeof fetch;
  retry?: GitHubRetryOptions;
}

export interface IssueControlPullReport {
  version: 1;
  id: string;
  provider: IssueControlProvider;
  repo: string;
  state: "open" | "closed" | "all";
  labels: string[];
  createdAt: string;
  issueCount: number;
  rateLimit: unknown[];
  issues: IssueControlRemoteIssue[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlRemoteIssue {
  number: number;
  title: string;
  body: string;
  bodyHash: string;
  htmlUrl?: string;
  state: "open" | "closed";
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  migrationGuard: IssueControlMetadata;
}

export interface IssueControlMetadata {
  runId?: string;
  issueId?: string;
  taskId?: string;
  issueType?: MigrationIssueType;
  status?: string;
  risk?: "low" | "medium" | "high";
  owner?: "engine" | "ai" | "human";
  proposalId?: string;
}

export interface IssueControlPlanReport {
  version: 1;
  id: string;
  provider: IssueControlProvider;
  repo: string;
  sourcePullId: string;
  createdAt: string;
  summary: {
    issueCount: number;
    mappedCount: number;
    executableCount: number;
    bootstrapCount: number;
    repairCount: number;
    externalReviewCount: number;
  };
  items: IssueControlPlanItem[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlPlanItem {
  issueNumber: number;
  title: string;
  url?: string;
  issueId?: string;
  runId?: string;
  taskId?: string;
  issueType?: MigrationIssueType;
  status?: string;
  risk?: "low" | "medium" | "high";
  labels: string[];
  action: IssueControlAction;
  executable: boolean;
  reason: string;
  recommendedCommand?: string;
}

export interface IssueControlRunOptions {
  execute?: boolean;
  onlyIssue?: string;
  runId?: string;
  maxItems?: number;
  editCommand?: string;
}

export interface IssueControlRunReport {
  version: 1;
  id: string;
  provider: IssueControlProvider;
  repo: string;
  sourcePlanId: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  onlyIssue?: string;
  maxItems: number;
  status: "planned" | "complete" | "failed" | "blocked";
  summary: {
    candidateCount: number;
    selectedCount: number;
    executedCount: number;
    skippedCount: number;
    failedCount: number;
  };
  items: IssueControlRunItem[];
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlRunItem {
  issueNumber: number;
  issueId?: string;
  title: string;
  action: IssueControlAction;
  command?: string;
  status: "planned" | "executed" | "skipped" | "failed" | "blocked";
  reason: string;
  result?: string;
  artifactPath?: string;
  error?: string;
}

export interface IssueControlAutoOptions extends IssueControlPullOptions {
  execute?: boolean;
  maxIterations?: number;
  allowHighRisk?: boolean;
  trustTier?: IssueControlTrustTier;
  runId?: string;
  editCommand?: string;
}

export interface IssueControlAutoReport {
  version: 1;
  id: string;
  provider: IssueControlProvider;
  repo: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  maxIterations: number;
  allowHighRisk: boolean;
  trustTier: IssueControlTrustTier;
  riskBudget: number;
  status: "planned" | "complete" | "failed" | "blocked";
  pullPath?: string;
  planPath?: string;
  runPath?: string;
  selectedIssueId?: string;
  selectedIssueNumber?: number;
  selectedAction?: IssueControlAction;
  selection: IssueControlAutoSelectionItem[];
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlAutoSelectionItem {
  issueNumber: number;
  issueId?: string;
  title: string;
  action: IssueControlAction;
  risk?: "low" | "medium" | "high";
  selected: boolean;
  reason: string;
}

export interface IssueControlSuperviseOptions extends IssueControlPullOptions {
  execute?: boolean;
  maxIterations?: number;
  allowHighRisk?: boolean;
  trustTier?: IssueControlTrustTier;
  runId?: string;
  editCommand?: string;
  verifyEach?: boolean;
  repairOnFail?: boolean;
  continueAfterRepair?: boolean;
  repairAgentCommand?: string;
  recoveryExecutor?: IssueControlRecoveryExecutor;
}

export type IssueControlRecoveryExecutor = (
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  plan: IssueControlRecoveryPlan,
  options: IssueControlSuperviseOptions
) => Promise<IssueControlRecoveryExecution>;

export interface IssueControlSuperviseReport {
  version: 1;
  id: string;
  provider: IssueControlProvider;
  repo: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  maxIterations: number;
  allowHighRisk: boolean;
  trustTier: IssueControlTrustTier;
  riskBudget: number;
  safetyEnvelope?: IssueControlSafetyEnvelope;
  controlOptions?: IssueControlSuperviseControlOptions;
  status: "planned" | "complete" | "failed" | "blocked";
  pullPath?: string;
  planPath?: string;
  summary: {
    issueCount: number;
    selectableCount: number;
    selectedCount: number;
    plannedCount: number;
    executedCount: number;
    verifiedCount: number;
    failedCount: number;
    blockedCount: number;
  };
  selection: IssueControlSuperviseSelectionItem[];
  iterations: IssueControlSuperviseIteration[];
  stopReason?: string;
  failureCategory?: SupervisorFailureCategory;
  recoveryPlanPath?: string;
  recoveryPlanMarkdownPath?: string;
  recoveryExecutionPath?: string;
  recoveryExecutionMarkdownPath?: string;
  recoveryExecutionStatus?: IssueControlRecoveryExecution["status"];
  autoRepairEligible?: boolean;
  humanActionRequired?: boolean;
  continuedAfterRepair?: boolean;
  continuedAfterRepairCount?: number;
  progressLedgerPath?: string;
  progressLedgerMarkdownPath?: string;
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlSuperviseControlOptions {
  configPath?: string;
  state: "open" | "closed" | "all";
  labels: string[];
  execute: boolean;
  maxIterations: number;
  allowHighRisk: boolean;
  trustTier: IssueControlTrustTier;
  riskBudget: number;
  verifyEach: boolean;
  repairOnFail: boolean;
  continueAfterRepair: boolean;
  repairAgentCommand?: string;
}

export interface IssueControlSafetyEnvelope {
  passed: boolean;
  trustTier: IssueControlTrustTier;
  checks: IssueControlSafetyEnvelopeCheck[];
}

export interface IssueControlSafetyEnvelopeCheck {
  id: string;
  passed: boolean;
  reason: string;
}

export interface IssueControlAdaptiveGate {
  state: "hold" | "upgrade" | "downgrade";
  currentMaxIterations?: number;
  recommendedMaxIterations: number;
  reason: string;
}

export interface IssueControlSuperviseSelectionItem {
  issueNumber: number;
  issueId?: string;
  runId?: string;
  title: string;
  action: IssueControlAction;
  risk?: "low" | "medium" | "high";
  selected: boolean;
  reason: string;
}

export interface IssueControlSuperviseIteration {
  index: number;
  issueNumber: number;
  issueId?: string;
  runId?: string;
  title: string;
  action: IssueControlAction;
  risk?: "low" | "medium" | "high";
  status: "planned" | "executed" | "failed" | "blocked";
  reason: string;
  runPath?: string;
  runMarkdownPath?: string;
  command?: string;
  artifactPath?: string;
  verification?: IssueControlSuperviseVerification;
  recoveryPlanPath?: string;
  recoveryPlanMarkdownPath?: string;
  recoveryExecutionPath?: string;
  recoveryExecutionMarkdownPath?: string;
  recoveryExecutionStatus?: IssueControlRecoveryExecution["status"];
  watchdogRollback?: IssueControlWatchdogRollback;
  continuedAfterRepair?: boolean;
  recoveryContinuationReason?: string;
  error?: string;
}

export interface IssueControlWatchdogRollback {
  status: "skipped" | "executed" | "blocked" | "failed";
  checkpointId?: string;
  message?: string;
  error?: string;
}

export interface IssueControlSuperviseVerification {
  status: "passed" | "failed" | "blocked" | "skipped";
  reason: string;
  baselineSnapshotPath?: string;
  runSnapshotPath?: string;
  compareReportPath?: string;
  compareMarkdownPath?: string;
  differenceCount?: number;
  differenceAreas?: Array<"check" | "probe" | "scan">;
}

export type IssueControlSuperviseProgressState =
  | "selected"
  | "planned"
  | "executed"
  | "verified"
  | "recovered"
  | "continued"
  | "failed"
  | "blocked"
  | "skipped";

export interface IssueControlSuperviseProgressLedger {
  version: 1;
  id: string;
  createdAt: string;
  sourceSuperviseId: string;
  provider: IssueControlProvider;
  repo: string;
  mode: "dry-run" | "execute";
  status: IssueControlSuperviseReport["status"];
  trustTier: IssueControlTrustTier;
  riskBudget: number;
  safetyEnvelope?: IssueControlSafetyEnvelope;
  controlOptions?: IssueControlSuperviseControlOptions;
  summary: {
    issueCount: number;
    selectedCount: number;
    reachedCount: number;
    unreachedSelectedCount: number;
    recoveredCount: number;
    continuedCount: number;
    unresolvedCount: number;
  };
  stopReason?: string;
  failureCategory?: SupervisorFailureCategory;
  superviseReportPath?: string;
  superviseReportMarkdownPath?: string;
  pullPath?: string;
  planPath?: string;
  items: IssueControlSuperviseProgressItem[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlSuperviseProgressItem {
  issueNumber: number;
  issueId?: string;
  runId?: string;
  title: string;
  action: IssueControlAction;
  risk?: "low" | "medium" | "high";
  selected: boolean;
  reached: boolean;
  iterationIndex?: number;
  state: IssueControlSuperviseProgressState;
  status?: IssueControlSuperviseIteration["status"];
  verificationStatus?: IssueControlSuperviseVerification["status"];
  recoveryExecutionStatus?: IssueControlRecoveryExecution["status"];
  continuedAfterRepair?: boolean;
  reason: string;
  artifactPaths: string[];
  events: IssueControlSuperviseProgressEvent[];
}

export interface IssueControlSuperviseProgressEvent {
  name: string;
  status: string;
  reason: string;
  artifactPaths: string[];
}

export interface IssueControlProgressOptions {
  input?: string;
}

export interface IssueControlAdvanceOptions extends IssueControlProgressOptions {
  execute?: boolean;
  maxSteps?: number;
  ignoreRepeatGuard?: boolean;
  fetchImpl?: typeof fetch;
  token?: string;
  retry?: GitHubRetryOptions;
  recoveryExecutor?: IssueControlRecoveryExecutor;
}

export interface IssueControlProgressStatusReport {
  version: 1;
  id: string;
  createdAt: string;
  sourceLedgerPath: string;
  sourceLedgerMarkdownPath?: string;
  sourceSuperviseId: string;
  provider: IssueControlProvider;
  repo: string;
  mode: "dry-run" | "execute";
  status: IssueControlSuperviseReport["status"];
  summary: IssueControlSuperviseProgressLedger["summary"];
  stopReason?: string;
  failureCategory?: SupervisorFailureCategory;
  unresolvedItems: IssueControlProgressStatusItem[];
  unreachedSelectedItems: IssueControlProgressStatusItem[];
  automationDecision: IssueControlProgressAutomationDecision;
  nextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export type IssueControlProgressAutomationDisposition =
  | "ready-to-execute"
  | "ready-to-continue"
  | "ready-to-sync"
  | "blocked"
  | "complete"
  | "review";

export interface IssueControlProgressAutomationDecision {
  disposition: IssueControlProgressAutomationDisposition;
  canAutoContinue: boolean;
  requiresHuman: boolean;
  trustTier?: IssueControlTrustTier;
  safetyEnvelope?: IssueControlSafetyEnvelope;
  adaptiveGate?: IssueControlAdaptiveGate;
  reason: string;
  nextCommand?: string;
}

export interface IssueControlProgressStatusItem {
  issueNumber: number;
  issueId?: string;
  runId?: string;
  title: string;
  action: IssueControlAction;
  state: IssueControlSuperviseProgressState;
  reason: string;
  artifactPaths: string[];
}

export interface IssueControlAdvanceReport {
  version: 1;
  id: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  status: "planned" | "executed" | "blocked" | "failed" | "skipped";
  sourceLedgerPath: string;
  sourceProgressStatusPath?: string;
  automationDecision: IssueControlProgressAutomationDecision;
  reason: string;
  nextCommand?: string;
  superviseReportPath?: string;
  superviseReportMarkdownPath?: string;
  superviseStatus?: IssueControlSuperviseReport["status"];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlAdvanceLoopReport {
  version: 1;
  id: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  maxSteps: number;
  status: "planned" | "complete" | "blocked" | "failed";
  stopReason: string;
  sourceLedgerPath?: string;
  repeatGuard?: IssueControlAdvanceLoopRepeatGuard;
  steps: IssueControlAdvanceLoopStep[];
  loopStatePath?: string;
  loopStateMarkdownPath?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlAdvanceLoopRepeatGuard {
  triggered: boolean;
  previousStatePath?: string;
  repeatedTerminalCount: number;
  reason: string;
}

export interface IssueControlAdvanceLoopStep {
  index: number;
  sourceLedgerPath: string;
  advanceReportPath?: string;
  advanceReportMarkdownPath?: string;
  status: IssueControlAdvanceReport["status"];
  decision: IssueControlProgressAutomationDisposition;
  reason: string;
  superviseReportPath?: string;
  superviseStatus?: IssueControlSuperviseReport["status"];
}

export interface IssueControlAdvanceLoopState {
  version: 1;
  id: string;
  updatedAt: string;
  mode: "dry-run" | "execute";
  configPath?: string;
  maxSteps: number;
  status: IssueControlAdvanceLoopReport["status"];
  stopReason: string;
  sourceLedgerPath?: string;
  lastLoopId: string;
  lastLoopPath?: string;
  lastLoopMarkdownPath?: string;
  terminalStepStatus?: IssueControlAdvanceReport["status"];
  terminalDecision?: IssueControlProgressAutomationDisposition;
  terminalSuperviseStatus?: IssueControlSuperviseReport["status"];
  repeatedTerminalCount: number;
  repeatGuardActive: boolean;
  trustTier?: IssueControlTrustTier;
  safetyEnvelope?: IssueControlSafetyEnvelope;
  adaptiveGate?: IssueControlAdaptiveGate;
  nextAction: string;
  schedulerDecision?: IssueControlAdvanceLoopSchedulerDecision;
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlAdvanceLoopStatusOptions {
  input?: string;
}

export interface IssueControlAdvanceSchedulerOptions extends IssueControlAdvanceLoopStatusOptions {
  execute?: boolean;
  fetchImpl?: typeof fetch;
  token?: string;
  retry?: GitHubRetryOptions;
  recoveryExecutor?: IssueControlRecoveryExecutor;
}

export type IssueControlAdvanceLoopSchedulerAction =
  | "run-advance-loop"
  | "review-plan"
  | "sync-issues"
  | "stop-for-recovery";

export interface IssueControlAdvanceLoopSchedulerDecision {
  action: IssueControlAdvanceLoopSchedulerAction;
  canRunUnattended: boolean;
  requiresHuman: boolean;
  trustTier?: IssueControlTrustTier;
  safetyEnvelope?: IssueControlSafetyEnvelope;
  adaptiveGate?: IssueControlAdaptiveGate;
  exitCode: 0 | 1;
  reason: string;
  nextCommand?: string;
}

export interface IssueControlAdvanceSchedulerReport {
  version: 1;
  id: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  status: "planned" | "executed" | "skipped" | "blocked" | "failed";
  sourceStatePath?: string;
  schedulerDecision: IssueControlAdvanceLoopSchedulerDecision;
  reason: string;
  nextCommand?: string;
  loopReportPath?: string;
  loopReportMarkdownPath?: string;
  loopStatus?: IssueControlAdvanceLoopReport["status"];
  auditLogPath?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlSyncGateOptions extends IssueControlAdvanceLoopStatusOptions {
  runId?: string;
  labels?: string[];
}

export interface IssueControlSyncGateReport {
  version: 1;
  id: string;
  createdAt: string;
  status: "ready" | "not-ready" | "blocked";
  sourceStatePath?: string;
  sourceLoopPath?: string;
  sourceLedgerPath?: string;
  provider?: IssueControlProvider;
  repo?: string;
  schedulerDecision: IssueControlAdvanceLoopSchedulerDecision;
  runId?: string;
  runIdSource?: "option" | "ledger" | "latest-fallback";
  completedIssueIds: string[];
  unresolvedIssueIds: string[];
  pendingIssueIds: string[];
  recommendedSyncCommand?: string;
  reason: string;
  outputPath?: string;
  markdownPath?: string;
}

export type SupervisorFailureCategory =
  | "missing-baseline"
  | "install-required"
  | "missing-script"
  | "probe-path-drift"
  | "formatting-noop"
  | "check-regression"
  | "probe-diff"
  | "compare-diff"
  | "task-execution-failed"
  | "proposal-repair-needed"
  | "bootstrap-blocked"
  | "github-read-blocked"
  | "human-approval-required"
  | "unknown";

export interface IssueControlRecoveryPlan {
  version: 1;
  id: string;
  createdAt: string;
  provider: IssueControlProvider;
  repo: string;
  sourceSuperviseId: string;
  status: "planned";
  failureCategory: SupervisorFailureCategory;
  failedIteration?: IssueControlSuperviseIteration;
  failedIssueId?: string;
  failedIssueNumber?: number;
  failedAction?: IssueControlAction;
  evidencePaths: string[];
  autoFixable: boolean;
  autoFixableReason: string;
  autoRepairEligible: boolean;
  humanActionRequired: boolean;
  repairStrategy: RepairStrategySummary;
  behaviorDiffRequired: boolean;
  recommendedNextCommand: string;
  recommendedActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

export interface IssueControlRecoveryExecution {
  version: 1;
  id: string;
  createdAt: string;
  provider: IssueControlProvider;
  repo: string;
  sourceSuperviseId: string;
  sourceRecoveryPlanId: string;
  mode: "dry-run" | "execute";
  status: "planned" | "executed" | "blocked" | "failed" | "skipped";
  failureCategory: SupervisorFailureCategory;
  autoFixable?: boolean;
  autoRepairEligible: boolean;
  repairStrategy?: RepairStrategySummary;
  behaviorDiffRequired?: boolean;
  behaviorDiffGuard?: IssueControlSuperviseVerification;
  action:
    | "capture-baseline"
    | "install-dependencies"
    | "patch-package-script"
    | "rewrite-probe-path"
    | "confirm-formatting-noop"
    | "proposal-repair"
    | "repair-agent"
    | "none";
  reason: string;
  recommendedNextCommand?: string;
  artifactPath?: string;
  error?: string;
  outputPath?: string;
  markdownPath?: string;
}

export async function pullIssueControl(loaded: LoadedConfig, options: IssueControlPullOptions = {}): Promise<IssueControlPullReport> {
  const provider = options.provider ?? "github";
  if (provider !== "github") {
    throw new Error(`Unsupported issue-control provider: ${provider}`);
  }
  const repo = resolveGitHubRepo(loaded, options.repo);
  const result = await readGitHubIssues({
    repo,
    token: options.token ?? process.env.GITHUB_TOKEN,
    state: options.state ?? "open",
    labels: options.labels,
    fetchImpl: options.fetchImpl,
    retry: options.retry
  });
  const report: IssueControlPullReport = {
    version: 1,
    id: `issue-control-pull-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    provider,
    repo: result.repo,
    state: result.state,
    labels: result.labels,
    createdAt: new Date().toISOString(),
    issueCount: result.issues.length,
    rateLimit: result.rateLimit,
    issues: result.issues.map(toIssueControlRemoteIssue)
  };
  return writeIssueControlPullReport(loaded, report);
}

export async function loadIssueControlPullReport(filePath: string): Promise<IssueControlPullReport> {
  return readJsonFile<IssueControlPullReport>(filePath);
}

export async function loadIssueControlPlanReport(filePath: string): Promise<IssueControlPlanReport> {
  return readJsonFile<IssueControlPlanReport>(filePath);
}

export async function writeIssueControlPlan(loaded: LoadedConfig, pull: IssueControlPullReport): Promise<IssueControlPlanReport> {
  const report = collectIssueControlPlan(pull);
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlPlan(report));
  return report;
}

export function collectIssueControlPlan(pull: IssueControlPullReport): IssueControlPlanReport {
  const items = pull.issues.map(toIssueControlPlanItem);
  return {
    version: 1,
    id: `issue-control-plan-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    provider: pull.provider,
    repo: pull.repo,
    sourcePullId: pull.id,
    createdAt: new Date().toISOString(),
    summary: {
      issueCount: pull.issues.length,
      mappedCount: items.filter((item) => item.issueId).length,
      executableCount: items.filter((item) => item.executable).length,
      bootstrapCount: items.filter((item) => item.action === "bootstrap-target").length,
      repairCount: items.filter((item) => item.action === "repair-proposal").length,
      externalReviewCount: items.filter((item) => item.action === "review-external").length
    },
    items
  };
}

export async function runIssueControlPlan(
  loaded: LoadedConfig,
  plan: IssueControlPlanReport,
  options: IssueControlRunOptions = {}
): Promise<IssueControlRunReport> {
  const maxItems = options.maxItems ?? 1;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`Invalid issue-control maxItems: ${maxItems}. Expected a positive integer.`);
  }
  if (maxItems !== 1) {
    throw new Error("Phase 99 issue-control run supports max-items 1 only.");
  }
  const executable = plan.items.filter((item) => item.executable);
  const candidates = options.onlyIssue
    ? executable.filter((item) => item.issueId === options.onlyIssue)
    : executable;
  if (options.onlyIssue && candidates.length === 0) {
    throw new Error(`Issue-control plan item not found or not executable for --only-issue ${options.onlyIssue}.`);
  }
  if (options.execute && !options.onlyIssue) {
    throw new Error("issue-control run --execute requires --only-issue <mg_issue_id> in Phase 99.");
  }
  const selected = candidates.slice(0, maxItems);
  const now = new Date().toISOString();
  const report: IssueControlRunReport = {
    version: 1,
    id: `issue-control-run-${now.replace(/[:.]/g, "-")}`,
    provider: plan.provider,
    repo: plan.repo,
    sourcePlanId: plan.id,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    onlyIssue: options.onlyIssue,
    maxItems,
    status: options.execute ? "complete" : "planned",
    summary: {
      candidateCount: candidates.length,
      selectedCount: selected.length,
      executedCount: 0,
      skippedCount: plan.items.length - selected.length,
      failedCount: 0
    },
    items: [],
    recommendedNextActions: []
  };

  if (selected.length === 0) {
    report.status = "blocked";
    report.recommendedNextActions.push("Select an executable issue-control plan item or refresh md2 issues.");
    return writeIssueControlRunReport(loaded, report);
  }

  for (const item of plan.items) {
    if (!selected.includes(item)) {
      report.items.push({
        issueNumber: item.issueNumber,
        issueId: item.issueId,
        title: item.title,
        action: item.action,
        command: item.recommendedCommand,
        status: "skipped",
        reason: selected.length > 0 ? "Not selected for this single-issue run." : "No executable item selected."
      });
      continue;
    }
    const runItem = await runIssueControlPlanItem(loaded, item, options);
    report.items.push(runItem);
    if (runItem.status === "executed") {
      report.summary.executedCount += 1;
    }
    if (runItem.status === "failed") {
      report.summary.failedCount += 1;
      report.status = "failed";
    }
    if (runItem.status === "blocked") {
      report.status = "blocked";
    }
  }
  report.recommendedNextActions.push(...createRunRecommendedNextActions(report));
  return writeIssueControlRunReport(loaded, report);
}

export async function autoIssueControl(
  loaded: LoadedConfig,
  options: IssueControlAutoOptions = {}
): Promise<IssueControlAutoReport> {
  const maxIterations = options.maxIterations ?? 1;
  const trustTier = options.trustTier ?? "supervised";
  const trustPolicy = createIssueControlTrustPolicy(trustTier, maxIterations, Boolean(options.allowHighRisk));
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`Invalid issue-control auto maxIterations: ${maxIterations}. Expected a positive integer.`);
  }
  if (maxIterations !== 1) {
    throw new Error("Phase 100 issue-control auto supports max-iterations 1 only.");
  }
  const pull = await pullIssueControl(loaded, options);
  const plan = await writeIssueControlPlan(loaded, pull);
  const selection = selectIssueControlAutoItem(plan, {
    allowHighRisk: Boolean(options.allowHighRisk),
    trustTier
  });
  const now = new Date().toISOString();
  const selected = selection.find((item) => item.selected);
  let run: IssueControlRunReport | undefined;
  if (selected?.issueId) {
    run = await runIssueControlPlan(loaded, plan, {
      execute: options.execute,
      onlyIssue: selected.issueId,
      runId: options.runId,
      editCommand: options.editCommand,
      maxItems: 1
    });
  }
  const status = !selected
    ? "blocked"
    : run?.status === "failed"
      ? "failed"
      : run?.status === "blocked"
        ? "blocked"
        : options.execute
          ? "complete"
          : "planned";
  const report: IssueControlAutoReport = {
    version: 1,
    id: `issue-control-auto-${now.replace(/[:.]/g, "-")}`,
    provider: plan.provider,
    repo: plan.repo,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    maxIterations,
    allowHighRisk: Boolean(options.allowHighRisk),
    trustTier,
    riskBudget: trustPolicy.riskBudget,
    status,
    pullPath: pull.outputPath,
    planPath: plan.outputPath,
    runPath: run?.outputPath,
    selectedIssueId: selected?.issueId,
    selectedIssueNumber: selected?.issueNumber,
    selectedAction: selected?.action,
    selection,
    recommendedNextActions: createAutoRecommendedNextActions(selected, run, options)
  };
  return writeIssueControlAutoReport(loaded, report);
}

export async function superviseIssueControl(
  loaded: LoadedConfig,
  options: IssueControlSuperviseOptions = {}
): Promise<IssueControlSuperviseReport> {
  const maxIterations = options.maxIterations ?? 3;
  const trustTier = options.trustTier ?? "supervised";
  const trustPolicy = createIssueControlTrustPolicy(trustTier, maxIterations, Boolean(options.allowHighRisk));
  const effectiveVerifyEach = trustTier === "unattended" ? true : Boolean(options.verifyEach);
  const effectiveRepairOnFail = trustTier === "unattended" ? true : Boolean(options.repairOnFail);
  const effectiveContinueAfterRepair = trustTier === "unattended" ? true : Boolean(options.continueAfterRepair);
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`Invalid issue-control supervise maxIterations: ${maxIterations}. Expected a positive integer.`);
  }
  if (maxIterations > 10) {
    throw new Error("issue-control supervise supports --max-iterations up to 10 in Phase 103.");
  }
  const pull = await pullIssueControl(loaded, options);
  const plan = await writeIssueControlPlan(loaded, pull);
  const selection = selectIssueControlSuperviseItems(plan, {
    allowHighRisk: Boolean(options.allowHighRisk),
    maxIterations,
    trustTier,
    riskBudget: trustPolicy.riskBudget
  });
  const selected = selection.filter((item) => item.selected);
  const now = new Date().toISOString();
  const report: IssueControlSuperviseReport = {
    version: 1,
    id: `issue-control-supervise-${now.replace(/[:.]/g, "-")}`,
    provider: plan.provider,
    repo: plan.repo,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    maxIterations,
    allowHighRisk: Boolean(options.allowHighRisk),
    trustTier,
    riskBudget: trustPolicy.riskBudget,
    controlOptions: {
      configPath: loaded.path,
      state: options.state ?? "open",
      labels: options.labels ?? [],
      execute: Boolean(options.execute),
      maxIterations,
      allowHighRisk: Boolean(options.allowHighRisk),
      trustTier,
      riskBudget: trustPolicy.riskBudget,
      verifyEach: effectiveVerifyEach,
      repairOnFail: effectiveRepairOnFail,
      continueAfterRepair: effectiveContinueAfterRepair,
      repairAgentCommand: options.repairAgentCommand
    },
    status: selected.length === 0 ? "blocked" : options.execute ? "complete" : "planned",
    pullPath: pull.outputPath,
    planPath: plan.outputPath,
    summary: {
      issueCount: plan.summary.issueCount,
      selectableCount: selection.filter((item) => isSuperviseSelectedReason(item.reason) || item.selected).length,
      selectedCount: selected.length,
      plannedCount: 0,
      executedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      blockedCount: 0
    },
    selection,
    iterations: [],
    recommendedNextActions: []
  };

  if (selected.length === 0) {
    report.stopReason = "No safe executable issue was selected.";
    await attachRecoveryPlan(loaded, report);
    report.safetyEnvelope = await createIssueControlSafetyEnvelopeForReport(loaded, report);
    report.recommendedNextActions = createSuperviseRecommendedNextActions(report);
    return writeIssueControlSuperviseReport(loaded, report);
  }

  for (const [index, selectedItem] of selected.entries()) {
    const run = await runIssueControlPlan(loaded, plan, {
      execute: options.execute,
      onlyIssue: selectedItem.issueId,
      runId: options.runId,
      editCommand: options.editCommand,
      maxItems: 1
    });
    const runItem = run.items.find((item) => item.issueId === selectedItem.issueId && item.issueNumber === selectedItem.issueNumber)
      ?? run.items.find((item) => item.issueId === selectedItem.issueId)
      ?? run.items.find((item) => item.issueNumber === selectedItem.issueNumber);
    const iteration = toSuperviseIteration(index + 1, selectedItem, run, runItem);
    const executionStatus = iteration.status;
    if (effectiveVerifyEach) {
      iteration.verification = await verifySuperviseIteration(loaded, iteration);
      if (iteration.verification.status === "passed") {
        report.summary.verifiedCount += 1;
      }
      if (iteration.verification.status === "failed") {
        iteration.status = "failed";
      }
      if (iteration.verification.status === "blocked") {
        iteration.status = "blocked";
      }
      if (trustTier === "unattended" && (iteration.verification.status === "failed" || iteration.verification.status === "blocked")) {
        iteration.watchdogRollback = await runIssueControlWatchdogRollback(loaded, iteration);
      }
    }
    report.iterations.push(iteration);

    if (executionStatus === "planned") {
      report.summary.plannedCount += 1;
    }
    if (executionStatus === "executed") {
      report.summary.executedCount += 1;
    }
    if (iteration.status === "failed") {
      report.summary.failedCount += 1;
      report.status = "failed";
      report.stopReason = `Iteration ${iteration.index} failed for ${iteration.issueId ?? `#${iteration.issueNumber}`}.`;
      const shouldContinue = await handleSuperviseRecovery(loaded, report, iteration, {
        ...options,
        repairOnFail: effectiveRepairOnFail,
        continueAfterRepair: effectiveContinueAfterRepair
      });
      if (shouldContinue) {
        continue;
      }
      break;
    }
    if (iteration.status === "blocked") {
      report.summary.blockedCount += 1;
      report.status = "blocked";
      report.stopReason = `Iteration ${iteration.index} blocked for ${iteration.issueId ?? `#${iteration.issueNumber}`}.`;
      const shouldContinue = await handleSuperviseRecovery(loaded, report, iteration, {
        ...options,
        repairOnFail: effectiveRepairOnFail,
        continueAfterRepair: effectiveContinueAfterRepair
      });
      if (shouldContinue) {
        continue;
      }
      break;
    }
  }

  if (!report.stopReason && report.iterations.length >= maxIterations && selected.length >= maxIterations) {
    report.stopReason = `Reached max iterations ${maxIterations}.`;
  }
  if (report.status === "failed" || report.status === "blocked") {
    const recoveryPlan = await attachRecoveryPlan(loaded, report);
    if (effectiveRepairOnFail && recoveryPlan) {
      await attachRecoveryExecution(loaded, report, recoveryPlan, {
        ...options,
        repairOnFail: effectiveRepairOnFail,
        continueAfterRepair: effectiveContinueAfterRepair
      });
    }
  }
  report.safetyEnvelope = await createIssueControlSafetyEnvelopeForReport(loaded, report);
  report.recommendedNextActions = createSuperviseRecommendedNextActions(report);
  return writeIssueControlSuperviseReport(loaded, report);
}

export async function issueControlProgressStatus(
  loaded: LoadedConfig,
  options: IssueControlProgressOptions = {}
): Promise<IssueControlProgressStatusReport> {
  const ledgerPath = options.input
    ? path.resolve(process.cwd(), options.input)
    : await latestIssueControlSuperviseProgressLedgerPath(loaded);
  if (!ledgerPath) {
    throw new Error("No issue-control supervise progress ledger found. Run issue-control supervise first or pass --input <progress.json>.");
  }
  const ledger = await loadIssueControlSuperviseProgressLedger(ledgerPath);
  const report = createIssueControlProgressStatusReport(ledger, ledgerPath);
  return writeIssueControlProgressStatusReport(loaded, report);
}

export async function advanceIssueControl(
  loaded: LoadedConfig,
  options: IssueControlAdvanceOptions = {}
): Promise<IssueControlAdvanceReport> {
  const progress = await issueControlProgressStatus(loaded, { input: options.input });
  const ledger = await loadIssueControlSuperviseProgressLedger(progress.sourceLedgerPath);
  const now = new Date().toISOString();
  const base: IssueControlAdvanceReport = {
    version: 1,
    id: `issue-control-advance-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    status: "planned",
    sourceLedgerPath: progress.sourceLedgerPath,
    sourceProgressStatusPath: progress.outputPath,
    automationDecision: progress.automationDecision,
    reason: progress.automationDecision.reason,
    nextCommand: progress.automationDecision.nextCommand
  };
  if (!options.execute) {
    return writeIssueControlAdvanceReport(loaded, {
      ...base,
      status: progress.automationDecision.canAutoContinue ? "planned" : "blocked",
      reason: progress.automationDecision.canAutoContinue
        ? "Advance is planned. Rerun with --execute to run the next supervised step."
        : progress.automationDecision.reason
    });
  }
  if (!progress.automationDecision.canAutoContinue || !ledger.controlOptions) {
    return writeIssueControlAdvanceReport(loaded, {
      ...base,
      status: "blocked",
      reason: "Advance is blocked because progress status is not eligible for automatic continuation."
    });
  }
  const supervise = await superviseIssueControl(loaded, {
    state: ledger.controlOptions.state,
    labels: ledger.controlOptions.labels,
    execute: true,
    maxIterations: ledger.controlOptions.maxIterations,
    allowHighRisk: ledger.controlOptions.allowHighRisk,
    verifyEach: ledger.controlOptions.verifyEach,
    repairOnFail: ledger.controlOptions.repairOnFail,
    continueAfterRepair: ledger.controlOptions.continueAfterRepair,
    repairAgentCommand: ledger.controlOptions.repairAgentCommand,
    repo: ledger.repo,
    token: options.token,
    fetchImpl: options.fetchImpl,
    retry: options.retry,
    recoveryExecutor: options.recoveryExecutor
  });
  return writeIssueControlAdvanceReport(loaded, {
    ...base,
    status: supervise.status === "failed" || supervise.status === "blocked" ? supervise.status : "executed",
    reason: `Advance executed supervise run ${supervise.id} with status ${supervise.status}.`,
    superviseReportPath: supervise.outputPath,
    superviseReportMarkdownPath: supervise.markdownPath,
    superviseStatus: supervise.status
  });
}

export async function advanceIssueControlLoop(
  loaded: LoadedConfig,
  options: IssueControlAdvanceOptions = {}
): Promise<IssueControlAdvanceLoopReport> {
  const maxSteps = options.maxSteps ?? 1;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`Invalid issue-control advance maxSteps: ${maxSteps}. Expected a positive integer.`);
  }
  if (maxSteps > 10) {
    throw new Error("issue-control advance supports --max-steps up to 10.");
  }
  const now = new Date().toISOString();
  const sourceLedgerPath = options.input
    ? path.resolve(process.cwd(), options.input)
    : await latestIssueControlSuperviseProgressLedgerPath(loaded);
  if (!sourceLedgerPath) {
    throw new Error("No issue-control supervise progress ledger found. Run issue-control supervise first or pass --input <progress.json>.");
  }
  const previousState = await loadIssueControlAdvanceLoopState(loaded);
  const repeatGuard = createIssueControlAdvanceLoopRepeatGuard(previousState, sourceLedgerPath, options);
  if (repeatGuard.triggered) {
    return writeIssueControlAdvanceLoopReport(loaded, {
      version: 1,
      id: `issue-control-advance-loop-${now.replace(/[:.]/g, "-")}`,
      createdAt: now,
      mode: options.execute ? "execute" : "dry-run",
      maxSteps,
      status: "blocked",
      stopReason: repeatGuard.reason,
      sourceLedgerPath,
      repeatGuard,
      steps: []
    }, previousState);
  }
  const steps: IssueControlAdvanceLoopStep[] = [];
  let status: IssueControlAdvanceLoopReport["status"] = options.execute ? "complete" : "planned";
  let stopReason = options.execute
    ? `Reached max steps ${maxSteps}.`
    : "Advance loop dry-run planned the next step only.";

  for (let index = 1; index <= maxSteps; index += 1) {
    const step = await advanceIssueControl(loaded, {
      ...options,
      input: index === 1 ? options.input : undefined
    });
    steps.push({
      index,
      sourceLedgerPath: step.sourceLedgerPath,
      advanceReportPath: step.outputPath,
      advanceReportMarkdownPath: step.markdownPath,
      status: step.status,
      decision: step.automationDecision.disposition,
      reason: step.reason,
      superviseReportPath: step.superviseReportPath,
      superviseStatus: step.superviseStatus
    });
    if (!options.execute) {
      status = step.status === "blocked" ? "blocked" : "planned";
      stopReason = step.reason;
      break;
    }
    if (step.status === "blocked" || step.status === "failed") {
      status = step.status;
      stopReason = step.reason;
      break;
    }
    if (step.status === "executed" && step.superviseStatus === "complete") {
      status = "complete";
      stopReason = step.reason;
      break;
    }
    if (step.automationDecision.disposition === "ready-to-sync" || step.automationDecision.disposition === "complete") {
      status = "complete";
      stopReason = step.reason;
      break;
    }
  }

  return writeIssueControlAdvanceLoopReport(loaded, {
    version: 1,
    id: `issue-control-advance-loop-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    maxSteps,
    status,
    stopReason,
    sourceLedgerPath,
    repeatGuard,
    steps
  }, previousState);
}

export async function issueControlAdvanceLoopStatus(
  loaded: LoadedConfig,
  options: IssueControlAdvanceLoopStatusOptions = {}
): Promise<IssueControlAdvanceLoopState> {
  const statePath = options.input
    ? path.resolve(process.cwd(), options.input)
    : path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
  if (!await pathExists(statePath)) {
    throw new Error("No issue-control advance loop state found. Run issue-control advance --max-steps <n> first or pass --input <state.json>.");
  }
  const state = await readJsonFile<IssueControlAdvanceLoopState>(statePath);
  const sourceSafety = state.sourceLedgerPath ? await readIssueControlLedgerSafety(state.sourceLedgerPath) : undefined;
  const enrichedState: IssueControlAdvanceLoopState = {
    ...state,
    trustTier: state.trustTier ?? sourceSafety?.trustTier,
    safetyEnvelope: state.safetyEnvelope ?? sourceSafety?.safetyEnvelope,
    adaptiveGate: state.adaptiveGate ?? sourceSafety?.adaptiveGate
  };
  return {
    ...enrichedState,
    schedulerDecision: state.schedulerDecision?.adaptiveGate
      ? state.schedulerDecision
      : createIssueControlAdvanceLoopSchedulerDecision(enrichedState)
  };
}

export async function advanceIssueControlScheduler(
  loaded: LoadedConfig,
  options: IssueControlAdvanceSchedulerOptions = {}
): Promise<IssueControlAdvanceSchedulerReport> {
  const state = await issueControlAdvanceLoopStatus(loaded, { input: options.input });
  const decision = state.schedulerDecision ?? createIssueControlAdvanceLoopSchedulerDecision(state);
  const now = new Date().toISOString();
  const base: IssueControlAdvanceSchedulerReport = {
    version: 1,
    id: `issue-control-advance-scheduler-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    mode: options.execute ? "execute" : "dry-run",
    status: "planned",
    sourceStatePath: state.outputPath ?? options.input,
    schedulerDecision: decision,
    reason: decision.reason,
    nextCommand: decision.nextCommand,
    auditLogPath: issueControlAuditLogPath(loaded)
  };
  await appendIssueControlAudit(loaded, {
    type: "scheduler-decision",
    reportId: base.id,
    sourceStatePath: base.sourceStatePath,
    decision
  });
  if (decision.action !== "run-advance-loop") {
    const report = await writeIssueControlAdvanceSchedulerReport(loaded, {
      ...base,
      status: decision.exitCode === 0 ? "skipped" : "blocked",
      reason: `Scheduler action ${decision.action} is not executable by advance-scheduler. ${decision.reason}`
    });
    await appendIssueControlAudit(loaded, {
      type: "scheduler-result",
      reportId: report.id,
      status: report.status,
      reason: report.reason
    });
    return report;
  }
  if (!options.execute) {
    const report = await writeIssueControlAdvanceSchedulerReport(loaded, {
      ...base,
      status: "planned",
      reason: "Scheduler planned the next bounded advance loop. Rerun with --execute to continue."
    });
    await appendIssueControlAudit(loaded, {
      type: "scheduler-result",
      reportId: report.id,
      status: report.status,
      reason: report.reason
    });
    return report;
  }
  if (!decision.canRunUnattended) {
    const report = await writeIssueControlAdvanceSchedulerReport(loaded, {
      ...base,
      status: "blocked",
      reason: `Scheduler action run-advance-loop is not allowed unattended. ${decision.reason}`
    });
    await appendIssueControlAudit(loaded, {
      type: "scheduler-result",
      reportId: report.id,
      status: report.status,
      reason: report.reason
    });
    return report;
  }
  const loop = await advanceIssueControlLoop(loaded, {
    execute: true,
    maxSteps: state.maxSteps,
    fetchImpl: options.fetchImpl,
    token: options.token,
    retry: options.retry,
    recoveryExecutor: options.recoveryExecutor
  });
  const report = await writeIssueControlAdvanceSchedulerReport(loaded, {
    ...base,
    status: loop.status === "failed" || loop.status === "blocked" ? loop.status : "executed",
    reason: `Scheduler executed advance loop ${loop.id} with status ${loop.status}.`,
    loopReportPath: loop.outputPath,
    loopReportMarkdownPath: loop.markdownPath,
    loopStatus: loop.status
  });
  await appendIssueControlAudit(loaded, {
    type: "scheduler-result",
    reportId: report.id,
    status: report.status,
    reason: report.reason,
    loopReportPath: report.loopReportPath
  });
  return report;
}

export async function issueControlSyncGate(
  loaded: LoadedConfig,
  options: IssueControlSyncGateOptions = {}
): Promise<IssueControlSyncGateReport> {
  const state = await issueControlAdvanceLoopStatus(loaded, { input: options.input });
  const decision = state.schedulerDecision ?? createIssueControlAdvanceLoopSchedulerDecision(state);
  const now = new Date().toISOString();
  const base: IssueControlSyncGateReport = {
    version: 1,
    id: `issue-control-sync-gate-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    status: "not-ready",
    sourceStatePath: state.outputPath ?? options.input,
    sourceLoopPath: state.lastLoopPath,
    schedulerDecision: decision,
    completedIssueIds: [],
    unresolvedIssueIds: [],
    pendingIssueIds: [],
    reason: decision.reason
  };

  if (decision.action !== "sync-issues") {
    return writeIssueControlSyncGateReport(loaded, {
      ...base,
      status: decision.exitCode === 0 ? "not-ready" : "blocked",
      reason: `Sync gate requires scheduler action sync-issues; got ${decision.action}. ${decision.reason}`
    });
  }

  const ledgerPath = await resolveIssueControlSyncGateLedgerPath(state);
  if (!ledgerPath) {
    return writeIssueControlSyncGateReport(loaded, {
      ...base,
      status: "blocked",
      reason: "Sync gate could not find the progress ledger behind the completed advance loop."
    });
  }

  const ledger = await loadIssueControlSuperviseProgressLedger(ledgerPath);
  const completedIssueIds = uniqueStrings(ledger.items
    .filter(isIssueControlSyncCompletedItem)
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  const unresolvedIssueIds = uniqueStrings(ledger.items
    .filter((item) => item.state === "failed" || item.state === "blocked")
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  const pendingIssueIds = uniqueStrings(ledger.items
    .filter((item) => item.selected && !isIssueControlSyncCompletedItem(item) && item.state !== "failed" && item.state !== "blocked")
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  const run = resolveIssueControlSyncGateRunId(options.runId, ledger);
  const recommendedSyncCommand = createIssueControlSyncGateCommand(run.runId, options.labels ?? [], completedIssueIds);

  return writeIssueControlSyncGateReport(loaded, {
    ...base,
    status: unresolvedIssueIds.length > 0 ? "blocked" : "ready",
    sourceLedgerPath: ledgerPath,
    provider: ledger.provider,
    repo: ledger.repo,
    runId: run.runId,
    runIdSource: run.source,
    completedIssueIds,
    unresolvedIssueIds,
    pendingIssueIds,
    recommendedSyncCommand,
    reason: unresolvedIssueIds.length > 0
      ? "Completed loop still has unresolved progress items; review recovery evidence before issue sync."
      : "Advance loop is complete and ready for a reviewed GitHub live-plan sync."
  });
}

export function renderIssueControlPull(report: IssueControlPullReport): string {
  return [
    `# Issue Control Pull: ${report.id}`,
    "",
    `- Provider: ${report.provider}`,
    `- Repo: ${report.repo}`,
    `- State: ${report.state}`,
    `- Labels: ${report.labels.join(", ") || "none"}`,
    `- Issues: ${report.issueCount}`,
    "",
    "| # | Title | mg_issue_id | Type | Status | Risk |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...report.issues.map((issue) => [
      `| ${issue.number}`,
      issue.htmlUrl ? `[${escapeCell(issue.title)}](${issue.htmlUrl})` : escapeCell(issue.title),
      issue.migrationGuard.issueId ?? "none",
      issue.migrationGuard.issueType ?? "none",
      issue.migrationGuard.status ?? "none",
      `${issue.migrationGuard.risk ?? "none"} |`
    ].join(" | "))
  ].join("\n");
}

export function renderIssueControlPlan(report: IssueControlPlanReport): string {
  return [
    `# Issue Control Plan: ${report.id}`,
    "",
    `- Provider: ${report.provider}`,
    `- Repo: ${report.repo}`,
    `- Source pull: ${report.sourcePullId}`,
    `- Issues: ${report.summary.issueCount}`,
    `- Mapped: ${report.summary.mappedCount}`,
    `- Executable: ${report.summary.executableCount}`,
    `- Bootstrap: ${report.summary.bootstrapCount}`,
    `- Repairs: ${report.summary.repairCount}`,
    `- External review: ${report.summary.externalReviewCount}`,
    "",
    "| # | Action | Executable | mg_issue_id | Type | Status | Reason |",
    "| ---: | --- | --- | --- | --- | --- | --- |",
    ...report.items.map((item) => [
      `| ${item.issueNumber}`,
      item.action,
      item.executable ? "yes" : "no",
      item.issueId ?? "none",
      item.issueType ?? "none",
      item.status ?? "none",
      `${escapeCell(item.reason)} |`
    ].join(" | ")),
    "",
    "## Recommended Commands",
    "",
    ...report.items
      .filter((item) => item.recommendedCommand)
      .map((item) => `- #${item.issueNumber}: \`${item.recommendedCommand}\``)
  ].join("\n");
}

export function renderIssueControlRun(report: IssueControlRunReport): string {
  return [
    `# Issue Control Run: ${report.id}`,
    "",
    `- Provider: ${report.provider}`,
    `- Repo: ${report.repo}`,
    `- Source plan: ${report.sourcePlanId}`,
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Only issue: ${report.onlyIssue ?? "none"}`,
    `- Selected: ${report.summary.selectedCount}`,
    `- Executed: ${report.summary.executedCount}`,
    `- Failed: ${report.summary.failedCount}`,
    "",
    "| # | Action | Status | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- |",
    ...report.items.map((item) => [
      `| ${item.issueNumber}`,
      item.action,
      item.status,
      item.issueId ?? "none",
      `${escapeCell(item.error ?? item.reason)} |`
    ].join(" | ")),
    "",
    "## Commands",
    "",
    ...report.items
      .filter((item) => item.command)
      .map((item) => `- #${item.issueNumber}: \`${item.command}\``),
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

export function renderIssueControlAuto(report: IssueControlAutoReport): string {
  return [
    `# Issue Control Auto: ${report.id}`,
    "",
    `- Provider: ${report.provider}`,
    `- Repo: ${report.repo}`,
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Max iterations: ${report.maxIterations}`,
    `- Allow high risk: ${report.allowHighRisk ? "yes" : "no"}`,
    `- Trust tier: ${report.trustTier}`,
    `- Risk budget: ${report.riskBudget}`,
    `- Selected issue: ${report.selectedIssueId ?? "none"}`,
    `- Selected action: ${report.selectedAction ?? "none"}`,
    "",
    "## Selection",
    "",
    "| # | Selected | Action | Risk | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...report.selection.map((item) => [
      `| ${item.issueNumber}`,
      item.selected ? "yes" : "no",
      item.action,
      item.risk ?? "none",
      item.issueId ?? "none",
      `${escapeCell(item.reason)} |`
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
    `- Pull: ${report.pullPath ?? "none"}`,
    `- Plan: ${report.planPath ?? "none"}`,
    `- Run: ${report.runPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlSupervise(report: IssueControlSuperviseReport): string {
  return [
    `# Issue Control Supervise: ${report.id}`,
    "",
    `- Provider: ${report.provider}`,
    `- Repo: ${report.repo}`,
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Max iterations: ${report.maxIterations}`,
    `- Allow high risk: ${report.allowHighRisk ? "yes" : "no"}`,
    `- Trust tier: ${report.trustTier}`,
    `- Risk budget: ${report.riskBudget}`,
    `- Safety envelope: ${report.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Selected: ${report.summary.selectedCount}`,
    `- Planned: ${report.summary.plannedCount}`,
    `- Executed: ${report.summary.executedCount}`,
    `- Verified: ${report.summary.verifiedCount}`,
    `- Failed: ${report.summary.failedCount}`,
    `- Blocked: ${report.summary.blockedCount}`,
    `- Stop reason: ${report.stopReason ?? "none"}`,
    `- Failure category: ${report.failureCategory ?? "none"}`,
    `- Auto repair eligible: ${report.autoRepairEligible === undefined ? "none" : report.autoRepairEligible ? "yes" : "no"}`,
    `- Human action required: ${report.humanActionRequired === undefined ? "none" : report.humanActionRequired ? "yes" : "no"}`,
    `- Continued after repair: ${report.continuedAfterRepair ? `yes (${report.continuedAfterRepairCount ?? 1})` : "no"}`,
    "",
    "## Selection",
    "",
    "| # | Selected | Action | Risk | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...report.selection.map((item) => [
      `| ${item.issueNumber}`,
      item.selected ? "yes" : "no",
      item.action,
      item.risk ?? "none",
      item.issueId ?? "none",
      `${escapeCell(item.reason)} |`
    ].join(" | ")),
    "",
    "## Iterations",
    "",
    "| Iteration | # | Action | Status | Verify | Recovery | Continue | mg_issue_id | Reason |",
    "| ---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
    ...report.iterations.map((item) => [
      `| ${item.index}`,
      item.issueNumber,
      item.action,
      item.status,
      item.verification?.status ?? "none",
      item.recoveryExecutionStatus ?? (item.recoveryPlanPath ? "planned" : "none"),
      item.continuedAfterRepair ? "yes" : "no",
      item.issueId ?? "none",
      `${escapeCell(item.error ?? item.reason)} |`
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
    `- Pull: ${report.pullPath ?? "none"}`,
    `- Plan: ${report.planPath ?? "none"}`,
    `- Progress ledger: ${report.progressLedgerPath ?? "none"}`,
    `- Recovery plan: ${report.recoveryPlanPath ?? "none"}`,
    `- Recovery execution: ${report.recoveryExecutionPath ?? "none"}`,
    ...report.iterations.map((iteration) => `- Iteration ${iteration.index}: ${iteration.runPath ?? "none"}`),
    ...report.iterations
      .filter((iteration) => iteration.recoveryPlanPath)
      .map((iteration) => `- Iteration ${iteration.index} recovery plan: ${iteration.recoveryPlanPath}`),
    ...report.iterations
      .filter((iteration) => iteration.recoveryExecutionPath)
      .map((iteration) => `- Iteration ${iteration.index} recovery execution: ${iteration.recoveryExecutionPath}`),
    ...report.iterations
      .filter((iteration) => iteration.verification?.compareReportPath)
      .map((iteration) => `- Iteration ${iteration.index} compare: ${iteration.verification?.compareReportPath}`),
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlSuperviseProgressLedger(ledger: IssueControlSuperviseProgressLedger): string {
  return [
    `# Issue Control Supervise Progress: ${ledger.id}`,
    "",
    `- Source supervise: ${ledger.sourceSuperviseId}`,
    `- Repo: ${ledger.repo}`,
    `- Mode: ${ledger.mode}`,
    `- Status: ${ledger.status}`,
    `- Trust tier: ${ledger.trustTier}`,
    `- Risk budget: ${ledger.riskBudget}`,
    `- Safety envelope: ${ledger.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Selected: ${ledger.summary.selectedCount}`,
    `- Reached: ${ledger.summary.reachedCount}`,
    `- Unreached selected: ${ledger.summary.unreachedSelectedCount}`,
    `- Recovered: ${ledger.summary.recoveredCount}`,
    `- Continued: ${ledger.summary.continuedCount}`,
    `- Unresolved: ${ledger.summary.unresolvedCount}`,
    `- Stop reason: ${ledger.stopReason ?? "none"}`,
    `- Failure category: ${ledger.failureCategory ?? "none"}`,
    "",
    "## Items",
    "",
    "| # | Selected | Reached | Iteration | State | Verify | Recovery | Continue | mg_issue_id | Reason |",
    "| ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
    ...ledger.items.map((item) => [
      `| ${item.issueNumber}`,
      item.selected ? "yes" : "no",
      item.reached ? "yes" : "no",
      item.iterationIndex ?? "none",
      item.state,
      item.verificationStatus ?? "none",
      item.recoveryExecutionStatus ?? "none",
      item.continuedAfterRepair ? "yes" : "no",
      item.issueId ?? "none",
      `${escapeCell(item.reason)} |`
    ].join(" | ")),
    "",
    "## Events",
    "",
    ...ledger.items.flatMap((item) => [
      `### #${item.issueNumber} ${item.issueId ?? "unmapped"}`,
      "",
      ...(item.events.length > 0
        ? item.events.map((event) => `- ${event.name}: ${event.status} - ${event.reason}`)
        : ["- none"]),
      ""
    ]),
    "## Artifacts",
    "",
    `- Supervise JSON: ${ledger.superviseReportPath ?? "none"}`,
    `- Supervise Markdown: ${ledger.superviseReportMarkdownPath ?? "none"}`,
    `- Pull: ${ledger.pullPath ?? "none"}`,
    `- Plan: ${ledger.planPath ?? "none"}`,
    ...ledger.items.flatMap((item) => item.artifactPaths.map((artifact) => `- #${item.issueNumber}: ${artifact}`)),
    `- JSON: ${ledger.outputPath ?? "none"}`,
    `- Markdown: ${ledger.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlProgressStatus(report: IssueControlProgressStatusReport): string {
  return [
    `# Issue Control Progress Status: ${report.id}`,
    "",
    `- Source supervise: ${report.sourceSuperviseId}`,
    `- Repo: ${report.repo}`,
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Selected: ${report.summary.selectedCount}`,
    `- Reached: ${report.summary.reachedCount}`,
    `- Unreached selected: ${report.summary.unreachedSelectedCount}`,
    `- Recovered: ${report.summary.recoveredCount}`,
    `- Continued: ${report.summary.continuedCount}`,
    `- Unresolved: ${report.summary.unresolvedCount}`,
    `- Automation disposition: ${report.automationDecision.disposition}`,
    `- Trust tier: ${report.automationDecision.trustTier ?? "unknown"}`,
    `- Safety envelope: ${report.automationDecision.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Adaptive gate: ${report.automationDecision.adaptiveGate?.state ?? "unknown"} -> ${report.automationDecision.adaptiveGate?.recommendedMaxIterations ?? "unknown"}`,
    `- Can auto continue: ${report.automationDecision.canAutoContinue ? "yes" : "no"}`,
    `- Requires human: ${report.automationDecision.requiresHuman ? "yes" : "no"}`,
    `- Automation reason: ${report.automationDecision.reason}`,
    `- Next command: ${report.automationDecision.nextCommand ?? "none"}`,
    `- Stop reason: ${report.stopReason ?? "none"}`,
    `- Failure category: ${report.failureCategory ?? "none"}`,
    "",
    "## Unresolved Items",
    "",
    ...(report.unresolvedItems.length > 0
      ? renderIssueControlProgressStatusItems(report.unresolvedItems)
      : ["- none"]),
    "",
    "## Unreached Selected Items",
    "",
    ...(report.unreachedSelectedItems.length > 0
      ? renderIssueControlProgressStatusItems(report.unreachedSelectedItems)
      : ["- none"]),
    "",
    "## Next Actions",
    "",
    ...(report.nextActions.length > 0
      ? report.nextActions.map((action) => `- ${action}`)
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- Source ledger: ${report.sourceLedgerPath}`,
    `- Source ledger markdown: ${report.sourceLedgerMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvance(report: IssueControlAdvanceReport): string {
  return [
    `# Issue Control Advance: ${report.id}`,
    "",
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Decision: ${report.automationDecision.disposition}`,
    `- Can auto continue: ${report.automationDecision.canAutoContinue ? "yes" : "no"}`,
    `- Requires human: ${report.automationDecision.requiresHuman ? "yes" : "no"}`,
    `- Reason: ${report.reason}`,
    `- Next command: ${report.nextCommand ?? "none"}`,
    `- Supervise status: ${report.superviseStatus ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Source ledger: ${report.sourceLedgerPath}`,
    `- Source progress status: ${report.sourceProgressStatusPath ?? "none"}`,
    `- Supervise JSON: ${report.superviseReportPath ?? "none"}`,
    `- Supervise Markdown: ${report.superviseReportMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceLoop(report: IssueControlAdvanceLoopReport): string {
  return [
    `# Issue Control Advance Loop: ${report.id}`,
    "",
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Max steps: ${report.maxSteps}`,
    `- Stop reason: ${report.stopReason}`,
    `- Source ledger: ${report.sourceLedgerPath ?? "none"}`,
    `- Repeat guard: ${report.repeatGuard?.triggered ? "triggered" : "clear"}`,
    `- Repeated terminal count: ${report.repeatGuard?.repeatedTerminalCount ?? "n/a"}`,
    `- Steps: ${report.steps.length}`,
    "",
    "## Steps",
    "",
    "| Step | Status | Decision | Supervise | Reason |",
    "| ---: | --- | --- | --- | --- |",
    ...report.steps.map((step) => [
      `| ${step.index}`,
      step.status,
      step.decision,
      step.superviseStatus ?? "none",
      `${escapeCell(step.reason)} |`
    ].join(" | ")),
    "",
    "## Artifacts",
    "",
    ...report.steps.flatMap((step) => [
      `- Step ${step.index} advance: ${step.advanceReportPath ?? "none"}`,
      `- Step ${step.index} source ledger: ${step.sourceLedgerPath}`,
      `- Step ${step.index} supervise: ${step.superviseReportPath ?? "none"}`
    ]),
    `- Loop state JSON: ${report.loopStatePath ?? "none"}`,
    `- Loop state Markdown: ${report.loopStateMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceLoopState(state: IssueControlAdvanceLoopState): string {
  return [
    `# Issue Control Advance Loop State: ${state.id}`,
    "",
    `- Updated at: ${state.updatedAt}`,
    `- Mode: ${state.mode}`,
    `- Status: ${state.status}`,
    `- Max steps: ${state.maxSteps}`,
    `- Stop reason: ${state.stopReason}`,
    `- Source ledger: ${state.sourceLedgerPath ?? "none"}`,
    `- Last loop: ${state.lastLoopId}`,
    `- Terminal step status: ${state.terminalStepStatus ?? "none"}`,
    `- Terminal decision: ${state.terminalDecision ?? "none"}`,
    `- Terminal supervise status: ${state.terminalSuperviseStatus ?? "none"}`,
    `- Repeated terminal count: ${state.repeatedTerminalCount}`,
    `- Repeat guard active: ${state.repeatGuardActive ? "yes" : "no"}`,
    `- Trust tier: ${state.trustTier ?? "unknown"}`,
    `- Safety envelope: ${state.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Adaptive gate: ${state.adaptiveGate?.state ?? "unknown"} -> ${state.adaptiveGate?.recommendedMaxIterations ?? "unknown"}`,
    `- Next action: ${state.nextAction}`,
    `- Scheduler action: ${state.schedulerDecision?.action ?? "unknown"}`,
    `- Scheduler unattended: ${state.schedulerDecision?.canRunUnattended ? "yes" : "no"}`,
    `- Scheduler requires human: ${state.schedulerDecision?.requiresHuman ? "yes" : "no"}`,
    `- Scheduler exit code: ${state.schedulerDecision?.exitCode ?? "unknown"}`,
    `- Scheduler reason: ${state.schedulerDecision?.reason ?? "none"}`,
    `- Scheduler next command: ${state.schedulerDecision?.nextCommand ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Last loop JSON: ${state.lastLoopPath ?? "none"}`,
    `- Last loop Markdown: ${state.lastLoopMarkdownPath ?? "none"}`,
    `- JSON: ${state.outputPath ?? "none"}`,
    `- Markdown: ${state.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceScheduler(report: IssueControlAdvanceSchedulerReport): string {
  return [
    `# Issue Control Advance Scheduler: ${report.id}`,
    "",
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Scheduler action: ${report.schedulerDecision.action}`,
    `- Trust tier: ${report.schedulerDecision.trustTier ?? "unknown"}`,
    `- Safety envelope: ${report.schedulerDecision.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Adaptive gate: ${report.schedulerDecision.adaptiveGate?.state ?? "unknown"} -> ${report.schedulerDecision.adaptiveGate?.recommendedMaxIterations ?? "unknown"}`,
    `- Can run unattended: ${report.schedulerDecision.canRunUnattended ? "yes" : "no"}`,
    `- Requires human: ${report.schedulerDecision.requiresHuman ? "yes" : "no"}`,
    `- Decision exit code: ${report.schedulerDecision.exitCode}`,
    `- Reason: ${report.reason}`,
    `- Next command: ${report.nextCommand ?? "none"}`,
    `- Loop status: ${report.loopStatus ?? "none"}`,
    `- Audit log: ${report.auditLogPath ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Source state: ${report.sourceStatePath ?? "none"}`,
    `- Loop JSON: ${report.loopReportPath ?? "none"}`,
    `- Loop Markdown: ${report.loopReportMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlSyncGate(report: IssueControlSyncGateReport): string {
  return [
    `# Issue Control Sync Gate: ${report.id}`,
    "",
    `- Status: ${report.status}`,
    `- Scheduler action: ${report.schedulerDecision.action}`,
    `- Reason: ${report.reason}`,
    `- Repo: ${report.repo ?? "none"}`,
    `- Run: ${report.runId ?? "none"}`,
    `- Run source: ${report.runIdSource ?? "none"}`,
    `- Completed issues: ${report.completedIssueIds.length > 0 ? report.completedIssueIds.join(", ") : "none"}`,
    `- Unresolved issues: ${report.unresolvedIssueIds.length > 0 ? report.unresolvedIssueIds.join(", ") : "none"}`,
    `- Pending issues: ${report.pendingIssueIds.length > 0 ? report.pendingIssueIds.join(", ") : "none"}`,
    `- Recommended sync command: ${report.recommendedSyncCommand ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Source state: ${report.sourceStatePath ?? "none"}`,
    `- Source loop: ${report.sourceLoopPath ?? "none"}`,
    `- Source ledger: ${report.sourceLedgerPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

function renderIssueControlProgressStatusItems(items: IssueControlProgressStatusItem[]): string[] {
  return [
    "| # | State | Action | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- |",
    ...items.map((item) => [
      `| ${item.issueNumber}`,
      item.state,
      item.action,
      item.issueId ?? "none",
      `${escapeCell(item.reason)} |`
    ].join(" | "))
  ];
}

async function runIssueControlPlanItem(
  loaded: LoadedConfig,
  item: IssueControlPlanItem,
  options: IssueControlRunOptions
): Promise<IssueControlRunItem> {
  const command = item.recommendedCommand;
  const base = {
    issueNumber: item.issueNumber,
    issueId: item.issueId,
    title: item.title,
    action: item.action,
    command
  };
  if (!options.execute) {
    return {
      ...base,
      status: "planned",
      reason: item.reason
    };
  }
  try {
    switch (item.action) {
      case "execute-task": {
        const runId = item.runId ?? options.runId;
        if (!runId) {
          return { ...base, status: "blocked", reason: "execute-task requires a run id from the issue or --run." };
        }
        if (!item.taskId) {
          return { ...base, status: "blocked", reason: "execute-task requires mg_task_id." };
        }
        const pkg = await loadRunPackage(loaded, runId);
        const task = await executeTask(loaded, pkg, item.taskId, { createCheckpoint: true });
        return {
          ...base,
          status: task.status === "done" ? "executed" : "failed",
          reason: `Task ${task.id} finished with status ${task.status}.`,
          result: task.result
        };
      }
      case "repair-proposal": {
        const runId = item.runId ?? options.runId;
        if (!runId) {
          return { ...base, status: "blocked", reason: "repair-proposal requires a run id from the issue or --run." };
        }
        const proposal = proposalFromCommand(command);
        if (!proposal) {
          return { ...base, status: "blocked", reason: "repair-proposal requires a proposal id." };
        }
        const pkg = await loadRunPackage(loaded, runId);
        const result = await repairProposal(loaded, pkg, proposal, {
          runChecks: true,
          accept: true,
          notes: `issue-control run for ${item.issueId ?? `#${item.issueNumber}`}`
        });
        const passed = result.verification?.passed !== false && result.acceptance?.acceptanceReport.accepted !== false;
        return {
          ...base,
          status: passed ? "executed" : "failed",
          reason: result.message,
          result: result.nextAction,
          artifactPath: result.verification?.outputPath ?? result.retry.proposal.patchPath
        };
      }
      case "bootstrap-target": {
        const sourceRoot = resolveIssueControlBootstrapSourceRoot(loaded);
        if (!sourceRoot) {
          return { ...base, status: "blocked", reason: "bootstrap-target requires config variable MG_SOURCE_ROOT." };
        }
        const { bootstrapMd2Target, verifyBootstrapMd2Target } = await import("./bootstrap.js");
        const manifest = await bootstrapMd2Target(loaded, {
          sourceRoot,
          targetRoot: loaded.targetRoot,
          execute: true
        });
        const verify = await verifyBootstrapMd2Target(loaded, {
          sourceRoot,
          targetRoot: loaded.targetRoot,
          runIssueAuto: false
        });
        return {
          ...base,
          status: verify.status === "passed" ? "executed" : verify.status,
          reason: `Bootstrap import finished with verify status ${verify.status}.`,
          artifactPath: verify.outputPath ?? manifest.outputPath
        };
      }
      default:
        return { ...base, status: "blocked", reason: `Action ${item.action} is not executable in Phase 99.` };
    }
  } catch (error) {
    return {
      ...base,
      status: "failed",
      reason: item.reason,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function writeIssueControlRunReport(loaded: LoadedConfig, report: IssueControlRunReport): Promise<IssueControlRunReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlRun(report));
  return report;
}

async function writeIssueControlAutoReport(loaded: LoadedConfig, report: IssueControlAutoReport): Promise<IssueControlAutoReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlAuto(report));
  return report;
}

async function writeIssueControlSuperviseReport(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport
): Promise<IssueControlSuperviseReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  const progressLedger = await writeIssueControlSuperviseProgressLedger(loaded, createIssueControlSuperviseProgressLedger(report));
  report.progressLedgerPath = progressLedger.outputPath;
  report.progressLedgerMarkdownPath = progressLedger.markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlSupervise(report));
  return report;
}

async function writeIssueControlSuperviseProgressLedger(
  loaded: LoadedConfig,
  ledger: IssueControlSuperviseProgressLedger
): Promise<IssueControlSuperviseProgressLedger> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${ledger.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  ledger.outputPath = outputPath;
  ledger.markdownPath = markdownPath;
  await writeJsonFile(outputPath, ledger);
  await writeTextFile(markdownPath, renderIssueControlSuperviseProgressLedger(ledger));
  return ledger;
}

async function writeIssueControlProgressStatusReport(
  loaded: LoadedConfig,
  report: IssueControlProgressStatusReport
): Promise<IssueControlProgressStatusReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlProgressStatus(report));
  return report;
}

async function writeIssueControlAdvanceReport(
  loaded: LoadedConfig,
  report: IssueControlAdvanceReport
): Promise<IssueControlAdvanceReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlAdvance(report));
  return report;
}

async function writeIssueControlAdvanceLoopReport(
  loaded: LoadedConfig,
  report: IssueControlAdvanceLoopReport,
  previousState?: IssueControlAdvanceLoopState
): Promise<IssueControlAdvanceLoopReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  const statePath = path.join(dir, "issue-control-advance-loop-state.json");
  const stateMarkdownPath = statePath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  report.loopStatePath = statePath;
  report.loopStateMarkdownPath = stateMarkdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlAdvanceLoop(report));
  await writeIssueControlAdvanceLoopState(loaded, report, previousState);
  return report;
}

async function writeIssueControlAdvanceSchedulerReport(
  loaded: LoadedConfig,
  report: IssueControlAdvanceSchedulerReport
): Promise<IssueControlAdvanceSchedulerReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlAdvanceScheduler(report));
  return report;
}

async function writeIssueControlSyncGateReport(
  loaded: LoadedConfig,
  report: IssueControlSyncGateReport
): Promise<IssueControlSyncGateReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlSyncGate(report));
  return report;
}

function issueControlAuditLogPath(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "issue-control", "issue-control-unattended-audit.jsonl");
}

async function appendIssueControlAudit(
  loaded: LoadedConfig,
  event: Record<string, unknown>
): Promise<void> {
  const filePath = issueControlAuditLogPath(loaded);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    ...event
  })}\n`, "utf8");
}

async function writeIssueControlAdvanceLoopState(
  loaded: LoadedConfig,
  report: IssueControlAdvanceLoopReport,
  previousState?: IssueControlAdvanceLoopState
): Promise<IssueControlAdvanceLoopState> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, "issue-control-advance-loop-state.json");
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  const terminalStep = report.steps[report.steps.length - 1];
  const sourceLedgerPath = report.sourceLedgerPath ?? terminalStep?.sourceLedgerPath;
  const sourceSafety = sourceLedgerPath ? await readIssueControlLedgerSafety(sourceLedgerPath) : undefined;
  const isTerminalStop = report.status === "failed" || report.status === "blocked";
  const repeatedTerminalCount = isTerminalStop && previousState?.sourceLedgerPath === sourceLedgerPath
    ? previousState.repeatedTerminalCount + 1
    : isTerminalStop
      ? 1
      : 0;
  const state: IssueControlAdvanceLoopState = {
    version: 1,
    id: "issue-control-advance-loop-state",
    updatedAt: new Date().toISOString(),
    mode: report.mode,
    configPath: loaded.path,
    maxSteps: report.maxSteps,
    status: report.status,
    stopReason: report.stopReason,
    sourceLedgerPath,
    lastLoopId: report.id,
    lastLoopPath: report.outputPath,
    lastLoopMarkdownPath: report.markdownPath,
    terminalStepStatus: terminalStep?.status,
    terminalDecision: terminalStep?.decision,
    terminalSuperviseStatus: terminalStep?.superviseStatus,
    repeatedTerminalCount,
    repeatGuardActive: isTerminalStop && repeatedTerminalCount > 1,
    trustTier: sourceSafety?.trustTier,
    safetyEnvelope: sourceSafety?.safetyEnvelope,
    adaptiveGate: sourceSafety?.adaptiveGate,
    nextAction: createIssueControlAdvanceLoopStateNextAction(report, repeatedTerminalCount),
    outputPath,
    markdownPath
  };
  state.schedulerDecision = createIssueControlAdvanceLoopSchedulerDecision(state);
  await writeJsonFile(outputPath, state);
  await writeTextFile(markdownPath, renderIssueControlAdvanceLoopState(state));
  return state;
}

async function readIssueControlLedgerSafety(
  filePath: string
): Promise<{ trustTier: IssueControlTrustTier; safetyEnvelope: IssueControlSafetyEnvelope; adaptiveGate: IssueControlAdaptiveGate } | undefined> {
  if (!await pathExists(filePath)) {
    return undefined;
  }
  const ledger = await readJsonFile<IssueControlSuperviseProgressLedger>(filePath);
  const trustTier = ledger.trustTier ?? ledger.controlOptions?.trustTier ?? "supervised";
  const unresolvedItems = ledger.items
    .filter((item) => item.state === "failed" || item.state === "blocked")
    .map(toIssueControlProgressStatusItem);
  return {
    trustTier,
    safetyEnvelope: ledger.safetyEnvelope ?? createIssueControlSafetyEnvelopeFromLedger(ledger),
    adaptiveGate: createIssueControlAdaptiveGate(ledger, unresolvedItems)
  };
}

async function writeIssueControlRecoveryPlan(
  loaded: LoadedConfig,
  plan: IssueControlRecoveryPlan
): Promise<IssueControlRecoveryPlan> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${plan.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  plan.outputPath = outputPath;
  plan.markdownPath = markdownPath;
  await writeJsonFile(outputPath, plan);
  await writeTextFile(markdownPath, renderIssueControlRecoveryPlan(plan));
  return plan;
}

async function writeIssueControlRecoveryExecution(
  loaded: LoadedConfig,
  execution: IssueControlRecoveryExecution
): Promise<IssueControlRecoveryExecution> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${execution.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  execution.outputPath = outputPath;
  execution.markdownPath = markdownPath;
  await writeJsonFile(outputPath, execution);
  await writeTextFile(markdownPath, renderIssueControlRecoveryExecution(execution));
  return execution;
}

function selectIssueControlAutoItem(
  plan: IssueControlPlanReport,
  options: { allowHighRisk: boolean; trustTier: IssueControlTrustTier }
): IssueControlAutoSelectionItem[] {
  const priority: Record<IssueControlAction, number> = {
    "bootstrap-target": 0,
    "repair-proposal": 1,
    "execute-task": 2,
    "classify-risk": 3,
    "review-external": 4,
    "track": 5
  };
  const candidates = plan.items
    .map((item, index) => ({
      item,
      index,
      selectable: isAutoSelectable(item, options),
      reason: autoSelectionReason(item, options)
    }))
    .sort((a, b) => priority[a.item.action] - priority[b.item.action] || a.index - b.index);
  const selected = candidates.find((candidate) => candidate.selectable)?.item;
  return plan.items.map((item) => ({
    issueNumber: item.issueNumber,
    issueId: item.issueId,
    runId: item.runId,
    title: item.title,
    action: item.action,
    risk: item.risk,
    selected: selected === item,
    reason: selected === item ? "Selected as the highest-priority safe executable issue." : autoSelectionReason(item, options)
  }));
}

function selectIssueControlSuperviseItems(
  plan: IssueControlPlanReport,
  options: { allowHighRisk: boolean; maxIterations: number; trustTier: IssueControlTrustTier; riskBudget: number }
): IssueControlSuperviseSelectionItem[] {
  const priority: Record<IssueControlAction, number> = {
    "bootstrap-target": 0,
    "repair-proposal": 1,
    "execute-task": 2,
    "classify-risk": 3,
    "review-external": 4,
    "track": 5
  };
  const ranked = plan.items
    .map((item, index) => ({
      item,
      index,
      selectable: isAutoSelectable(item, options),
      reason: autoSelectionReason(item, options)
    }))
    .sort((a, b) => priority[a.item.action] - priority[b.item.action] || a.index - b.index);
  const selected = new Set<IssueControlPlanItem>();
  let spentRisk = 0;
  for (const candidate of ranked.filter((item) => item.selectable)) {
    if (selected.size >= options.maxIterations) {
      break;
    }
    const risk = riskWeight(candidate.item.risk);
    if (spentRisk + risk > options.riskBudget) {
      continue;
    }
    selected.add(candidate.item);
    spentRisk += risk;
  }
  return plan.items.map((item) => ({
    issueNumber: item.issueNumber,
    issueId: item.issueId,
    runId: item.runId,
    title: item.title,
    action: item.action,
    risk: item.risk,
    selected: selected.has(item),
    reason: selected.has(item)
      ? "Selected for supervised issue-control iteration."
      : autoSelectionReason(item, options)
  }));
}

function toSuperviseIteration(
  index: number,
  selected: IssueControlSuperviseSelectionItem,
  run: IssueControlRunReport,
  item: IssueControlRunItem | undefined
): IssueControlSuperviseIteration {
  const status = item?.status === "executed"
    ? "executed"
    : item?.status === "failed" || run.status === "failed"
      ? "failed"
      : item?.status === "blocked" || run.status === "blocked"
        ? "blocked"
        : "planned";
  return {
    index,
    issueNumber: selected.issueNumber,
    issueId: selected.issueId,
    runId: selected.runId,
    title: selected.title,
    action: selected.action,
    risk: selected.risk,
    status,
    reason: item?.reason ?? selected.reason,
    runPath: run.outputPath,
    runMarkdownPath: run.markdownPath,
    command: item?.command,
    artifactPath: item?.artifactPath,
    error: item?.error
  };
}

async function attachRecoveryPlan(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  iteration?: IssueControlSuperviseIteration
): Promise<IssueControlRecoveryPlan | undefined> {
  if (report.status !== "blocked" && report.status !== "failed") {
    return undefined;
  }
  const recovery = await writeIssueControlRecoveryPlan(loaded, createIssueControlRecoveryPlan(report, iteration));
  report.failureCategory = recovery.failureCategory;
  report.recoveryPlanPath = recovery.outputPath;
  report.recoveryPlanMarkdownPath = recovery.markdownPath;
  report.autoRepairEligible = recovery.autoRepairEligible;
  report.humanActionRequired = recovery.humanActionRequired;
  if (iteration) {
    iteration.recoveryPlanPath = recovery.outputPath;
    iteration.recoveryPlanMarkdownPath = recovery.markdownPath;
  }
  return recovery;
}

async function attachRecoveryExecution(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  plan: IssueControlRecoveryPlan,
  options: IssueControlSuperviseOptions,
  iteration?: IssueControlSuperviseIteration
): Promise<IssueControlRecoveryExecution> {
  const runRecovery = options.recoveryExecutor ?? executeIssueControlRecoveryPlan;
  const execution = await writeIssueControlRecoveryExecution(loaded, await runRecovery(loaded, report, plan, options));
  report.recoveryExecutionPath = execution.outputPath;
  report.recoveryExecutionMarkdownPath = execution.markdownPath;
  report.recoveryExecutionStatus = execution.status;
  if (iteration) {
    iteration.recoveryExecutionPath = execution.outputPath;
    iteration.recoveryExecutionMarkdownPath = execution.markdownPath;
    iteration.recoveryExecutionStatus = execution.status;
  }
  return execution;
}

async function handleSuperviseRecovery(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  iteration: IssueControlSuperviseIteration,
  options: IssueControlSuperviseOptions
): Promise<boolean> {
  const recoveryPlan = await attachRecoveryPlan(loaded, report, iteration);
  if (!recoveryPlan) {
    return false;
  }
  const execution = options.repairOnFail
    ? await attachRecoveryExecution(loaded, report, recoveryPlan, options, iteration)
    : undefined;
  if (!options.continueAfterRepair) {
    return false;
  }
  if (execution?.status !== "executed") {
    iteration.recoveryContinuationReason = execution
      ? `Recovery execution status ${execution.status} is not safe to continue.`
      : "Recovery execution was not attempted.";
    return false;
  }
  report.status = "complete";
  report.stopReason = undefined;
  report.continuedAfterRepair = true;
  report.continuedAfterRepairCount = (report.continuedAfterRepairCount ?? 0) + 1;
  iteration.continuedAfterRepair = true;
  iteration.recoveryContinuationReason = "Recovery executed successfully; continuing to the next selected issue.";
  return true;
}

function createIssueControlRecoveryPlan(
  report: IssueControlSuperviseReport,
  iteration?: IssueControlSuperviseIteration
): IssueControlRecoveryPlan {
  const failedIteration = iteration ?? report.iterations.find((item) => item.status === "failed" || item.status === "blocked");
  const category = classifySupervisorFailure(report, failedIteration);
  const evidencePaths = collectRecoveryEvidencePaths(report, failedIteration);
  const now = new Date().toISOString();
  const decision = recoveryDecision(category, failedIteration);
  return {
    version: 1,
    id: `issue-control-recovery-plan-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    provider: report.provider,
    repo: report.repo,
    sourceSuperviseId: report.id,
    status: "planned",
    failureCategory: category,
    failedIteration,
    failedIssueId: failedIteration?.issueId,
    failedIssueNumber: failedIteration?.issueNumber,
    failedAction: failedIteration?.action,
    evidencePaths,
    autoFixable: decision.autoFixable,
    autoFixableReason: decision.autoFixableReason,
    autoRepairEligible: decision.autoRepairEligible,
    humanActionRequired: decision.humanActionRequired,
    repairStrategy: decision.repairStrategy,
    behaviorDiffRequired: decision.behaviorDiffRequired,
    recommendedNextCommand: decision.recommendedNextCommand,
    recommendedActions: decision.recommendedActions
  };
}

function renderIssueControlRecoveryPlan(plan: IssueControlRecoveryPlan): string {
  return [
    `# Issue Control Recovery Plan: ${plan.id}`,
    "",
    `- Source supervise: ${plan.sourceSuperviseId}`,
    `- Repo: ${plan.repo}`,
    `- Failure category: ${plan.failureCategory}`,
    `- Failed issue: ${plan.failedIssueId ?? "none"}`,
    `- Failed action: ${plan.failedAction ?? "none"}`,
    `- Auto fixable: ${plan.autoFixable ? "yes" : "no"}`,
    `- Auto fixable reason: ${plan.autoFixableReason}`,
    `- Auto repair eligible: ${plan.autoRepairEligible ? "yes" : "no"}`,
    `- Human action required: ${plan.humanActionRequired ? "yes" : "no"}`,
    `- Repair strategy: ${plan.repairStrategy.id} (${plan.repairStrategy.kind})`,
    `- Behavior diff required: ${plan.behaviorDiffRequired ? "yes" : "no"}`,
    `- Recommended next command: ${plan.recommendedNextCommand}`,
    "",
    "## Recommended Actions",
    "",
    ...plan.recommendedActions.map((action) => `- ${action}`),
    "",
    "## Evidence",
    "",
    ...(plan.evidencePaths.length > 0
      ? plan.evidencePaths.map((evidence) => `- ${evidence}`)
      : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- JSON: ${plan.outputPath ?? "none"}`,
    `- Markdown: ${plan.markdownPath ?? "none"}`
  ].join("\n");
}

function renderIssueControlRecoveryExecution(execution: IssueControlRecoveryExecution): string {
  return [
    `# Issue Control Recovery Execution: ${execution.id}`,
    "",
    `- Source supervise: ${execution.sourceSuperviseId}`,
    `- Source recovery plan: ${execution.sourceRecoveryPlanId}`,
    `- Repo: ${execution.repo}`,
    `- Mode: ${execution.mode}`,
    `- Status: ${execution.status}`,
    `- Failure category: ${execution.failureCategory}`,
    `- Auto fixable: ${execution.autoFixable === undefined ? "unknown" : execution.autoFixable ? "yes" : "no"}`,
    `- Auto repair eligible: ${execution.autoRepairEligible ? "yes" : "no"}`,
    `- Repair strategy: ${execution.repairStrategy?.id ?? "none"}`,
    `- Behavior diff required: ${execution.behaviorDiffRequired ? "yes" : "no"}`,
    `- Behavior diff guard: ${execution.behaviorDiffGuard?.status ?? "not-run"}`,
    `- Action: ${execution.action}`,
    `- Reason: ${execution.reason}`,
    `- Recommended next command: ${execution.recommendedNextCommand ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Recovery artifact: ${execution.artifactPath ?? "none"}`,
    `- JSON: ${execution.outputPath ?? "none"}`,
    `- Markdown: ${execution.markdownPath ?? "none"}`
  ].join("\n");
}

async function executeIssueControlRecoveryPlan(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  plan: IssueControlRecoveryPlan,
  options: IssueControlSuperviseOptions
): Promise<IssueControlRecoveryExecution> {
  const now = new Date().toISOString();
  const base: IssueControlRecoveryExecution = {
    version: 1,
    id: `issue-control-recovery-execution-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    provider: report.provider,
    repo: report.repo,
    sourceSuperviseId: report.id,
    sourceRecoveryPlanId: plan.id,
    mode: options.execute ? "execute" : "dry-run",
    status: "blocked",
    failureCategory: plan.failureCategory,
    autoFixable: plan.autoFixable,
    autoRepairEligible: plan.autoRepairEligible,
    repairStrategy: plan.repairStrategy,
    behaviorDiffRequired: plan.behaviorDiffRequired,
    action: plan.repairStrategy.action,
    reason: "No recovery action selected.",
    recommendedNextCommand: plan.recommendedNextCommand
  };
  const strategy = selectRepairStrategy({ category: plan.failureCategory, plan });
  if (options.repairAgentCommand) {
    if (!options.execute) {
      return {
        ...base,
        status: "planned",
        action: "repair-agent",
        behaviorDiffRequired: true,
        reason: "Recovery can call the configured repair agent when rerun with --execute.",
        recommendedNextCommand: options.repairAgentCommand
      };
    }
    const agent = await runShellCommand(options.repairAgentCommand, {
      cwd: loaded.targetRoot,
      timeoutMs: 120000,
      maxOutputBytes: loaded.config.output.maxOutputBytes,
      env: {
        MG_RECOVERY_PLAN: plan.outputPath ?? "",
        MG_RECOVERY_CATEGORY: plan.failureCategory,
        MG_FAILED_ISSUE_ID: plan.failedIssueId ?? "",
        MG_FAILED_ISSUE_NUMBER: plan.failedIssueNumber ? String(plan.failedIssueNumber) : ""
      }
    });
    return applyRecoveryBehaviorDiffGuard(loaded, {
      ...base,
      status: agent.exitCode === 0 ? "executed" : "failed",
      action: "repair-agent",
      behaviorDiffRequired: true,
      reason: agent.exitCode === 0
        ? "Repair agent completed successfully."
        : "Repair agent failed.",
      recommendedNextCommand: options.repairAgentCommand,
      error: agent.exitCode === 0 ? undefined : agent.stderr || agent.stdout || agent.error || "repair agent failed"
    });
  }
  if (!strategy.autoFixable) {
    return {
      ...base,
      status: "blocked",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: `Recovery category ${plan.failureCategory} is not auto-fixable.`
    };
  }
  if (!options.execute) {
    return {
      ...base,
      status: "planned",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: "Recovery is eligible; rerun supervisor with --execute --repair-on-fail to attempt it."
    };
  }
  try {
    const applied = await strategy.apply({
      loaded,
      report,
      plan,
      options
    });
    const verified = strategy.verify ? await strategy.verify({ loaded, report, plan, options }, applied) : applied;
    return applyRecoveryBehaviorDiffGuard(loaded, {
      ...base,
      ...verified,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired
    });
  } catch (error) {
    return {
      ...base,
      status: "failed",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: "Automatic recovery failed.",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function applyRecoveryBehaviorDiffGuard(
  loaded: LoadedConfig,
  execution: IssueControlRecoveryExecution
): Promise<IssueControlRecoveryExecution> {
  if (execution.status !== "executed" || execution.behaviorDiffRequired !== true) {
    return execution;
  }
  const guard = await runRecoveryBehaviorDiffGuard(loaded, execution.id);
  if (guard.status === "passed") {
    return {
      ...execution,
      behaviorDiffGuard: guard,
      reason: `${execution.reason} Behavior diff guard passed.`
    };
  }
  return {
    ...execution,
    status: guard.status === "blocked" ? "blocked" : "failed",
    behaviorDiffGuard: guard,
    reason: `${execution.reason} Behavior diff guard ${guard.status}.`,
    error: guard.reason
  };
}

async function runRecoveryBehaviorDiffGuard(
  loaded: LoadedConfig,
  executionId: string
): Promise<IssueControlSuperviseVerification> {
  const baselinePath = latestBaselinePath(loaded);
  if (!await pathExists(baselinePath)) {
    return {
      status: "blocked",
      reason: `No baseline found at ${baselinePath}; behavior diff guard cannot run.`,
      baselineSnapshotPath: baselinePath
    };
  }
  const baseline = await loadSnapshot(baselinePath);
  const run = await captureSnapshot(loaded, "run");
  const runSnapshotPath = await saveSnapshot(loaded, run);
  const compare = compareSnapshots(baseline, run, loaded.config.compare);
  const baseName = `recovery-${executionId}-compare`;
  const compareReportPath = path.join(loaded.artifactsDir, "issue-control", `${baseName}.json`);
  const compareMarkdownPath = compareReportPath.replace(/\.json$/, ".md");
  await writeJsonFile(compareReportPath, compare);
  await writeTextFile(compareMarkdownPath, renderCompareReport(compare));
  return {
    status: compare.passed ? "passed" : "failed",
    reason: compare.passed
      ? "Recovery behavior diff guard passed."
      : "Recovery behavior diff guard failed.",
    baselineSnapshotPath: baselinePath,
    runSnapshotPath,
    compareReportPath,
    compareMarkdownPath,
    differenceCount: compare.differences.length,
    differenceAreas: [...new Set(compare.differences.map((difference) => difference.area))]
  };
}

function classifySupervisorFailure(
  report: IssueControlSuperviseReport,
  iteration: IssueControlSuperviseIteration | undefined
): SupervisorFailureCategory {
  const haystack = [
    report.stopReason,
    iteration?.reason,
    iteration?.error,
    iteration?.verification?.reason
  ].filter(Boolean).join("\n").toLowerCase();
  if (iteration?.verification?.status === "blocked" && haystack.includes("no baseline")) {
    return "missing-baseline";
  }
  if (haystack.includes("missing script") || haystack.includes("script not found") || /command .+ not found/.test(haystack)) {
    return "missing-script";
  }
  if (haystack.includes("install required") || haystack.includes("node_modules") || haystack.includes("pnpm install")) {
    return "install-required";
  }
  if (
    (haystack.includes("enoent") || haystack.includes("no such file") || haystack.includes("cannot find module"))
    && (haystack.includes("probe") || iteration?.verification?.differenceAreas?.includes("probe"))
  ) {
    return "probe-path-drift";
  }
  if (
    haystack.includes("format")
    && (haystack.includes("no-op") || haystack.includes("no changes") || haystack.includes("already formatted"))
  ) {
    return "formatting-noop";
  }
  if (iteration?.verification?.status === "failed") {
    return classifyCompareFailure(iteration);
  }
  if (iteration?.action === "repair-proposal" || haystack.includes("proposal")) {
    return "proposal-repair-needed";
  }
  if (iteration?.action === "bootstrap-target") {
    return "bootstrap-blocked";
  }
  if (iteration?.action === "execute-task" && iteration.status === "failed") {
    return "task-execution-failed";
  }
  if (haystack.includes("github") || haystack.includes("rate limit") || haystack.includes("api.github.com")) {
    return "github-read-blocked";
  }
  if (haystack.includes("human") || haystack.includes("approval")) {
    return "human-approval-required";
  }
  return "unknown";
}

function classifyCompareFailure(iteration: IssueControlSuperviseIteration): SupervisorFailureCategory {
  if (iteration.verification?.differenceAreas?.includes("check")) {
    return "check-regression";
  }
  if (iteration.verification?.differenceAreas?.includes("probe")) {
    return "probe-diff";
  }
  const reason = iteration.verification?.reason.toLowerCase() ?? "";
  if (reason.includes("check")) {
    return "check-regression";
  }
  if (reason.includes("probe")) {
    return "probe-diff";
  }
  return "compare-diff";
}

function collectRecoveryEvidencePaths(
  report: IssueControlSuperviseReport,
  iteration: IssueControlSuperviseIteration | undefined
): string[] {
  return [
    report.pullPath,
    report.planPath,
    iteration?.runPath,
    iteration?.runMarkdownPath,
    iteration?.artifactPath,
    iteration?.verification?.baselineSnapshotPath,
    iteration?.verification?.runSnapshotPath,
    iteration?.verification?.compareReportPath,
    iteration?.verification?.compareMarkdownPath
  ].filter((item): item is string => Boolean(item));
}

function recoveryDecision(
  category: SupervisorFailureCategory,
  iteration: IssueControlSuperviseIteration | undefined
): {
  autoFixable: boolean;
  autoFixableReason: string;
  autoRepairEligible: boolean;
  humanActionRequired: boolean;
  repairStrategy: RepairStrategySummary;
  behaviorDiffRequired: boolean;
  recommendedNextCommand: string;
  recommendedActions: string[];
} {
  const strategy = selectRepairStrategy({ category });
  const repairStrategy = summarizeRepairStrategy(strategy);
  const strategyFields = {
    autoFixable: repairStrategy.autoFixable,
    autoFixableReason: repairStrategy.reason,
    autoRepairEligible: repairStrategy.autoFixable,
    humanActionRequired: !repairStrategy.autoFixable,
    repairStrategy,
    behaviorDiffRequired: repairStrategy.behaviorDiffRequired
  };
  switch (category) {
    case "missing-baseline":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Capture a fresh baseline with the active config, review it, then rerun issue-control supervise with --verify-each."]
      };
    case "install-required":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Install dependencies using the detected package manager, then rerun the blocked command."]
      };
    case "missing-script":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Add a conservative package.json script alias for the missing script, then rerun verification."]
      };
    case "probe-path-drift":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Rewrite the stale probe path only when a unique target file replacement is found, then rerun behavior verification."]
      };
    case "formatting-noop":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Confirm the formatting-only recovery with a behavior diff guard before continuing automation."]
      };
    case "check-regression":
    case "probe-diff":
    case "compare-diff":
      return {
        ...strategyFields,
        recommendedNextCommand: `node dist/cli.js diff list --compare ${iteration?.verification?.compareReportPath ?? "<compare.json>"}`,
        recommendedActions: ["Review the compare report, classify intentional differences, or create a repair issue before continuing."]
      };
    case "proposal-repair-needed":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Run the proposal repair loop, verify the retry proposal with behavior-diff gates, then rerun supervisor."]
      };
    case "task-execution-failed":
      return {
        ...strategyFields,
        recommendedNextCommand: `node dist/cli.js issue-control run --input <plan.json> --only-issue ${iteration?.issueId ?? "<mg_issue_id>"} --execute`,
        recommendedActions: ["Inspect the failed task run artifact, resolve the task failure, then rerun the same issue."]
      };
    case "bootstrap-blocked":
      return {
        ...strategyFields,
        recommendedNextCommand: "node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --verify",
        recommendedActions: ["Inspect bootstrap readiness, resolve target/import blockers, then rerun supervisor."]
      };
    case "github-read-blocked":
      return {
        ...strategyFields,
        recommendedNextCommand: "node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration",
        recommendedActions: ["Check GitHub token, repo access, labels and rate limit before retrying."]
      };
    case "human-approval-required":
      return {
        ...strategyFields,
        recommendedNextCommand: "Review the recovery plan evidence and approve the next bounded action.",
        recommendedActions: ["Review the evidence and choose the next approved command."]
      };
    default:
      return {
        ...strategyFields,
        recommendedNextCommand: "Inspect the supervisor and child run artifacts.",
        recommendedActions: ["Inspect artifacts, classify the failure manually, then rerun supervisor with a narrower issue selection."]
      };
  }
}

function runIdFromCommand(command?: string): string | undefined {
  return command?.match(/--run\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}

function resolveIssueControlBootstrapSourceRoot(loaded: LoadedConfig): string | undefined {
  const value = loaded.config.variables?.MG_SOURCE_ROOT;
  return value ? path.resolve(loaded.baseDir, value) : undefined;
}

async function verifySuperviseIteration(
  loaded: LoadedConfig,
  iteration: IssueControlSuperviseIteration
): Promise<IssueControlSuperviseVerification> {
  if (iteration.status !== "executed") {
    return {
      status: "skipped",
      reason: `Iteration status ${iteration.status} is not executable verification input.`
    };
  }
  const baselinePath = latestBaselinePath(loaded);
  if (!await pathExists(baselinePath)) {
    return {
      status: "blocked",
      reason: `No baseline found at ${baselinePath}. Run baseline before --verify-each.`,
      baselineSnapshotPath: baselinePath
    };
  }
  const baseline = await loadSnapshot(baselinePath);
  const run = await captureSnapshot(loaded, "run");
  const runSnapshotPath = await saveSnapshot(loaded, run);
  const compare = compareSnapshots(baseline, run, loaded.config.compare);
  const baseName = `supervise-${iteration.index}-${run.id}-compare`;
  const compareReportPath = path.join(loaded.artifactsDir, "issue-control", `${baseName}.json`);
  const compareMarkdownPath = compareReportPath.replace(/\.json$/, ".md");
  await writeJsonFile(compareReportPath, compare);
  await writeTextFile(compareMarkdownPath, renderCompareReport(compare));
  return {
    status: compare.passed ? "passed" : "failed",
    reason: compare.passed
      ? "Post-iteration verification compare passed."
      : "Post-iteration verification compare failed.",
    baselineSnapshotPath: baselinePath,
    runSnapshotPath,
    compareReportPath,
    compareMarkdownPath,
    differenceCount: compare.differences.length,
    differenceAreas: [...new Set(compare.differences.map((difference) => difference.area))]
  };
}

async function runIssueControlWatchdogRollback(
  loaded: LoadedConfig,
  iteration: IssueControlSuperviseIteration
): Promise<IssueControlWatchdogRollback> {
  if (!iteration.runId) {
    return {
      status: "blocked",
      error: "Watchdog rollback requires an iteration run id."
    };
  }
  try {
    const pkg = await loadRunPackage(loaded, iteration.runId);
    const checkpointId = pkg.run.latestCheckpointId;
    if (!checkpointId) {
      return {
        status: "blocked",
        error: `Run ${iteration.runId} has no latest checkpoint.`
      };
    }
    const message = await rollbackToCheckpoint(loaded, pkg, checkpointId);
    return {
      status: "executed",
      checkpointId,
      message
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function isSuperviseSelectedReason(reason: string): boolean {
  return reason === "Selectable but lower priority than the selected issue."
    || reason === "Selected for supervised issue-control iteration.";
}

function createIssueControlSuperviseProgressLedger(report: IssueControlSuperviseReport): IssueControlSuperviseProgressLedger {
  const now = new Date().toISOString();
  const items = report.selection.map((item) => createIssueControlSuperviseProgressItem(report, item));
  return {
    version: 1,
    id: `${report.id.replace(/^issue-control-supervise-/, "issue-control-supervise-progress-")}`,
    createdAt: now,
    sourceSuperviseId: report.id,
    provider: report.provider,
    repo: report.repo,
    mode: report.mode,
    status: report.status,
    trustTier: report.trustTier,
    riskBudget: report.riskBudget,
    safetyEnvelope: report.safetyEnvelope,
    controlOptions: report.controlOptions,
    summary: {
      issueCount: report.summary.issueCount,
      selectedCount: report.summary.selectedCount,
      reachedCount: items.filter((item) => item.reached).length,
      unreachedSelectedCount: items.filter((item) => item.selected && !item.reached).length,
      recoveredCount: items.filter((item) => item.recoveryExecutionStatus === "executed").length,
      continuedCount: items.filter((item) => item.continuedAfterRepair).length,
      unresolvedCount: items.filter((item) => item.state === "failed" || item.state === "blocked").length
    },
    stopReason: report.stopReason,
    failureCategory: report.failureCategory,
    superviseReportPath: report.outputPath,
    superviseReportMarkdownPath: report.markdownPath,
    pullPath: report.pullPath,
    planPath: report.planPath,
    items
  };
}

export async function loadIssueControlSuperviseProgressLedger(filePath: string): Promise<IssueControlSuperviseProgressLedger> {
  return readJsonFile<IssueControlSuperviseProgressLedger>(filePath);
}

async function latestIssueControlSuperviseProgressLedgerPath(loaded: LoadedConfig): Promise<string | undefined> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  if (!await pathExists(dir)) {
    return undefined;
  }
  const entries = await fs.readdir(dir);
  const candidates = await Promise.all(entries
    .filter((entry) => /^issue-control-supervise-progress-.*\.json$/.test(entry))
    .map(async (entry) => {
      const filePath = path.join(dir, entry);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath;
}

function createIssueControlProgressStatusReport(
  ledger: IssueControlSuperviseProgressLedger,
  ledgerPath: string
): IssueControlProgressStatusReport {
  const now = new Date().toISOString();
  const unresolvedItems = ledger.items
    .filter((item) => item.state === "failed" || item.state === "blocked")
    .map(toIssueControlProgressStatusItem);
  const unreachedSelectedItems = ledger.items
    .filter((item) => item.selected && !item.reached)
    .map(toIssueControlProgressStatusItem);
  const automationDecision = createIssueControlProgressAutomationDecision(ledger, unresolvedItems, unreachedSelectedItems);
  return {
    version: 1,
    id: `issue-control-progress-status-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    sourceLedgerPath: ledgerPath,
    sourceLedgerMarkdownPath: ledger.markdownPath,
    sourceSuperviseId: ledger.sourceSuperviseId,
    provider: ledger.provider,
    repo: ledger.repo,
    mode: ledger.mode,
    status: ledger.status,
    summary: ledger.summary,
    stopReason: ledger.stopReason,
    failureCategory: ledger.failureCategory,
    unresolvedItems,
    unreachedSelectedItems,
    automationDecision,
    nextActions: createIssueControlProgressNextActions(ledger, unresolvedItems, unreachedSelectedItems, automationDecision)
  };
}

async function loadIssueControlAdvanceLoopState(loaded: LoadedConfig): Promise<IssueControlAdvanceLoopState | undefined> {
  const filePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
  if (!await pathExists(filePath)) {
    return undefined;
  }
  return readJsonFile<IssueControlAdvanceLoopState>(filePath);
}

function createIssueControlAdvanceLoopRepeatGuard(
  previousState: IssueControlAdvanceLoopState | undefined,
  sourceLedgerPath: string,
  options: IssueControlAdvanceOptions
): IssueControlAdvanceLoopRepeatGuard {
  const repeatedTerminalCount = previousState?.sourceLedgerPath === sourceLedgerPath
    ? previousState.repeatedTerminalCount
    : 0;
  const triggered = Boolean(
    options.execute
    && !options.ignoreRepeatGuard
    && previousState
    && previousState.sourceLedgerPath === sourceLedgerPath
    && (previousState.status === "failed" || previousState.status === "blocked")
  );
  return {
    triggered,
    previousStatePath: previousState?.outputPath,
    repeatedTerminalCount: triggered ? repeatedTerminalCount + 1 : repeatedTerminalCount,
    reason: triggered
      ? [
        `Advance loop repeat guard blocked source ledger ${sourceLedgerPath}.`,
        `Previous loop already stopped as ${previousState?.status} for the same ledger.`,
        "Resolve the blocker, produce a new supervise progress ledger, or rerun with --force to override."
      ].join(" ")
      : "No repeated failed/blocked source ledger was detected."
  };
}

function createIssueControlAdvanceLoopStateNextAction(
  report: IssueControlAdvanceLoopReport,
  repeatedTerminalCount: number
): string {
  if (report.status === "planned") {
    return "Review the planned advance, then rerun issue-control advance with --execute when acceptable.";
  }
  if (report.status === "complete" && isAdvanceLoopMaxStepPause(report.stopReason)) {
    return "Max-step guard was reached before a terminal sync or complete decision; another bounded advance loop may continue unattended.";
  }
  if (report.status === "complete") {
    return "Review completed loop artifacts and refresh md2 issue state with a reviewed sync plan when ready.";
  }
  if (repeatedTerminalCount > 1) {
    return "Repeat guard is active. Resolve the blocker or produce a new supervise progress ledger before unattended execution continues.";
  }
  if (report.status === "failed") {
    return "Inspect the failed step evidence and recovery artifacts before the next advance loop.";
  }
  return "Inspect the blocked step evidence and recovery artifacts before the next advance loop.";
}

function createIssueControlAdvanceLoopSchedulerDecision(
  state: IssueControlAdvanceLoopState
): IssueControlAdvanceLoopSchedulerDecision {
  const trustTier = state.trustTier ?? "supervised";
  const safetyEnvelope = state.safetyEnvelope;
  const unattendedAllowed = trustTier === "unattended"
    ? safetyEnvelope?.passed === true
    : true;
  const decisionBase = {
    trustTier,
    safetyEnvelope,
    adaptiveGate: state.adaptiveGate
  };
  if (state.repeatGuardActive) {
    return {
      ...decisionBase,
      action: "stop-for-recovery",
      canRunUnattended: false,
      requiresHuman: true,
      exitCode: 1,
      reason: "Repeat guard is active for the same failed or blocked source ledger."
    };
  }
  if (state.status === "failed" || state.status === "blocked") {
    return {
      ...decisionBase,
      action: "stop-for-recovery",
      canRunUnattended: false,
      requiresHuman: true,
      exitCode: 1,
      reason: `Advance loop stopped as ${state.status}; inspect recovery evidence before continuing.`
    };
  }
  if (state.status === "planned") {
    return {
      ...decisionBase,
      action: "review-plan",
      canRunUnattended: false,
      requiresHuman: true,
      exitCode: 0,
      reason: "Advance loop is planned only; explicit review is required before execution.",
      nextCommand: createIssueControlAdvanceCommand(state)
    };
  }
  if (state.status === "complete" && isAdvanceLoopMaxStepPause(state.stopReason)) {
    return {
      ...decisionBase,
      action: "run-advance-loop",
      canRunUnattended: unattendedAllowed,
      requiresHuman: !unattendedAllowed,
      exitCode: 0,
      reason: unattendedAllowed
        ? "Advance loop reached its max-step guard and the trust safety envelope allows unattended continuation."
        : `Advance loop reached max-step guard, but unattended safety envelope is not green: ${failedSafetyChecks(safetyEnvelope ?? { passed: false, trustTier, checks: [] }).join(", ") || "missing-envelope"}.`,
      nextCommand: createIssueControlAdvanceCommand(state)
    };
  }
  return {
    ...decisionBase,
    action: "sync-issues",
    canRunUnattended: false,
    requiresHuman: false,
    exitCode: 0,
    reason: "Advance loop is complete; review artifacts and refresh md2 issue state with a sync plan."
  };
}

function isAdvanceLoopMaxStepPause(stopReason: string): boolean {
  return /^Reached max steps \d+\.$/.test(stopReason);
}

async function resolveIssueControlSyncGateLedgerPath(
  state: IssueControlAdvanceLoopState
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (state.lastLoopPath && await pathExists(state.lastLoopPath)) {
    const loop = await readJsonFile<IssueControlAdvanceLoopReport>(state.lastLoopPath);
    const terminalStep = loop.steps[loop.steps.length - 1];
    if (terminalStep?.decision === "ready-to-sync" || terminalStep?.decision === "complete") {
      candidates.push(terminalStep.sourceLedgerPath);
    }
    if (terminalStep?.superviseReportPath && await pathExists(terminalStep.superviseReportPath)) {
      const supervise = await readJsonFile<IssueControlSuperviseReport>(terminalStep.superviseReportPath);
      if (supervise.progressLedgerPath) {
        candidates.push(supervise.progressLedgerPath);
      }
    }
    if (loop.sourceLedgerPath) {
      candidates.push(loop.sourceLedgerPath);
    }
  }
  if (state.sourceLedgerPath) {
    candidates.push(state.sourceLedgerPath);
  }
  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isIssueControlSyncCompletedItem(item: IssueControlSuperviseProgressItem): boolean {
  return item.selected && ["executed", "verified", "recovered", "continued"].includes(item.state);
}

function resolveIssueControlSyncGateRunId(
  runId: string | undefined,
  ledger: IssueControlSuperviseProgressLedger
): { runId: string; source: IssueControlSyncGateReport["runIdSource"] } {
  if (runId) {
    return { runId, source: "option" };
  }
  const ledgerRunId = ledger.items
    .map((item) => item.runId)
    .find((candidate) => candidate && !candidate.startsWith("<"));
  if (ledgerRunId) {
    return { runId: ledgerRunId, source: "ledger" };
  }
  return { runId: "latest", source: "latest-fallback" };
}

function createIssueControlSyncGateCommand(
  runId: string,
  labels: string[],
  completedIssueIds: string[]
): string {
  const parts = [
    "node",
    "dist/cli.js",
    "sync-issues",
    "--config",
    "configs/md2-fast.migration-guard.json",
    "--run",
    runId,
    "--provider",
    "github",
    "--live-plan"
  ];
  if (labels.length > 0) {
    parts.push("--labels", labels.join(","));
  }
  if (completedIssueIds.length === 1) {
    parts.push("--only-issue", completedIssueIds[0]);
  }
  return parts.map(shellToken).join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function toIssueControlProgressStatusItem(item: IssueControlSuperviseProgressItem): IssueControlProgressStatusItem {
  return {
    issueNumber: item.issueNumber,
    issueId: item.issueId,
    runId: item.runId,
    title: item.title,
    action: item.action,
    state: item.state,
    reason: item.reason,
    artifactPaths: item.artifactPaths
  };
}

function createIssueControlProgressNextActions(
  ledger: IssueControlSuperviseProgressLedger,
  unresolvedItems: IssueControlProgressStatusItem[],
  unreachedSelectedItems: IssueControlProgressStatusItem[],
  automationDecision: IssueControlProgressAutomationDecision
): string[] {
  if (unresolvedItems.length > 0) {
    const first = unresolvedItems[0];
    return [
      `Inspect unresolved issue ${first.issueId ?? `#${first.issueNumber}`} and its progress ledger artifacts.`,
      "Resolve the blocker or recovery failure, then rerun issue-control supervise with the same labels and max-iterations.",
      ...(unreachedSelectedItems.length > 0
        ? [`${unreachedSelectedItems.length} selected issue(s) were not reached before the stop.`]
        : [])
    ];
  }
  if (automationDecision.disposition === "blocked") {
    return [
      automationDecision.reason,
      "Inspect the supervisor progress ledger and recovery artifacts before retrying."
    ];
  }
  if (ledger.summary.selectedCount === 0) {
    return [
      ledger.stopReason ?? "No safe executable issue was selected.",
      "Refresh md2 issues, seed a bootstrap/import issue, or rerun with --allow-high-risk only after review."
    ];
  }
  if (ledger.mode === "dry-run") {
    return [
      "Review selected issues, then rerun issue-control supervise with --execute when acceptable.",
      ...(automationDecision.nextCommand ? [`Next command: ${automationDecision.nextCommand}`] : [])
    ];
  }
  if (unreachedSelectedItems.length > 0) {
    return [
      "Rerun issue-control supervise to continue selected issues that were not reached before the prior stop or max-iterations limit.",
      ...(automationDecision.nextCommand ? [`Next command: ${automationDecision.nextCommand}`] : [])
    ];
  }
  if (ledger.summary.continuedCount > 0) {
    return ["Review recovered/continued items, then refresh md2 issue state with sync-issues --live-plan for completed issues."];
  }
  if (ledger.status === "complete") {
    return ["Refresh md2 issue state with sync-issues --live-plan for completed issues."];
  }
  return ["Inspect the source progress ledger for the current supervisor state."];
}

function createIssueControlProgressAutomationDecision(
  ledger: IssueControlSuperviseProgressLedger,
  unresolvedItems: IssueControlProgressStatusItem[],
  unreachedSelectedItems: IssueControlProgressStatusItem[]
): IssueControlProgressAutomationDecision {
  const trustTier = ledger.trustTier ?? ledger.controlOptions?.trustTier ?? "supervised";
  const safetyEnvelope = ledger.safetyEnvelope ?? createIssueControlSafetyEnvelopeFromLedger(ledger);
  const adaptiveGate = createIssueControlAdaptiveGate(ledger, unresolvedItems);
  const canUseUnattendedEnvelope = trustTier !== "unattended" || safetyEnvelope.passed;
  const withSafety = (decision: Omit<IssueControlProgressAutomationDecision, "safetyEnvelope" | "trustTier">): IssueControlProgressAutomationDecision => ({
    ...decision,
    trustTier,
    safetyEnvelope,
    adaptiveGate
  });
  if (unresolvedItems.length > 0) {
    const first = unresolvedItems[0];
    return withSafety({
      disposition: "blocked",
      canAutoContinue: false,
      requiresHuman: true,
      reason: `Unresolved issue ${first.issueId ?? `#${first.issueNumber}`} is ${first.state}.`
    });
  }
  if (ledger.status === "failed" || ledger.status === "blocked") {
    return withSafety({
      disposition: "blocked",
      canAutoContinue: false,
      requiresHuman: true,
      reason: ledger.stopReason ?? `Supervisor progress is ${ledger.status}.`
    });
  }
  if (ledger.summary.selectedCount === 0) {
    return withSafety({
      disposition: "review",
      canAutoContinue: false,
      requiresHuman: true,
      reason: "No selected issue-control item is available for automatic continuation."
    });
  }
  if (!canUseUnattendedEnvelope) {
    return withSafety({
      disposition: "review",
      canAutoContinue: false,
      requiresHuman: true,
      reason: `Unattended safety envelope is not green: ${failedSafetyChecks(safetyEnvelope).join(", ")}.`
    });
  }
  if (ledger.mode === "dry-run") {
    return withSafety({
      disposition: "ready-to-execute",
      canAutoContinue: Boolean(ledger.controlOptions),
      requiresHuman: false,
      reason: "Dry-run selected issues are ready for explicit execution.",
      nextCommand: createIssueControlSuperviseCommand(ledger, { execute: true, maxIterations: adaptiveGate.recommendedMaxIterations })
    });
  }
  if (unreachedSelectedItems.length > 0) {
    return withSafety({
      disposition: "ready-to-continue",
      canAutoContinue: Boolean(ledger.controlOptions),
      requiresHuman: false,
      reason: `${unreachedSelectedItems.length} selected issue(s) were not reached.`,
      nextCommand: createIssueControlSuperviseCommand(ledger, { execute: true, maxIterations: adaptiveGate.recommendedMaxIterations })
    });
  }
  if (ledger.status === "complete" && ledger.summary.reachedCount > 0) {
    return withSafety({
      disposition: "ready-to-sync",
      canAutoContinue: false,
      requiresHuman: false,
      reason: "Supervisor completed reached issues; refresh md2 issue state with a reviewed sync plan."
    });
  }
  if (ledger.status === "complete") {
    return withSafety({
      disposition: "complete",
      canAutoContinue: false,
      requiresHuman: false,
      reason: "Supervisor progress is complete."
    });
  }
  return withSafety({
    disposition: "review",
    canAutoContinue: false,
    requiresHuman: true,
    reason: "Progress state requires review before another automated step."
  });
}

function createIssueControlSuperviseCommand(
  ledger: IssueControlSuperviseProgressLedger,
  overrides: Partial<IssueControlSuperviseControlOptions> = {}
): string | undefined {
  const control = ledger.controlOptions;
  if (!control) {
    return undefined;
  }
  const merged: IssueControlSuperviseControlOptions = {
    ...control,
    ...overrides
  };
  const parts = [
    "node",
    "dist/cli.js",
    "issue-control",
    "supervise",
    ...(merged.configPath ? ["--config", merged.configPath] : []),
    "--repo",
    ledger.repo,
    "--state",
    merged.state,
    "--max-iterations",
    String(merged.maxIterations)
  ];
  if (merged.labels.length > 0) {
    parts.push("--labels", merged.labels.join(","));
  }
  if (merged.execute) {
    parts.push("--execute");
  }
  if (merged.allowHighRisk) {
    parts.push("--allow-high-risk");
  }
  if (merged.verifyEach) {
    parts.push("--verify-each");
  }
  if (merged.repairOnFail) {
    parts.push("--repair-on-fail");
  }
  if (merged.continueAfterRepair) {
    parts.push("--continue-after-repair");
  }
  if (merged.repairAgentCommand) {
    parts.push("--repair-agent", merged.repairAgentCommand);
  }
  return parts.map(shellToken).join(" ");
}

function createIssueControlAdvanceCommand(state: IssueControlAdvanceLoopState): string {
  return [
    "node",
    "dist/cli.js",
    "issue-control",
    "advance",
    ...(state.configPath ? ["--config", state.configPath] : []),
    ...(state.sourceLedgerPath ? ["--input", state.sourceLedgerPath] : []),
    "--execute",
    "--max-steps",
    String(state.maxSteps)
  ].map(shellToken).join(" ");
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function createIssueControlSuperviseProgressItem(
  report: IssueControlSuperviseReport,
  selection: IssueControlSuperviseSelectionItem
): IssueControlSuperviseProgressItem {
  const iteration = report.iterations.find((item) => item.issueNumber === selection.issueNumber && item.issueId === selection.issueId)
    ?? report.iterations.find((item) => item.issueNumber === selection.issueNumber)
    ?? report.iterations.find((item) => item.issueId === selection.issueId);
  const artifactPaths = collectSuperviseProgressArtifacts(iteration);
  const events = createIssueControlSuperviseProgressEvents(selection, iteration);
  const state = superviseProgressState(selection, iteration);
  return {
    issueNumber: selection.issueNumber,
    issueId: selection.issueId,
    runId: selection.runId,
    title: selection.title,
    action: selection.action,
    risk: selection.risk,
    selected: selection.selected,
    reached: Boolean(iteration),
    iterationIndex: iteration?.index,
    state,
    status: iteration?.status,
    verificationStatus: iteration?.verification?.status,
    recoveryExecutionStatus: iteration?.recoveryExecutionStatus,
    continuedAfterRepair: iteration?.continuedAfterRepair,
    reason: progressItemReason(selection, iteration),
    artifactPaths,
    events
  };
}

function superviseProgressState(
  selection: IssueControlSuperviseSelectionItem,
  iteration: IssueControlSuperviseIteration | undefined
): IssueControlSuperviseProgressState {
  if (!selection.selected) {
    return "skipped";
  }
  if (!iteration) {
    return "selected";
  }
  if (iteration.continuedAfterRepair) {
    return "continued";
  }
  if (iteration.recoveryExecutionStatus === "executed") {
    return "recovered";
  }
  if (iteration.status === "failed" || iteration.status === "blocked") {
    return iteration.status;
  }
  if (iteration.verification?.status === "passed") {
    return "verified";
  }
  return iteration.status;
}

function progressItemReason(
  selection: IssueControlSuperviseSelectionItem,
  iteration: IssueControlSuperviseIteration | undefined
): string {
  if (!selection.selected) {
    return selection.reason;
  }
  if (!iteration) {
    return "Selected but not reached before supervisor stopped or hit max iterations.";
  }
  return iteration.recoveryContinuationReason
    ?? iteration.error
    ?? iteration.verification?.reason
    ?? iteration.reason;
}

function collectSuperviseProgressArtifacts(iteration: IssueControlSuperviseIteration | undefined): string[] {
  if (!iteration) {
    return [];
  }
  return [
    iteration.runPath,
    iteration.runMarkdownPath,
    iteration.artifactPath,
    iteration.verification?.baselineSnapshotPath,
    iteration.verification?.runSnapshotPath,
    iteration.verification?.compareReportPath,
    iteration.verification?.compareMarkdownPath,
    iteration.recoveryPlanPath,
    iteration.recoveryPlanMarkdownPath,
    iteration.recoveryExecutionPath,
    iteration.recoveryExecutionMarkdownPath
  ].filter((item): item is string => Boolean(item));
}

function createIssueControlSuperviseProgressEvents(
  selection: IssueControlSuperviseSelectionItem,
  iteration: IssueControlSuperviseIteration | undefined
): IssueControlSuperviseProgressEvent[] {
  const events: IssueControlSuperviseProgressEvent[] = [{
    name: "selection",
    status: selection.selected ? "selected" : "skipped",
    reason: selection.reason,
    artifactPaths: []
  }];
  if (!iteration) {
    return events;
  }
  events.push({
    name: "iteration",
    status: iteration.status,
    reason: iteration.error ?? iteration.reason,
    artifactPaths: [iteration.runPath, iteration.runMarkdownPath, iteration.artifactPath].filter((item): item is string => Boolean(item))
  });
  if (iteration.verification) {
    events.push({
      name: "verification",
      status: iteration.verification.status,
      reason: iteration.verification.reason,
      artifactPaths: [
        iteration.verification.baselineSnapshotPath,
        iteration.verification.runSnapshotPath,
        iteration.verification.compareReportPath,
        iteration.verification.compareMarkdownPath
      ].filter((item): item is string => Boolean(item))
    });
  }
  if (iteration.recoveryPlanPath) {
    events.push({
      name: "recovery-plan",
      status: "planned",
      reason: "Recovery plan created for this iteration.",
      artifactPaths: [iteration.recoveryPlanPath, iteration.recoveryPlanMarkdownPath].filter((item): item is string => Boolean(item))
    });
  }
  if (iteration.recoveryExecutionPath) {
    events.push({
      name: "recovery-execution",
      status: iteration.recoveryExecutionStatus ?? "unknown",
      reason: iteration.recoveryContinuationReason ?? "Recovery execution artifact created.",
      artifactPaths: [iteration.recoveryExecutionPath, iteration.recoveryExecutionMarkdownPath].filter((item): item is string => Boolean(item))
    });
  }
  if (iteration.watchdogRollback) {
    events.push({
      name: "watchdog-rollback",
      status: iteration.watchdogRollback.status,
      reason: iteration.watchdogRollback.message ?? iteration.watchdogRollback.error ?? "Watchdog rollback completed.",
      artifactPaths: []
    });
  }
  if (iteration.continuedAfterRepair) {
    events.push({
      name: "continuation",
      status: "continued",
      reason: iteration.recoveryContinuationReason ?? "Supervisor continued after repair.",
      artifactPaths: []
    });
  }
  return events;
}

function createSuperviseRecommendedNextActions(report: IssueControlSuperviseReport): string[] {
  if (report.status === "blocked" && report.iterations.length === 0) {
    return ["No safe executable issue was selected. Refresh md2 issues or rerun with --allow-high-risk when appropriate."];
  }
  if (report.status === "blocked" || report.status === "failed") {
    return ["Inspect the failed or blocked iteration report, resolve the cause, then rerun issue-control supervise."];
  }
  if (report.mode === "dry-run") {
    return ["Review this supervise dry-run report, then rerun with --execute when the selected iterations are acceptable."];
  }
  return report.iterations
    .filter((iteration) => iteration.status === "executed" && iteration.issueId)
    .map((iteration) => `Refresh md2 issue state with sync-issues --live-plan --only-issue ${iteration.issueId}.`);
}

function createIssueControlTrustPolicy(
  trustTier: IssueControlTrustTier,
  maxIterations: number,
  allowHighRisk: boolean
): { riskBudget: number; maxBatchSize: number; allowHighRisk: boolean } {
  if (trustTier === "manual") {
    return {
      riskBudget: 1,
      maxBatchSize: 1,
      allowHighRisk: false
    };
  }
  if (trustTier === "unattended") {
    return {
      riskBudget: Math.max(1, maxIterations),
      maxBatchSize: maxIterations,
      allowHighRisk: false
    };
  }
  return {
    riskBudget: Math.max(1, maxIterations * 3),
    maxBatchSize: maxIterations,
    allowHighRisk
  };
}

function riskWeight(risk?: "low" | "medium" | "high"): number {
  if (risk === "high") {
    return 8;
  }
  if (risk === "medium") {
    return 3;
  }
  return 1;
}

function isRiskAllowedByTrust(
  item: IssueControlPlanItem,
  options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }
): boolean {
  if (options.trustTier === "unattended" && item.risk && item.risk !== "low") {
    return false;
  }
  if (item.risk === "high" && !options.allowHighRisk) {
    return false;
  }
  return true;
}

async function createIssueControlSafetyEnvelopeForReport(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport
): Promise<IssueControlSafetyEnvelope> {
  const selected = report.selection.filter((item) => item.selected);
  const targetClean = report.mode === "execute"
    ? await readIssueControlTargetClean(loaded)
    : { passed: true, reason: "Target git clean is enforced before unattended execution, not for dry-run planning." };
  const baselinePresent = report.mode === "execute"
    ? await pathExists(latestBaselinePath(loaded))
    : true;
  const checks: IssueControlSafetyEnvelopeCheck[] = [{
    id: "no-high-risk",
    passed: selected.every((item) => item.risk !== "high"),
    reason: selected.some((item) => item.risk === "high")
      ? "Selected set includes high-risk issues."
      : "Selected set has no high-risk issues."
  }, {
    id: "unattended-low-risk-only",
    passed: report.trustTier !== "unattended" || selected.every((item) => !item.risk || item.risk === "low"),
    reason: report.trustTier === "unattended"
      ? "Unattended tier requires every selected issue to be low risk."
      : "Low-risk-only check is advisory outside unattended tier."
  }, {
    id: "target-git-clean",
    passed: targetClean.passed,
    reason: targetClean.reason
  }, {
    id: "baseline-present",
    passed: baselinePresent,
    reason: baselinePresent
      ? "Latest baseline snapshot is available or not required for dry-run planning."
      : "Latest baseline snapshot is required before unattended execution."
  }, {
    id: "verify-each",
    passed: Boolean(report.controlOptions?.verifyEach),
    reason: "Unattended mutation watchdog requires verify-each."
  }, {
    id: "repair-on-fail",
    passed: Boolean(report.controlOptions?.repairOnFail),
    reason: "Unattended mutation watchdog requires repair-on-fail."
  }, {
    id: "continue-after-repair",
    passed: Boolean(report.controlOptions?.continueAfterRepair),
    reason: "Unattended continuation requires explicit continue-after-repair."
  }, {
    id: "critical-verification",
    passed: report.mode !== "execute" || report.summary.executedCount === 0 || report.summary.verifiedCount >= report.summary.executedCount,
    reason: report.mode !== "execute"
      ? "Critical verification is enforced during execution."
      : "Every executed unattended iteration must have post-iteration verification."
  }, {
    id: "no-no-op-risk",
    passed: true,
    reason: "No selected issue-control item carries no-op-risk metadata."
  }, {
    id: "no-unresolved-failures",
    passed: report.summary.failedCount === 0 && report.summary.blockedCount === 0 && report.humanActionRequired !== true,
    reason: "No failed, blocked or human-action-required iterations are present."
  }];
  return {
    passed: checks.every((check) => check.passed),
    trustTier: report.trustTier,
    checks
  };
}

async function readIssueControlTargetClean(loaded: LoadedConfig): Promise<{ passed: boolean; reason: string }> {
  const result = await runShellCommand("git status --short", {
    cwd: loaded.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return {
      passed: false,
      reason: result.error ?? (output || "git status failed for target root.")
    };
  }
  return {
    passed: output.length === 0,
    reason: output.length === 0
      ? "Target repository is clean."
      : `Target repository has uncommitted changes: ${output}`
  };
}

function createIssueControlSafetyEnvelopeFromLedger(ledger: IssueControlSuperviseProgressLedger): IssueControlSafetyEnvelope {
  const trustTier = ledger.trustTier ?? ledger.controlOptions?.trustTier ?? "supervised";
  const selected = ledger.items.filter((item) => item.selected);
  const checks: IssueControlSafetyEnvelopeCheck[] = [{
    id: "no-high-risk",
    passed: selected.every((item) => item.risk !== "high"),
    reason: selected.some((item) => item.risk === "high")
      ? "Selected set includes high-risk issues."
      : "Selected set has no high-risk issues."
  }, {
    id: "unattended-low-risk-only",
    passed: trustTier !== "unattended" || selected.every((item) => !item.risk || item.risk === "low"),
    reason: trustTier === "unattended"
      ? "Unattended tier requires every selected issue to be low risk."
      : "Low-risk-only check is advisory outside unattended tier."
  }, {
    id: "verify-each",
    passed: Boolean(ledger.controlOptions?.verifyEach),
    reason: "Unattended mutation watchdog requires verify-each."
  }, {
    id: "repair-on-fail",
    passed: Boolean(ledger.controlOptions?.repairOnFail),
    reason: "Unattended mutation watchdog requires repair-on-fail."
  }, {
    id: "continue-after-repair",
    passed: Boolean(ledger.controlOptions?.continueAfterRepair),
    reason: "Unattended continuation requires explicit continue-after-repair."
  }, {
    id: "no-unresolved-failures",
    passed: ledger.summary.unresolvedCount === 0,
    reason: "Progress ledger has no unresolved failed or blocked items."
  }];
  return {
    passed: checks.every((check) => check.passed),
    trustTier,
    checks
  };
}

function failedSafetyChecks(envelope: IssueControlSafetyEnvelope): string[] {
  return envelope.checks
    .filter((check) => !check.passed)
    .map((check) => check.id);
}

function createIssueControlAdaptiveGate(
  ledger: IssueControlSuperviseProgressLedger,
  unresolvedItems: IssueControlProgressStatusItem[]
): IssueControlAdaptiveGate {
  const current = ledger.controlOptions?.maxIterations ?? ledger.summary.selectedCount;
  if (unresolvedItems.length > 0 || ledger.status === "failed" || ledger.status === "blocked") {
    return {
      state: "downgrade",
      currentMaxIterations: current,
      recommendedMaxIterations: 1,
      reason: "A failed or blocked iteration downgrades the next unattended batch to single-step."
    };
  }
  if (ledger.mode === "execute" && ledger.status === "complete" && ledger.summary.reachedCount >= current && ledger.summary.reachedCount > 0) {
    return {
      state: "upgrade",
      currentMaxIterations: current,
      recommendedMaxIterations: Math.min(10, current + 1),
      reason: "The last bounded batch completed cleanly; the next batch may grow by one step."
    };
  }
  return {
    state: "hold",
    currentMaxIterations: current,
    recommendedMaxIterations: Math.max(1, current || 1),
    reason: "No upgrade or downgrade trigger was observed."
  };
}

function isAutoSelectable(item: IssueControlPlanItem, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }): boolean {
  if (!item.executable) {
    return false;
  }
  if (!item.issueId) {
    return false;
  }
  if (!isRiskAllowedByTrust(item, options)) {
    return false;
  }
  if (!["bootstrap-target", "repair-proposal", "execute-task"].includes(item.action)) {
    return false;
  }
  if (item.action === "execute-task" && (!item.runId || !item.taskId)) {
    return false;
  }
  if (item.action === "repair-proposal" && (!item.runId || !proposalFromCommand(item.recommendedCommand))) {
    return false;
  }
  return true;
}

function autoSelectionReason(item: IssueControlPlanItem, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }): string {
  if (!item.executable) {
    return "Not executable by issue-control plan.";
  }
  if (!item.issueId) {
    return "Missing mg_issue_id.";
  }
  if (!isRiskAllowedByTrust(item, options)) {
    if (options.trustTier === "unattended") {
      return "Unattended trust tier only selects low-risk issues.";
    }
    return "High risk item skipped; rerun with --allow-high-risk to select it.";
  }
  if (!["bootstrap-target", "repair-proposal", "execute-task"].includes(item.action)) {
    return `Action ${item.action} is not auto-selectable.`;
  }
  if (item.action === "execute-task" && (!item.runId || !item.taskId)) {
    return "execute-task requires mg_run_id and mg_task_id.";
  }
  if (item.action === "repair-proposal" && (!item.runId || !proposalFromCommand(item.recommendedCommand))) {
    return "repair-proposal requires mg_run_id and proposal id.";
  }
  return "Selectable but lower priority than the selected issue.";
}

function createAutoRecommendedNextActions(
  selected: IssueControlAutoSelectionItem | undefined,
  run: IssueControlRunReport | undefined,
  options: IssueControlAutoOptions
): string[] {
  if (!selected) {
    return ["No safe executable issue was selected. Review skipped reasons or rerun with --allow-high-risk when appropriate."];
  }
  if (!options.execute) {
    return [`Review the run dry-run report, then rerun auto with --execute${selected.risk === "high" ? " --allow-high-risk" : ""}.`];
  }
  if (run?.status === "complete" && selected.issueId) {
    return [`Refresh md2 issue state with sync-issues --live-plan --only-issue ${selected.issueId}.`];
  }
  return ["Inspect the issue-control run report and resolve the blocked or failed item before the next auto iteration."];
}

function createRunRecommendedNextActions(report: IssueControlRunReport): string[] {
  if (report.mode === "dry-run") {
    return report.items
      .filter((item) => item.status === "planned")
      .map((item) => `Rerun with --execute --only-issue ${item.issueId ?? "<mg_issue_id>"} after reviewing this plan.`);
  }
  if (report.status === "complete") {
    return report.items
      .filter((item) => item.status === "executed" && item.issueId)
      .map((item) => `Refresh md2 issue state with sync-issues --live-plan --only-issue ${item.issueId}.`);
  }
  return ["Inspect this run report, fix the blocked/failed item, then rerun with the same --only-issue."];
}

async function writeIssueControlPullReport(loaded: LoadedConfig, report: IssueControlPullReport): Promise<IssueControlPullReport> {
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlPull(report));
  return report;
}

function resolveGitHubRepo(loaded: LoadedConfig, repo?: string): string {
  const resolved = repo ?? loaded.config.issueSync?.githubRepo;
  if (!resolved) {
    throw new Error("GitHub issue-control requires --repo owner/name or config issueSync.githubRepo.");
  }
  validateGitHubRepo(resolved);
  return resolved;
}

function toIssueControlRemoteIssue(issue: GitHubIssueRemote): IssueControlRemoteIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyHash: issue.bodyHash,
    htmlUrl: issue.htmlUrl,
    state: issue.state,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: issue.author,
    migrationGuard: parseIssueControlMetadata(issue)
  };
}

function parseIssueControlMetadata(issue: GitHubIssueRemote): IssueControlMetadata {
  return {
    runId: field(issue.body, "mg_run_id"),
    issueId: field(issue.body, "mg_issue_id"),
    taskId: field(issue.body, "mg_task_id"),
    issueType: issueType(field(issue.body, "mg_issue_type") ?? labelValue(issue.labels, "mg-type")),
    status: field(issue.body, "mg_status") ?? labelValue(issue.labels, "status"),
    risk: risk(field(issue.body, "mg_risk") ?? labelValue(issue.labels, "mg-risk")),
    owner: owner(field(issue.body, "mg_owner") ?? labelValue(issue.labels, "owner")),
    proposalId: proposalId(issue.title, issue.body)
  };
}

function toIssueControlPlanItem(issue: IssueControlRemoteIssue): IssueControlPlanItem {
  const metadata = issue.migrationGuard;
  const ready = isReadyStatus(metadata.status);
  const commandRun = metadata.runId ? ` --run ${metadata.runId}` : " --run <run-id>";
  if (!metadata.issueId) {
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      labels: issue.labels,
      action: "review-external",
      executable: false,
      reason: "Issue has no mg_issue_id; keep it out of automated Migration Guard execution."
    };
  }
  if (isBootstrapIssue(issue)) {
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      issueId: metadata.issueId,
      runId: metadata.runId,
      taskId: metadata.taskId,
      issueType: metadata.issueType,
      status: metadata.status,
      risk: metadata.risk,
      labels: issue.labels,
      action: "bootstrap-target",
      executable: true,
      reason: "Target bootstrap issue; run the bounded md -> md2 bootstrap/import lane before normal refactor checks.",
      recommendedCommand: "node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration"
    };
  }
  if (metadata.issueType === "failure") {
    const proposal = metadata.proposalId ?? "<failed-proposal-id>";
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      issueId: metadata.issueId,
      runId: metadata.runId,
      taskId: metadata.taskId,
      issueType: metadata.issueType,
      status: metadata.status,
      risk: metadata.risk,
      labels: issue.labels,
      action: "repair-proposal",
      executable: true,
      reason: "Failure issue can enter the proposal repair loop.",
      recommendedCommand: `node dist/cli.js proposal repair --config configs/md2-fast.migration-guard.json${commandRun} --proposal ${proposal} --checks --accept`
    };
  }
  if (metadata.issueType === "risk" || metadata.issueType === "diff") {
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      issueId: metadata.issueId,
      runId: metadata.runId,
      taskId: metadata.taskId,
      issueType: metadata.issueType,
      status: metadata.status,
      risk: metadata.risk,
      labels: issue.labels,
      action: "classify-risk",
      executable: false,
      reason: "Risk/diff issues need classification before source edits."
    };
  }
  if (metadata.taskId && ready) {
    return {
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      issueId: metadata.issueId,
      runId: metadata.runId,
      taskId: metadata.taskId,
      issueType: metadata.issueType,
      status: metadata.status,
      risk: metadata.risk,
      labels: issue.labels,
      action: "execute-task",
      executable: true,
      reason: "Ready Migration Guard task issue can be handed to the task executor.",
      recommendedCommand: `node dist/cli.js task run --config configs/md2-fast.migration-guard.json${commandRun} --task ${metadata.taskId}`
    };
  }
  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.htmlUrl,
    issueId: metadata.issueId,
    runId: metadata.runId,
    taskId: metadata.taskId,
    issueType: metadata.issueType,
    status: metadata.status,
    risk: metadata.risk,
    labels: issue.labels,
    action: "track",
    executable: false,
    reason: "Issue is mapped to Migration Guard but is not ready for automated execution."
  };
}

function field(body: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function labelValue(labels: string[], prefix: string): string | undefined {
  return labels.find((label) => label.startsWith(`${prefix}:`))?.slice(prefix.length + 1).trim();
}

function issueType(value?: string): MigrationIssueType | undefined {
  return value && ["epic", "phase", "task", "risk", "diff", "failure"].includes(value)
    ? value as MigrationIssueType
    : undefined;
}

function risk(value?: string): "low" | "medium" | "high" | undefined {
  return value && ["low", "medium", "high"].includes(value)
    ? value as "low" | "medium" | "high"
    : undefined;
}

function owner(value?: string): "engine" | "ai" | "human" | undefined {
  return value && ["engine", "ai", "human"].includes(value)
    ? value as "engine" | "ai" | "human"
    : undefined;
}

function proposalId(title: string, body: string): string | undefined {
  return title.match(/^Proposal gate failed:\s*(\S+)/)?.[1]
    ?? body.match(/\bproposal(?:Id| id)?:?\s*`?([A-Za-z0-9_.-]+)`?/i)?.[1];
}

function proposalFromCommand(command?: string): string | undefined {
  return command?.match(/--proposal\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}

function isReadyStatus(status?: string): boolean {
  return Boolean(status && ["ready", "running", "replanned"].includes(status));
}

function isBootstrapIssue(issue: IssueControlRemoteIssue): boolean {
  const title = issue.title.toLowerCase();
  const labels = issue.labels.map((label) => label.toLowerCase());
  const metadata = issue.migrationGuard;
  const taskId = metadata.taskId?.toLowerCase() ?? "";
  const issueId = metadata.issueId?.toLowerCase() ?? "";
  return labels.some((label) => ["bootstrap", "mg-bootstrap", "type:bootstrap", "mg-type:bootstrap"].includes(label))
    || taskId.includes("bootstrap")
    || issueId.includes("bootstrap")
    || /\bbootstrap\b/.test(title)
    || /\binitial import\b/.test(title);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
