import { promises as fs } from "node:fs";
import path from "node:path";
import { renderMigrationPlan } from "./plan.js";
import { assessRefactorReadiness } from "./refactorReadiness.js";
import { scanProject } from "./scan.js";
import { createEstimate, createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import { decisionPolicyForCompareReportPath, formatPolicyLine } from "./diffDecision.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import type {
  EvidenceEvent,
  LoadedConfig,
  MigrationActionCheckReadiness,
  MigrationActionPlan,
  MigrationAutomationMode,
  MigrationIssue,
  MigrationRun,
  MigrationTask,
  MigrationTaskGraph,
  MigrationTaskStatus,
  ProposalBatchReport,
  ProposalRepairAcceptanceReport,
  ProposalVerificationReport,
  ProposedPatch,
  RefactorReadinessReport
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

export interface MigrationRunIndexEntry {
  runId: string;
  goal: string;
  status: MigrationRun["status"];
  mode: MigrationRun["mode"];
  adapter?: string;
  targetRoot: string;
  createdAt: string;
  updatedAt: string;
  latestCheckpointId?: string;
  latestBaselineId?: string;
  latestVerificationId?: string;
  taskSummary: Record<string, number>;
  issueSummary: Record<string, number>;
  estimate: {
    taskCount: number;
    riskLevel: MigrationRun["estimate"]["riskLevel"];
    confidence: MigrationRun["estimate"]["confidence"];
  };
}

export interface MigrationRunIndex {
  version: 1;
  updatedAt: string;
  latestRunId?: string;
  runCount: number;
  runs: MigrationRunIndexEntry[];
}

export interface MigrationRunNextAction {
  action: string;
  command?: string;
  reason?: string;
  evidence?: string[];
  retryCommand?: string;
  actionCheckReadiness?: ActionCheckReadinessSummary;
}

export interface ActionCheckReadinessFinding {
  actionId: string;
  actionTitle: string;
  command: string;
  status: MigrationActionCheckReadiness["status"];
  reason: string;
  affectedFiles: string[];
}

export interface ActionCheckReadinessMissing {
  actionId: string;
  actionTitle: string;
  command: string;
  reason: string;
  affectedFiles: string[];
}

export interface ActionCheckReadinessSummary {
  actionPlanPath: string;
  handoffJsonPath: string;
  handoffMarkdownPath: string;
  actionCount: number;
  recommendedCheckCount: number;
  trackedCheckCount: number;
  checksWithoutReadiness: number;
  readyCount: number;
  noOpRiskCount: number;
  unknownCount: number;
  findings: ActionCheckReadinessFinding[];
  missingReadiness: ActionCheckReadinessMissing[];
}

export type ActionCheckReadinessHandoffItemStatus = "no-op-risk" | "unknown" | "missing-metadata";

export interface ActionCheckReadinessHandoffItem {
  actionId: string;
  actionTitle: string;
  command: string;
  status: ActionCheckReadinessHandoffItemStatus;
  reason: string;
  recommendedAction: string;
  affectedFiles: string[];
  taskId?: string;
  issueId?: string;
  repairBriefPath?: string;
  repairContextPath?: string;
}

export interface ActionCheckReadinessHandoff {
  version: 1;
  runId: string;
  createdAt: string;
  goal: string;
  actionPlanPath: string;
  markdownPath: string;
  jsonPath: string;
  summary: {
    actionCount: number;
    recommendedCheckCount: number;
    trackedCheckCount: number;
    checksWithoutReadiness: number;
    readyCount: number;
    noOpRiskCount: number;
    unknownCount: number;
    attentionItemCount: number;
    replanTaskCount: number;
    repairBriefCount: number;
  };
  blockedBeforeProposal: boolean;
  items: ActionCheckReadinessHandoffItem[];
  recommendedNextActions: string[];
}

export interface WriteActionCheckReadinessHandoffOptions {
  createReplans?: boolean;
  writeRepairBriefs?: boolean;
}

export interface ActionCheckReadinessRepairContext {
  version: 1;
  run: {
    id: string;
    goal: string;
    targetRoot: string;
    adapter?: string;
  };
  item: ActionCheckReadinessHandoffItem;
  task?: MigrationTask;
  issue?: MigrationIssue;
  paths: {
    handoffJson: string;
    handoffMarkdown: string;
    actionPlan: string;
    brief: string;
    context: string;
  };
  commands: {
    refreshHandoff: string;
    inspectActions: string;
    proposeAction: string;
  };
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
  excludedCount: number;
  reportPath: string;
  firstFailedProposalId?: string;
  firstFailedVerificationPath?: string;
  stopReason?: string;
  nextCommand?: string;
  skippedProposals: string[];
  excludedProposals: string[];
  recommendedNextActions?: string[];
}

interface ProposalRepairAcceptanceSummary {
  id: string;
  createdAt: string;
  accepted: boolean;
  sourceProposalId: string;
  retryProposalId: string;
  retryVerificationPath: string;
  outputPath: string;
  checklistCount: number;
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

export function migrationRunIndexPath(loaded: LoadedConfig): string {
  return path.join(migrationRunsDir(loaded), "run-index.json");
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
    policyHash: loaded.policy?.hash,
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
  await updateMigrationRunIndex(loaded, pkg);
}

export async function loadMigrationRunIndex(loaded: LoadedConfig): Promise<MigrationRunIndex | undefined> {
  const filePath = migrationRunIndexPath(loaded);
  if (!await pathExists(filePath)) {
    return undefined;
  }
  return readJsonFile<MigrationRunIndex>(filePath);
}

async function updateMigrationRunIndex(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<void> {
  const existing = await loadMigrationRunIndex(loaded);
  const entry = createMigrationRunIndexEntry(pkg);
  const runs = [
    entry,
    ...(existing?.runs ?? []).filter((item) => item.runId !== pkg.run.id)
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latestRunId = await readLatestRunIdIfPresent(loaded) ?? pkg.run.id;
  await writeJsonFile(migrationRunIndexPath(loaded), {
    version: 1,
    updatedAt: new Date().toISOString(),
    latestRunId,
    runCount: runs.length,
    runs
  });
}

function createMigrationRunIndexEntry(pkg: MigrationRunPackage): MigrationRunIndexEntry {
  return {
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
  };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
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
    ...renderActionCheckReadinessTextLines(nextAction?.actionCheckReadiness),
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
  const actionCheckReadiness = await readActionCheckReadinessSummary(loaded, pkg);
  return withActionCheckReadiness(
    selectRunNextAction(pkg, proposals, proposalGates, proposalBatches, actionCheckReadiness),
    actionCheckReadiness
  );
}

export async function renderRunReport(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const evidence = await readEvidence(loaded, pkg.run.id);
  const counts = countTasks(pkg.graph);
  const openIssues = pkg.issues.filter((issue) => issue.status !== "closed" && issue.status !== "done");
  const graphErrors = validateTaskGraph(pkg.graph);
  const proposals = await readProposalSummaries(loaded, pkg.run.id);
  const proposalGates = await readRecentProposalGateSummaries(loaded, pkg.run.id);
  const proposalBatches = await readRecentProposalBatchSummaries(loaded, pkg.run.id);
  const repairAcceptances = await readRecentProposalRepairAcceptanceSummaries(loaded, pkg.run.id);
  const actionCheckReadiness = await readActionCheckReadinessSummary(loaded, pkg);
  const refactorReadiness = await assessRefactorReadiness(loaded, pkg);
  const nextAction = withActionCheckReadiness(
    selectRunNextAction(pkg, proposals, proposalGates, proposalBatches, actionCheckReadiness),
    actionCheckReadiness
  );
  const latestBehaviorDecision = [...proposalGates].reverse().find((gate) => gate.behaviorDecisionSummary);

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
    latestBehaviorDecision?.behaviorDecisionSummary ? `- Behavior decision gate: ${latestBehaviorDecision.behaviorDecisionSummary}` : undefined,
    "",
    "## Next Action",
    "",
    ...renderNextActionMarkdownLines(nextAction),
    "",
    "## Refactor Readiness",
    "",
    ...renderRefactorReadinessMarkdownLines(refactorReadiness),
    "",
    "## Action Check Readiness",
    "",
    ...renderActionCheckReadinessMarkdownLines(actionCheckReadiness),
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
    "## Evidence Graph",
    "",
    ...renderEvidenceGraphLines(proposals, proposalGates, proposalBatches, repairAcceptances),
    "",
    "## Proposals",
    "",
    proposals.length > 0
      ? proposals.map((proposal) => renderProposalCompactSummary(proposal, proposalGates, proposalBatches, repairAcceptances)).join("\n")
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
        batch.skippedProposals.length > 0 ? `  failure-skipped:${batch.skippedProposals.join(", ")}` : undefined,
        batch.excludedProposals.length > 0 ? `  excluded:${batch.excludedProposals.join(", ")}` : undefined,
        batch.excludedCount > 0 ? `  excluded-count:${batch.excludedCount}` : undefined,
        ...(batch.recommendedNextActions ?? []).map((action) => `  recommended:${action}`)
      ].filter(Boolean).join("\n")).join("\n")
      : "No proposal batch reports.",
    "",
    "## Recent Repair Acceptances",
    "",
    repairAcceptances.length > 0
      ? repairAcceptances.map((acceptance) => [
        `- ${acceptance.createdAt} ${acceptance.id} ${acceptance.accepted ? "accepted" : "needs-work"} source:${acceptance.sourceProposalId} retry:${acceptance.retryProposalId}`,
        `  retry-verification:${acceptance.retryVerificationPath}`,
        `  checklist:${acceptance.checklistCount}`,
        `  report:${acceptance.outputPath}`
      ].join("\n")).join("\n")
      : "No repair acceptance reports.",
    "",
    "## Evidence",
    "",
    ...evidence.slice(-20).map((event) => `- ${event.createdAt} [${event.type}] ${event.message}`)
  ].join("\n");
}

function renderEvidenceGraphLines(
  proposals: ProposedPatch[],
  gates: ProposalGateSummary[],
  batches: ProposalBatchSummary[],
  repairAcceptances: ProposalRepairAcceptanceSummary[] = []
): string[] {
  if (proposals.length === 0 && gates.length === 0 && batches.length === 0 && repairAcceptances.length === 0) {
    return ["- No proposal evidence yet."];
  }
  const lines: string[] = [];
  for (const batch of batches.slice(-5)) {
    lines.push(`- batch:${batch.id} -> results:${batch.executedCount} failure-skipped:${batch.skippedCount} excluded:${batch.excludedCount} -> ${batch.passed ? "passed" : "next action required"}`);
    if (batch.firstFailedProposalId) {
      lines.push(`  failed-proposal:${batch.firstFailedProposalId}${batch.nextCommand ? ` next:${batch.nextCommand}` : ""}`);
    }
  }
  for (const gate of gates.slice(-5)) {
    lines.push(`- proposal:${gate.proposalId} -> gate:${gate.passed ? "passed" : "failed"} checks:${gate.checks}${gate.failureCategory ? ` failure:${gate.failureCategory}` : ""}${gate.behaviorDecisionStatus ? ` behavior:${gate.behaviorDecisionStatus}` : ""}`);
    if (gate.replanIssueId || gate.replanTaskId) {
      lines.push(`  replan:${gate.replanIssueId ?? "none"} task:${gate.replanTaskId ?? "none"}`);
    }
  }
  for (const acceptance of repairAcceptances.slice(-5)) {
    lines.push(`- repair:${acceptance.id} -> ${acceptance.accepted ? "accepted" : "needs-work"} source:${acceptance.sourceProposalId} retry:${acceptance.retryProposalId}`);
  }
  if (lines.length === 0) {
    for (const proposal of proposals.slice(-5)) {
      lines.push(`- proposal:${proposal.id} -> state:${proposal.applyState}${proposal.exclusion?.reason ? ` excluded:${proposal.exclusion.reason}` : ""}${proposal.retryOfProposalId ? ` retry-of:${proposal.retryOfProposalId}` : ""}`);
    }
  }
  return lines;
}

function renderProposalCompactSummary(
  proposal: ProposedPatch,
  gates: ProposalGateSummary[],
  batches: ProposalBatchSummary[],
  repairAcceptances: ProposalRepairAcceptanceSummary[] = []
): string {
  const gate = [...gates].reverse().find((candidate) => candidate.proposalId === proposal.id);
  const batch = [...batches].reverse().find((candidate) => {
    return candidate.firstFailedProposalId === proposal.id
      || candidate.skippedProposals.includes(proposal.id)
      || candidate.excludedProposals.includes(proposal.id);
  });
  const details = [
    proposal.retryOfProposalId ? `retry-of:${proposal.retryOfProposalId}` : undefined,
    proposal.retrySourceFailureCategory ? `source-failure:${proposal.retrySourceFailureCategory}` : undefined,
    proposal.templateSelection ? `template:${proposal.templateSelection.template}` : undefined,
    proposal.exclusion?.reason ? `excluded:${proposal.exclusion.reason}` : undefined,
    proposal.exclusion?.supersededBy ? `superseded-by:${proposal.exclusion.supersededBy}` : undefined,
    gate ? `gate:${gate.passed ? "passed" : gate.failureCategory ?? "failed"}` : undefined,
    gate?.behaviorDecisionStatus ? `behavior:${gate.behaviorDecisionStatus}` : undefined,
    batch?.id ? `batch:${batch.id}` : undefined,
    proposal.lastAcceptancePath ? `acceptance:${proposal.lastAcceptancePath}` : undefined,
    repairAcceptances.some((acceptance) => acceptance.retryProposalId === proposal.id || acceptance.sourceProposalId === proposal.id) ? "repair:accepted" : undefined,
    proposal.replanBriefPath ? `next:retry-from-brief` : undefined
  ].filter(Boolean).join(" ");
  return `- ${proposal.id} [${proposal.applyState}/${proposal.risk}] ${proposal.title}${details ? ` (${details})` : ""}`;
}

export async function writeRunReport(loaded: LoadedConfig, pkg: MigrationRunPackage, name = "latest-report.md"): Promise<string> {
  const report = await renderRunReport(loaded, pkg);
  const reportPath = path.join(migrationRunDir(loaded, pkg.run.id), "reports", name);
  await writeTextFile(reportPath, report);
  await writeActionCheckReadinessHandoff(loaded, pkg);
  pkg.run.finalReportPath = reportPath;
  await saveRunPackage(loaded, pkg);
  return reportPath;
}

export async function writeActionCheckReadinessHandoff(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  options: WriteActionCheckReadinessHandoffOptions = {}
): Promise<ActionCheckReadinessHandoff | undefined> {
  const summary = await readActionCheckReadinessSummary(loaded, pkg);
  if (!summary) {
    return undefined;
  }
  const handoff = createActionCheckReadinessHandoff(pkg, summary);
  if (options.createReplans || options.writeRepairBriefs) {
    ensureActionCheckReadinessReplanTasks(pkg, handoff);
    await saveRunPackage(loaded, pkg);
  }
  if (options.writeRepairBriefs) {
    await writeActionCheckReadinessRepairBriefs(loaded, pkg, handoff);
  }
  await writeJsonFile(summary.handoffJsonPath, handoff);
  await writeTextFile(summary.handoffMarkdownPath, renderActionCheckReadinessHandoffMarkdown(handoff));
  return handoff;
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
  batches: ProposalBatchSummary[],
  actionCheckReadiness?: ActionCheckReadinessSummary
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

  const actionCheckReadinessAction = nextActionForActionCheckReadiness(actionCheckReadiness);
  if (actionCheckReadinessAction) {
    return actionCheckReadinessAction;
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

function nextActionForActionCheckReadiness(summary?: ActionCheckReadinessSummary): MigrationRunNextAction | undefined {
  if (!summary || summary.noOpRiskCount === 0) {
    return undefined;
  }
  const firstRisk = summary.findings.find((finding) => finding.status === "no-op-risk");
  return {
    action: "Fix no-op-risk action checks before generating proposals.",
    command: "migration-guard actions --run latest",
    reason: firstRisk
      ? `${summary.noOpRiskCount} recommended check(s) may no-op; first: ${firstRisk.actionId} ${firstRisk.command} (${firstRisk.reason})`
      : `${summary.noOpRiskCount} recommended check(s) may no-op`,
    evidence: [summary.handoffMarkdownPath, summary.handoffJsonPath, summary.actionPlanPath]
  };
}

function withActionCheckReadiness(
  nextAction: MigrationRunNextAction,
  actionCheckReadiness?: ActionCheckReadinessSummary
): MigrationRunNextAction {
  if (!actionCheckReadiness) {
    return nextAction;
  }
  return {
    ...nextAction,
    actionCheckReadiness
  };
}

function latestRetryProposalFor(proposals: ProposedPatch[], sourceProposalId: string): ProposedPatch | undefined {
  return proposals
    .filter((proposal) => proposal.retryOfProposalId === sourceProposalId && proposal.applyState !== "rejected" && proposal.applyState !== "ignored")
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

function renderActionCheckReadinessTextLines(summary?: ActionCheckReadinessSummary): string[] {
  if (!summary) {
    return [];
  }
  const firstRisk = summary.findings.find((finding) => finding.status === "no-op-risk");
  return [
    `Action check readiness: actions:${summary.actionCount} checks:${summary.recommendedCheckCount} tracked:${summary.trackedCheckCount} ready:${summary.readyCount} no-op-risk:${summary.noOpRiskCount} unknown:${summary.unknownCount}`,
    summary.checksWithoutReadiness > 0 ? `Action check readiness missing: ${summary.checksWithoutReadiness}` : undefined,
    `Action check handoff: ${summary.handoffMarkdownPath}`,
    firstRisk ? `Action check risk: ${firstRisk.actionId} ${firstRisk.command} (${firstRisk.reason})` : undefined
  ].filter((line): line is string => Boolean(line));
}

function renderActionCheckReadinessMarkdownLines(summary?: ActionCheckReadinessSummary): string[] {
  if (!summary) {
    return ["No action plan found."];
  }
  const riskFindings = summary.findings.filter((finding) => finding.status === "no-op-risk");
  const unknownFindings = summary.findings.filter((finding) => finding.status === "unknown");
  return [
    `- Action plan: ${summary.actionPlanPath}`,
    `- Handoff JSON: ${summary.handoffJsonPath}`,
    `- Handoff Markdown: ${summary.handoffMarkdownPath}`,
    `- Actions: ${summary.actionCount}`,
    `- Checks: ${summary.recommendedCheckCount} recommended, ${summary.trackedCheckCount} readiness-tracked`,
    `- Status counts: ready:${summary.readyCount}, no-op-risk:${summary.noOpRiskCount}, unknown:${summary.unknownCount}`,
    summary.checksWithoutReadiness > 0 ? `- Missing readiness metadata: ${summary.checksWithoutReadiness} check(s)` : undefined,
    ...(riskFindings.length > 0 ? [
      "- No-op-risk checks:",
      ...riskFindings.slice(0, 5).map((finding) => `  - ${finding.actionId}: \`${finding.command}\` (${finding.reason})`)
    ] : []),
    ...(unknownFindings.length > 0 ? [
      "- Unknown checks:",
      ...unknownFindings.slice(0, 5).map((finding) => `  - ${finding.actionId}: \`${finding.command}\` (${finding.reason})`)
    ] : []),
    ...(summary.missingReadiness.length > 0 ? [
      "- Missing readiness metadata:",
      ...summary.missingReadiness.slice(0, 5).map((finding) => `  - ${finding.actionId}: \`${finding.command}\` (${finding.reason})`)
    ] : [])
  ].filter((line): line is string => Boolean(line));
}

function renderRefactorReadinessMarkdownLines(report: RefactorReadinessReport): string[] {
  const blocking = report.criteria.filter((criterion) => criterion.status === "blocked");
  const warnings = report.criteria.filter((criterion) => criterion.status === "warning");
  return [
    `- Status: ${report.status}`,
    `- Mode: ${report.mode}`,
    `- Blockers: ${report.summary.blockerCount}`,
    `- Warnings: ${report.summary.warningCount}`,
    `- Proposals: ${report.summary.proposalCount}`,
    `- Batches: ${report.summary.batchCount}`,
    `- Latest passing batch: ${report.summary.latestPassingBatchId ?? "none"}`,
    `- Target clean: ${report.summary.targetClean === undefined ? "not checked" : report.summary.targetClean ? "yes" : "no"}`,
    ...(blocking.length > 0 ? [
      "- Blocking criteria:",
      ...blocking.slice(0, 6).map((criterion) => `  - ${criterion.id}: ${criterion.summary}`)
    ] : []),
    ...(warnings.length > 0 ? [
      "- Warnings:",
      ...warnings.slice(0, 4).map((criterion) => `  - ${criterion.id}: ${criterion.summary}`)
    ] : []),
    ...(report.recommendedNextActions.length > 0 ? [
      "- Recommended next actions:",
      ...report.recommendedNextActions.slice(0, 5).map((action) => `  - ${action}`)
    ] : [])
  ];
}

function createActionCheckReadinessHandoff(
  pkg: MigrationRunPackage,
  summary: ActionCheckReadinessSummary
): ActionCheckReadinessHandoff {
  const items = createActionCheckReadinessHandoffItems(summary);
  return {
    version: 1,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    goal: pkg.run.goal,
    actionPlanPath: summary.actionPlanPath,
    markdownPath: summary.handoffMarkdownPath,
    jsonPath: summary.handoffJsonPath,
    summary: {
      actionCount: summary.actionCount,
      recommendedCheckCount: summary.recommendedCheckCount,
      trackedCheckCount: summary.trackedCheckCount,
      checksWithoutReadiness: summary.checksWithoutReadiness,
      readyCount: summary.readyCount,
      noOpRiskCount: summary.noOpRiskCount,
      unknownCount: summary.unknownCount,
      attentionItemCount: items.length,
      replanTaskCount: 0,
      repairBriefCount: 0
    },
    blockedBeforeProposal: summary.noOpRiskCount > 0,
    items,
    recommendedNextActions: createActionCheckReadinessNextActions(summary)
  };
}

function createActionCheckReadinessHandoffItems(summary: ActionCheckReadinessSummary): ActionCheckReadinessHandoffItem[] {
  const items: ActionCheckReadinessHandoffItem[] = [];
  for (const finding of summary.findings) {
    if (finding.status === "no-op-risk" || finding.status === "unknown") {
      items.push({
        actionId: finding.actionId,
        actionTitle: finding.actionTitle,
        command: finding.command,
        status: finding.status,
        reason: finding.reason,
        recommendedAction: finding.status === "no-op-risk"
          ? "Replace the recommended check with a command that definitely runs for the target package, or use --allow-no-op-risk only after explicit review."
          : "Inspect the command manually and add a more specific readiness classifier or safer recommended check.",
        affectedFiles: finding.affectedFiles
      });
    }
  }
  for (const finding of summary.missingReadiness) {
    items.push({
      actionId: finding.actionId,
      actionTitle: finding.actionTitle,
      command: finding.command,
      status: "missing-metadata" as const,
      reason: finding.reason,
      recommendedAction: "Regenerate the action plan with readiness metadata or add a readiness entry for this recommended check.",
      affectedFiles: finding.affectedFiles
    });
  }
  return items;
}

function ensureActionCheckReadinessReplanTasks(
  pkg: MigrationRunPackage,
  handoff: ActionCheckReadinessHandoff
): void {
  const now = new Date().toISOString();
  for (const item of handoff.items) {
    const taskId = actionCheckReadinessReplanTaskId(item);
    let task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      task = {
        id: taskId,
        title: `Replan action check readiness for ${item.actionId}`,
        description: renderActionCheckReadinessReplanDescription(item, handoff),
        type: "replan",
        status: "ready",
        priority: item.status === "no-op-risk" ? 82 : 72,
        risk: item.status === "no-op-risk" ? "medium" : "low",
        owner: "engine",
        dependsOn: [],
        affectedFiles: item.affectedFiles,
        verificationCommands: ["migration-guard actions handoff --run latest --json"],
        acceptanceCriteria: [
          "readiness handoff no longer lists this action/check attention item",
          "recommended check is ready or explicitly documented as accepted",
          "action propose can continue without relying on a known no-op check"
        ],
        executor: "manual",
        result: `Created from action check readiness handoff ${handoff.jsonPath}`,
        createdAt: now,
        updatedAt: now
      };
      pkg.graph.tasks.push(task);
    }

    let issue = task.issueId
      ? pkg.issues.find((candidate) => candidate.id === task.issueId)
      : undefined;
    if (!issue) {
      issue = {
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
    }

    item.taskId = task.id;
    item.issueId = issue.id;
  }
  handoff.summary.replanTaskCount = handoff.items.filter((item) => item.taskId).length;
}

async function writeActionCheckReadinessRepairBriefs(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  handoff: ActionCheckReadinessHandoff
): Promise<void> {
  for (const item of handoff.items) {
    const task = item.taskId
      ? pkg.graph.tasks.find((candidate) => candidate.id === item.taskId)
      : undefined;
    const issue = item.issueId
      ? pkg.issues.find((candidate) => candidate.id === item.issueId)
      : undefined;
    const itemDir = path.join(migrationRunDir(loaded, pkg.run.id), "replans", "readiness", item.taskId ?? actionCheckReadinessReplanTaskId(item));
    const briefPath = path.join(itemDir, "repair-brief.md");
    const contextPath = path.join(itemDir, "repair-context.json");
    const context: ActionCheckReadinessRepairContext = {
      version: 1,
      run: {
        id: pkg.run.id,
        goal: pkg.run.goal,
        targetRoot: pkg.run.targetRoot,
        adapter: pkg.run.adapter
      },
      item,
      task,
      issue,
      paths: {
        handoffJson: handoff.jsonPath,
        handoffMarkdown: handoff.markdownPath,
        actionPlan: handoff.actionPlanPath,
        brief: briefPath,
        context: contextPath
      },
      commands: {
        refreshHandoff: "migration-guard actions handoff --run latest --create-replans --repair-briefs --json",
        inspectActions: "migration-guard actions --run latest",
        proposeAction: `migration-guard action propose --run latest --action ${item.actionId}`
      }
    };
    await writeJsonFile(contextPath, context);
    await writeTextFile(briefPath, renderActionCheckReadinessRepairBrief(context));
    item.repairBriefPath = briefPath;
    item.repairContextPath = contextPath;
  }
  handoff.summary.repairBriefCount = handoff.items.filter((item) => item.repairBriefPath).length;
}

function actionCheckReadinessReplanTaskId(item: ActionCheckReadinessHandoffItem): string {
  const actionSlug = item.actionId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  const fingerprint = sha256(`${item.status}\n${item.actionId}\n${item.command}`).slice(0, 10);
  return `task-readiness-replan-${actionSlug}-${fingerprint}`;
}

function renderActionCheckReadinessReplanDescription(
  item: ActionCheckReadinessHandoffItem,
  handoff: ActionCheckReadinessHandoff
): string {
  return [
    `Action check readiness needs repair before proposal generation.`,
    `Action: ${item.actionId}`,
    `Action title: ${item.actionTitle}`,
    `Status: ${item.status}`,
    `Command: ${item.command}`,
    `Reason: ${item.reason}`,
    `Recommended action: ${item.recommendedAction}`,
    `Handoff: ${handoff.markdownPath}`,
    `Handoff JSON: ${handoff.jsonPath}`,
    `Action plan: ${handoff.actionPlanPath}`,
    item.affectedFiles.length > 0 ? `Affected files: ${item.affectedFiles.join(", ")}` : undefined
  ].filter(Boolean).join("\n");
}

function renderActionCheckReadinessRepairBrief(context: ActionCheckReadinessRepairContext): string {
  const { item, task, issue } = context;
  return [
    `# Readiness Repair Brief: ${item.actionId}`,
    "",
    "This brief gives an AI or human repair agent the smallest context needed to fix an action check readiness failure.",
    "",
    "## Mission",
    "",
    "- Repair the recommended check readiness problem without weakening proposal gates.",
    "- Keep the change scoped to the action/check plan or the missing command wiring.",
    "- Do not use `--allow-no-op-risk` as the default repair.",
    "- After repair, refresh the readiness handoff and confirm the attention item is gone.",
    "",
    "## Attention Item",
    "",
    `- Action: ${item.actionId}`,
    `- Action title: ${item.actionTitle}`,
    `- Status: ${item.status}`,
    `- Command: \`${item.command}\``,
    `- Reason: ${item.reason}`,
    `- Recommended repair: ${item.recommendedAction}`,
    `- Affected files: ${item.affectedFiles.join(", ") || "none"}`,
    task ? `- Replan task: ${task.id}` : undefined,
    issue ? `- Issue: ${issue.id}` : undefined,
    "",
    "## Evidence",
    "",
    `- Handoff Markdown: ${context.paths.handoffMarkdown}`,
    `- Handoff JSON: ${context.paths.handoffJson}`,
    `- Action plan: ${context.paths.actionPlan}`,
    `- Context JSON: ${context.paths.context}`,
    "",
    "## Repair Guidance",
    "",
    renderActionCheckReadinessRepairGuidance(item),
    "",
    "## Commands",
    "",
    "```bash",
    context.commands.inspectActions,
    context.commands.refreshHandoff,
    context.commands.proposeAction,
    "```",
    "",
    "## Done When",
    "",
    "- The refreshed readiness handoff no longer lists this item.",
    "- The replacement check is `ready`, or the exception is explicitly reviewed and documented.",
    "- `action propose` can run without relying on a known no-op check."
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderActionCheckReadinessRepairGuidance(item: ActionCheckReadinessHandoffItem): string {
  if (item.status === "no-op-risk") {
    return [
      "- Find the package or root script that actually exercises this action's risk.",
      "- Replace the no-op command with a runtime smoke, package script, or root script that must execute.",
      "- Prefer adding a specific script/check over broadening the proposal gate."
    ].join("\n");
  }
  if (item.status === "unknown") {
    return [
      "- Inspect the command manually and decide whether it truly runs a check.",
      "- If the command is safe, add static readiness classification support or rewrite it into a known ready pattern.",
      "- If the command is unsafe or ambiguous, replace it with a clearer recommended check."
    ].join("\n");
  }
  return [
    "- Regenerate the action plan so every recommended check has readiness metadata.",
    "- If regeneration is not possible, add a readiness entry for this command before proposal generation.",
    "- Treat missing metadata as unreviewed, not as accepted."
  ].join("\n");
}

function createActionCheckReadinessNextActions(summary: ActionCheckReadinessSummary): string[] {
  const actions: string[] = [];
  if (summary.noOpRiskCount > 0) {
    actions.push("Fix no-op-risk recommended checks before running action propose.");
  }
  if (summary.unknownCount > 0) {
    actions.push("Review unknown recommended checks before relying on them as proposal gates.");
  }
  if (summary.checksWithoutReadiness > 0) {
    actions.push("Regenerate or update the action plan so every recommended check has readiness metadata.");
  }
  if (actions.length === 0) {
    actions.push("No action check readiness blockers found.");
  }
  return actions;
}

export function renderActionCheckReadinessHandoffMarkdown(handoff: ActionCheckReadinessHandoff): string {
  return [
    `# Action Check Readiness Handoff: ${handoff.runId}`,
    "",
    `- Goal: ${handoff.goal}`,
    `- Action plan: ${handoff.actionPlanPath}`,
    `- JSON: ${handoff.jsonPath}`,
    `- Blocked before proposal: ${handoff.blockedBeforeProposal ? "yes" : "no"}`,
    `- Summary: actions:${handoff.summary.actionCount} checks:${handoff.summary.recommendedCheckCount} tracked:${handoff.summary.trackedCheckCount} ready:${handoff.summary.readyCount} no-op-risk:${handoff.summary.noOpRiskCount} unknown:${handoff.summary.unknownCount} missing:${handoff.summary.checksWithoutReadiness} replan-tasks:${handoff.summary.replanTaskCount} repair-briefs:${handoff.summary.repairBriefCount}`,
    "",
    "## Recommended Next Actions",
    "",
    ...handoff.recommendedNextActions.map((action) => `- ${action}`),
    "",
    "## Attention Items",
    "",
    handoff.items.length > 0
      ? handoff.items.map((item) => [
        `- ${item.actionId} [${item.status}] ${item.command}`,
        `  action-title: ${item.actionTitle}`,
        `  reason: ${item.reason}`,
        `  recommended: ${item.recommendedAction}`,
        item.taskId ? `  task: ${item.taskId}` : undefined,
        item.issueId ? `  issue: ${item.issueId}` : undefined,
        item.repairBriefPath ? `  repair-brief: ${item.repairBriefPath}` : undefined,
        item.repairContextPath ? `  repair-context: ${item.repairContextPath}` : undefined
      ].filter(Boolean).join("\n")).join("\n")
      : "No attention items."
  ].join("\n");
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

async function readLatestRunIdIfPresent(loaded: LoadedConfig): Promise<string | undefined> {
  const latestPath = latestMigrationRunPath(loaded);
  if (!await pathExists(latestPath)) {
    return undefined;
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

async function readActionCheckReadinessSummary(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): Promise<ActionCheckReadinessSummary | undefined> {
  const filePath = actionPlanArtifactPath(loaded, pkg);
  if (!await pathExists(filePath)) {
    return undefined;
  }
  const handoffJsonPath = actionCheckReadinessHandoffJsonPath(loaded, pkg.run.id);
  const handoffMarkdownPath = actionCheckReadinessHandoffMarkdownPath(loaded, pkg.run.id);

  const raw = await readJsonFile<Partial<MigrationActionPlan>>(filePath);
  const actions = raw.actions ?? [];
  const findings: ActionCheckReadinessFinding[] = [];
  const missingReadiness: ActionCheckReadinessMissing[] = [];
  let recommendedCheckCount = 0;
  let trackedCheckCount = 0;
  let readyCount = 0;
  let noOpRiskCount = 0;
  let unknownCount = 0;

  for (const action of actions) {
    const recommendedChecks = action.recommendedChecks ?? [];
    const readinessEntries = action.checkReadiness ?? [];
    recommendedCheckCount += recommendedChecks.length;
    trackedCheckCount += readinessEntries.length;

    for (const command of recommendedChecks) {
      if (!readinessEntries.some((readiness) => readiness.command === command)) {
        missingReadiness.push({
          actionId: action.id,
          actionTitle: action.title,
          command,
          reason: "recommended check has no checkReadiness entry",
          affectedFiles: action.affectedFiles
        });
      }
    }

    for (const readiness of readinessEntries) {
      if (readiness.status === "ready") {
        readyCount += 1;
        continue;
      }
      if (readiness.status === "no-op-risk") {
        noOpRiskCount += 1;
      } else {
        unknownCount += 1;
      }
      findings.push({
        actionId: action.id,
        actionTitle: action.title,
        command: readiness.command,
        status: readiness.status,
        reason: readiness.reason,
        affectedFiles: action.affectedFiles
      });
    }
  }

  return {
    actionPlanPath: filePath,
    handoffJsonPath,
    handoffMarkdownPath,
    actionCount: actions.length,
    recommendedCheckCount,
    trackedCheckCount,
    checksWithoutReadiness: missingReadiness.length,
    readyCount,
    noOpRiskCount,
    unknownCount,
    findings,
    missingReadiness
  };
}

function actionPlanArtifactPath(loaded: LoadedConfig, pkg: MigrationRunPackage): string {
  const fileName = pkg.run.adapter === "md-monorepo"
    ? "md-monorepo-action-plan.json"
    : pkg.run.adapter === "cross-language-http"
      ? "cross-language-http-action-plan.json"
      : "pnpm-vite-vue-action-plan.json";
  return path.join(migrationRunDir(loaded, pkg.run.id), "adapter", fileName);
}

function actionCheckReadinessHandoffJsonPath(loaded: LoadedConfig, runId: string): string {
  return path.join(migrationRunDir(loaded, runId), "reports", "action-check-readiness-handoff.json");
}

function actionCheckReadinessHandoffMarkdownPath(loaded: LoadedConfig, runId: string): string {
  return path.join(migrationRunDir(loaded, runId), "reports", "action-check-readiness-handoff.md");
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
      excludedCount: report.excludedCount ?? report.excluded?.length ?? 0,
      reportPath: report.outputPath,
      firstFailedVerificationPath: report.firstFailedVerificationPath,
      stopReason: report.stopReason,
      nextCommand: report.nextCommand,
      skippedProposals: report.skipped.map((item) => item.proposalId),
      excludedProposals: (report.excluded ?? []).map((item) => item.proposalId),
      recommendedNextActions: report.recommendedNextActions
    }));
}

async function readRecentProposalRepairAcceptanceSummaries(
  loaded: LoadedConfig,
  runId: string
): Promise<ProposalRepairAcceptanceSummary[]> {
  const replansDir = path.join(migrationRunDir(loaded, runId), "replans");
  if (!await pathExists(replansDir)) {
    return [];
  }

  const reports: ProposalRepairAcceptanceReport[] = [];
  const replanEntries = await fs.readdir(replansDir, { withFileTypes: true });
  for (const replanEntry of replanEntries) {
    if (!replanEntry.isDirectory()) {
      continue;
    }
    const acceptanceDir = path.join(replansDir, replanEntry.name, "acceptance");
    if (!await pathExists(acceptanceDir)) {
      continue;
    }
    const files = await fs.readdir(acceptanceDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith("repair-acceptance-") || !file.name.endsWith(".json")) {
        continue;
      }
      reports.push(await readJsonFile<ProposalRepairAcceptanceReport>(path.join(acceptanceDir, file.name)));
    }
  }

  return reports
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-10)
    .map((report) => ({
      id: report.id,
      createdAt: report.createdAt,
      accepted: report.accepted,
      sourceProposalId: report.sourceProposalId,
      retryProposalId: report.retryProposalId,
      retryVerificationPath: report.retryVerificationPath,
      outputPath: report.outputPath,
      checklistCount: report.checklist.length
    }));
}
