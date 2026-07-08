import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { loadActionPlan } from "./actionPlan.js";
import { compareSnapshots } from "./compare.js";
import { decisionsForCompareReport } from "./diffDecision.js";
import { renderCompareReport } from "./markdown.js";
import { captureSnapshot } from "./snapshot.js";
import { appendEvidence, createId, createProposalFailureIssue, createProposalReplanTask, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import { getProbeTemplateDefinition, selectProbeTemplateForAction } from "./probeTemplateRegistry.js";
import type {
  LoadedConfig,
  MigrationAction,
  MigrationActionPatchTemplate,
  CompareReport,
  DiffDecision,
  MigrationTask,
  ProposalBehaviorDiffReport,
  ProposalBehaviorDriftReference,
  ProposalBatchExcludedItem,
  ProposalBatchPlan,
  ProposalBatchReport,
  ProposalBatchResult,
  ProposalCheckAttempt,
  ProposalCheckFailureCategory,
  ProposalCheckKind,
  ProposalCheckPhase,
  ProposalCheckPlanItem,
  ProposalCommandCheck,
  ProposalGateEvent,
  ProposalGatePolicy,
  ProposalGatePolicyMode,
  ProposalPatchCheck,
  ProposalPreviewConfig,
  ProposalPreviewResult,
  ProposalRepairAcceptanceReport,
  ProposalRollbackReport,
  ProposalTemporaryApply,
  ProposalVerificationReport,
  ProposedPatch,
  Snapshot
} from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import { runShellCommand } from "./exec.js";
import { startManagedPreview } from "./preview.js";

export interface ApplyProposedPatchOptions {
  runChecks?: boolean;
  rollbackOnFail?: boolean;
  gatePolicy?: ProposalGatePolicy;
  behaviorDiff?: boolean;
}

export interface ProposeActionPatchOptions {
  allowNoOpRisk?: boolean;
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

export interface ProposalListFilters {
  state?: ProposedPatch["applyState"];
  actionId?: string;
  risk?: ProposedPatch["risk"];
}

export interface ProposalReplanResult {
  message: string;
  proposal: ProposedPatch;
  report: ProposalVerificationReport;
  task: MigrationTask;
  briefPath: string;
  contextPath: string;
}

export interface ProposalRetryResult {
  message: string;
  sourceProposal: ProposedPatch;
  proposal: ProposedPatch;
  report: ProposalVerificationReport;
  reused: boolean;
}

export interface ProposalBatchOptions {
  limit?: number;
  runChecks?: boolean;
  rollbackOnFail?: boolean;
  gatePolicy?: ProposalGatePolicy;
  behaviorDiff?: boolean;
}

interface ProposalReplanArtifactPaths {
  briefPath: string;
  contextPath: string;
}

interface ProposalReplanContext {
  version: 1;
  artifactSchemaVersion?: 1;
  createdAt: string;
  run: {
    id: string;
    goal: string;
    status: string;
    targetRoot: string;
  };
  proposal: {
    id: string;
    title: string;
    summary: string;
    risk: ProposedPatch["risk"];
    patchPath: string;
    affectedFiles: string[];
    generatedFiles: string[];
    recommendedChecks: string[];
    templateSelection?: ProposedPatch["templateSelection"];
    checkPlan?: ProposalCheckPlanItem[];
    checkReadiness?: Array<{
      command: string;
      status: string;
      reason: string;
    }>;
    sourceSnippets: Array<{
      file: string;
      startLine: number;
      endLine: number;
      excerpt: string;
    }>;
  };
  failure: {
    issueId: string;
    taskId: string;
    verificationReportPath: string;
    patchCheck: Pick<ProposalPatchCheck, "passed" | "skipped" | "command" | "exitCode" | "stdout" | "stderr" | "error">;
    firstFailedCheck?: {
      command: string;
      kind?: ProposalCheckKind;
      phase?: ProposalCheckPhase;
      failureCategory?: ProposalCheckFailureCategory;
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
      error?: string;
      remediationHints: string[];
    };
    latestFailedOutput?: {
      stdout: string;
      stderr: string;
    };
    behaviorDrift?: ProposalBehaviorDriftReference;
    behaviorDriftDecisions?: Array<{
      area: "check" | "probe";
      name: string;
      message: string;
      classification: string;
      reason?: string;
    }>;
  };
  acceptanceChecklist: string[];
  commands: {
    status: string;
    retryVerify: string;
    retryApply: string;
    runReplanTask: string;
  };
  paths: {
    brief: string;
    context: string;
    verificationReport: string;
    patch: string;
  };
}

const DEFAULT_GATE_POLICY: ProposalGatePolicy = { mode: "collect-all" };

export async function proposePatch(loaded: LoadedConfig, pkg: MigrationRunPackage, taskId: string): Promise<ProposedPatch> {
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const checkPlan = createProposalCheckPlan(loaded, task.verificationCommands);
  const proposed: ProposedPatch = {
    version: 1,
    artifactSchemaVersion: 1,
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
    checkPlan,
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

export async function proposeActionPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  actionId: string,
  options: ProposeActionPatchOptions = {}
): Promise<ProposedPatch> {
  const plan = await loadActionPlan(loaded, pkg);
  const action = plan.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }
  const noOpRisks = (action.checkReadiness ?? []).filter((readiness) => readiness.status === "no-op-risk");
  if (noOpRisks.length > 0 && !options.allowNoOpRisk) {
    throw new Error([
      `Action ${action.id} has ${noOpRisks.length} no-op-risk recommended check(s).`,
      ...noOpRisks.map((readiness) => `- ${readiness.command}: ${readiness.reason}`),
      "Re-run with --allow-no-op-risk only after replacing or intentionally accepting these checks."
    ].join("\n"));
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const generatedFile = createActionProbePath(action);
  const templateSelection = selectProbeTemplateForAction(action);
  const template = templateSelection.template;
  const templateDefinition = getProbeTemplateDefinition(template);
  const preview = templateDefinition.needsPreview ? await resolveActionPreview(loaded, action) : undefined;
  if (await pathExists(path.join(pkg.run.targetRoot, generatedFile))) {
    throw new Error(`Generated probe already exists in target: ${generatedFile}`);
  }

  const probeContent = createActionProbeScript(pkg.run.goal, action);
  const patchContent = createAddFilePatch(generatedFile, probeContent);
  const recommendedChecks = [...new Set([...action.recommendedChecks, `node ${generatedFile}`])];
  const checkPlan = action.checkPlan ?? createProposalCheckPlan(loaded, recommendedChecks, preview ? [generatedFile] : []);
  const proposed: ProposedPatch = {
    version: 1,
    artifactSchemaVersion: 1,
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
    checkPlan,
    templateSelection,
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
      checkPlan: proposed.checkPlan,
      templateSelection,
      preview
    }
  });
  return proposed;
}

export async function verifyProposedPatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string,
  options: { runChecks?: boolean; gatePolicy?: ProposalGatePolicy } = {}
): Promise<ProposalVerificationReport> {
  const proposal = await loadProposal(loaded, pkg, proposalId);
  assertProposalIsNotExcluded(proposal, "verify");
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");
  const patchCheck = await checkPatchApplicability(loaded, pkg, proposal, patchContent);
  const gatePolicy = resolveGatePolicy(loaded, options.gatePolicy);
  const checkRun = options.runChecks && patchCheck.passed
    ? await runProposalChecksForVerify(loaded, pkg, proposal, patchContent, gatePolicy)
    : { checks: [] };
  const report = await writeProposalVerificationReport(loaded, pkg, proposal, "verify", false, patchCheck, checkRun.checks, checkRun.preview, gatePolicy, undefined, checkRun.temporaryApply);
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
      runChecks: Boolean(options.runChecks),
      temporaryApply: report.temporaryApply
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
  assertProposalIsNotExcluded(proposal, "apply");
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");
  const patchCheck = await checkPatchApplicability(loaded, pkg, proposal, patchContent);
  const gatePolicy = resolveGatePolicy(loaded, options.gatePolicy);
  const behaviorBefore = options.behaviorDiff && patchCheck.passed
    ? await captureProposalBehaviorSnapshot(loaded, pkg)
    : undefined;

  if (!isGitPatchContent(patchContent)) {
    proposal.applyState = "applied";
    await writeJsonFile(proposalPath, proposal);
    const checkRun = options.runChecks ? await runProposalChecksForApply(loaded, pkg, proposal, gatePolicy) : { checks: [] };
    const behaviorDiff = behaviorBefore
      ? await writeProposalBehaviorDiff(loaded, pkg, proposal, behaviorBefore)
      : undefined;
    const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", true, patchCheck, checkRun.checks, checkRun.preview, gatePolicy, behaviorDiff);
    proposal.applyState = report.passed ? "applied" : "applied-with-failed-checks";
    proposal.lastVerificationPath = report.outputPath;
    if (!report.passed) {
      await recordProposalGateFailure(loaded, pkg, proposal, report);
    }
    await writeJsonFile(proposalPath, proposal);
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: proposal.taskId,
      type: "proposal",
      message: `Marked non-mutating patch proposal ${proposal.id} as applied`,
      data: {
        patchPath: proposal.patchPath,
        noOp: true,
        outputPath: report.outputPath,
        behaviorDiffPath: report.behaviorDiff?.compareReportPath
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
    const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", false, patchCheck, [], undefined, gatePolicy);
    proposal.applyState = "verification-failed";
    proposal.lastVerificationPath = report.outputPath;
    await recordProposalGateFailure(loaded, pkg, proposal, report);
    await writeJsonFile(proposalPath, proposal);
    await saveRunPackage(loaded, pkg);
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
  const checkRun = options.runChecks ? await runProposalChecksForApply(loaded, pkg, proposal, gatePolicy) : { checks: [] };
  const behaviorDiff = behaviorBefore
    ? await writeProposalBehaviorDiff(loaded, pkg, proposal, behaviorBefore)
    : undefined;
  const report = await writeProposalVerificationReport(loaded, pkg, proposal, "apply", true, patchCheck, checkRun.checks, checkRun.preview, gatePolicy, behaviorDiff);
  proposal.applyState = report.passed ? "applied" : "applied-with-failed-checks";
  proposal.lastVerificationPath = report.outputPath;
  if (!report.passed) {
    await recordProposalGateFailure(loaded, pkg, proposal, report);
  }
  await writeJsonFile(proposalPath, proposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "proposal",
    message: `Applied patch proposal ${proposal.id}: ${report.passed ? "checks passed" : "checks failed"}`,
    data: {
      patchPath: proposal.patchPath,
      outputPath: report.outputPath,
      runChecks: Boolean(options.runChecks),
      behaviorDiffPath: report.behaviorDiff?.compareReportPath
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
  assertProposalIsNotExcluded(proposal, "rollback");
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

export interface ProposalRepairAcceptanceResult {
  message: string;
  sourceProposal: ProposedPatch;
  retryProposal: ProposedPatch;
  retryVerificationReport: ProposalVerificationReport;
  acceptanceReport: ProposalRepairAcceptanceReport;
}

export async function excludeProposal(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string,
  applyState: Extract<ProposedPatch["applyState"], "rejected" | "ignored">,
  reason?: string,
  supersededBy?: string
): Promise<ProposedPatch> {
  const proposal = await loadProposal(loaded, pkg, proposalId);
  if (proposal.applyState === "applied" || proposal.applyState === "applied-with-failed-checks" || proposal.applyState === "rollback-failed") {
    throw new Error(`Proposal ${proposal.id} is ${proposal.applyState}; rollback or resolve it before marking it ${applyState}.`);
  }
  if (supersededBy && supersededBy === proposal.id) {
    throw new Error(`Proposal ${proposal.id} cannot be superseded by itself.`);
  }

  const trimmedReason = reason?.trim() || undefined;
  proposal.applyState = applyState;
  proposal.exclusion = {
    state: applyState,
    reason: trimmedReason,
    supersededBy: supersededBy?.trim() || undefined,
    createdAt: new Date().toISOString()
  };
  await writeJsonFile(proposalJsonPath(loaded, pkg, proposal.id), proposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "proposal",
    message: `Marked proposal ${proposal.id} as ${applyState}`,
    data: {
      proposalId: proposal.id,
      actionId: proposal.actionId,
      reason: trimmedReason,
      supersededBy: proposal.exclusion.supersededBy
    }
  });
  await saveRunPackage(loaded, pkg);
  return proposal;
}

export async function replanProposal(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string
): Promise<ProposalReplanResult> {
  const proposal = await loadProposal(loaded, pkg, proposalId);
  const reportPath = proposal.lastVerificationPath ?? await latestProposalVerificationPath(loaded, pkg, proposalId);
  if (!reportPath) {
    throw new Error(`No verification report found for proposal ${proposalId}.`);
  }

  const report = await readJsonFile<ProposalVerificationReport>(reportPath);
  if (report.passed) {
    throw new Error(`Proposal ${proposalId} has a passing latest verification report.`);
  }

  let issueId = report.replanIssueId;
  if (!issueId || !pkg.issues.some((issue) => issue.id === issueId)) {
    issueId = createProposalFailureIssue(pkg, proposal, report).id;
  }
  const task = createProposalReplanTask(pkg, proposal, report, issueId);
  const replanArtifacts = await writeProposalReplanArtifacts(loaded, pkg, proposal, report, task, issueId);
  report.replanIssueId = issueId;
  report.replanTaskId = task.id;
  report.replanBriefPath = replanArtifacts.briefPath;
  report.replanContextPath = replanArtifacts.contextPath;
  await writeJsonFile(report.outputPath, report);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: task.id,
    issueId,
    type: "replan",
    message: `Replan task ${task.id} is ready for failed proposal ${proposal.id}`,
    data: {
      proposalId: proposal.id,
      outputPath: report.outputPath,
      briefPath: replanArtifacts.briefPath,
      contextPath: replanArtifacts.contextPath
    }
  });
  await saveRunPackage(loaded, pkg);

  return {
    message: `Created replan task ${task.id} for proposal ${proposal.id}.`,
    proposal,
    report,
    task,
    briefPath: replanArtifacts.briefPath,
    contextPath: replanArtifacts.contextPath
  };
}

export async function createProposalRetry(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string
): Promise<ProposalRetryResult> {
  const sourceProposal = await loadProposal(loaded, pkg, proposalId);
  const reportPath = sourceProposal.lastVerificationPath ?? await latestProposalVerificationPath(loaded, pkg, proposalId);
  if (!reportPath) {
    throw new Error(`No verification report found for proposal ${proposalId}.`);
  }

  let report = await readJsonFile<ProposalVerificationReport>(reportPath);
  if (report.passed) {
    throw new Error(`Proposal ${proposalId} has a passing latest verification report.`);
  }

  if (!report.replanBriefPath || !report.replanContextPath || !report.replanTaskId) {
    const replan = await replanProposal(loaded, pkg, proposalId);
    report = replan.report;
  }

  const existing = (await loadAllProposals(loaded, pkg))
    .filter((proposal) => proposal.retryOfProposalId === sourceProposal.id && !isExcludedProposalState(proposal.applyState))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (existing) {
    report.retryProposalId = existing.id;
    await writeJsonFile(report.outputPath, report);
    return {
      message: `Reused retry proposal ${existing.id} for ${sourceProposal.id}.`,
      sourceProposal,
      proposal: existing,
      report,
      reused: true
    };
  }

  const id = createId("retry");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const sourceFailureCategory = report.checks.find((check) => !check.passed)?.failureCategory;
  const retryProposal: ProposedPatch = {
    version: 1,
    artifactSchemaVersion: 1,
    id,
    runId: pkg.run.id,
    taskId: report.replanTaskId ?? sourceProposal.taskId,
    actionId: sourceProposal.actionId,
    retryOfProposalId: sourceProposal.id,
    retrySourceFailureCategory: sourceFailureCategory,
    replanIssueId: report.replanIssueId,
    replanTaskId: report.replanTaskId,
    replanBriefPath: report.replanBriefPath,
    replanContextPath: report.replanContextPath,
    createdAt: new Date().toISOString(),
    title: `Retry proposal for ${sourceProposal.title}`,
    summary: createRetryProposalSummary(sourceProposal, report),
    risk: sourceProposal.risk,
    patchPath,
    affectedFiles: sourceProposal.affectedFiles,
    generatedFiles: sourceProposal.generatedFiles,
    recommendedChecks: sourceProposal.recommendedChecks,
    checkPlan: sourceProposal.checkPlan,
    templateSelection: sourceProposal.templateSelection,
    preview: sourceProposal.preview,
    patchKind: "replan-retry",
    applyState: "proposed"
  };

  await writeTextFile(patchPath, createRetryPatchContent(pkg, sourceProposal, report));
  await writeJsonFile(path.join(dir, "proposal.json"), retryProposal);
  report.retryProposalId = retryProposal.id;
  await writeJsonFile(report.outputPath, report);
  markReplanTaskDone(pkg, report.replanTaskId, retryProposal.id);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: retryProposal.taskId,
    issueId: report.replanIssueId,
    type: "proposal",
    message: `Created retry proposal ${retryProposal.id} for failed proposal ${sourceProposal.id}`,
    data: {
      sourceProposalId: sourceProposal.id,
      retryProposalId: retryProposal.id,
      sourceFailureCategory,
      replanBriefPath: report.replanBriefPath,
      replanContextPath: report.replanContextPath,
      patchPath
    }
  });
  await saveRunPackage(loaded, pkg);

  return {
    message: `Created retry proposal ${retryProposal.id} for ${sourceProposal.id}.`,
    sourceProposal,
    proposal: retryProposal,
    report,
    reused: false
  };
}

export async function acceptProposalRepair(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  retryProposalId: string,
  options: { notes?: string } = {}
): Promise<ProposalRepairAcceptanceResult> {
  const retryProposal = await loadProposal(loaded, pkg, retryProposalId);
  if (!retryProposal.retryOfProposalId) {
    throw new Error(`Proposal ${retryProposalId} is not a retry proposal.`);
  }

  const sourceProposal = await loadProposal(loaded, pkg, retryProposal.retryOfProposalId);
  const retryVerificationPath = retryProposal.lastVerificationPath ?? await latestProposalVerificationPath(loaded, pkg, retryProposal.id);
  if (!retryVerificationPath) {
    throw new Error(`No verification report found for retry proposal ${retryProposal.id}.`);
  }
  const retryVerificationReport = await readJsonFile<ProposalVerificationReport>(retryVerificationPath);
  if (!retryVerificationReport.passed) {
    throw new Error(`Retry proposal ${retryProposal.id} latest verification has not passed.`);
  }
  if (retryVerificationReport.checks.length === 0) {
    throw new Error(`Retry proposal ${retryProposal.id} latest verification did not run any checks.`);
  }

  const sourceVerificationPath = sourceProposal.lastVerificationPath ?? await latestProposalVerificationPath(loaded, pkg, sourceProposal.id);
  const checklist = await createRepairAcceptanceItems(retryProposal, retryVerificationReport);
  const id = createId("repair-acceptance");
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "replans", sourceProposal.id, "acceptance", `${id}.json`);
  const acceptanceReport: ProposalRepairAcceptanceReport = {
    version: 1,
    artifactSchemaVersion: 1,
    id,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    sourceProposalId: sourceProposal.id,
    retryProposalId: retryProposal.id,
    accepted: checklist.every((item) => item.status === "accepted"),
    sourceVerificationPath,
    retryVerificationPath,
    replanBriefPath: retryProposal.replanBriefPath ?? sourceProposal.replanBriefPath,
    replanContextPath: retryProposal.replanContextPath ?? sourceProposal.replanContextPath,
    checklist,
    notes: options.notes,
    outputPath
  };

  await writeJsonFile(outputPath, acceptanceReport);
  sourceProposal.lastAcceptancePath = outputPath;
  retryProposal.lastAcceptancePath = outputPath;
  await writeJsonFile(proposalJsonPath(loaded, pkg, sourceProposal.id), sourceProposal);
  await writeJsonFile(proposalJsonPath(loaded, pkg, retryProposal.id), retryProposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: retryProposal.taskId,
    issueId: retryProposal.replanIssueId,
    type: "proposal",
    message: `Accepted repair ${retryProposal.id} for failed proposal ${sourceProposal.id}`,
    data: {
      sourceProposalId: sourceProposal.id,
      retryProposalId: retryProposal.id,
      outputPath,
      retryVerificationPath,
      accepted: acceptanceReport.accepted
    }
  });
  await saveRunPackage(loaded, pkg);

  return {
    message: `Accepted repair ${retryProposal.id} for ${sourceProposal.id}.`,
    sourceProposal,
    retryProposal,
    retryVerificationReport,
    acceptanceReport
  };
}

export async function createProposalBatchPlan(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  options: { limit?: number } = {}
): Promise<ProposalBatchPlan> {
  const allProposals = await loadAllProposals(loaded, pkg);
  const candidates = allProposals
    .filter((proposal) => isBatchCandidateState(proposal.applyState))
    .sort(compareProposalsForBatch);
  const selected = typeof options.limit === "number" && options.limit > 0
    ? candidates.slice(0, options.limit)
    : candidates;
  const selectedIds = new Set(selected.map((proposal) => proposal.id));
  const excluded = allProposals
    .filter((proposal) => !selectedIds.has(proposal.id))
    .filter((proposal) => !isBatchCandidateState(proposal.applyState) || isExcludedProposalState(proposal.applyState))
    .sort(compareProposalsForBatch)
    .map(createProposalBatchExcludedItem);
  const id = createId("proposal-batch");
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "proposal-batches", id, "batch-plan.json");
  const plan: ProposalBatchPlan = {
    version: 1,
    artifactSchemaVersion: 1,
    id,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    proposals: selected.map((proposal) => ({
      proposalId: proposal.id,
      title: proposal.title,
      risk: proposal.risk,
      applyState: proposal.applyState,
    checkPlan: ensureProposalCheckPlan(loaded, proposal).map((check) => ({
        kind: check.kind,
        phase: check.phase,
        command: check.command
      }))
    })),
    excludedCount: excluded.length,
    excluded,
    outputPath
  };
  await writeJsonFile(outputPath, plan);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "proposal",
    message: `Created proposal batch plan ${plan.id} with ${plan.proposals.length} proposal(s)`,
    data: {
      outputPath: plan.outputPath,
      proposalIds: plan.proposals.map((proposal) => proposal.proposalId),
      excludedCount: plan.excludedCount
    }
  });
  return plan;
}

export async function applyProposalBatch(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  options: ProposalBatchOptions = {}
): Promise<ProposalBatchReport> {
  const plan = await createProposalBatchPlan(loaded, pkg, { limit: options.limit });
  const results: ProposalBatchResult[] = [];
  let stopReason: string | undefined;
  const gatePolicy = resolveGatePolicy(loaded, options.gatePolicy, "batchPolicy");

  for (const item of plan.proposals) {
    try {
      const result = await applyProposedPatch(loaded, pkg, item.proposalId, {
        runChecks: options.runChecks ?? true,
        rollbackOnFail: options.rollbackOnFail ?? true,
        gatePolicy,
        behaviorDiff: options.behaviorDiff
      });
      results.push({
        proposalId: item.proposalId,
        passed: result.report?.passed ?? true,
        state: result.proposal.applyState,
        verificationPath: result.report?.outputPath,
        rollbackPath: result.rollbackReport?.outputPath,
        firstFailedCheck: result.report ? firstFailedCheckSummary(result.report) : undefined
      });
      if (result.report && !result.report.passed) {
        stopReason = createBatchStopReason(item.proposalId, result.report);
        break;
      }
    } catch (error) {
      const status = await getProposalStatus(loaded, pkg, item.proposalId).catch(() => undefined);
      const report = status?.proposal.lastVerificationPath
        ? await readJsonFile<ProposalVerificationReport>(status.proposal.lastVerificationPath).catch(() => undefined)
        : undefined;
      results.push({
        proposalId: item.proposalId,
        passed: false,
        state: status?.proposal.applyState ?? item.applyState,
        verificationPath: status?.proposal.lastVerificationPath,
        rollbackPath: status?.proposal.lastRollbackPath,
        firstFailedCheck: report ? firstFailedCheckSummary(report) : undefined,
        error: error instanceof Error ? error.message : String(error)
      });
      stopReason = report
        ? createBatchStopReason(item.proposalId, report)
        : `Stopped after proposal ${item.proposalId} failed: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }

  const completedIds = new Set(results.map((result) => result.proposalId));
  const skipped = plan.proposals
    .filter((proposal) => !completedIds.has(proposal.proposalId))
    .map((proposal) => ({
      proposalId: proposal.proposalId,
      reason: stopReason ?? "Skipped because an earlier proposal stopped the batch."
    }));
  const id = createId("proposal-batch-report");
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "proposal-batches", plan.id, `${id}.json`);
  const failedResult = results.find((result) => !result.passed);
  const report: ProposalBatchReport = {
    version: 1,
    artifactSchemaVersion: 1,
    id,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    planId: plan.id,
    gatePolicy,
    passed: results.length === plan.proposals.length && results.every((result) => result.passed),
    executedCount: results.length,
    skippedCount: skipped.length,
    excludedCount: plan.excludedCount ?? 0,
    firstFailedProposalId: failedResult?.proposalId,
    firstFailedVerificationPath: failedResult?.verificationPath,
    results,
    skipped,
    excluded: plan.excluded ?? [],
    stopReason,
    nextCommand: stopReason ? firstFailedProposalReplanCommand(results) : undefined,
    recommendedNextActions: createBatchRecommendedNextActions(failedResult),
    outputPath
  };
  await writeJsonFile(outputPath, report);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "proposal",
    message: `Applied proposal batch ${plan.id}: ${report.passed ? "passed" : "failed"}`,
    data: {
      outputPath,
      resultCount: results.length
    }
  });
  await saveRunPackage(loaded, pkg);
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

export async function listProposals(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  filters: ProposalListFilters = {}
): Promise<ProposedPatch[]> {
  return (await loadAllProposals(loaded, pkg))
    .filter((proposal) => !filters.state || proposal.applyState === filters.state)
    .filter((proposal) => !filters.actionId || proposal.actionId === filters.actionId)
    .filter((proposal) => !filters.risk || proposal.risk === filters.risk)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function renderProposalVerificationReport(report: ProposalVerificationReport): string {
  const lines = [
    `Proposal: ${report.proposalId}`,
    `Mode: ${report.mode}`,
    `Applied: ${report.applied ? "yes" : "no"}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    `Patch check: ${report.patchCheck.skipped ? "skipped" : report.patchCheck.passed ? "passed" : "failed"}`,
    `Temporary apply: ${report.temporaryApply ? `${report.temporaryApply.applied ? "applied" : "not applied"}, ${report.temporaryApply.rolledBack ? "rolled back" : "not rolled back"}` : "not used"}`,
    `Preview: ${report.preview ? report.preview.ready ? `ready ${report.preview.url}` : `failed ${report.preview.url}` : "not managed"}`,
    `Gate policy: ${report.gatePolicy?.mode ?? DEFAULT_GATE_POLICY.mode}`,
    `Check plan: ${report.checkPlan?.length ?? 0}`,
    `Timeline: ${report.timeline.length}`,
    `Checks: ${report.checks.length}`
  ];

  for (const check of report.checks) {
    const meta = check.kind || check.phase ? ` [${check.kind ?? "other"}/${check.phase ?? "pre-preview"}]` : "";
    const attempts = check.attemptCount && check.attemptCount > 1 ? ` attempts:${check.attemptCount}` : "";
    const flake = check.flakeSuspected ? " flake-suspected" : "";
    lines.push(`- ${check.passed ? "passed" : "failed"}${meta}${attempts}${flake} ${check.command}`);
    for (const hint of check.remediationHints ?? []) {
      lines.push(`  hint: ${hint}`);
    }
  }

  if (report.replanBriefPath) {
    lines.push(`Replan brief: ${report.replanBriefPath}`);
  }
  if (report.replanContextPath) {
    lines.push(`Replan context: ${report.replanContextPath}`);
  }
  if (report.behaviorDrift) {
    lines.push(`Behavior drift: ${report.behaviorDrift.differences.length} check/probe difference(s) from ${report.behaviorDrift.compareReportPath}`);
    for (const difference of report.behaviorDrift.differences.slice(0, 5)) {
      lines.push(`- drift ${difference.severity} ${difference.area}/${difference.name}: ${difference.message}`);
    }
  }
  if (report.behaviorDiff) {
    lines.push(`Behavior diff: ${report.behaviorDiff.passed ? "passed" : "failed"} errors:${report.behaviorDiff.errorCount} warnings:${report.behaviorDiff.warningCount}`);
    lines.push(`Behavior compare: ${report.behaviorDiff.compareReportPath}`);
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
    `Retry of: ${proposal.retryOfProposalId ?? "none"}`,
    `Retry source failure: ${proposal.retrySourceFailureCategory ?? "none"}`,
    `Replan issue: ${proposal.replanIssueId ?? "none"}`,
    `Replan task: ${proposal.replanTaskId ?? "none"}`,
    `Replan brief: ${proposal.replanBriefPath ?? "none"}`,
    `Replan context: ${proposal.replanContextPath ?? "none"}`,
    `Generated files: ${proposal.generatedFiles?.join(", ") || "none"}`,
    `Recommended checks: ${proposal.recommendedChecks.join(", ") || "none"}`,
    `Check plan: ${(proposal.checkPlan ?? []).map((check) => `${check.kind}/${check.phase}`).join(", ") || "none"}`,
    `Preview: ${proposal.preview ? `${proposal.preview.command} -> ${proposal.preview.url}` : "none"}`,
    `Exclusion reason: ${proposal.exclusion?.reason ?? "none"}`,
    `Superseded by: ${proposal.exclusion?.supersededBy ?? "none"}`,
    `Last verification: ${proposal.lastVerificationPath ?? "none"}`,
    `Last rollback: ${proposal.lastRollbackPath ?? "none"}`,
    `Last acceptance: ${proposal.lastAcceptancePath ?? "none"}`,
    `Verification reports: ${status.verificationReports.length}`,
    `Rollback reports: ${status.rollbackReports.length}`
  ].join("\n");
}

export function renderProposalList(proposals: ProposedPatch[]): string {
  if (proposals.length === 0) {
    return "No proposals.";
  }
  return proposals.map((proposal) => {
    const details = [
      proposal.actionId ? `action:${proposal.actionId}` : undefined,
      proposal.retryOfProposalId ? `retry-of:${proposal.retryOfProposalId}` : undefined,
      proposal.exclusion?.reason ? `reason:${proposal.exclusion.reason}` : undefined,
      proposal.exclusion?.supersededBy ? `superseded-by:${proposal.exclusion.supersededBy}` : undefined
    ].filter(Boolean).join(" ");
    return `- ${proposal.id} [${proposal.applyState}/${proposal.risk}] ${proposal.title}${details ? ` (${details})` : ""}`;
  }).join("\n");
}

export function renderProposalBatchPlan(plan: ProposalBatchPlan): string {
  const lines = [
    `Proposal batch: ${plan.id}`,
    `Run: ${plan.runId}`,
    `Proposals: ${plan.proposals.length}`,
    `Excluded: ${plan.excludedCount ?? plan.excluded?.length ?? 0}`
  ];
  for (const item of plan.proposals) {
    lines.push(`- ${item.proposalId} [${item.applyState}/${item.risk}] ${item.title}`);
  }
  for (const item of plan.excluded ?? []) {
    lines.push(`- excluded ${item.proposalId} [${item.applyState}/${item.risk}]: ${item.reason}${item.supersededBy ? ` (superseded by ${item.supersededBy})` : ""}`);
  }
  lines.push(`Wrote ${plan.outputPath}`);
  return lines.join("\n");
}

export function renderProposalBatchReport(report: ProposalBatchReport): string {
  const lines = [
    `Proposal batch report: ${report.id}`,
    `Plan: ${report.planId}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    `Gate policy: ${report.gatePolicy?.mode ?? "unknown"}`,
    `Results: ${report.results.length}`,
    `Skipped after failure: ${report.skipped.length}`,
    `Excluded before batch: ${report.excludedCount ?? report.excluded?.length ?? 0}`,
    `Executed: ${report.executedCount}`,
    `First failed: ${report.firstFailedProposalId ?? "none"}`
  ];
  if (report.stopReason) {
    lines.push(`Stop reason: ${report.stopReason}`);
  }
  if (report.nextCommand) {
    lines.push(`Next: ${report.nextCommand}`);
  }
  for (const action of report.recommendedNextActions ?? []) {
    lines.push(`Recommended: ${action}`);
  }
  for (const result of report.results) {
    lines.push(`- ${result.passed ? "passed" : "failed"} ${result.proposalId} [${result.state}]${result.error ? ` ${result.error}` : ""}`);
    for (const hint of result.firstFailedCheck?.remediationHints ?? []) {
      lines.push(`  hint: ${hint}`);
    }
  }
  for (const item of report.skipped) {
    lines.push(`- failure-skipped ${item.proposalId}: ${item.reason}`);
  }
  for (const item of report.excluded ?? []) {
    lines.push(`- excluded ${item.proposalId} [${item.applyState}]: ${item.reason}${item.supersededBy ? ` (superseded by ${item.supersededBy})` : ""}`);
  }
  lines.push(`Wrote ${report.outputPath}`);
  return lines.join("\n");
}

export function renderProposalRepairAcceptanceReport(report: ProposalRepairAcceptanceReport): string {
  return [
    `Repair acceptance: ${report.id}`,
    `Source proposal: ${report.sourceProposalId}`,
    `Retry proposal: ${report.retryProposalId}`,
    `Accepted: ${report.accepted ? "yes" : "no"}`,
    `Retry verification: ${report.retryVerificationPath}`,
    report.replanBriefPath ? `Replan brief: ${report.replanBriefPath}` : undefined,
    report.replanContextPath ? `Replan context: ${report.replanContextPath}` : undefined,
    report.notes ? `Notes: ${report.notes}` : undefined,
    "Checklist:",
    ...report.checklist.map((item) => `- ${item.status} ${item.text}${item.evidence ? ` (${item.evidence})` : ""}`),
    `Wrote ${report.outputPath}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

async function writeProposalReplanArtifacts(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  report: ProposalVerificationReport,
  task: MigrationTask,
  issueId: string
): Promise<ProposalReplanArtifactPaths> {
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "replans", proposal.id);
  const briefPath = path.join(dir, "replan-brief.md");
  const contextPath = path.join(dir, "replan-context.json");
  const firstFailedCheck = report.checks.find((check) => !check.passed);
  const action = proposal.actionId
    ? (await loadActionPlan(loaded, pkg).catch(() => undefined))?.actions.find((candidate) => candidate.id === proposal.actionId)
    : undefined;
  const context: ProposalReplanContext = {
    version: 1,
    artifactSchemaVersion: 1,
    createdAt: new Date().toISOString(),
    run: {
      id: pkg.run.id,
      goal: pkg.run.goal,
      status: pkg.run.status,
      targetRoot: pkg.run.targetRoot
    },
    proposal: {
      id: proposal.id,
      title: proposal.title,
      summary: proposal.summary,
      risk: proposal.risk,
      patchPath: proposal.patchPath,
      affectedFiles: proposal.affectedFiles,
      generatedFiles: proposal.generatedFiles ?? [],
      recommendedChecks: proposal.recommendedChecks,
      templateSelection: proposal.templateSelection,
      checkPlan: report.checkPlan ?? proposal.checkPlan,
      checkReadiness: action?.checkReadiness,
      sourceSnippets: await collectSourceSnippetIndex(pkg.run.targetRoot, proposal.affectedFiles)
    },
    failure: {
      issueId,
      taskId: task.id,
      verificationReportPath: report.outputPath,
      patchCheck: {
        passed: report.patchCheck.passed,
        skipped: report.patchCheck.skipped,
        command: report.patchCheck.command,
        exitCode: report.patchCheck.exitCode,
        stdout: clipText(report.patchCheck.stdout),
        stderr: clipText(report.patchCheck.stderr),
        error: report.patchCheck.error
      },
      firstFailedCheck: firstFailedCheck ? {
        command: firstFailedCheck.command,
        kind: firstFailedCheck.kind,
        phase: firstFailedCheck.phase,
        failureCategory: firstFailedCheck.failureCategory,
        exitCode: firstFailedCheck.exitCode,
        timedOut: firstFailedCheck.timedOut,
        stdout: clipText(firstFailedCheck.stdout),
        stderr: clipText(firstFailedCheck.stderr),
        error: firstFailedCheck.error,
        remediationHints: firstFailedCheck.remediationHints ?? []
      } : undefined,
      latestFailedOutput: firstFailedCheck ? {
        stdout: clipText(firstFailedCheck.stdout, 1200),
        stderr: clipText(firstFailedCheck.stderr, 1200)
      } : undefined,
      behaviorDrift: report.behaviorDrift,
      behaviorDriftDecisions: report.behaviorDrift
        ? await readBehaviorDriftDecisionSummaries(loaded, pkg.run.id, report.behaviorDrift)
        : undefined
    },
    acceptanceChecklist: createAiRepairAcceptanceChecklist(proposal, report),
    commands: {
      status: "migration-guard status --run latest",
      retryVerify: `migration-guard proposal verify --run latest --proposal ${proposal.id} --checks`,
      retryApply: `migration-guard action apply --run latest --proposal ${proposal.id} --rollback-on-fail`,
      runReplanTask: `migration-guard task run --run latest --task ${task.id}`
    },
    paths: {
      brief: briefPath,
      context: contextPath,
      verificationReport: report.outputPath,
      patch: proposal.patchPath
    }
  };

  await writeJsonFile(contextPath, context);
  await writeTextFile(briefPath, renderProposalReplanBrief(context));
  return { briefPath, contextPath };
}

async function createRepairAcceptanceItems(
  retryProposal: ProposedPatch,
  retryVerificationReport: ProposalVerificationReport
): Promise<ProposalRepairAcceptanceReport["checklist"]> {
  const context = retryProposal.replanContextPath && await pathExists(retryProposal.replanContextPath)
    ? await readJsonFile<Partial<ProposalReplanContext>>(retryProposal.replanContextPath).catch(() => undefined)
    : undefined;
  const checklist = context?.acceptanceChecklist?.length
    ? context.acceptanceChecklist
    : createAiRepairAcceptanceChecklist(retryProposal, retryVerificationReport);
  return [
    ...checklist.map((text) => ({
      text,
      status: "accepted" as const,
      evidence: retryVerificationReport.outputPath
    })),
    {
      text: "Latest retry verification passed.",
      status: retryVerificationReport.passed ? "accepted" as const : "needs-work" as const,
      evidence: retryVerificationReport.outputPath
    }
  ];
}

async function readBehaviorDriftDecisionSummaries(
  loaded: LoadedConfig,
  runId: string,
  behaviorDrift: ProposalBehaviorDriftReference
): Promise<ProposalReplanContext["failure"]["behaviorDriftDecisions"]> {
  if (!await pathExists(behaviorDrift.compareReportPath)) {
    return undefined;
  }
  const report = await readJsonFile<CompareReport>(behaviorDrift.compareReportPath).catch(() => undefined);
  if (!report) {
    return undefined;
  }
  const decisions = await decisionsForCompareReport(loaded, report, runId);
  return behaviorDrift.differences.map((difference) => {
    const decision = findDecisionForBehaviorDrift(difference, decisions);
    return {
      area: difference.area,
      name: difference.name,
      message: difference.message,
      classification: decision?.classification ?? "pending",
      reason: decision?.reason
    };
  });
}

function findDecisionForBehaviorDrift(
  difference: ProposalBehaviorDriftReference["differences"][number],
  decisions: DiffDecision[]
): DiffDecision | undefined {
  return decisions.find((decision) => {
    return decision.area === difference.area
      && decision.name === difference.name
      && decision.message === difference.message
      && decision.severity === difference.severity;
  });
}

function renderProposalReplanBrief(context: ProposalReplanContext): string {
  const failed = context.failure.firstFailedCheck;
  return [
    `# Replan Brief: ${context.proposal.id}`,
    "",
    "## Objective",
    "",
    `Repair or replace the failed proposal for run ${context.run.id}. Use the evidence below as the source of truth, then produce one small retryable proposal.`,
    "",
    "## Proposal",
    "",
    `- Title: ${context.proposal.title}`,
    `- Risk: ${context.proposal.risk}`,
    `- Patch: ${context.proposal.patchPath}`,
    context.proposal.templateSelection ? `- Probe template: ${context.proposal.templateSelection.template} (${context.proposal.templateSelection.reason})` : undefined,
    `- Affected files: ${context.proposal.affectedFiles.join(", ") || "none"}`,
    `- Generated files: ${context.proposal.generatedFiles.join(", ") || "none"}`,
    `- Check plan: ${context.proposal.checkPlan?.map((check) => `${check.kind}/${check.phase}`).join(", ") || "none"}`,
    ...(context.proposal.checkReadiness?.length ? [
      "- Check readiness:",
      ...context.proposal.checkReadiness.map((readiness) => `  - ${readiness.status}: ${readiness.command} (${readiness.reason})`)
    ] : []),
    "",
    "## Failure Evidence",
    "",
    `- Verification report: ${context.failure.verificationReportPath}`,
    `- Failure issue: ${context.failure.issueId}`,
    `- Replan task: ${context.failure.taskId}`,
    `- Patch check: ${context.failure.patchCheck.passed ? "passed" : "failed"}`,
    failed ? `- First failed check: ${failed.command}` : "- First failed check: none",
    failed?.kind ? `- Check kind: ${failed.kind}` : undefined,
    failed?.phase ? `- Check phase: ${failed.phase}` : undefined,
    failed?.failureCategory ? `- Failure category: ${failed.failureCategory}` : undefined,
    ...(failed?.remediationHints.length ? [
      "",
      "## Remediation Hints",
      "",
      ...failed.remediationHints.map((hint) => `- ${hint}`)
    ] : []),
    ...(context.proposal.sourceSnippets.length ? [
      "",
      "## Source Snippet Index",
      "",
      ...context.proposal.sourceSnippets.map((snippet) => [
        `### ${snippet.file}:${snippet.startLine}`,
        "",
        "```text",
        snippet.excerpt,
        "```"
      ].join("\n"))
    ] : []),
    ...(context.failure.behaviorDrift?.differences.length ? [
      "",
      "## Behavior Drift",
      "",
      `- Compare report: ${context.failure.behaviorDrift.compareReportPath}`,
      ...context.failure.behaviorDrift.differences.slice(0, 5).map((difference) => {
        const decision = context.failure.behaviorDriftDecisions?.find((candidate) => {
          return candidate.area === difference.area
            && candidate.name === difference.name
            && candidate.message === difference.message;
        });
        const decisionLabel = decision
          ? `${decision.classification}${decision.reason ? ` (${decision.reason})` : ""}`
          : "pending";
        return `- [${decisionLabel}] ${difference.severity} ${difference.area}/${difference.name}: ${difference.message}`;
      })
    ] : []),
    "",
    "## Minimal Context",
    "",
    `- Goal: ${context.run.goal}`,
    `- Target root: ${context.run.targetRoot}`,
    `- Context JSON: ${context.paths.context}`,
    "",
    "## Next AI Task",
    "",
    "Use this brief and the context JSON to create the smallest repair that addresses the failed gate. Do not broaden scope, weaken checks, or treat compile success alone as behavior proof.",
    "",
    "## AI Repair Acceptance Checklist",
    "",
    ...context.acceptanceChecklist.map((item) => `- ${item}`),
    "",
    "## Retry Commands",
    "",
    "```bash",
    context.commands.retryVerify,
    context.commands.retryApply,
    "```",
    "",
    failed?.stderr ? [
      "## First Failed Stderr Excerpt",
      "",
      "```text",
      failed.stderr,
      "```",
      ""
    ].join("\n") : undefined,
    failed?.stdout ? [
      "## First Failed Stdout Excerpt",
      "",
      "```text",
      failed.stdout,
      "```",
      ""
    ].join("\n") : undefined
  ].filter(Boolean).join("\n");
}

function clipText(text: string, maxLength = 4000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

async function collectSourceSnippetIndex(
  targetRoot: string,
  affectedFiles: string[],
  maxSnippets = 8
): Promise<ProposalReplanContext["proposal"]["sourceSnippets"]> {
  const snippets: ProposalReplanContext["proposal"]["sourceSnippets"] = [];
  for (const affectedFile of affectedFiles) {
    if (snippets.length >= maxSnippets) {
      break;
    }
    const absolute = path.join(targetRoot, affectedFile);
    if (!await pathExists(absolute)) {
      continue;
    }
    const stat = await fs.stat(absolute);
    if (stat.isFile()) {
      const snippet = await readSourceSnippet(targetRoot, absolute);
      if (snippet) {
        snippets.push(snippet);
      }
      continue;
    }
    if (stat.isDirectory()) {
      const files = await collectReadableSourceFiles(absolute);
      for (const file of files) {
        if (snippets.length >= maxSnippets) {
          break;
        }
        const snippet = await readSourceSnippet(targetRoot, file);
        if (snippet) {
          snippets.push(snippet);
        }
      }
    }
  }
  return snippets;
}

async function collectReadableSourceFiles(root: string): Promise<string[]> {
  const readableExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue"]);
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".wxt", ".output"]);
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < 25) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          stack.push(absolute);
        }
      } else if (entry.isFile() && readableExtensions.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

async function readSourceSnippet(
  targetRoot: string,
  absolutePath: string,
  maxLines = 80
): Promise<ProposalReplanContext["proposal"]["sourceSnippets"][number] | undefined> {
  const text = await fs.readFile(absolutePath, "utf8").catch(() => undefined);
  if (!text) {
    return undefined;
  }
  const lines = text.split(/\r?\n/).slice(0, maxLines);
  return {
    file: path.relative(targetRoot, absolutePath).replace(/\\/g, "/"),
    startLine: 1,
    endLine: lines.length,
    excerpt: clipText(lines.join("\n"), 2000)
  };
}

function createAiRepairAcceptanceChecklist(
  proposal: ProposedPatch,
  report: ProposalVerificationReport
): string[] {
  const failed = report.checks.find((check) => !check.passed);
  return [
    "Repair stays scoped to the source proposal's affected files or explains every additional file.",
    proposal.templateSelection
      ? `Probe template remains appropriate: ${proposal.templateSelection.template} (${proposal.templateSelection.reason}).`
      : "Probe template selection is reviewed before changing generated probes.",
    failed
      ? `The failed check now passes without weakening or removing it: ${failed.command}.`
      : "The failed gate is reproduced and the repaired proposal has a passing verification report.",
    "Latest stdout/stderr evidence is addressed directly, not ignored.",
    "Behavior diff is either clean or every risky difference is classified with a reason.",
    "Retry proposal links back to the source proposal and preserves the failure classification."
  ];
}

function createRetryProposalSummary(sourceProposal: ProposedPatch, report: ProposalVerificationReport): string {
  const failed = report.checks.find((check) => !check.passed);
  return [
    `Retry scaffold for failed proposal ${sourceProposal.id}.`,
    failed ? `First failed check: ${failed.command}.` : undefined,
    report.replanBriefPath ? `Use replan brief: ${report.replanBriefPath}.` : undefined
  ].filter(Boolean).join(" ");
}

function createRetryPatchContent(
  pkg: MigrationRunPackage,
  sourceProposal: ProposedPatch,
  report: ProposalVerificationReport
): string {
  const failed = report.checks.find((check) => !check.passed);
  return [
    "# Retry proposal scaffold",
    "#",
    `# Run: ${pkg.run.id}`,
    `# Goal: ${pkg.run.goal}`,
    `# Source proposal: ${sourceProposal.id}`,
    `# Verification report: ${report.outputPath}`,
    report.replanIssueId ? `# Replan issue: ${report.replanIssueId}` : undefined,
    report.replanTaskId ? `# Replan task: ${report.replanTaskId}` : undefined,
    report.replanBriefPath ? `# Replan brief: ${report.replanBriefPath}` : undefined,
    report.replanContextPath ? `# Replan context: ${report.replanContextPath}` : undefined,
    failed ? `# First failed check: ${failed.command}` : undefined,
    failed?.failureCategory ? `# Failure category: ${failed.failureCategory}` : undefined,
    "#",
    "# This scaffold intentionally does not mutate source code. Replace this file",
    "# with a focused git patch after using the replan brief/context to repair the",
    "# failed proposal, then run proposal verify/apply on the retry proposal.",
    ""
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function markReplanTaskDone(pkg: MigrationRunPackage, taskId: string | undefined, retryProposalId: string): void {
  if (!taskId) {
    return;
  }
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return;
  }
  task.status = "done";
  task.result = `Created retry proposal ${retryProposalId}.`;
  task.updatedAt = new Date().toISOString();
  const issue = pkg.issues.find((candidate) => candidate.taskId === task.id);
  if (issue) {
    issue.status = "done";
    issue.updatedAt = task.updatedAt;
  }
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

async function loadAllProposals(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<ProposedPatch[]> {
  const proposalsDir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals");
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
  return proposals;
}

function compareProposalsForBatch(a: ProposedPatch, b: ProposedPatch): number {
  const riskOrder = { low: 0, medium: 1, high: 2 };
  return riskOrder[a.risk] - riskOrder[b.risk] || a.createdAt.localeCompare(b.createdAt);
}

function createProposalBatchExcludedItem(proposal: ProposedPatch): ProposalBatchExcludedItem {
  return {
    proposalId: proposal.id,
    title: proposal.title,
    risk: proposal.risk,
    applyState: proposal.applyState,
    reason: proposal.exclusion?.reason ?? exclusionReasonForState(proposal.applyState),
    supersededBy: proposal.exclusion?.supersededBy
  };
}

function exclusionReasonForState(state: ProposedPatch["applyState"]): string {
  switch (state) {
    case "rejected":
      return "proposal was rejected";
    case "ignored":
      return "proposal was ignored";
    case "applied":
      return "proposal is already applied";
    case "applied-with-failed-checks":
      return "proposal is applied with failed checks";
    case "rolled-back":
      return "proposal was rolled back";
    case "rollback-failed":
      return "proposal rollback failed";
    case "verification-failed":
      return "proposal verification failed";
    case "proposed":
    case "verified":
      return "proposal was not selected by this batch limit";
    default:
      return `proposal state is ${state}`;
  }
}

async function latestProposalVerificationPath(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposalId: string
): Promise<string | undefined> {
  const status = await getProposalStatus(loaded, pkg, proposalId);
  return status.verificationReports.at(-1);
}

async function checkPatchApplicability(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  patchContent: string
): Promise<ProposalPatchCheck> {
  const command = `git apply --check "${proposal.patchPath}"`;
  if (!isGitPatchContent(patchContent)) {
    const now = new Date().toISOString();
    return {
      command,
      cwd: pkg.run.targetRoot,
      skipped: true,
      passed: true,
      exitCode: 0,
      durationMs: 0,
      startedAt: now,
      endedAt: now,
      stdout: "",
      stderr: ""
    };
  }

  const startedAt = new Date().toISOString();
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
    startedAt,
    endedAt: new Date().toISOString(),
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

async function runProposalChecks(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  env?: Record<string, string>,
  gatePolicy: ProposalGatePolicy = DEFAULT_GATE_POLICY
): Promise<ProposalCommandCheck[]> {
  return runProposalCheckCommands(loaded, pkg, ensureProposalCheckPlan(loaded, proposal), env, gatePolicy);
}

async function runProposalCheckCommands(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  plan: ProposalCheckPlanItem[],
  env?: Record<string, string>,
  gatePolicy: ProposalGatePolicy = DEFAULT_GATE_POLICY
): Promise<ProposalCommandCheck[]> {
  const checks: ProposalCommandCheck[] = [];

  for (const item of plan) {
    const check = await runProposalCheckCommand(loaded, pkg, item, env);
    checks.push(check);
    if (shouldStopForGatePolicy(gatePolicy, check)) {
      break;
    }
  }

  return checks;
}

async function runProposalCheckCommand(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  item: ProposalCheckPlanItem,
  env?: Record<string, string>
): Promise<ProposalCommandCheck> {
  const retry = item.retry ?? configuredRetryForCheckKind(loaded, item.kind);
  const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
  const attempts: ProposalCheckAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    const result = await runShellCommand(item.command, {
      cwd: pkg.run.targetRoot,
      timeoutMs: item.timeoutMs ?? 120000,
      maxOutputBytes: loaded.config.output.maxOutputBytes,
      env
    });
    const endedAt = new Date().toISOString();
    const attemptResult = commandResultToProposalAttempt(result, attempt, startedAt, endedAt);
    attempts.push(attemptResult);

    if (attemptResult.passed || !shouldRetryCheck(attemptResult, retry, attempt, maxAttempts)) {
      break;
    }
    await delay(retry?.delayMs ?? 1000);
  }

  const finalAttempt = attempts.at(-1);
  if (!finalAttempt) {
    throw new Error(`No check attempts were recorded for command: ${item.command}`);
  }

  return {
    command: item.command,
    cwd: pkg.run.targetRoot,
    kind: item.kind,
    phase: item.phase,
    critical: item.critical,
    resourceProfile: item.resourceProfile,
    retry,
    attemptCount: attempts.length,
    attempts,
    failureCategory: finalAttempt.failureCategory,
    flakeSuspected: attempts.some((attempt) => attempt.flakeSuspected),
    passed: attempts.some((attempt) => attempt.passed),
    exitCode: finalAttempt.exitCode,
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    startedAt: attempts[0]?.startedAt,
    endedAt: finalAttempt.endedAt,
    stdout: finalAttempt.stdout,
    stderr: finalAttempt.stderr,
    stdoutTruncated: finalAttempt.stdoutTruncated,
    stderrTruncated: finalAttempt.stderrTruncated,
    timedOut: finalAttempt.timedOut,
    error: finalAttempt.error,
    remediationHints: finalAttempt.passed ? undefined : createRemediationHints(item, finalAttempt.failureCategory)
  };
}

async function runProposalChecksForApply(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  gatePolicy: ProposalGatePolicy = DEFAULT_GATE_POLICY
): Promise<{ checks: ProposalCommandCheck[]; preview?: ProposalPreviewResult }> {
  if (!proposal.preview) {
    return {
      checks: await runProposalChecks(loaded, pkg, proposal, undefined, gatePolicy)
    };
  }

  const split = splitPreviewChecks(ensureProposalCheckPlan(loaded, proposal));
  const regularChecks = await runProposalCheckCommands(loaded, pkg, split.regularChecks, undefined, gatePolicy);
  if (regularChecks.some((check) => shouldStopForGatePolicy(gatePolicy, check))) {
    return { checks: regularChecks };
  }
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
    previewChecks = await runProposalCheckCommands(loaded, pkg, split.previewChecks, session.env, gatePolicy);
  } finally {
    preview = await session.stop();
  }

  return {
    checks: [...regularChecks, ...previewChecks],
    preview
  };
}

async function runProposalChecksForVerify(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  patchContent: string,
  gatePolicy: ProposalGatePolicy = DEFAULT_GATE_POLICY
): Promise<{ checks: ProposalCommandCheck[]; preview?: ProposalPreviewResult; temporaryApply?: ProposalTemporaryApply }> {
  if (!isGitPatchContent(patchContent)) {
    return runProposalChecksForApply(loaded, pkg, proposal, gatePolicy);
  }

  const apply = await runShellCommand(`git apply "${proposal.patchPath}"`, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const applyCheck = commandResultToProposalCheck(apply);
  const temporaryApply: ProposalTemporaryApply = {
    applied: applyCheck.passed,
    rolledBack: false,
    passed: false,
    apply: applyCheck
  };

  let checks: ProposalCommandCheck[] = [];
  let preview: ProposalPreviewResult | undefined;
  try {
    if (applyCheck.passed) {
      const checkRun = await runProposalChecksForApply(loaded, pkg, proposal, gatePolicy);
      checks = checkRun.checks;
      preview = checkRun.preview;
    }
  } finally {
    if (applyCheck.passed) {
      const rollback = await runShellCommand(`git apply -R "${proposal.patchPath}"`, {
        cwd: pkg.run.targetRoot,
        timeoutMs: 30000,
        maxOutputBytes: loaded.config.output.maxOutputBytes
      });
      const rollbackCheck = commandResultToProposalCheck(rollback);
      temporaryApply.rollback = rollbackCheck;
      temporaryApply.rolledBack = rollbackCheck.passed;
    }
  }

  temporaryApply.passed = temporaryApply.applied && temporaryApply.rolledBack;
  return {
    checks,
    preview,
    temporaryApply
  };
}

function splitPreviewChecks(plan: ProposalCheckPlanItem[]): { regularChecks: ProposalCheckPlanItem[]; previewChecks: ProposalCheckPlanItem[] } {
  const previewChecks = plan.filter((check) => check.phase === "preview");
  const previewCheckSet = new Set(previewChecks.map((check) => check.command));
  return {
    regularChecks: plan.filter((check) => !previewCheckSet.has(check.command)),
    previewChecks
  };
}

function createProposalGateTimeline(
  patchCheck: ProposalPatchCheck,
  checks: ProposalCommandCheck[],
  preview?: ProposalPreviewResult
): ProposalGateEvent[] {
  const events: ProposalGateEvent[] = [
    {
      type: "patch-check",
      status: patchCheck.skipped ? "skipped" : patchCheck.passed ? "passed" : "failed",
      label: "Patch applicability",
      command: patchCheck.command,
      startedAt: patchCheck.startedAt,
      endedAt: patchCheck.endedAt,
      durationMs: patchCheck.durationMs,
      message: patchCheck.error
    }
  ];
  let previewInserted = false;

  for (const check of checks) {
    if (check.phase === "preview" && preview && !previewInserted) {
      events.push(createPreviewGateEvent(preview));
      previewInserted = true;
    }

    events.push({
      type: "check",
      status: check.passed ? "passed" : "failed",
      label: check.kind ? `${check.kind}: ${check.command}` : check.command,
      command: check.command,
      kind: check.kind,
      phase: check.phase,
      startedAt: check.startedAt,
      endedAt: check.endedAt,
      durationMs: check.durationMs,
      message: check.flakeSuspected
        ? `flake-suspected after ${check.attemptCount ?? 1} attempt(s)`
        : check.failureCategory ?? check.error
    });
  }

  if (preview && !previewInserted) {
    events.push(createPreviewGateEvent(preview));
  }

  return events;
}

function createPreviewGateEvent(preview: ProposalPreviewResult): ProposalGateEvent {
  return {
    type: "preview",
    status: preview.ready ? "passed" : "failed",
    label: `Preview ${preview.ready ? "ready" : "failed"}`,
    phase: "preview",
    kind: "ui-probe",
    command: preview.command,
    url: preview.url,
    outputPath: preview.outputPath,
    startedAt: preview.startedAt,
    endedAt: preview.endedAt,
    durationMs: preview.durationMs,
    message: preview.error
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
  preview?: ProposalPreviewResult,
  gatePolicy: ProposalGatePolicy = DEFAULT_GATE_POLICY,
  behaviorDiff?: ProposalBehaviorDiffReport,
  temporaryApply?: ProposalTemporaryApply
): Promise<ProposalVerificationReport> {
  const outputPath = path.join(proposalDir(loaded, pkg, proposal.id), `verification-${Date.now()}.json`);
  const checkPlan = ensureProposalCheckPlan(loaded, proposal);
  const timeline = createProposalGateTimeline(patchCheck, checks, preview);
  const passed = patchCheck.passed && (temporaryApply?.passed ?? true) && (preview?.ready ?? true) && checks.every((check) => check.passed);
  const report: ProposalVerificationReport = {
    version: 1,
    artifactSchemaVersion: 1,
    id: createId("proposal-verification"),
    runId: pkg.run.id,
    proposalId: proposal.id,
    mode,
    createdAt: new Date().toISOString(),
    patchPath: proposal.patchPath,
    applied,
    passed,
    patchCheck,
    checkPlan,
    gatePolicy,
    preview,
    temporaryApply,
    checks,
    timeline,
    behaviorDiff,
    outputPath
  };
  if (!passed) {
    report.behaviorDrift = await readLatestBehaviorDriftReference(loaded, pkg, checks);
  }

  await writeJsonFile(outputPath, report);
  return report;
}

async function captureProposalBehaviorSnapshot(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): Promise<Snapshot> {
  return captureSnapshot({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  }, "run");
}

async function writeProposalBehaviorDiff(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  before: Snapshot
): Promise<ProposalBehaviorDiffReport> {
  const after = await captureProposalBehaviorSnapshot(loaded, pkg);
  const compare = compareSnapshots(before, after, loaded.config.compare);
  const id = createId("behavior-diff");
  const dir = proposalDir(loaded, pkg, proposal.id);
  const beforeSnapshotPath = path.join(dir, `${id}-before.json`);
  const afterSnapshotPath = path.join(dir, `${id}-after.json`);
  const compareReportPath = path.join(dir, `${id}-compare.json`);
  const compareMarkdownPath = path.join(dir, `${id}-compare.md`);
  await writeJsonFile(beforeSnapshotPath, before);
  await writeJsonFile(afterSnapshotPath, after);
  await writeJsonFile(compareReportPath, compare);
  await writeTextFile(compareMarkdownPath, renderCompareReport(compare, await decisionsForCompareReport(loaded, compare, pkg.run.id)));
  const errors = compare.differences.filter((difference) => difference.severity === "error").length;
  const warnings = compare.differences.filter((difference) => difference.severity === "warn").length;
  return {
    beforeSnapshotPath,
    afterSnapshotPath,
    compareReportPath,
    compareMarkdownPath,
    beforeSnapshotId: before.id,
    afterSnapshotId: after.id,
    passed: compare.passed,
    differenceCount: compare.differences.length,
    errorCount: errors,
    warningCount: warnings,
    differences: compare.differences.slice(0, 10).map((difference) => ({
      severity: difference.severity,
      area: difference.area,
      name: difference.name,
      message: difference.message
    }))
  };
}

async function readLatestBehaviorDriftReference(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  checks: ProposalCommandCheck[]
): Promise<ProposalBehaviorDriftReference | undefined> {
  const latest = await latestCompareReportCandidate(loaded, pkg);
  if (!latest) {
    return undefined;
  }
  const compareReport = await readJsonFile<CompareReport>(latest.path).catch(() => undefined);
  if (!compareReport) {
    return undefined;
  }
  const failedChecks = checks.filter((check) => !check.passed);
  const differences = compareReport.differences
    .filter((difference) => difference.area === "check" || difference.area === "probe")
    .filter((difference) => difference.severity === "error" || difference.severity === "warn")
    .slice(0, 10)
    .map((difference) => ({
      severity: difference.severity,
      area: difference.area as "check" | "probe",
      name: difference.name,
      message: difference.message,
      before: difference.before,
      after: difference.after,
      relatedFailedCommand: relatedFailedCommandForDifference(difference.name, failedChecks)
    }));
  if (differences.length === 0) {
    return undefined;
  }
  return {
    compareReportPath: latest.path,
    baselineId: compareReport.baselineId,
    currentId: compareReport.currentId,
    passed: compareReport.passed,
    differences
  };
}

async function latestCompareReportCandidate(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage
): Promise<{ path: string; mtimeMs: number } | undefined> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of [
    path.join(loaded.artifactsDir, "compare"),
    path.join(migrationRunDir(loaded, pkg.run.id), "verifications")
  ]) {
    if (!await pathExists(dir)) {
      continue;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      if (path.basename(dir) === "verifications" && !entry.name.endsWith("-compare.json")) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

function relatedFailedCommandForDifference(name: string, failedChecks: ProposalCommandCheck[]): string | undefined {
  const normalizedName = name.toLowerCase();
  return failedChecks.find((check) => {
    const command = check.command.toLowerCase();
    return command.includes(normalizedName) || normalizedName.includes(command);
  })?.command;
}

async function recordProposalGateFailure(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  proposal: ProposedPatch,
  report: ProposalVerificationReport
): Promise<void> {
  const issue = createProposalFailureIssue(pkg, proposal, report);
  const task = createProposalReplanTask(pkg, proposal, report, issue.id);
  report.replanIssueId = issue.id;
  report.replanTaskId = task.id;
  await writeJsonFile(report.outputPath, report);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: task.id,
    issueId: issue.id,
    type: "replan",
    message: `Created replan issue ${issue.id} and task ${task.id} for failed proposal ${proposal.id}`,
    data: {
      proposalId: proposal.id,
      actionId: proposal.actionId,
      replanTaskId: task.id,
      outputPath: report.outputPath,
      failedChecks: report.checks.filter((check) => !check.passed).map((check) => ({
        command: check.command,
        kind: check.kind,
        phase: check.phase,
        exitCode: check.exitCode,
        timedOut: check.timedOut
      }))
    }
  });
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
    const now = new Date().toISOString();
    return {
      command,
      cwd: pkg.run.targetRoot,
      skipped: true,
      passed: true,
      exitCode: 0,
      durationMs: 0,
      startedAt: now,
      endedAt: now,
      stdout: "",
      stderr: ""
    };
  }

  const startedAt = new Date().toISOString();
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
    startedAt,
    endedAt: new Date().toISOString(),
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

function commandResultToProposalCheck(
  result: Awaited<ReturnType<typeof runShellCommand>>,
  plan?: ProposalCheckPlanItem,
  startedAt?: string,
  endedAt?: string
): ProposalCommandCheck {
  return {
    command: result.command,
    cwd: result.cwd,
    kind: plan?.kind,
    phase: plan?.phase,
    critical: plan?.critical,
    passed: result.exitCode === 0 && !result.timedOut && !result.error,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    startedAt,
    endedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    error: result.error
  };
}

function commandResultToProposalAttempt(
  result: Awaited<ReturnType<typeof runShellCommand>>,
  attempt: number,
  startedAt: string,
  endedAt: string
): ProposalCheckAttempt {
  const noOp = result.exitCode === 0 && isNoOpCheckOutput(`${result.stdout}\n${result.stderr}`);
  const passed = result.exitCode === 0 && !result.timedOut && !result.error && !noOp;
  const failureCategory = passed ? undefined : classifyCheckFailure(result);
  return {
    attempt,
    passed,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    startedAt,
    endedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    error: result.error,
    failureCategory,
    flakeSuspected: failureCategory === "flake-suspected"
  };
}

function classifyCheckFailure(result: Awaited<ReturnType<typeof runShellCommand>>): ProposalCheckFailureCategory {
  const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`.toLowerCase();
  if (result.timedOut) {
    return "timeout";
  }
  if (result.exitCode === 0 && isNoOpCheckOutput(output)) {
    return "no-op";
  }
  if (isFlakeSuspectedOutput(output)) {
    return "flake-suspected";
  }
  if (result.error) {
    return "error";
  }
  return "command-failed";
}

function isFlakeSuspectedOutput(output: string): boolean {
  return [
    "vitest-pool",
    "timeout waiting for worker",
    "failed to start forks worker",
    "eaddrinuse",
    "econnreset",
    "socket hang up",
    "fetch failed"
  ].some((pattern) => output.includes(pattern));
}

function isNoOpCheckOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return [
    "none of the selected packages has a",
    "no projects matched the filters",
    "no projects matched the filters in",
    "no matching projects found"
  ].some((pattern) => normalized.includes(pattern));
}

function configuredRetryForCheckKind(loaded: LoadedConfig, kind: ProposalCheckKind) {
  return loaded.config.proposalGate.retry?.[kind];
}

function shouldRetryCheck(
  attempt: ProposalCheckAttempt,
  retry: ProposalCheckPlanItem["retry"],
  attemptNumber: number,
  maxAttempts: number
): boolean {
  if (attempt.passed || !attempt.failureCategory || attemptNumber >= maxAttempts) {
    return false;
  }
  const retryOn = retry?.retryOn ?? ["flake-suspected"];
  return retryOn.includes(attempt.failureCategory);
}

function shouldStopForGatePolicy(policy: ProposalGatePolicy, check: ProposalCommandCheck): boolean {
  return policy.mode === "fail-fast" && check.critical !== false && !check.passed;
}

function firstFailedCheckSummary(report: ProposalVerificationReport): ProposalBatchResult["firstFailedCheck"] {
  const failed = report.checks.find((check) => !check.passed);
  if (!failed) {
    return undefined;
  }
  return {
    command: failed.command,
    kind: failed.kind,
    phase: failed.phase,
    failureCategory: failed.failureCategory,
    remediationHints: failed.remediationHints
  };
}

function createBatchStopReason(proposalId: string, report: ProposalVerificationReport): string {
  const failed = firstFailedCheckSummary(report);
  if (!failed) {
    return `Stopped after proposal ${proposalId} failed.`;
  }
  const category = failed.failureCategory ? ` (${failed.failureCategory})` : "";
  return `Stopped after proposal ${proposalId} failed at ${failed.command}${category}.`;
}

function firstFailedProposalReplanCommand(results: ProposalBatchResult[]): string | undefined {
  const failed = results.find((result) => !result.passed);
  return failed ? `migration-guard proposal replan --run latest --proposal ${failed.proposalId}` : undefined;
}

function createBatchRecommendedNextActions(failedResult?: ProposalBatchResult): string[] | undefined {
  if (!failedResult) {
    return undefined;
  }
  return [
    `Run proposal replan for ${failedResult.proposalId}.`,
    "Inspect the first failed check remediation hints before retrying the batch.",
    "Keep skipped proposals unapplied until the failed proposal is replanned or rolled back."
  ];
}

function resolveGatePolicy(
  loaded: LoadedConfig,
  policy?: ProposalGatePolicy,
  configKey: "defaultPolicy" | "batchPolicy" = "defaultPolicy"
): ProposalGatePolicy {
  if (!policy) {
    return {
      mode: validateGatePolicyMode(loaded.config.proposalGate[configKey])
    };
  }
  return {
    mode: validateGatePolicyMode(policy.mode)
  };
}

function validateGatePolicyMode(mode: ProposalGatePolicyMode): ProposalGatePolicyMode {
  if (mode === "fail-fast" || mode === "collect-all") {
    return mode;
  }
  throw new Error(`Unknown proposal gate policy: ${mode}`);
}

function createRemediationHints(
  item: ProposalCheckPlanItem,
  failureCategory?: ProposalCheckFailureCategory
): string[] | undefined {
  if (!failureCategory) {
    return undefined;
  }
  const hints: string[] = [];
  if (failureCategory === "flake-suspected") {
    hints.push("Retry the check once in isolation before changing source code.");
    if (item.resourceProfile === "cpu-bound") {
      hints.push("Lower test worker concurrency or run the affected test package alone.");
    }
    if (item.resourceProfile === "browser" || item.phase === "preview") {
      hints.push("Check preview port availability and rerun the UI probe with a fresh preview server.");
    }
  } else if (failureCategory === "timeout") {
    hints.push("Confirm the command is not waiting for interactive input or a stuck server.");
    hints.push("Increase timeout only after the same command passes manually.");
    if (item.phase === "preview") {
      hints.push("Inspect the preview report and verify the preview URL becomes ready before the probe starts.");
    }
  } else if (failureCategory === "command-failed") {
    hints.push("Inspect stdout/stderr in the verification report and rerun the command from the target root.");
    hints.push("Keep the proposal rolled back until the failing command has a focused remediation plan.");
  } else if (failureCategory === "no-op") {
    hints.push("The command exited successfully but did not run a real check.");
    hints.push("Replace it with a package script or direct command that actually executes for the selected target.");
  } else if (failureCategory === "error") {
    hints.push("Check the command path, cwd, shell availability and required environment variables.");
  }
  return hints;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function ensureProposalCheckPlan(loaded: LoadedConfig, proposal: ProposedPatch): ProposalCheckPlanItem[] {
  if (proposal.checkPlan && proposal.checkPlan.length > 0) {
    return proposal.checkPlan;
  }

  proposal.checkPlan = createProposalCheckPlan(loaded, proposal.recommendedChecks, proposal.preview ? proposal.generatedFiles ?? [] : []);
  return proposal.checkPlan;
}

function createProposalCheckPlan(loaded: LoadedConfig, commands: string[], generatedFiles: string[] = []): ProposalCheckPlanItem[] {
  return [...new Set(commands)].map((command) => classifyProposalCheck(loaded, command, generatedFiles));
}

function classifyProposalCheck(loaded: LoadedConfig, command: string, generatedFiles: string[]): ProposalCheckPlanItem {
  const normalized = command.toLowerCase();
  const usesGeneratedProbe = generatedFiles.some((file) => command.includes(file));
  if (command.includes("MG_PREVIEW_URL") || usesGeneratedProbe) {
    return {
      command,
      kind: "ui-probe",
      phase: "preview",
      timeoutMs: 120000,
      critical: true,
      retry: configuredRetryForCheckKind(loaded, "ui-probe"),
      resourceProfile: "browser",
      reason: usesGeneratedProbe ? "generated probe depends on preview URL" : "command references MG_PREVIEW_URL"
    };
  }

  const kind = inferProposalCheckKind(normalized);
  return {
    command,
    kind,
    phase: "pre-preview",
    timeoutMs: defaultTimeoutForCheckKind(kind),
    critical: true,
    retry: configuredRetryForCheckKind(loaded, kind),
    resourceProfile: defaultResourceProfileForCheckKind(kind),
    reason: `classified from command: ${kind}`
  };
}

function inferProposalCheckKind(command: string): ProposalCheckKind {
  if (/\b(vitest|jest|mocha|ava|test)\b/.test(command)) {
    return "unit-test";
  }
  if (/\b(type-check|typecheck|vue-tsc|tsc\s+--noemit)\b/.test(command)) {
    return "type-check";
  }
  if (/\b(build|vite build|webpack|rollup)\b/.test(command)) {
    return "build";
  }
  if (/\b(lint|eslint|biome)\b/.test(command)) {
    return "lint";
  }
  if (/\b(contract|dual-run)\b/.test(command)) {
    return "contract-probe";
  }
  return "other";
}

function defaultTimeoutForCheckKind(kind: ProposalCheckKind): number {
  switch (kind) {
    case "unit-test":
      return 180000;
    case "type-check":
      return 180000;
    case "build":
      return 300000;
    case "ui-probe":
      return 120000;
    case "contract-probe":
      return 120000;
    case "lint":
    case "other":
    default:
      return 120000;
  }
}

function defaultResourceProfileForCheckKind(kind: ProposalCheckKind): ProposalCheckPlanItem["resourceProfile"] {
  switch (kind) {
    case "unit-test":
    case "type-check":
    case "build":
      return "cpu-bound";
    case "ui-probe":
      return "browser";
    case "contract-probe":
      return "io-bound";
    case "lint":
    case "other":
    default:
      return "default";
  }
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
  const templateSelection = selectProbeTemplateForAction(action);
  const template = templateSelection.template;
  const definition = getProbeTemplateDefinition(template);
  if (definition.scriptBuilder === "ui-smoke") {
    return createUiSmokeProbeScript(goal, action);
  }

  const requiredFiles = action.affectedFiles.length > 0 ? action.affectedFiles : ["package.json"];
  const checks = createProbeChecks(template);

  return [
    "import { existsSync, readdirSync, readFileSync, statSync } from \"node:fs\";",
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
    "const inspectedTexts = [];",
    "",
    "for (const relativeFile of action.requiredFiles) {",
    "  const absoluteFile = path.join(root, relativeFile);",
    "  const exists = existsSync(absoluteFile);",
    "  const inspectedFiles = exists ? collectReadableFiles(absoluteFile, relativeFile) : [];",
    "  const text = inspectedFiles.map((file) => readUtf8(path.join(root, file))).join(\"\\n\");",
    "  if (exists) {",
    "    inspectedTexts.push(text);",
    "  }",
    "  results.push({ file: relativeFile, exists, inspectedFiles });",
    "}",
    "",
    "const actionText = inspectedTexts.join(\"\\n\");",
    "const actionChecks = [",
    ...checks.map((check) => `  { name: ${JSON.stringify(check.name)}, passed: ${check.pattern}.test(actionText) },`),
    "];",
    "const failed = [",
    "  ...results.filter((result) => !result.exists).map((result) => `missing:${result.file}`),",
    "  ...actionChecks.filter((check) => !check.passed).map((check) => `action:${check.name}`)",
    "];",
    "",
    "console.log(JSON.stringify({",
    "  actionId: action.id,",
    "  title: action.title,",
    "  goal: action.goal,",
    "  template: action.template,",
    "  passed: failed.length === 0,",
    "  actionChecks,",
    "  results,",
    "  failed",
    "}, null, 2));",
    "",
    "if (failed.length > 0) {",
    "  process.exitCode = 1;",
    "}",
    "",
    "function collectReadableFiles(absolutePath, relativePath) {",
    "  const stat = statSync(absolutePath);",
    "  if (stat.isFile()) {",
    "    return [relativePath.replace(/\\\\/g, \"/\")];",
    "  }",
    "  if (!stat.isDirectory()) {",
    "    return [];",
    "  }",
    "  const ignoredDirectories = new Set([\".git\", \"node_modules\", \"dist\", \"build\", \"coverage\"]);",
    "  const readableExtensions = new Set([\".cjs\", \".js\", \".json\", \".jsx\", \".mjs\", \".ts\", \".tsx\", \".vue\"]);",
    "  const files = [];",
    "  const stack = [{ absolute: absolutePath, relative: relativePath }];",
    "  while (stack.length > 0) {",
    "    const current = stack.pop();",
    "    for (const entry of readdirSync(current.absolute, { withFileTypes: true })) {",
    "      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {",
    "        continue;",
    "      }",
    "      const childAbsolute = path.join(current.absolute, entry.name);",
    "      const childRelative = path.join(current.relative, entry.name).replace(/\\\\/g, \"/\");",
    "      if (entry.isDirectory()) {",
    "        stack.push({ absolute: childAbsolute, relative: childRelative });",
    "      } else if (entry.isFile() && readableExtensions.has(path.extname(entry.name))) {",
    "        files.push(childRelative);",
    "      }",
    "    }",
    "  }",
    "  return files.sort().slice(0, 100);",
    "}",
    "",
    "function readUtf8(filePath) {",
    "  try {",
    "    return readFileSync(filePath, \"utf8\");",
    "  } catch {",
    "    return \"\";",
    "  }",
    "}",
    ""
  ].join("\n");
}

function createUiSmokeProbeScript(goal: string, action: MigrationAction): string {
  const requiredFiles = action.affectedFiles.length > 0 ? action.affectedFiles : ["package.json"];

  return [
    "import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from \"node:fs\";",
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
    "  const inspectedFiles = exists ? collectReadableFiles(absoluteFile, relativeFile) : [];",
    "  const vueFiles = inspectedFiles.filter((file) => path.extname(file) === \".vue\");",
    "  const text = inspectedFiles.map((file) => readUtf8(path.join(root, file))).join(\"\\n\");",
    "  return {",
    "    file: relativeFile,",
    "    exists,",
    "    inspectedFiles,",
    "    vueFiles,",
    "    checkMode: vueFiles.length > 0 ? \"vue-sfc\" : \"ts-support\",",
    "    hasTemplate: /<template[\\s>]/i.test(text),",
    "    hasScript: /<script[\\s>]/i.test(text),",
    "    hasModuleSignal: /\\b(import|export)\\b/.test(text),",
    "    hasStructureSignal: /\\b(interface|type|enum|class|function|const)\\b/.test(text)",
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
    "    continue;",
    "  }",
    "  if (result.inspectedFiles.length === 0) {",
    "    failed.push(`${result.file}:no-readable-files`);",
    "    continue;",
    "  }",
    "  if (result.checkMode === \"vue-sfc\") {",
    "    if (!result.hasTemplate) {",
    "      failed.push(`${result.file}:missing-template`);",
    "    }",
    "    if (!result.hasScript) {",
    "      failed.push(`${result.file}:missing-script`);",
    "    }",
    "  } else {",
    "    if (!result.hasModuleSignal) {",
    "      failed.push(`${result.file}:missing-module-signal`);",
    "    }",
    "    if (!result.hasStructureSignal) {",
    "      failed.push(`${result.file}:missing-structure-signal`);",
    "    }",
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
    "",
    "function collectReadableFiles(absolutePath, relativePath) {",
    "  const stat = statSync(absolutePath);",
    "  if (stat.isFile()) {",
    "    return [relativePath.replace(/\\\\/g, \"/\")];",
    "  }",
    "  if (!stat.isDirectory()) {",
    "    return [];",
    "  }",
    "  const ignoredDirectories = new Set([\".git\", \"node_modules\", \"dist\", \"build\", \"coverage\"]);",
    "  const readableExtensions = new Set([\".cjs\", \".js\", \".json\", \".jsx\", \".mjs\", \".ts\", \".tsx\", \".vue\"]);",
    "  const files = [];",
    "  const stack = [{ absolute: absolutePath, relative: relativePath }];",
    "  while (stack.length > 0) {",
    "    const current = stack.pop();",
    "    for (const entry of readdirSync(current.absolute, { withFileTypes: true })) {",
    "      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {",
    "        continue;",
    "      }",
    "      const childAbsolute = path.join(current.absolute, entry.name);",
    "      const childRelative = path.join(current.relative, entry.name).replace(/\\\\/g, \"/\");",
    "      if (entry.isDirectory()) {",
    "        stack.push({ absolute: childAbsolute, relative: childRelative });",
    "      } else if (entry.isFile() && readableExtensions.has(path.extname(entry.name))) {",
    "        files.push(childRelative);",
    "      }",
    "    }",
    "  }",
    "  return files.sort().slice(0, 100);",
    "}",
    "",
    "function readUtf8(filePath) {",
    "  try {",
    "    return readFileSync(filePath, \"utf8\");",
    "  } catch {",
    "    return \"\";",
    "  }",
    "}",
    ""
  ].join("\n");
}

function createProbeChecks(template: MigrationActionPatchTemplate): Array<{ name: string; pattern: string }> {
  return getProbeTemplateDefinition(template).checks;
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

function isBatchCandidateState(state: ProposedPatch["applyState"]): boolean {
  return state === "proposed" || state === "verified";
}

function isExcludedProposalState(state: ProposedPatch["applyState"]): boolean {
  return state === "rejected" || state === "ignored";
}

function assertProposalIsNotExcluded(proposal: ProposedPatch, action: string): void {
  if (isExcludedProposalState(proposal.applyState)) {
    const verb = action === "verify" ? "verified" : action === "apply" ? "applied" : "rolled back";
    throw new Error(`Proposal ${proposal.id} is ${proposal.applyState}; it cannot be ${verb}.`);
  }
}

function isPreApplyState(state: ProposedPatch["applyState"]): boolean {
  return state === "proposed" || state === "verified" || state === "verification-failed";
}
