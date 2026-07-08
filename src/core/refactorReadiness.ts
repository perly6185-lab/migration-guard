import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { runShellCommand } from "./exec.js";
import { validateTaskGraph } from "./taskGraph.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import type {
  LoadedConfig,
  MigrationActionPlan,
  MigrationAction,
  ProposalBatchReport,
  ProposedPatch,
  RefactorReadinessCriterion,
  RefactorReadinessReport
} from "../types.js";

export interface RefactorReadinessOptions {
  minProposalCount?: number;
  minBatchSize?: number;
  checkTargetGit?: boolean;
}

interface TargetGitStatus {
  clean: boolean;
  output: string;
  error?: string;
}

const DEFAULT_MIN_PROPOSALS = 3;
const DEFAULT_MIN_BATCH_SIZE = 3;
const CANDIDATE_STATES = new Set<ProposedPatch["applyState"]>(["proposed", "verified"]);
const UNRESOLVED_STATES = new Set<ProposedPatch["applyState"]>([
  "verification-failed",
  "applied",
  "applied-with-failed-checks",
  "rollback-failed"
]);

export async function assessRefactorReadiness(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  options: RefactorReadinessOptions = {}
): Promise<RefactorReadinessReport> {
  const minProposalCount = options.minProposalCount ?? DEFAULT_MIN_PROPOSALS;
  const minBatchSize = options.minBatchSize ?? DEFAULT_MIN_BATCH_SIZE;
  const runDir = migrationRunDir(loaded, pkg.run.id);
  const actionPlan = await loadOptionalActionPlan(loaded, pkg);
  const proposals = await loadRunProposals(runDir);
  const batches = await loadRunBatchReports(runDir);
  const targetStatus = options.checkTargetGit === false
    ? undefined
    : await readTargetGitStatus(loaded, pkg);
  const latestPassingBatch = latestPassingBatchWithMinimum(batches, minBatchSize);
  const latestFailedBatch = [...batches].reverse().find((batch) => !batch.passed);
  const unresolvedProposals = proposals.filter((proposal) => UNRESOLVED_STATES.has(proposal.applyState));
  const criteria: RefactorReadinessCriterion[] = [];

  criteria.push(createTargetCleanCriterion(targetStatus));
  criteria.push(createTaskGraphCriterion(pkg));
  criteria.push(createRunProgressCriterion(pkg, actionPlan));
  criteria.push(createActionPlanCriterion(actionPlan, loaded, pkg));
  criteria.push(createActionCheckReadinessCriterion(actionPlan, loaded, pkg));
  criteria.push(createProposalFloorCriterion(proposals, minProposalCount, runDir));
  criteria.push(createTemplateCoverageCriterion(pkg, actionPlan, proposals));
  criteria.push(createPassingBatchCriterion(latestPassingBatch, batches, minBatchSize));
  criteria.push(createUnresolvedFailureCriterion(unresolvedProposals, latestFailedBatch, latestPassingBatch));
  criteria.push(createConfidenceCriterion(pkg));

  const blockerCount = criteria.filter((criterion) => criterion.status === "blocked").length;
  const warningCount = criteria.filter((criterion) => criterion.status === "warning").length;
  const report: RefactorReadinessReport = {
    version: 1,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    status: blockerCount === 0 ? "go" : "hold",
    mode: "large-batch-refactor",
    minProposalCount,
    minBatchSize,
    summary: {
      actionCount: actionPlan?.actions.length ?? 0,
      proposalCount: proposals.length,
      batchCount: batches.length,
      latestPassingBatchId: latestPassingBatch?.id,
      targetClean: targetStatus?.clean,
      blockerCount,
      warningCount
    },
    criteria,
    recommendedNextActions: criteria
      .filter((criterion) => criterion.status === "blocked" && criterion.nextAction)
      .map((criterion) => criterion.nextAction as string)
  };
  return report;
}

export async function writeRefactorReadinessReport(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  report: RefactorReadinessReport
): Promise<RefactorReadinessReport> {
  const basePath = path.join(migrationRunDir(loaded, pkg.run.id), "reports", "refactor-readiness");
  const jsonPath = `${basePath}.json`;
  const markdownPath = `${basePath}.md`;
  const withPaths = {
    ...report,
    outputPath: jsonPath,
    markdownPath
  };
  await writeJsonFile(jsonPath, withPaths);
  await writeTextFile(markdownPath, renderRefactorReadinessReport(withPaths));
  return withPaths;
}

export function renderRefactorReadinessReport(report: RefactorReadinessReport): string {
  const lines = [
    `# Refactor Readiness: ${report.runId}`,
    "",
    `- Status: ${report.status}`,
    `- Mode: ${report.mode}`,
    `- Minimum proposals: ${report.minProposalCount}`,
    `- Minimum passing batch size: ${report.minBatchSize}`,
    `- Actions: ${report.summary.actionCount}`,
    `- Proposals: ${report.summary.proposalCount}`,
    `- Batches: ${report.summary.batchCount}`,
    `- Latest passing batch: ${report.summary.latestPassingBatchId ?? "none"}`,
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
      : ["- none"])
  ];
  if (report.outputPath || report.markdownPath) {
    lines.push("", "## Artifacts", "");
    if (report.outputPath) {
      lines.push(`- JSON: ${report.outputPath}`);
    }
    if (report.markdownPath) {
      lines.push(`- Markdown: ${report.markdownPath}`);
    }
  }
  return lines.join("\n");
}

function createTargetCleanCriterion(targetStatus?: TargetGitStatus): RefactorReadinessCriterion {
  if (!targetStatus) {
    return {
      id: "target-clean",
      title: "Target repository clean",
      status: "warning",
      summary: "target git status was not checked",
      nextAction: "Run readiness without disabling target git status, or manually confirm the target repository is clean."
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
    nextAction: "Rollback or commit target changes before entering a large refactor."
  };
}

function createTaskGraphCriterion(pkg: MigrationRunPackage): RefactorReadinessCriterion {
  const errors = validateTaskGraph(pkg.graph);
  if (errors.length === 0) {
    return {
      id: "task-graph",
      title: "Task graph valid",
      status: "passed",
      summary: "task graph is valid"
    };
  }
  return {
    id: "task-graph",
    title: "Task graph valid",
    status: "blocked",
    summary: `${errors.length} task graph error(s) found`,
    evidence: errors,
    nextAction: "Repair the task graph before generating or applying more proposals."
  };
}

function createRunProgressCriterion(
  pkg: MigrationRunPackage,
  actionPlan: MigrationActionPlan | undefined
): RefactorReadinessCriterion {
  if (actionPlan && pkg.run.status !== "initialized" && pkg.run.status !== "planned") {
    return {
      id: "run-progress",
      title: "Run progressed beyond initial planning",
      status: "passed",
      summary: `run status is ${pkg.run.status} and action evidence exists`
    };
  }
  return {
    id: "run-progress",
    title: "Run progressed beyond initial planning",
    status: "blocked",
    summary: `run status is ${pkg.run.status}; action evidence is ${actionPlan ? "present" : "missing"}`,
    nextAction: `Run migration-guard resume --run ${pkg.run.id} --auto until the adapter action plan exists.`
  };
}

function createActionPlanCriterion(
  actionPlan: MigrationActionPlan | undefined,
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): RefactorReadinessCriterion {
  const filePath = actionPlanPath(loaded, pkg);
  if (actionPlan && actionPlan.actions.length > 0) {
    return {
      id: "action-plan",
      title: "Action plan exists",
      status: "passed",
      summary: `${actionPlan.actions.length} action(s) available`,
      evidence: [filePath]
    };
  }
  return {
    id: "action-plan",
    title: "Action plan exists",
    status: "blocked",
    summary: "no action plan with actions is available",
    evidence: [filePath],
    nextAction: `Run migration-guard resume --run ${pkg.run.id} --auto, then inspect migration-guard actions --run ${pkg.run.id}.`
  };
}

function createActionCheckReadinessCriterion(
  actionPlan: MigrationActionPlan | undefined,
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): RefactorReadinessCriterion {
  if (!actionPlan) {
    return {
      id: "action-check-readiness",
      title: "Action checks ready",
      status: "blocked",
      summary: "action check readiness cannot be evaluated without an action plan",
      nextAction: `Generate the action plan, then run migration-guard actions handoff --run ${pkg.run.id}.`
    };
  }
  const readiness = summarizeActionCheckReadiness(actionPlan.actions);
  const evidence = [actionPlanPath(loaded, pkg)];
  if (readiness.noOpRisk === 0 && readiness.unknown === 0 && readiness.missing === 0 && readiness.tracked > 0) {
    return {
      id: "action-check-readiness",
      title: "Action checks ready",
      status: "passed",
      summary: `all ${readiness.tracked} tracked recommended check(s) are ready`,
      evidence
    };
  }
  return {
    id: "action-check-readiness",
    title: "Action checks ready",
    status: "blocked",
    summary: `ready:${readiness.ready} no-op-risk:${readiness.noOpRisk} unknown:${readiness.unknown} missing:${readiness.missing}`,
    evidence,
    nextAction: `Run migration-guard actions handoff --run ${pkg.run.id} --create-replans --repair-briefs and clear every readiness attention item.`
  };
}

function createProposalFloorCriterion(
  proposals: ProposedPatch[],
  minProposalCount: number,
  runDir: string
): RefactorReadinessCriterion {
  const candidates = proposals.filter((proposal) => CANDIDATE_STATES.has(proposal.applyState));
  if (candidates.length >= minProposalCount) {
    return {
      id: "proposal-floor",
      title: "Enough ready proposals",
      status: "passed",
      summary: `${candidates.length} candidate proposal(s) are ready for batch selection`,
      evidence: [path.join(runDir, "proposals")]
    };
  }
  return {
    id: "proposal-floor",
    title: "Enough ready proposals",
    status: "blocked",
    summary: `${candidates.length}/${minProposalCount} candidate proposal(s) are ready`,
    evidence: [path.join(runDir, "proposals")],
    nextAction: "Generate more scoped proposals from the action plan before attempting a large batch."
  };
}

function createTemplateCoverageCriterion(
  pkg: MigrationRunPackage,
  actionPlan: MigrationActionPlan | undefined,
  proposals: ProposedPatch[]
): RefactorReadinessCriterion {
  const requiredTemplates: Array<NonNullable<MigrationAction["templateSelection"]>["template"]> = pkg.run.adapter === "md-monorepo"
    ? ["ts-structural-probe", "renderer-probe", "api-contract-probe"]
    : [];
  if (requiredTemplates.length === 0) {
    return {
      id: "template-coverage",
      title: "Template coverage",
      status: "passed",
      summary: "no adapter-specific template coverage is required"
    };
  }
  const actionTemplates = new Set((actionPlan?.actions ?? [])
    .map((action) => action.templateSelection?.template ?? action.patchTemplate)
    .filter((template): template is NonNullable<typeof template> => Boolean(template)));
  const proposalTemplates = new Set(proposals
    .map((proposal) => proposal.templateSelection?.template)
    .filter((template): template is NonNullable<typeof template> => Boolean(template)));
  const available = new Set([...actionTemplates, ...proposalTemplates]);
  const missing = requiredTemplates.filter((template) => !available.has(template));
  if (missing.length === 0) {
    return {
      id: "template-coverage",
      title: "Template coverage",
      status: "passed",
      summary: `required templates are covered: ${requiredTemplates.join(", ")}`
    };
  }
  return {
    id: "template-coverage",
    title: "Template coverage",
    status: "blocked",
    summary: `missing required template(s): ${missing.join(", ")}`,
    nextAction: "Regenerate or add proposals so shared TS, renderer, and API contract lanes are all represented."
  };
}

function createPassingBatchCriterion(
  latestPassingBatch: ProposalBatchReport | undefined,
  batches: ProposalBatchReport[],
  minBatchSize: number
): RefactorReadinessCriterion {
  if (latestPassingBatch) {
    return {
      id: "passing-batch",
      title: "Recent passing batch",
      status: "passed",
      summary: `batch ${latestPassingBatch.id} passed with ${latestPassingBatch.executedCount} executed proposal(s)`,
      evidence: [latestPassingBatch.outputPath]
    };
  }
  return {
    id: "passing-batch",
    title: "Recent passing batch",
    status: "blocked",
    summary: `no passing batch with at least ${minBatchSize} executed proposal(s); total batch reports:${batches.length}`,
    nextAction: `Run migration-guard proposal batch apply --run latest --limit ${minBatchSize} --gate-policy fail-fast and keep the target clean afterward.`
  };
}

function createUnresolvedFailureCriterion(
  unresolvedProposals: ProposedPatch[],
  latestFailedBatch: ProposalBatchReport | undefined,
  latestPassingBatch: ProposalBatchReport | undefined
): RefactorReadinessCriterion {
  const failedAfterPassingBatch = latestFailedBatch && (!latestPassingBatch || latestFailedBatch.createdAt > latestPassingBatch.createdAt);
  if (unresolvedProposals.length === 0 && !failedAfterPassingBatch) {
    return {
      id: "unresolved-failures",
      title: "No unresolved proposal failures",
      status: "passed",
      summary: "no unresolved failed/applied proposal states were found"
    };
  }
  return {
    id: "unresolved-failures",
    title: "No unresolved proposal failures",
    status: "blocked",
    summary: `${unresolvedProposals.length} unresolved proposal state(s)${failedAfterPassingBatch ? "; latest batch failed after latest passing batch" : ""}`,
    evidence: [
      ...unresolvedProposals.map((proposal) => `${proposal.id}:${proposal.applyState}`),
      failedAfterPassingBatch && latestFailedBatch ? latestFailedBatch.outputPath : undefined
    ].filter((item): item is string => Boolean(item)),
    nextAction: "Replan failed proposals, rollback applied leftovers, and rerun a clean passing batch."
  };
}

function createConfidenceCriterion(pkg: MigrationRunPackage): RefactorReadinessCriterion {
  if (pkg.run.estimate.confidence === "high") {
    return {
      id: "confidence",
      title: "Verification confidence",
      status: "passed",
      summary: "run estimate confidence is high"
    };
  }
  if (pkg.run.estimate.confidence === "medium") {
    return {
      id: "confidence",
      title: "Verification confidence",
      status: "warning",
      summary: "run estimate confidence is medium; proceed only after passing batch evidence is current",
      evidence: pkg.run.estimate.notes
    };
  }
  return {
    id: "confidence",
    title: "Verification confidence",
    status: "blocked",
    summary: "run estimate confidence is low",
    evidence: pkg.run.estimate.notes,
    nextAction: "Add or enable stronger checks/probes before a large refactor."
  };
}

async function readTargetGitStatus(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<TargetGitStatus> {
  const result = await runShellCommand("git status --short --branch", {
    cwd: pkg.run.targetRoot,
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

async function loadOptionalActionPlan(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): Promise<MigrationActionPlan | undefined> {
  const filePath = actionPlanPath(loaded, pkg);
  if (!await pathExists(filePath)) {
    return undefined;
  }
  const raw = await readJsonFile<Partial<MigrationActionPlan>>(filePath);
  return {
    version: 1,
    runId: raw.runId ?? pkg.run.id,
    createdAt: raw.createdAt ?? pkg.run.updatedAt,
    goal: raw.goal ?? pkg.run.goal,
    actions: raw.actions ?? []
  };
}

function actionPlanPath(loaded: LoadedConfig, pkg: MigrationRunPackage): string {
  const fileName = pkg.run.adapter === "md-monorepo"
    ? "md-monorepo-action-plan.json"
    : "pnpm-vite-vue-action-plan.json";
  return path.join(migrationRunDir(loaded, pkg.run.id), "adapter", fileName);
}

async function loadRunProposals(runDir: string): Promise<ProposedPatch[]> {
  const proposalsDir = path.join(runDir, "proposals");
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

async function loadRunBatchReports(runDir: string): Promise<ProposalBatchReport[]> {
  const batchRoot = path.join(runDir, "proposal-batches");
  if (!await pathExists(batchRoot)) {
    return [];
  }
  const batchDirs = await fs.readdir(batchRoot, { withFileTypes: true });
  const reports: ProposalBatchReport[] = [];
  for (const batchDir of batchDirs) {
    if (!batchDir.isDirectory()) {
      continue;
    }
    const dirPath = path.join(batchRoot, batchDir.name);
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && /^proposal-batch-report-.*\.json$/.test(file.name)) {
        reports.push(await readJsonFile<ProposalBatchReport>(path.join(dirPath, file.name)));
      }
    }
  }
  return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function latestPassingBatchWithMinimum(
  batches: ProposalBatchReport[],
  minBatchSize: number
): ProposalBatchReport | undefined {
  return [...batches]
    .reverse()
    .find((batch) => batch.passed && batch.executedCount >= minBatchSize && batch.skippedCount === 0);
}

function summarizeActionCheckReadiness(actions: MigrationAction[]): {
  ready: number;
  noOpRisk: number;
  unknown: number;
  missing: number;
  tracked: number;
} {
  let ready = 0;
  let noOpRisk = 0;
  let unknown = 0;
  let missing = 0;
  let tracked = 0;

  for (const action of actions) {
    const byCommand = new Map((action.checkReadiness ?? []).map((readiness) => [readiness.command, readiness]));
    for (const command of action.recommendedChecks) {
      const readiness = byCommand.get(command);
      if (!readiness) {
        missing += 1;
        continue;
      }
      tracked += 1;
      if (readiness.status === "ready") {
        ready += 1;
      } else if (readiness.status === "no-op-risk") {
        noOpRisk += 1;
      } else {
        unknown += 1;
      }
    }
  }

  return { ready, noOpRisk, unknown, missing, tracked };
}

function migrationRunDir(loaded: LoadedConfig, runId: string): string {
  return path.join(loaded.artifactsDir, "migration-runs", runId);
}
