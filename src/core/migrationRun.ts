import { promises as fs } from "node:fs";
import path from "node:path";
import { renderMigrationPlan } from "./plan.js";
import { scanProject } from "./scan.js";
import { createEstimate, createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import { decisionPolicyForCompareReportPath, formatPolicyLine } from "./diffDecision.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type {
  EvidenceEvent,
  LoadedConfig,
  MigrationAutomationMode,
  MigrationIssue,
  MigrationRun,
  MigrationTask,
  MigrationTaskGraph,
  MigrationTaskStatus,
  ProposalBatchReport,
  ProposalVerificationReport,
  ProposedPatch
} from "../types.js";

export interface CreateRunOptions {
  goal: string;
  sourceRoot: string;
  targetRoot: string;
  mode: MigrationAutomationMode;
  adapter?: string;
  issueProvider?: MigrationRun["issueProvider"];
}

export interface MigrationRunPackage {
  run: MigrationRun;
  graph: MigrationTaskGraph;
  issues: MigrationIssue[];
}

export interface MigrationRunNextAction {
  action: string;
  command?: string;
  reason?: string;
  evidence?: string[];
  retryCommand?: string;
}

interface ProposalGateSummary {
  proposalId: string;
  createdAt: string;
  passed: boolean;
  checks: number;
  timeline: number;
  reportPath: string;
  replanIssueId?: string;
  replanTaskId?: string;
  replanBriefPath?: string;
  replanContextPath?: string;
  failureCategory?: string;
  remediationHint?: string;
  behaviorDriftCount?: number;
  firstBehaviorDrift?: string;
  behaviorComparePath?: string;
  behaviorDiffPath?: string;
  behaviorDiffPassed?: boolean;
  behaviorDiffErrors?: number;
  behaviorDiffWarnings?: number;
  behaviorDecisionStatus?: string;
  behaviorDecisionCanContinue?: boolean;
  behaviorDecisionSummary?: string;
  behaviorDecisionPendingRisk?: number;
  behaviorDecisionAccidentalRisk?: number;
  behaviorDecisionUnknownRisk?: number;
}

interface ProposalBatchSummary {
  id: string;
  createdAt: string;
  passed: boolean;
  gatePolicy?: string;
  executedCount: number;
  skippedCount: number;
  reportPath: string;
  firstFailedProposalId?: string;
  firstFailedVerificationPath?: string;
  stopReason?: string;
  nextCommand?: string;
  skippedProposals: string[];
  recommendedNextActions?: string[];
}

export function migrationRunsDir(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "migration-runs");
}

export function migrationRunDir(loaded: LoadedConfig, runId: string): string {
  return path.join(migrationRunsDir(loaded), runId);
}

export function latestMigrationRunPath(loaded: LoadedConfig): string {
  return path.join(migrationRunsDir(loaded), "latest.json");
}

export async function createMigrationRun(loaded: LoadedConfig, options: CreateRunOptions): Promise<MigrationRunPackage> {
  const runId = createId("run");
  const now = new Date().toISOString();
  const scanLoaded = {
    ...loaded,
    targetRoot: options.targetRoot
  };
  const scan = await scanProject(scanLoaded);
  const graph = createTaskGraph(runId, scan, options.goal, options.adapter);
  const estimate = createEstimate(scan, graph);
  const run: MigrationRun = {
    version: 1,
    id: runId,
    goal: options.goal,
    sourceRoot: options.sourceRoot,
    targetRoot: options.targetRoot,
    artifactsDir: migrationRunDir(loaded, runId),
    status: options.mode === "dry-run" ? "planned" : "initialized",
    mode: options.mode,
    adapter: options.adapter,
    issueProvider: options.issueProvider ?? "local",
    createdAt: now,
    updatedAt: now,
    estimate
  };
  const issues = createIssuesForRun(run, graph);

  for (const task of graph.tasks) {
    task.issueId = issues.find((issue) => issue.taskId === task.id)?.id;
  }

  await saveRunPackage(loaded, { run, graph, issues });
  await appendEvidence(loaded, run.id, {
    runId: run.id,
    type: "run-created",
    message: `Created migration run for goal: ${run.goal}`,
    data: {
      mode: run.mode,
      adapter: run.adapter,
      graphErrors: validateTaskGraph(graph)
    }
  });
  await writeTextFile(path.join(migrationRunDir(loaded, run.id), "reports", "initial-plan.md"), renderMigrationPlan(scan));

  return { run, graph, issues };
}

export async function loadRunPackage(loaded: LoadedConfig, selector = "latest"): Promise<MigrationRunPackage> {
  const runId = selector === "latest" || selector.length === 0
    ? await readLatestRunId(loaded)
    : selector;
  const dir = migrationRunDir(loaded, runId);

  return {
    run: await readJsonFile<MigrationRun>(path.join(dir, "run.json")),
    graph: await readJsonFile<MigrationTaskGraph>(path.join(dir, "task-graph.json")),
    issues: await readJsonFile<MigrationIssue[]>(path.join(dir, "issues.json"))
  };
}

export async function saveRunPackage(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<void> {
  const dir = migrationRunDir(loaded, pkg.run.id);
  pkg.run.updatedAt = new Date().toISOString();
  pkg.graph.updatedAt = new Date().toISOString();

  await writeJsonFile(path.join(dir, "run.json"), pkg.run);
  await writeJsonFile(path.join(dir, "task-graph.json"), pkg.graph);
  await writeJsonFile(path.join(dir, "issues.json"), pkg.issues);
  await writeJsonFile(latestMigrationRunPath(loaded), {
    runId: pkg.run.id,
    updatedAt: pkg.run.updatedAt
  });
}

export async function appendEvidence(
  loaded: LoadedConfig,
  runId: string,
  event: Omit<EvidenceEvent, "id" | "createdAt">
): Promise<EvidenceEvent> {
  const created: EvidenceEvent = {
    id: createId("evidence"),
    createdAt: new Date().toISOString(),
    ...event
  };
  const filePath = path.join(migrationRunDir(loaded, runId), "evidence.jsonl");
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(created)}\n`, "utf8");
  return created;
}

export async function readEvidence(loaded: LoadedConfig, runId: string): Promise<EvidenceEvent[]> {
  const filePath = path.join(migrationRunDir(loaded, runId), "evidence.jsonl");
  if (!await pathExists(filePath)) {
    return [];
  }

  const content = await fs.readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvidenceEvent);
}

export function renderRunStatus(pkg: MigrationRunPackage, nextAction?: MigrationRunNextAction): string {
  const ready = getReadyTasks(pkg.graph);
  const counts = countTasks(pkg.graph);

  return [
    `Run: ${pkg.run.id}`,
    `Goal: ${pkg.run.goal}`,
    `Status: ${pkg.run.status}`,
    `Mode: ${pkg.run.mode}${pkg.run.adapter ? ` (${pkg.run.adapter})` : ""}`,
    `Source: ${pkg.run.sourceRoot}`,
    `Target: ${pkg.run.targetRoot}`,
    `Tasks: ${formatTaskCounts(counts)}`,
    `Issues: ${pkg.issues.length}`,
    `Risk: ${pkg.run.estimate.riskLevel}`,
    `Confidence: ${pkg.run.estimate.confidence}`,
    `Ready tasks: ${ready.map((task) => task.id).join(", ") || "none"}`,
    "",
    ...renderNextActionTextLines(nextAction)
  ].join("\n");
}

export function renderIssues(issues: MigrationIssue[]): string {
  if (issues.length === 0) {
    return "No migration issues.";
  }

  return issues
    .map((issue) => [
      `- ${issue.id} [${issue.type}/${issue.status}/${issue.risk}] ${issue.title}`,
      issue.taskId ? `  task: ${issue.taskId}` : undefined,
      issue.externalUrl ? `  external: ${issue.externalUrl}` : undefined
    ].filter(Boolean).join("\n"))
    .join("\n");
}

export async function resolveRunNextAction(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<MigrationRunNextAction> {
  const proposals = await readProposalSummaries(loaded, pkg.run.id);
  const proposalGates = await readRecentProposalGateSummaries(loaded, pkg.run.id);
  const proposalBatches = await readRecentProposalBatchSummaries(loaded, pkg.run.id);
  return selectRunNextAction(pkg, proposals, proposalGates, proposalBatches);
}

export async function renderRunReport(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const evidence = await readEvidence(loaded, pkg.run.id);
  const counts = countTasks(pkg.graph);
  const openIssues = pkg.issues.filter((issue) => issue.status !== "closed" && issue.status !== "done");
  const graphErrors = validateTaskGraph(pkg.graph);
  const proposals = await readProposalSummaries(loaded, pkg.run.id);
  const proposalGates = await readRecentProposalGateSummaries(loaded, pkg.run.id);
  const proposalBatches = await readRecentProposalBatchSummaries(loaded, pkg.run.id);
  const nextAction = selectRunNextAction(pkg, proposals, proposalGates, proposalBatches);

  return [
    `# Migration Run Report: ${pkg.run.id}`,
    "",
    "## Summary",
    "",
    `- Goal: ${pkg.run.goal}`,
    `- Status: ${pkg.run.status}`,
    `- Mode: ${pkg.run.mode}`,
    `- Adapter: ${pkg.run.adapter ?? "none"}`,
    `- Source: ${pkg.run.sourceRoot}`,
    `- Target: ${pkg.run.targetRoot}`,
    `- Created: ${pkg.run.createdAt}`,
    `- Updated: ${pkg.run.updatedAt}`,
    "",
    "## Next Action",
    "",
    ...renderNextActionMarkdownLines(nextAction),
    "",
    "## Estimate",
    "",
    `- Source files: ${pkg.run.estimate.sourceFiles}`,
    `- Test files: ${pkg.run.estimate.testFiles}`,
    `- Task count: ${pkg.run.estimate.taskCount}`,
    `- Risk: ${pkg.run.estimate.riskLevel}`,
    `- Confidence: ${pkg.run.estimate.confidence}`,
    `- Estimated verification rounds: ${pkg.run.estimate.estimatedVerificationRounds}`,
    "",
    "## Task Status",
    "",
    `- ${formatTaskCounts(counts)}`,
    "",
    "## Ready Tasks",
    "",
    ...getReadyTasks(pkg.graph).map((task) => `- ${task.id}: ${task.title}`),
    getReadyTasks(pkg.graph).length === 0 ? "- none" : "",
    "",
    "## Open Issues",
    "",
    openIssues.length > 0 ? renderIssues(openIssues) : "No open issues.",
    "",
    "## Graph Validation",
    "",
    graphErrors.length > 0 ? graphErrors.map((error) => `- ${error}`).join("\n") : "No graph errors.",
    "",
    "## Proposals",
    "",
    proposals.length > 0
      ? proposals.map((proposal) => `- ${proposal.id} [${proposal.applyState}/${proposal.risk}] ${proposal.title}${proposal.retryOfProposalId ? ` retry-of:${proposal.retryOfProposalId}` : ""}`).join("\n")
      : "No proposals.",
    "",
    "## Recent Proposal Gates",
    "",
    proposalGates.length > 0
      ? proposalGates.map((gate) => [
        `- ${gate.createdAt} ${gate.proposalId} ${gate.passed ? "passed" : "failed"} checks:${gate.checks} timeline:${gate.timeline}${gate.replanIssueId ? ` replan:${gate.replanIssueId}` : ""}`,
        gate.failureCategory ? `  failure:${gate.failureCategory}` : undefined,
        gate.remediationHint ? `  hint:${gate.remediationHint}` : undefined,
        gate.behaviorDriftCount ? `  behavior-drift:${gate.behaviorDriftCount}` : undefined,
        gate.firstBehaviorDrift ? `  first-drift:${gate.firstBehaviorDrift}` : undefined,
        gate.behaviorDiffPath ? `  behavior-diff:${gate.behaviorDiffPassed ? "passed" : "failed"} errors:${gate.behaviorDiffErrors ?? 0} warnings:${gate.behaviorDiffWarnings ?? 0}` : undefined,
        gate.behaviorDiffPath ? `  behavior-compare:${gate.behaviorDiffPath}` : undefined,
        gate.behaviorDecisionSummary ? `  behavior-decisions: ${gate.behaviorDecisionSummary}` : undefined,
        gate.replanBriefPath ? `  replan-brief:${gate.replanBriefPath}` : undefined,
        gate.replanContextPath ? `  replan-context:${gate.replanContextPath}` : undefined
      ].filter(Boolean).join("\n")).join("\n")
      : "No proposal gate reports.",
    "",
    "## Recent Proposal Batches",
    "",
    proposalBatches.length > 0
      ? proposalBatches.map((batch) => [
        `- ${batch.createdAt} ${batch.id} ${batch.passed ? "passed" : "failed"} policy:${batch.gatePolicy ?? "unknown"} executed:${batch.executedCount} skipped:${batch.skippedCount}`,
        `  report:${batch.reportPath}`,
        batch.firstFailedVerificationPath ? `  first-failed-verification:${batch.firstFailedVerificationPath}` : undefined,
        batch.stopReason ? `  stop:${batch.stopReason}` : undefined,
        batch.nextCommand ? `  next:${batch.nextCommand}` : undefined,
        batch.skippedProposals.length > 0 ? `  skipped:${batch.skippedProposals.join(", ")}` : undefined,
        ...(batch.recommendedNextActions ?? []).map((action) => `  recommended:${action}`)
      ].filter(Boolean).join("\n")).join("\n")
      : "No proposal batch reports.",
    "",
    "## Evidence",
    "",
    ...evidence.slice(-20).map((event) => `- ${event.createdAt} [${event.type}] ${event.message}`)
  ].join("\n");
}

export async function writeRunReport(loaded: LoadedConfig, pkg: MigrationRunPackage, name = "latest-report.md"): Promise<string> {
  const report = await renderRunReport(loaded, pkg);
  const reportPath = path.join(migrationRunDir(loaded, pkg.run.id), "reports", name);
  await writeTextFile(reportPath, report);
  pkg.run.finalReportPath = reportPath;
  await saveRunPackage(loaded, pkg);
  return reportPath;
}

export async function writeCiHandoffReport(loaded: LoadedConfig, pkg: MigrationRunPackage, name = "ci-handoff.md"): Promise<string> {
  const gates = await readRecentProposalGateSummaries(loaded, pkg.run.id);
  const batches = await readRecentProposalBatchSummaries(loaded, pkg.run.id);
  const failedGate = [...gates].reverse().find((gate) => !gate.passed);
  const failedBatch = [...batches].reverse().find((batch) => !batch.passed);
  const report = renderCiHandoffMarkdown(pkg, failedGate, failedBatch, "CI Handoff");
  const reportPath = path.join(migrationRunDir(loaded, pkg.run.id), "reports", name);
  await writeTextFile(reportPath, report);
  await writeTextFile(
    path.join(migrationRunDir(loaded, pkg.run.id), "reports", "github-step-summary.md"),
    renderCiHandoffMarkdown(pkg, failedGate, failedBatch, "Migration Guard CI Summary")
  );
  return reportPath;
}

function renderCiHandoffMarkdown(
  pkg: MigrationRunPackage,
  failedGate: Awaited<ReturnType<typeof readRecentProposalGateSummaries>>[number] | undefined,
  failedBatch: Awaited<ReturnType<typeof readRecentProposalBatchSummaries>>[number] | undefined,
  title: string
): string {
  return [
    `# ${title}: ${pkg.run.id}`,
    "",
    `- Goal: ${pkg.run.goal}`,
    `- Status: ${pkg.run.status}`,
    `- Latest failed gate: ${failedGate ? failedGate.proposalId : "none"}`,
    failedGate?.failureCategory ? `- Gate failure category: ${failedGate.failureCategory}` : undefined,
    failedGate?.remediationHint ? `- Gate hint: ${failedGate.remediationHint}` : undefined,
    `- Latest failed batch: ${failedBatch ? failedBatch.id : "none"}`,
    failedBatch?.reportPath ? `- Batch report: ${failedBatch.reportPath}` : undefined,
    failedBatch?.firstFailedVerificationPath ? `- First failed verification: ${failedBatch.firstFailedVerificationPath}` : undefined,
    failedBatch?.stopReason ? `- Batch stop reason: ${failedBatch.stopReason}` : undefined,
    failedBatch?.nextCommand ? `- Next command: ${failedBatch.nextCommand}` : undefined,
    failedBatch && failedBatch.skippedProposals.length > 0 ? `- Skipped proposals: ${failedBatch.skippedProposals.join(", ")}` : undefined,
    ...(failedBatch?.recommendedNextActions ?? []).map((action) => `- Recommended: ${action}`)
  ].filter(Boolean).join("\n");
}

function selectRunNextAction(
  pkg: MigrationRunPackage,
  proposals: ProposedPatch[],
  gates: ProposalGateSummary[],
  batches: ProposalBatchSummary[]
): MigrationRunNextAction {
  const latestFailedBatch = [...batches].reverse().find((batch) => !batch.passed);
  const latestFailedGate = latestFailedBatch?.firstFailedProposalId
    ? [...gates].reverse().find((gate) => !gate.passed && gate.proposalId === latestFailedBatch.firstFailedProposalId)
    : [...gates].reverse().find((gate) => !gate.passed);

  if (latestFailedGate?.replanBriefPath) {
    const retryProposal = latestRetryProposalFor(proposals, latestFailedGate.proposalId);
    if (retryProposal) {
      return nextActionForRetryProposal(retryProposal, latestFailedGate, latestFailedBatch);
    }
    return {
      action: `Create a retry proposal for ${latestFailedGate.proposalId}.`,
      command: `migration-guard proposal retry --run latest --proposal ${latestFailedGate.proposalId}`,
      reason: latestFailedBatch?.stopReason ?? latestFailedGate.failureCategory ?? "replan brief is ready",
      evidence: [
        latestFailedGate.replanBriefPath,
        latestFailedGate.replanContextPath,
        latestFailedGate.reportPath,
        latestFailedBatch?.reportPath
      ].filter((item): item is string => Boolean(item))
    };
  }

  if (latestFailedBatch?.nextCommand) {
    return {
      action: `Create a replan brief for proposal ${latestFailedBatch.firstFailedProposalId ?? "latest failed proposal"}.`,
      command: latestFailedBatch.nextCommand,
      reason: latestFailedBatch.stopReason,
      evidence: [
        latestFailedBatch.reportPath,
        latestFailedBatch.firstFailedVerificationPath
      ].filter((item): item is string => Boolean(item))
    };
  }

  if (latestFailedGate) {
    return {
      action: `Create a replan brief for proposal ${latestFailedGate.proposalId}.`,
      command: `migration-guard proposal replan --run latest --proposal ${latestFailedGate.proposalId}`,
      reason: latestFailedGate.failureCategory ?? "latest proposal gate failed",
      evidence: [latestFailedGate.reportPath]
    };
  }

  const latestBlockedBehaviorDecision = [...gates].reverse().find((gate) => {
    return (gate.behaviorDecisionAccidentalRisk ?? 0) > 0 && Boolean(gate.behaviorComparePath);
  });
  if (latestBlockedBehaviorDecision?.behaviorComparePath) {
    return {
      action: `Replan accidental behavior differences for proposal ${latestBlockedBehaviorDecision.proposalId}.`,
      command: `migration-guard proposal replan --run latest --proposal ${latestBlockedBehaviorDecision.proposalId}`,
      reason: `${latestBlockedBehaviorDecision.behaviorDecisionAccidentalRisk} risk difference(s) are classified accidental`,
      evidence: [
        latestBlockedBehaviorDecision.behaviorComparePath,
        latestBlockedBehaviorDecision.reportPath
      ]
    };
  }

  const latestPendingBehaviorDecision = [...gates].reverse().find((gate) => {
    return ((gate.behaviorDecisionPendingRisk ?? 0) > 0 || (gate.behaviorDecisionUnknownRisk ?? 0) > 0) && Boolean(gate.behaviorComparePath);
  });
  if (latestPendingBehaviorDecision?.behaviorComparePath) {
    const pendingCount = (latestPendingBehaviorDecision.behaviorDecisionPendingRisk ?? 0)
      + (latestPendingBehaviorDecision.behaviorDecisionUnknownRisk ?? 0);
    return {
      action: `Classify behavior differences for proposal ${latestPendingBehaviorDecision.proposalId}.`,
      command: `migration-guard diff list --run latest --compare ${latestPendingBehaviorDecision.behaviorComparePath}`,
      reason: `${pendingCount} risk difference(s) are pending or unknown`,
      evidence: [
        latestPendingBehaviorDecision.behaviorComparePath,
        latestPendingBehaviorDecision.reportPath
      ]
    };
  }

  const readyReplanTask = getReadyTasks(pkg.graph)
    .filter((task) => task.type === "replan")
    .sort((a, b) => a.priority - b.priority)[0];
  if (readyReplanTask) {
    return {
      action: `Run replan task ${readyReplanTask.id}.`,
      command: `migration-guard task run --run latest --task ${readyReplanTask.id}`,
      reason: "a replan task is ready",
      evidence: readyReplanTask.issueId ? [readyReplanTask.issueId] : undefined
    };
  }

  const readyTask = getReadyTasks(pkg.graph).sort((a, b) => a.priority - b.priority)[0];
  if (readyTask) {
    return {
      action: `Run ready task ${readyTask.id}.`,
      command: `migration-guard task run --run latest --task ${readyTask.id}`,
      reason: readyTask.title,
      evidence: readyTask.issueId ? [readyTask.issueId] : undefined
    };
  }

  if (pkg.graph.tasks.length > 0 && pkg.graph.tasks.every((task) => task.status === "done")) {
    return {
      action: "Generate the final migration report.",
      command: "migration-guard report --run latest",
      reason: "all tasks are done"
    };
  }

  return {
    action: "No runnable next action.",
    reason: "no failed proposal, replan task, or ready task was found"
  };
}

function latestRetryProposalFor(proposals: ProposedPatch[], sourceProposalId: string): ProposedPatch | undefined {
  return proposals
    .filter((proposal) => proposal.retryOfProposalId === sourceProposalId && proposal.applyState !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function nextActionForRetryProposal(
  proposal: ProposedPatch,
  gate: ProposalGateSummary,
  batch?: ProposalBatchSummary
): MigrationRunNextAction {
  const evidence = [
    proposal.patchPath,
    proposal.replanBriefPath,
    proposal.replanContextPath,
    gate.reportPath,
    batch?.reportPath
  ].filter((item): item is string => Boolean(item));
  if (proposal.applyState === "verified") {
    return {
      action: `Apply verified retry proposal ${proposal.id}.`,
      command: `migration-guard action apply --run latest --proposal ${proposal.id} --rollback-on-fail`,
      reason: `retry proposal for ${proposal.retryOfProposalId ?? gate.proposalId} is verified`,
      evidence
    };
  }
  if (proposal.applyState === "applied-with-failed-checks" || proposal.applyState === "rolled-back" || proposal.applyState === "rollback-failed") {
    return {
      action: `Replan retry proposal ${proposal.id}.`,
      command: `migration-guard proposal replan --run latest --proposal ${proposal.id}`,
      reason: `retry proposal state is ${proposal.applyState}`,
      evidence
    };
  }
  if (proposal.applyState === "applied") {
    return {
      action: `Review retry proposal ${proposal.id} result in the run report.`,
      command: "migration-guard report --run latest",
      reason: "retry proposal has been applied",
      evidence
    };
  }
  return {
    action: `Verify retry proposal ${proposal.id}.`,
    command: `migration-guard proposal verify --run latest --proposal ${proposal.id} --checks`,
    reason: `retry proposal for ${proposal.retryOfProposalId ?? gate.proposalId} is ready`,
    evidence
  };
}

function renderNextActionTextLines(nextAction?: MigrationRunNextAction): string[] {
  if (!nextAction) {
    return ["Next action: unknown"];
  }
  return [
    `Next action: ${nextAction.action}`,
    nextAction.command ? `Next command: ${nextAction.command}` : undefined,
    nextAction.reason ? `Next reason: ${nextAction.reason}` : undefined,
    nextAction.retryCommand ? `Retry command: ${nextAction.retryCommand}` : undefined,
    nextAction.evidence && nextAction.evidence.length > 0 ? `Next evidence: ${nextAction.evidence.join(", ")}` : undefined
  ].filter((line): line is string => Boolean(line));
}

function renderNextActionMarkdownLines(nextAction: MigrationRunNextAction): string[] {
  return [
    `- Action: ${nextAction.action}`,
    nextAction.command ? `- Command: \`${nextAction.command}\`` : undefined,
    nextAction.reason ? `- Reason: ${nextAction.reason}` : undefined,
    nextAction.retryCommand ? `- Retry command: \`${nextAction.retryCommand}\`` : undefined,
    ...(nextAction.evidence?.length ? [
      "- Evidence:",
      ...nextAction.evidence.map((item) => `  - ${item}`)
    ] : [])
  ].filter((line): line is string => Boolean(line));
}

export function syncIssueStatuses(pkg: MigrationRunPackage): void {
  for (const issue of pkg.issues) {
    if (!issue.taskId) {
      continue;
    }
    const task = pkg.graph.tasks.find((candidate) => candidate.id === issue.taskId);
    if (!task) {
      continue;
    }
    issue.status = task.status;
    issue.updatedAt = new Date().toISOString();
  }
}

export function setRunStatus(pkg: MigrationRunPackage, status: MigrationRun["status"]): void {
  pkg.run.status = status;
  pkg.run.updatedAt = new Date().toISOString();
}

export function createFailureIssue(pkg: MigrationRunPackage, taskId: string, title: string, body: string): MigrationIssue {
  const now = new Date().toISOString();
  const issue: MigrationIssue = {
    id: createId("issue"),
    runId: pkg.run.id,
    taskId,
    type: "failure",
    title,
    body,
    status: "failed",
    risk: "high",
    owner: "engine",
    affectedFiles: pkg.graph.tasks.find((task) => task.id === taskId)?.affectedFiles ?? [],
    createdAt: now,
    updatedAt: now
  };
  pkg.issues.push(issue);
  return issue;
}

export function createProposalFailureIssue(
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  report: ProposalVerificationReport
): MigrationIssue {
  const failedChecks = report.checks.filter((check) => !check.passed);
  const firstFailedCheck = failedChecks[0];
  const now = new Date().toISOString();
  const issue: MigrationIssue = {
    id: createId("issue"),
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "failure",
    title: `Proposal gate failed: ${proposal.title}`,
    body: [
      `Proposal: ${proposal.id}`,
      `Report: ${report.outputPath}`,
      `Patch check: ${report.patchCheck.passed ? "passed" : "failed"}`,
      report.preview ? `Preview: ${report.preview.ready ? "ready" : "failed"} ${report.preview.url}` : "Preview: not managed",
      firstFailedCheck ? `First failed check: ${firstFailedCheck.command}` : undefined,
      firstFailedCheck?.kind ? `Check kind: ${firstFailedCheck.kind}` : undefined,
      firstFailedCheck?.phase ? `Check phase: ${firstFailedCheck.phase}` : undefined,
      firstFailedCheck?.failureCategory ? `Failure category: ${firstFailedCheck.failureCategory}` : undefined,
      ...(report.behaviorDrift?.differences.length ? [
        "",
        "Behavior drift:",
        `Compare report: ${report.behaviorDrift.compareReportPath}`,
        ...report.behaviorDrift.differences.slice(0, 5).map((difference) => `- ${difference.severity} ${difference.area}/${difference.name}: ${difference.message}`)
      ] : []),
      ...(firstFailedCheck?.remediationHints?.length ? [
        "",
        "Remediation hints:",
        ...firstFailedCheck.remediationHints.map((hint) => `- ${hint}`)
      ] : [])
    ].filter(Boolean).join("\n"),
    status: "failed",
    risk: proposal.risk === "low" ? "medium" : proposal.risk,
    owner: "engine",
    affectedFiles: proposal.affectedFiles,
    createdAt: now,
    updatedAt: now
  };
  pkg.issues.push(issue);
  return issue;
}

export function createProposalReplanTask(
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  report: ProposalVerificationReport,
  failureIssueId?: string
): MigrationTask {
  const taskId = `task-replan-${proposal.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const existing = pkg.graph.tasks.find((task) => task.id === taskId);
  if (existing) {
    return existing;
  }

  const firstFailedCheck = report.checks.find((check) => !check.passed);
  const now = new Date().toISOString();
  const task: MigrationTask = {
    id: taskId,
    title: `Replan failed proposal ${proposal.id}`,
    description: [
      `Proposal gate failed for ${proposal.title}.`,
      `Report: ${report.outputPath}`,
      firstFailedCheck ? `First failed check: ${firstFailedCheck.command}` : undefined,
      firstFailedCheck?.kind ? `Kind: ${firstFailedCheck.kind}` : undefined,
      firstFailedCheck?.phase ? `Phase: ${firstFailedCheck.phase}` : undefined,
      firstFailedCheck?.failureCategory ? `Failure category: ${firstFailedCheck.failureCategory}` : undefined,
      ...(report.behaviorDrift?.differences.length ? [
        "",
        "Behavior drift:",
        `Compare report: ${report.behaviorDrift.compareReportPath}`,
        ...report.behaviorDrift.differences.slice(0, 5).map((difference) => `- ${difference.severity} ${difference.area}/${difference.name}: ${difference.message}`)
      ] : []),
      ...(firstFailedCheck?.remediationHints?.length ? [
        "",
        "Remediation hints:",
        ...firstFailedCheck.remediationHints.map((hint) => `- ${hint}`)
      ] : []),
      failureIssueId ? `Failure issue: ${failureIssueId}` : undefined
    ].filter(Boolean).join("\n"),
    type: "replan",
    status: "ready",
    priority: 85,
    risk: proposal.risk,
    owner: "engine",
    dependsOn: [],
    affectedFiles: proposal.affectedFiles,
    verificationCommands: proposal.recommendedChecks,
    acceptanceCriteria: [
      "failed gate has a remediation plan",
      "proposal can be retried or explicitly accepted as blocked"
    ],
    executor: "manual",
    result: `Created from proposal ${proposal.id}`,
    createdAt: now,
    updatedAt: now
  };
  pkg.graph.tasks.push(task);

  const issue: MigrationIssue = {
    id: createId("issue"),
    runId: pkg.run.id,
    taskId: task.id,
    type: "task",
    title: task.title,
    body: task.description,
    status: task.status,
    risk: task.risk,
    owner: task.owner,
    affectedFiles: task.affectedFiles,
    createdAt: now,
    updatedAt: now
  };
  pkg.issues.push(issue);
  task.issueId = issue.id;
  return task;
}

export function createId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readLatestRunId(loaded: LoadedConfig): Promise<string> {
  const latestPath = latestMigrationRunPath(loaded);
  if (!await pathExists(latestPath)) {
    throw new Error("No migration run found. Run `migration-guard run --init-only` first.");
  }
  const latest = await readJsonFile<{ runId: string }>(latestPath);
  return latest.runId;
}

function createIssuesForRun(run: MigrationRun, graph: MigrationTaskGraph): MigrationIssue[] {
  const now = new Date().toISOString();
  const issues: MigrationIssue[] = [
    {
      id: createId("issue"),
      runId: run.id,
      type: "epic",
      title: `Migration Run: ${run.goal}`,
      body: `Source: ${run.sourceRoot}\nTarget: ${run.targetRoot}`,
      status: "open",
      risk: run.estimate.riskLevel,
      owner: "engine",
      affectedFiles: [],
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const task of graph.tasks) {
    issues.push({
      id: createId("issue"),
      runId: run.id,
      taskId: task.id,
      type: "task",
      title: task.title,
      body: task.description,
      status: task.status,
      risk: task.risk,
      owner: task.owner,
      affectedFiles: task.affectedFiles,
      createdAt: now,
      updatedAt: now
    });
  }

  return issues;
}

function countTasks(graph: MigrationTaskGraph): Record<MigrationTaskStatus, number> {
  const result = {
    discovered: 0,
    planned: 0,
    ready: 0,
    running: 0,
    changed: 0,
    verifying: 0,
    failed: 0,
    replanned: 0,
    blocked: 0,
    "rolled-back": 0,
    "accepted-diff": 0,
    done: 0
  };

  for (const task of graph.tasks) {
    result[task.status] += 1;
  }

  return result;
}

function formatTaskCounts(counts: Record<MigrationTaskStatus, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}:${count}`)
    .join(", ") || "none";
}

async function readProposalSummaries(loaded: LoadedConfig, runId: string): Promise<ProposedPatch[]> {
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
    const proposalPath = path.join(proposalsDir, entry.name, "proposal.json");
    if (await pathExists(proposalPath)) {
      proposals.push(await readJsonFile<ProposedPatch>(proposalPath));
    }
  }

  return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function readRecentProposalGateSummaries(
  loaded: LoadedConfig,
  runId: string
): Promise<ProposalGateSummary[]> {
  const proposalsDir = path.join(migrationRunDir(loaded, runId), "proposals");
  if (!await pathExists(proposalsDir)) {
    return [];
  }

  const entries = await fs.readdir(proposalsDir, { withFileTypes: true });
  const reports: ProposalVerificationReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const proposalDir = path.join(proposalsDir, entry.name);
    const files = await fs.readdir(proposalDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith("verification-") || !file.name.endsWith(".json")) {
        continue;
      }
      reports.push(await readJsonFile<ProposalVerificationReport>(path.join(proposalDir, file.name)));
    }
  }

  return Promise.all(reports
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-10)
    .map(async (report) => {
      const failed = report.checks.find((check) => !check.passed);
      const behaviorComparePath = report.behaviorDiff?.compareReportPath ?? report.behaviorDrift?.compareReportPath;
      const policy = await decisionPolicyForCompareReportPath(loaded, runId, behaviorComparePath);
      return {
        proposalId: report.proposalId,
        createdAt: report.createdAt,
        passed: report.passed,
        checks: report.checks.length,
        timeline: report.timeline?.length ?? 0,
        reportPath: report.outputPath,
        replanIssueId: report.replanIssueId,
        replanTaskId: report.replanTaskId,
        replanBriefPath: report.replanBriefPath,
        replanContextPath: report.replanContextPath,
        failureCategory: failed?.failureCategory,
        remediationHint: failed?.remediationHints?.[0],
        behaviorDriftCount: report.behaviorDrift?.differences.length,
        firstBehaviorDrift: report.behaviorDrift?.differences[0]
          ? `${report.behaviorDrift.differences[0].area}/${report.behaviorDrift.differences[0].name}: ${report.behaviorDrift.differences[0].message}`
          : undefined,
        behaviorComparePath,
        behaviorDiffPath: report.behaviorDiff?.compareReportPath,
        behaviorDiffPassed: report.behaviorDiff?.passed,
        behaviorDiffErrors: report.behaviorDiff?.errorCount,
        behaviorDiffWarnings: report.behaviorDiff?.warningCount,
        behaviorDecisionStatus: policy?.status,
        behaviorDecisionCanContinue: policy?.canContinue,
        behaviorDecisionSummary: policy ? formatPolicyLine(policy) : undefined,
        behaviorDecisionPendingRisk: policy?.pendingRisk,
        behaviorDecisionAccidentalRisk: policy?.accidentalRisk,
        behaviorDecisionUnknownRisk: policy?.unknownRisk
      };
    }));
}

async function readRecentProposalBatchSummaries(
  loaded: LoadedConfig,
  runId: string
): Promise<ProposalBatchSummary[]> {
  const batchesDir = path.join(migrationRunDir(loaded, runId), "proposal-batches");
  if (!await pathExists(batchesDir)) {
    return [];
  }

  const entries = await fs.readdir(batchesDir, { withFileTypes: true });
  const reports: ProposalBatchReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const batchDir = path.join(batchesDir, entry.name);
    const files = await fs.readdir(batchDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith("proposal-batch-report-") || !file.name.endsWith(".json")) {
        continue;
      }
      reports.push(await readJsonFile<ProposalBatchReport>(path.join(batchDir, file.name)));
    }
  }

  return reports
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-10)
    .map((report) => ({
      id: report.id,
      createdAt: report.createdAt,
      passed: report.passed,
      gatePolicy: report.gatePolicy?.mode,
      executedCount: report.executedCount,
      skippedCount: report.skippedCount,
      reportPath: report.outputPath,
      firstFailedVerificationPath: report.firstFailedVerificationPath,
      stopReason: report.stopReason,
      nextCommand: report.nextCommand,
      skippedProposals: report.skipped.map((item) => item.proposalId),
      recommendedNextActions: report.recommendedNextActions
    }));
}
