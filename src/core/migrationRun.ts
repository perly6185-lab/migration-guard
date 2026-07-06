import { promises as fs } from "node:fs";
import path from "node:path";
import { renderMigrationPlan } from "./plan.js";
import { scanProject } from "./scan.js";
import { createEstimate, createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
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

export function renderRunStatus(pkg: MigrationRunPackage): string {
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
    `Ready tasks: ${ready.map((task) => task.id).join(", ") || "none"}`
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

export async function renderRunReport(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const evidence = await readEvidence(loaded, pkg.run.id);
  const counts = countTasks(pkg.graph);
  const openIssues = pkg.issues.filter((issue) => issue.status !== "closed" && issue.status !== "done");
  const graphErrors = validateTaskGraph(pkg.graph);
  const proposals = await readProposalSummaries(loaded, pkg.run.id);
  const proposalGates = await readRecentProposalGateSummaries(loaded, pkg.run.id);
  const proposalBatches = await readRecentProposalBatchSummaries(loaded, pkg.run.id);

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
      ? proposals.map((proposal) => `- ${proposal.id} [${proposal.applyState}/${proposal.risk}] ${proposal.title}`).join("\n")
      : "No proposals.",
    "",
    "## Recent Proposal Gates",
    "",
    proposalGates.length > 0
      ? proposalGates.map((gate) => [
        `- ${gate.createdAt} ${gate.proposalId} ${gate.passed ? "passed" : "failed"} checks:${gate.checks} timeline:${gate.timeline}${gate.replanIssueId ? ` replan:${gate.replanIssueId}` : ""}`,
        gate.failureCategory ? `  failure:${gate.failureCategory}` : undefined,
        gate.remediationHint ? `  hint:${gate.remediationHint}` : undefined
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
): Promise<Array<{ proposalId: string; createdAt: string; passed: boolean; checks: number; timeline: number; replanIssueId?: string; failureCategory?: string; remediationHint?: string }>> {
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

  return reports
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-10)
    .map((report) => {
      const failed = report.checks.find((check) => !check.passed);
      return {
        proposalId: report.proposalId,
        createdAt: report.createdAt,
        passed: report.passed,
        checks: report.checks.length,
        timeline: report.timeline?.length ?? 0,
        replanIssueId: report.replanIssueId,
        failureCategory: failed?.failureCategory,
        remediationHint: failed?.remediationHints?.[0]
      };
    });
}

async function readRecentProposalBatchSummaries(
  loaded: LoadedConfig,
  runId: string
): Promise<Array<{ id: string; createdAt: string; passed: boolean; gatePolicy?: string; executedCount: number; skippedCount: number; reportPath: string; firstFailedVerificationPath?: string; stopReason?: string; nextCommand?: string; skippedProposals: string[]; recommendedNextActions?: string[] }>> {
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
