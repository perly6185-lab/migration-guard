import type { IssueControlPlanReport, IssueControlPullReport } from "../issueControl.js";
import { escapeMarkdownCell as escapeCell } from "./renderHelpers.js";

export function renderIssueControlPull(report: IssueControlPullReport): string {
  return [
    `# Issue Control Pull: ${report.id}`, "", `- Provider: ${report.provider}`, `- Repo: ${report.repo}`,
    `- State: ${report.state}`, `- Labels: ${report.labels.join(", ") || "none"}`, `- Issues: ${report.issueCount}`, "",
    "| # | Title | mg_issue_id | Type | Status | Risk |", "| ---: | --- | --- | --- | --- | --- |",
    ...report.issues.map((issue) => [`| ${issue.number}`, issue.htmlUrl ? `[${escapeCell(issue.title)}](${issue.htmlUrl})` : escapeCell(issue.title), issue.migrationGuard.issueId ?? "none", issue.migrationGuard.issueType ?? "none", issue.migrationGuard.status ?? "none", `${issue.migrationGuard.risk ?? "none"} |`].join(" | "))
  ].join("\n");
}

export function renderIssueControlPlan(report: IssueControlPlanReport): string {
  return [
    `# Issue Control Plan: ${report.id}`, "", `- Provider: ${report.provider}`, `- Repo: ${report.repo}`, `- Source pull: ${report.sourcePullId}`,
    `- Issues: ${report.summary.issueCount}`, `- Mapped: ${report.summary.mappedCount}`, `- Executable: ${report.summary.executableCount}`,
    `- Bootstrap: ${report.summary.bootstrapCount}`, `- Repairs: ${report.summary.repairCount}`, `- External review: ${report.summary.externalReviewCount}`, "",
    "| # | Action | Executable | mg_issue_id | Type | Status | Reason |", "| ---: | --- | --- | --- | --- | --- | --- |",
    ...report.items.map((item) => [`| ${item.issueNumber}`, item.action, item.executable ? "yes" : "no", item.issueId ?? "none", item.issueType ?? "none", item.status ?? "none", `${escapeCell(item.reason)} |`].join(" | ")),
    "", "## Recommended Commands", "", ...report.items.filter((item) => item.recommendedCommand).map((item) => `- #${item.issueNumber}: \`${item.recommendedCommand}\``)
  ].join("\n");
}
