import type {
  IssueControlAdvanceLoopReport,
  IssueControlAdvanceLoopState,
  IssueControlAdvanceReport,
  IssueControlAdvanceSchedulerReport,
  IssueControlSyncGateReport
} from "../issueControl.js";
import { escapeMarkdownCell as escapeCell } from "./renderHelpers.js";

export function renderIssueControlAdvance(report: IssueControlAdvanceReport): string {
  return [
    `# Issue Control Advance: ${report.id}`, "", `- Mode: ${report.mode}`, `- Status: ${report.status}`,
    `- Decision: ${report.automationDecision.disposition}`,
    `- Can auto continue: ${report.automationDecision.canAutoContinue ? "yes" : "no"}`,
    `- Requires human: ${report.automationDecision.requiresHuman ? "yes" : "no"}`, `- Reason: ${report.reason}`,
    `- Next command: ${report.nextCommand ?? "none"}`, `- Supervise status: ${report.superviseStatus ?? "none"}`,
    "", "## Artifacts", "", `- Source ledger: ${report.sourceLedgerPath}`,
    `- Source progress status: ${report.sourceProgressStatusPath ?? "none"}`,
    `- Supervise JSON: ${report.superviseReportPath ?? "none"}`,
    `- Supervise Markdown: ${report.superviseReportMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceLoop(report: IssueControlAdvanceLoopReport): string {
  return [
    `# Issue Control Advance Loop: ${report.id}`, "", `- Mode: ${report.mode}`, `- Status: ${report.status}`,
    `- Max steps: ${report.maxSteps}`, `- Stop reason: ${report.stopReason}`,
    `- Source ledger: ${report.sourceLedgerPath ?? "none"}`,
    `- Repeat guard: ${report.repeatGuard?.triggered ? "triggered" : "clear"}`,
    `- Repeated terminal count: ${report.repeatGuard?.repeatedTerminalCount ?? "n/a"}`,
    `- Steps: ${report.steps.length}`, "", "## Steps", "", "| Step | Status | Decision | Supervise | Reason |",
    "| ---: | --- | --- | --- | --- |",
    ...report.steps.map((step) => [
      `| ${step.index}`, step.status, step.decision, step.superviseStatus ?? "none", `${escapeCell(step.reason)} |`
    ].join(" | ")),
    "", "## Artifacts", "",
    ...report.steps.flatMap((step) => [
      `- Step ${step.index} advance: ${step.advanceReportPath ?? "none"}`,
      `- Step ${step.index} source ledger: ${step.sourceLedgerPath}`,
      `- Step ${step.index} supervise: ${step.superviseReportPath ?? "none"}`
    ]),
    `- Loop state JSON: ${report.loopStatePath ?? "none"}`,
    `- Loop state Markdown: ${report.loopStateMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceLoopState(state: IssueControlAdvanceLoopState): string {
  return [
    `# Issue Control Advance Loop State: ${state.id}`, "", `- Updated at: ${state.updatedAt}`,
    `- Mode: ${state.mode}`, `- Status: ${state.status}`, `- Max steps: ${state.maxSteps}`,
    `- Stop reason: ${state.stopReason}`, `- Source ledger: ${state.sourceLedgerPath ?? "none"}`,
    `- Last loop: ${state.lastLoopId}`, `- Terminal step status: ${state.terminalStepStatus ?? "none"}`,
    `- Terminal decision: ${state.terminalDecision ?? "none"}`,
    `- Terminal supervise status: ${state.terminalSuperviseStatus ?? "none"}`,
    `- Repeated terminal count: ${state.repeatedTerminalCount}`,
    `- Repeat guard active: ${state.repeatGuardActive ? "yes" : "no"}`,
    `- Trust tier: ${state.trustTier ?? "unknown"}`,
    `- Safety envelope: ${state.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Adaptive gate: ${state.adaptiveGate?.state ?? "unknown"} -> ${state.adaptiveGate?.recommendedMaxIterations ?? "unknown"}`,
    `- Next action: ${state.nextAction}`, `- Scheduler action: ${state.schedulerDecision?.action ?? "unknown"}`,
    `- Scheduler unattended: ${state.schedulerDecision?.canRunUnattended ? "yes" : "no"}`,
    `- Scheduler requires human: ${state.schedulerDecision?.requiresHuman ? "yes" : "no"}`,
    `- Scheduler exit code: ${state.schedulerDecision?.exitCode ?? "unknown"}`,
    `- Scheduler reason: ${state.schedulerDecision?.reason ?? "none"}`,
    `- Scheduler next command: ${state.schedulerDecision?.nextCommand ?? "none"}`,
    "", "## Artifacts", "", `- Last loop JSON: ${state.lastLoopPath ?? "none"}`,
    `- Last loop Markdown: ${state.lastLoopMarkdownPath ?? "none"}`,
    `- JSON: ${state.outputPath ?? "none"}`, `- Markdown: ${state.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAdvanceScheduler(report: IssueControlAdvanceSchedulerReport): string {
  return [
    `# Issue Control Advance Scheduler: ${report.id}`, "", `- Mode: ${report.mode}`, `- Status: ${report.status}`,
    `- Scheduler action: ${report.schedulerDecision.action}`,
    `- Trust tier: ${report.schedulerDecision.trustTier ?? "unknown"}`,
    `- Safety envelope: ${report.schedulerDecision.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Adaptive gate: ${report.schedulerDecision.adaptiveGate?.state ?? "unknown"} -> ${report.schedulerDecision.adaptiveGate?.recommendedMaxIterations ?? "unknown"}`,
    `- Can run unattended: ${report.schedulerDecision.canRunUnattended ? "yes" : "no"}`,
    `- Requires human: ${report.schedulerDecision.requiresHuman ? "yes" : "no"}`,
    `- Decision exit code: ${report.schedulerDecision.exitCode}`, `- Reason: ${report.reason}`,
    `- Next command: ${report.nextCommand ?? "none"}`, `- Loop status: ${report.loopStatus ?? "none"}`,
    `- Audit log: ${report.auditLogPath ?? "none"}`, "", "## Artifacts", "",
    `- Source state: ${report.sourceStatePath ?? "none"}`, `- Loop JSON: ${report.loopReportPath ?? "none"}`,
    `- Loop Markdown: ${report.loopReportMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlSyncGate(report: IssueControlSyncGateReport): string {
  return [
    `# Issue Control Sync Gate: ${report.id}`, "", `- Status: ${report.status}`,
    `- Scheduler action: ${report.schedulerDecision.action}`, `- Reason: ${report.reason}`,
    `- Repo: ${report.repo ?? "none"}`, `- Run: ${report.runId ?? "none"}`,
    `- Run source: ${report.runIdSource ?? "none"}`,
    `- Completed issues: ${report.completedIssueIds.length > 0 ? report.completedIssueIds.join(", ") : "none"}`,
    `- Unresolved issues: ${report.unresolvedIssueIds.length > 0 ? report.unresolvedIssueIds.join(", ") : "none"}`,
    `- Pending issues: ${report.pendingIssueIds.length > 0 ? report.pendingIssueIds.join(", ") : "none"}`,
    `- Recommended sync command: ${report.recommendedSyncCommand ?? "none"}`, "", "## Artifacts", "",
    `- Source state: ${report.sourceStatePath ?? "none"}`, `- Source loop: ${report.sourceLoopPath ?? "none"}`,
    `- Source ledger: ${report.sourceLedgerPath ?? "none"}`, `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}
