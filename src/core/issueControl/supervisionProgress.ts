import type {
  IssueControlSuperviseIteration,
  IssueControlSuperviseProgressEvent,
  IssueControlSuperviseProgressItem,
  IssueControlSuperviseProgressLedger,
  IssueControlSuperviseProgressState,
  IssueControlSuperviseReport,
  IssueControlSuperviseSelectionItem
} from "../issueControl.js";

export function createIssueControlSuperviseProgressLedger(report: IssueControlSuperviseReport): IssueControlSuperviseProgressLedger {
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


