import type {
  IssueControlProgressAutomationDecision,
  IssueControlProgressStatusItem,
  IssueControlProgressStatusReport,
  IssueControlSuperviseControlOptions,
  IssueControlSuperviseProgressItem,
  IssueControlSuperviseProgressLedger
} from "../issueControl.js";
import { createIssueControlAdaptiveGate, createIssueControlSafetyEnvelopeFromLedger, failedSafetyChecks } from "./safetyPolicy.js";

export function createIssueControlProgressStatusReport(
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

export function toIssueControlProgressStatusItem(item: IssueControlSuperviseProgressItem): IssueControlProgressStatusItem {
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


function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(value) ? value : JSON.stringify(value);
}
