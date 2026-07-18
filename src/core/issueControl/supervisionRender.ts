import type { IssueControlSuperviseProgressLedger, IssueControlSuperviseReport } from "../issueControl.js";
import { escapeMarkdownCell as escapeCell } from "./renderHelpers.js";

export function renderIssueControlSupervise(report: IssueControlSuperviseReport): string {
  return [
    `# Issue Control Supervise: ${report.id}`, "", `- Provider: ${report.provider}`, `- Repo: ${report.repo}`,
    `- Mode: ${report.mode}`, `- Status: ${report.status}`, `- Max iterations: ${report.maxIterations}`,
    `- Allow high risk: ${report.allowHighRisk ? "yes" : "no"}`, `- Trust tier: ${report.trustTier}`,
    `- Risk budget: ${report.riskBudget}`, `- Safety envelope: ${report.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Selected: ${report.summary.selectedCount}`, `- Planned: ${report.summary.plannedCount}`,
    `- Executed: ${report.summary.executedCount}`, `- Verified: ${report.summary.verifiedCount}`,
    `- Failed: ${report.summary.failedCount}`, `- Blocked: ${report.summary.blockedCount}`,
    `- Stop reason: ${report.stopReason ?? "none"}`, `- Failure category: ${report.failureCategory ?? "none"}`,
    `- Auto repair eligible: ${report.autoRepairEligible === undefined ? "none" : report.autoRepairEligible ? "yes" : "no"}`,
    `- Human action required: ${report.humanActionRequired === undefined ? "none" : report.humanActionRequired ? "yes" : "no"}`,
    `- Continued after repair: ${report.continuedAfterRepair ? `yes (${report.continuedAfterRepairCount ?? 1})` : "no"}`,
    "", "## Selection", "", "| # | Selected | Action | Risk | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...report.selection.map((item) => [
      `| ${item.issueNumber}`, item.selected ? "yes" : "no", item.action, item.risk ?? "none",
      item.issueId ?? "none", `${escapeCell(item.reason)} |`
    ].join(" | ")),
    "", "## Iterations", "", "| Iteration | # | Action | Status | Verify | Recovery | Continue | mg_issue_id | Reason |",
    "| ---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
    ...report.iterations.map((item) => [
      `| ${item.index}`, item.issueNumber, item.action, item.status, item.verification?.status ?? "none",
      item.recoveryExecutionStatus ?? (item.recoveryPlanPath ? "planned" : "none"),
      item.continuedAfterRepair ? "yes" : "no", item.issueId ?? "none", `${escapeCell(item.error ?? item.reason)} |`
    ].join(" | ")),
    "", "## Recommended Next Actions", "",
    ...(report.recommendedNextActions.length > 0 ? report.recommendedNextActions.map((action) => `- ${action}`) : ["- none"]),
    "", "## Artifacts", "", `- Pull: ${report.pullPath ?? "none"}`, `- Plan: ${report.planPath ?? "none"}`,
    `- Progress ledger: ${report.progressLedgerPath ?? "none"}`, `- Recovery plan: ${report.recoveryPlanPath ?? "none"}`,
    `- Recovery execution: ${report.recoveryExecutionPath ?? "none"}`,
    ...report.iterations.map((iteration) => `- Iteration ${iteration.index}: ${iteration.runPath ?? "none"}`),
    ...report.iterations.filter((iteration) => iteration.recoveryPlanPath)
      .map((iteration) => `- Iteration ${iteration.index} recovery plan: ${iteration.recoveryPlanPath}`),
    ...report.iterations.filter((iteration) => iteration.recoveryExecutionPath)
      .map((iteration) => `- Iteration ${iteration.index} recovery execution: ${iteration.recoveryExecutionPath}`),
    ...report.iterations.filter((iteration) => iteration.verification?.compareReportPath)
      .map((iteration) => `- Iteration ${iteration.index} compare: ${iteration.verification?.compareReportPath}`),
    `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlSuperviseProgressLedger(ledger: IssueControlSuperviseProgressLedger): string {
  return [
    `# Issue Control Supervise Progress: ${ledger.id}`, "", `- Source supervise: ${ledger.sourceSuperviseId}`,
    `- Repo: ${ledger.repo}`, `- Mode: ${ledger.mode}`, `- Status: ${ledger.status}`,
    `- Trust tier: ${ledger.trustTier}`, `- Risk budget: ${ledger.riskBudget}`,
    `- Safety envelope: ${ledger.safetyEnvelope?.passed ? "passed" : "not-passed"}`,
    `- Selected: ${ledger.summary.selectedCount}`, `- Reached: ${ledger.summary.reachedCount}`,
    `- Unreached selected: ${ledger.summary.unreachedSelectedCount}`, `- Recovered: ${ledger.summary.recoveredCount}`,
    `- Continued: ${ledger.summary.continuedCount}`, `- Unresolved: ${ledger.summary.unresolvedCount}`,
    `- Stop reason: ${ledger.stopReason ?? "none"}`, `- Failure category: ${ledger.failureCategory ?? "none"}`,
    "", "## Items", "",
    "| # | Selected | Reached | Iteration | State | Verify | Recovery | Continue | mg_issue_id | Reason |",
    "| ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
    ...ledger.items.map((item) => [
      `| ${item.issueNumber}`, item.selected ? "yes" : "no", item.reached ? "yes" : "no",
      item.iterationIndex ?? "none", item.state, item.verificationStatus ?? "none",
      item.recoveryExecutionStatus ?? "none", item.continuedAfterRepair ? "yes" : "no",
      item.issueId ?? "none", `${escapeCell(item.reason)} |`
    ].join(" | ")),
    "", "## Events", "",
    ...ledger.items.flatMap((item) => [
      `### #${item.issueNumber} ${item.issueId ?? "unmapped"}`, "",
      ...(item.events.length > 0 ? item.events.map((event) => `- ${event.name}: ${event.status} - ${event.reason}`) : ["- none"]), ""
    ]),
    "## Artifacts", "", `- Supervise JSON: ${ledger.superviseReportPath ?? "none"}`,
    `- Supervise Markdown: ${ledger.superviseReportMarkdownPath ?? "none"}`,
    `- Pull: ${ledger.pullPath ?? "none"}`, `- Plan: ${ledger.planPath ?? "none"}`,
    ...ledger.items.flatMap((item) => item.artifactPaths.map((artifact) => `- #${item.issueNumber}: ${artifact}`)),
    `- JSON: ${ledger.outputPath ?? "none"}`, `- Markdown: ${ledger.markdownPath ?? "none"}`
  ].join("\n");
}
