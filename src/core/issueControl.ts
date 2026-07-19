import { promises as fs } from "node:fs";
import path from "node:path";
import { readGitHubIssues, type GitHubRetryOptions } from "./githubIssueAdapter.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { loadActionPlan } from "./actionPlan.js";
import { selectRepairStrategy, summarizeRepairStrategy, type RepairStrategySummary } from "./repairStrategy.js";
import {
  type IssueControlPlanModelContext,
  toIssueControlPlanItem as modelToIssueControlPlanItem,
  toIssueControlRemoteIssue as modelToIssueControlRemoteIssue
} from "./issueControlModel.js";
import type { LoadedConfig, MigrationIssueType } from "../types.js";
import { loadRunPackage } from "./migrationRun.js";
import { writeIssueControlRecoveryExecution, writeIssueControlRecoveryPlan } from "./issueControl/recoveryArtifacts.js";
import { appendIssueControlAudit, issueControlAuditLogPath } from "./issueControl/audit.js";
import { resolveIssueControlGitHubRepo } from "./issueControl/githubConfig.js";
import { escapeMarkdownCell as escapeCell } from "./issueControl/renderHelpers.js";
import { renderIssueControlPlan, renderIssueControlPull } from "./issueControl/basicRender.js";
import { writeIssueControlPullReport } from "./issueControl/basicArtifacts.js";
import { renderIssueControlAuto, renderIssueControlRun } from "./issueControl/executionRender.js";
import { writeIssueControlAutoReport, writeIssueControlRunReport } from "./issueControl/executionArtifacts.js";
import {
  writeIssueControlProgressStatusReport,
  writeIssueControlSuperviseReport
} from "./issueControl/supervisionArtifacts.js";
import { renderIssueControlProgressStatus } from "./issueControl/progressRender.js";
import {
  renderIssueControlSupervise,
  renderIssueControlSuperviseProgressLedger
} from "./issueControl/supervisionRender.js";
import {
  renderIssueControlAdvance,
  renderIssueControlAdvanceLoop,
  renderIssueControlAdvanceLoopState,
  renderIssueControlAdvanceScheduler,
  renderIssueControlSyncGate
} from "./issueControl/advanceRender.js";
import {
  writeIssueControlAdvanceReport,
  writeIssueControlAdvanceSchedulerReport,
  writeIssueControlSyncGateReport
} from "./issueControl/advanceArtifacts.js";
import {
  writeIssueControlAdvanceLoopReport,
  type AdvanceLoopStatePaths
} from "./issueControl/advanceLoopArtifacts.js";
import {
  createIssueControlAdvanceLoopRepeatGuard,
  createIssueControlAdvanceLoopSchedulerDecision,
  createIssueControlAdvanceLoopStateNextAction
} from "./issueControl/advanceLoopPolicy.js";
import {
  createIssueControlTrustPolicy,
  selectIssueControlAutoItem,
  selectIssueControlSuperviseItems
} from "./issueControl/selectionPolicy.js";
import {
  createIssueControlAdaptiveGate,
  createIssueControlSafetyEnvelopeFromLedger,
  failedSafetyChecks
} from "./issueControl/safetyPolicy.js";
import {
  createIssueControlProgressStatusReport,
  toIssueControlProgressStatusItem
} from "./issueControl/progressPolicy.js";
import { createIssueControlSuperviseProgressLedger } from "./issueControl/supervisionProgress.js";
import { runIssueControlPlanItem } from "./issueControl/planExecution.js";
import { createIssueControlRecoveryPlan } from "./issueControl/recoveryPolicy.js";
import { executeIssueControlRecoveryPlan } from "./issueControl/recoveryExecution.js";
import { runIssueControlSnapshotCompare } from "./issueControl/verificationService.js";
import { runIssueControlWatchdogRollback } from "./issueControl/watchdog.js";
import { createIssueControlSafetyEnvelopeForReport } from "./issueControl/supervisionSafety.js";
import {
  createAutoRecommendedNextActions,
  createRunRecommendedNextActions,
  createSuperviseRecommendedNextActions
} from "./issueControl/recommendations.js";
import {
  createIssueControlSyncGateCommand,
  resolveIssueControlSyncGateRunId,
  summarizeIssueControlSyncGate
} from "./issueControl/syncGatePolicy.js";
export { renderIssueControlAuto, renderIssueControlRun } from "./issueControl/executionRender.js";
export { renderIssueControlPlan, renderIssueControlPull } from "./issueControl/basicRender.js";
export { renderIssueControlProgressStatus } from "./issueControl/progressRender.js";
export {
  renderIssueControlSupervise,
  renderIssueControlSuperviseProgressLedger
} from "./issueControl/supervisionRender.js";
export {
  renderIssueControlAdvance,
  renderIssueControlAdvanceLoop,
  renderIssueControlAdvanceLoopState,
  renderIssueControlAdvanceScheduler,
  renderIssueControlSyncGate
} from "./issueControl/advanceRender.js";

export type IssueControlProvider = "github";
export type IssueControlTrustTier = "manual" | "supervised" | "unattended";
export type IssueControlAction =
  | "bootstrap-target"
  | "repair-proposal"
  | "execute-task"
  | "propose-action"
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
  actionId?: string;
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
  actionId?: string;
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
  const repo = resolveIssueControlGitHubRepo(loaded, options.repo);
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
    issues: result.issues.map(modelToIssueControlRemoteIssue)
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
  const report = collectIssueControlPlan(pull, {
    actionPlans: await loadIssueControlActionPlans(loaded, pull)
  });
  const dir = path.join(loaded.artifactsDir, "issue-control");
  const outputPath = path.join(dir, `${report.id}.json`);
  const markdownPath = outputPath.replace(/\.json$/, ".md");
  report.outputPath = outputPath;
  report.markdownPath = markdownPath;
  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, renderIssueControlPlan(report));
  return report;
}

export function collectIssueControlPlan(pull: IssueControlPullReport, context: IssueControlPlanModelContext = {}): IssueControlPlanReport {
  const items = pull.issues.map((issue) => modelToIssueControlPlanItem(issue, context));
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

async function loadIssueControlActionPlans(loaded: LoadedConfig, pull: IssueControlPullReport): Promise<IssueControlPlanModelContext["actionPlans"]> {
  const runIds = [...new Set(pull.issues.map((issue) => issue.migrationGuard.runId).filter(Boolean))] as string[];
  const plans: NonNullable<IssueControlPlanModelContext["actionPlans"]> = [];
  for (const runId of runIds) {
    try {
      const pkg = await loadRunPackage(loaded, runId);
      plans.push(await loadActionPlan(loaded, pkg));
    } catch {
      // Remote issue planning should stay usable even if a referenced run is stale or local-only.
    }
  }
  return plans;
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
    return writeIssueControlSuperviseReport(loaded, report, supervisionArtifactDependencies());
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
  return writeIssueControlSuperviseReport(loaded, report, supervisionArtifactDependencies());
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
  return writeIssueControlProgressStatusReport(loaded, report, renderIssueControlProgressStatus);
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
    }, previousState, (report, previous, paths) => createIssueControlAdvanceLoopState(loaded, report, previous, paths));
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
  }, previousState, (report, previous, paths) => createIssueControlAdvanceLoopState(loaded, report, previous, paths));
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
  const source = await resolveIssueControlSyncGateSource(loaded, options);
  const decision = source.schedulerDecision;
  const now = new Date().toISOString();
  const base: IssueControlSyncGateReport = {
    version: 1,
    id: `issue-control-sync-gate-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    status: "not-ready",
    sourceStatePath: source.sourceStatePath,
    sourceLoopPath: source.sourceLoopPath,
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

  const ledgerPath = source.ledgerPath ?? (source.state ? await resolveIssueControlSyncGateLedgerPath(source.state) : undefined);
  if (!ledgerPath) {
    return writeIssueControlSyncGateReport(loaded, {
      ...base,
      status: "blocked",
      reason: "Sync gate could not find the progress ledger behind the completed advance loop."
    });
  }

  const ledger = await loadIssueControlSuperviseProgressLedger(ledgerPath);
  const { completedIssueIds, unresolvedIssueIds, pendingIssueIds } = summarizeIssueControlSyncGate(ledger);
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



function supervisionArtifactDependencies() {
  return {
    createProgressLedger: createIssueControlSuperviseProgressLedger,
    renderProgressLedger: renderIssueControlSuperviseProgressLedger,
    renderSupervise: renderIssueControlSupervise
  };
}




async function createIssueControlAdvanceLoopState(
  loaded: LoadedConfig,
  report: IssueControlAdvanceLoopReport,
  previousState: IssueControlAdvanceLoopState | undefined,
  paths: AdvanceLoopStatePaths
): Promise<IssueControlAdvanceLoopState> {
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
    outputPath: paths.outputPath,
    markdownPath: paths.markdownPath
  };
  state.schedulerDecision = createIssueControlAdvanceLoopSchedulerDecision(state);
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
  const runRecovery = options.recoveryExecutor
    ?? ((currentLoaded, currentReport, currentPlan, currentOptions) => executeIssueControlRecoveryPlan(
      currentLoaded,
      currentReport,
      currentPlan,
      currentOptions,
      applyRecoveryBehaviorDiffGuard
    ));
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
  return runIssueControlSnapshotCompare(loaded, {
    artifactName: () => `recovery-${executionId}-compare`,
    passedReason: "Recovery behavior diff guard passed.",
    failedReason: "Recovery behavior diff guard failed.",
    missingBaselineReason: (baselinePath) => `No baseline found at ${baselinePath}; behavior diff guard cannot run.`
  });
}



function runIdFromCommand(command?: string): string | undefined {
  return command?.match(/--run\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}


async function verifySuperviseIteration(
  loaded: LoadedConfig,
  iteration: IssueControlSuperviseIteration
): Promise<IssueControlSuperviseVerification> {
  if (iteration.status !== "executed") {
    return { status: "skipped", reason: `Iteration status ${iteration.status} is not executable verification input.` };
  }
  return runIssueControlSnapshotCompare(loaded, {
    artifactName: (runId) => `supervise-${iteration.index}-${runId}-compare`,
    passedReason: "Post-iteration verification compare passed.",
    failedReason: "Post-iteration verification compare failed.",
    missingBaselineReason: (baselinePath) => `No baseline found at ${baselinePath}. Run baseline before --verify-each.`
  });
}



function isSuperviseSelectedReason(reason: string): boolean {
  return reason === "Selectable but lower priority than the selected issue."
    || reason === "Selected for supervised issue-control iteration.";
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


async function loadIssueControlAdvanceLoopState(loaded: LoadedConfig): Promise<IssueControlAdvanceLoopState | undefined> {
  const filePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
  if (!await pathExists(filePath)) {
    return undefined;
  }
  return readJsonFile<IssueControlAdvanceLoopState>(filePath);
}


interface IssueControlSyncGateSource {
  state?: IssueControlAdvanceLoopState;
  sourceStatePath?: string;
  sourceLoopPath?: string;
  ledgerPath?: string;
  schedulerDecision: IssueControlAdvanceLoopSchedulerDecision;
}

async function resolveIssueControlSyncGateSource(
  loaded: LoadedConfig,
  options: IssueControlSyncGateOptions
): Promise<IssueControlSyncGateSource> {
  if (!options.input) {
    const progress = await latestIssueControlSyncReadyProgress(loaded);
    if (progress) {
      return {
        ledgerPath: progress.sourceLedgerPath,
        schedulerDecision: createIssueControlSyncGateSchedulerDecisionFromProgress(progress)
      };
    }
  }
  const state = await issueControlAdvanceLoopStatus(loaded, { input: options.input });
  return {
    state,
    sourceStatePath: state.outputPath ?? options.input,
    sourceLoopPath: state.lastLoopPath,
    schedulerDecision: state.schedulerDecision ?? createIssueControlAdvanceLoopSchedulerDecision(state)
  };
}

async function latestIssueControlSyncReadyProgress(
  loaded: LoadedConfig
): Promise<IssueControlProgressStatusReport | undefined> {
  const ledgerPath = await latestIssueControlSuperviseProgressLedgerPath(loaded);
  if (!ledgerPath) {
    return undefined;
  }
  const ledger = await loadIssueControlSuperviseProgressLedger(ledgerPath);
  const progress = createIssueControlProgressStatusReport(ledger, ledgerPath);
  return isIssueControlProgressSyncReady(progress) ? progress : undefined;
}

function isIssueControlProgressSyncReady(progress: IssueControlProgressStatusReport): boolean {
  return progress.automationDecision.disposition === "ready-to-sync"
    || progress.automationDecision.disposition === "complete";
}

function createIssueControlSyncGateSchedulerDecisionFromProgress(
  progress: IssueControlProgressStatusReport
): IssueControlAdvanceLoopSchedulerDecision {
  const decision = progress.automationDecision;
  return {
    action: "sync-issues",
    canRunUnattended: false,
    requiresHuman: false,
    trustTier: decision.trustTier,
    safetyEnvelope: decision.safetyEnvelope,
    adaptiveGate: decision.adaptiveGate,
    exitCode: 0,
    reason: `Latest supervisor progress ${progress.sourceSuperviseId} is ready for issue sync. ${decision.reason}`,
    nextCommand: decision.nextCommand
  };
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
