import type { IssueControlAutoReport, IssueControlRunReport } from "../issueControl.js";
import { escapeMarkdownCell as escapeCell } from "./renderHelpers.js";

export function renderIssueControlRun(report: IssueControlRunReport): string {
  return [
    `# Issue Control Run: ${report.id}`, "", `- Provider: ${report.provider}`, `- Repo: ${report.repo}`, `- Source plan: ${report.sourcePlanId}`,
    `- Mode: ${report.mode}`, `- Status: ${report.status}`, `- Only issue: ${report.onlyIssue ?? "none"}`, `- Selected: ${report.summary.selectedCount}`,
    `- Executed: ${report.summary.executedCount}`, `- Failed: ${report.summary.failedCount}`, "", "| # | Action | Status | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- |", ...report.items.map((item) => [`| ${item.issueNumber}`, item.action, item.status, item.issueId ?? "none", `${escapeCell(item.error ?? item.reason)} |`].join(" | ")),
    "", "## Commands", "", ...report.items.filter((item) => item.command).map((item) => `- #${item.issueNumber}: \`${item.command}\``), "", "## Recommended Next Actions", "",
    ...(report.recommendedNextActions.length > 0 ? report.recommendedNextActions.map((action) => `- ${action}`) : ["- none"]), "", "## Artifacts", "", `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlAuto(report: IssueControlAutoReport): string {
  return [
    `# Issue Control Auto: ${report.id}`, "", `- Provider: ${report.provider}`, `- Repo: ${report.repo}`, `- Mode: ${report.mode}`, `- Status: ${report.status}`,
    `- Max iterations: ${report.maxIterations}`, `- Allow high risk: ${report.allowHighRisk ? "yes" : "no"}`, `- Trust tier: ${report.trustTier}`, `- Risk budget: ${report.riskBudget}`,
    `- Selected issue: ${report.selectedIssueId ?? "none"}`, `- Selected action: ${report.selectedAction ?? "none"}`, "", "## Selection", "", "| # | Selected | Action | Risk | mg_issue_id | Reason |",
    "| ---: | --- | --- | --- | --- | --- |", ...report.selection.map((item) => [`| ${item.issueNumber}`, item.selected ? "yes" : "no", item.action, item.risk ?? "none", item.issueId ?? "none", `${escapeCell(item.reason)} |`].join(" | ")),
    "", "## Recommended Next Actions", "", ...(report.recommendedNextActions.length > 0 ? report.recommendedNextActions.map((action) => `- ${action}`) : ["- none"]), "", "## Artifacts", "",
    `- Pull: ${report.pullPath ?? "none"}`, `- Plan: ${report.planPath ?? "none"}`, `- Run: ${report.runPath ?? "none"}`, `- JSON: ${report.outputPath ?? "none"}`, `- Markdown: ${report.markdownPath ?? "none"}`
  ].join("\n");
}
