import type { IssueControlProgressStatusItem, IssueControlProgressStatusReport } from "../issueControl.js";
import { escapeMarkdownCell as escapeCell } from "./renderHelpers.js";

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
    ...(report.unresolvedItems.length > 0 ? renderItems(report.unresolvedItems) : ["- none"]),
    "",
    "## Unreached Selected Items",
    "",
    ...(report.unreachedSelectedItems.length > 0 ? renderItems(report.unreachedSelectedItems) : ["- none"]),
    "",
    "## Next Actions",
    "",
    ...(report.nextActions.length > 0 ? report.nextActions.map((action) => `- ${action}`) : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- Source ledger: ${report.sourceLedgerPath}`,
    `- Source ledger markdown: ${report.sourceLedgerMarkdownPath ?? "none"}`,
    `- JSON: ${report.outputPath ?? "none"}`,
    `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

function renderItems(items: IssueControlProgressStatusItem[]): string[] {
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
