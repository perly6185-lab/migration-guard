import type { IssueControlAutoOptions, IssueControlAutoSelectionItem, IssueControlRunReport, IssueControlSuperviseReport } from "../issueControl.js";

export function createSuperviseRecommendedNextActions(report: IssueControlSuperviseReport): string[] {
  if (report.status === "blocked" && report.iterations.length === 0) {
    return ["No safe executable issue was selected. Refresh md2 issues or rerun with --allow-high-risk when appropriate."];
  }
  if (report.status === "blocked" || report.status === "failed") {
    return ["Inspect the failed or blocked iteration report, resolve the cause, then rerun issue-control supervise."];
  }
  if (report.mode === "dry-run") {
    return ["Review this supervise dry-run report, then rerun with --execute when the selected iterations are acceptable."];
  }
  return report.iterations
    .filter((iteration) => iteration.status === "executed" && iteration.issueId)
    .map((iteration) => `Refresh md2 issue state with sync-issues --live-plan --only-issue ${iteration.issueId}.`);
}






export function createAutoRecommendedNextActions(
  selected: IssueControlAutoSelectionItem | undefined,
  run: IssueControlRunReport | undefined,
  options: IssueControlAutoOptions
): string[] {
  if (!selected) {
    return ["No safe executable issue was selected. Review skipped reasons or rerun with --allow-high-risk when appropriate."];
  }
  if (!options.execute) {
    return [`Review the run dry-run report, then rerun auto with --execute${selected.risk === "high" ? " --allow-high-risk" : ""}.`];
  }
  if (run?.status === "complete" && selected.issueId) {
    return [`Refresh md2 issue state with sync-issues --live-plan --only-issue ${selected.issueId}.`];
  }
  return ["Inspect the issue-control run report and resolve the blocked or failed item before the next auto iteration."];
}

export function createRunRecommendedNextActions(report: IssueControlRunReport): string[] {
  if (report.mode === "dry-run") {
    return report.items
      .filter((item) => item.status === "planned")
      .map((item) => `Rerun with --execute --only-issue ${item.issueId ?? "<mg_issue_id>"} after reviewing this plan.`);
  }
  if (report.status === "complete") {
    return report.items
      .filter((item) => item.status === "executed" && item.issueId)
      .map((item) => `Refresh md2 issue state with sync-issues --live-plan --only-issue ${item.issueId}.`);
  }
  return ["Inspect this run report, fix the blocked/failed item, then rerun with the same --only-issue."];
}
