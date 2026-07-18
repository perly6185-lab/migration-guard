import type { IssueControlRecoveryExecution, IssueControlRecoveryPlan } from "../issueControl.js";

export function renderIssueControlRecoveryPlan(plan: IssueControlRecoveryPlan): string {
  return [
    `# Issue Control Recovery Plan: ${plan.id}`,
    "",
    `- Source supervise: ${plan.sourceSuperviseId}`,
    `- Repo: ${plan.repo}`,
    `- Failure category: ${plan.failureCategory}`,
    `- Failed issue: ${plan.failedIssueId ?? "none"}`,
    `- Failed action: ${plan.failedAction ?? "none"}`,
    `- Auto fixable: ${plan.autoFixable ? "yes" : "no"}`,
    `- Auto fixable reason: ${plan.autoFixableReason}`,
    `- Auto repair eligible: ${plan.autoRepairEligible ? "yes" : "no"}`,
    `- Human action required: ${plan.humanActionRequired ? "yes" : "no"}`,
    `- Repair strategy: ${plan.repairStrategy.id} (${plan.repairStrategy.kind})`,
    `- Behavior diff required: ${plan.behaviorDiffRequired ? "yes" : "no"}`,
    `- Recommended next command: ${plan.recommendedNextCommand}`,
    "",
    "## Recommended Actions",
    "",
    ...plan.recommendedActions.map((action) => `- ${action}`),
    "",
    "## Evidence",
    "",
    ...(plan.evidencePaths.length > 0 ? plan.evidencePaths.map((evidence) => `- ${evidence}`) : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- JSON: ${plan.outputPath ?? "none"}`,
    `- Markdown: ${plan.markdownPath ?? "none"}`
  ].join("\n");
}

export function renderIssueControlRecoveryExecution(execution: IssueControlRecoveryExecution): string {
  return [
    `# Issue Control Recovery Execution: ${execution.id}`,
    "",
    `- Source supervise: ${execution.sourceSuperviseId}`,
    `- Source recovery plan: ${execution.sourceRecoveryPlanId}`,
    `- Repo: ${execution.repo}`,
    `- Mode: ${execution.mode}`,
    `- Status: ${execution.status}`,
    `- Failure category: ${execution.failureCategory}`,
    `- Auto fixable: ${execution.autoFixable === undefined ? "unknown" : execution.autoFixable ? "yes" : "no"}`,
    `- Auto repair eligible: ${execution.autoRepairEligible ? "yes" : "no"}`,
    `- Repair strategy: ${execution.repairStrategy?.id ?? "none"}`,
    `- Behavior diff required: ${execution.behaviorDiffRequired ? "yes" : "no"}`,
    `- Behavior diff guard: ${execution.behaviorDiffGuard?.status ?? "not-run"}`,
    `- Action: ${execution.action}`,
    `- Reason: ${execution.reason}`,
    `- Recommended next command: ${execution.recommendedNextCommand ?? "none"}`,
    "",
    "## Artifacts",
    "",
    `- Recovery artifact: ${execution.artifactPath ?? "none"}`,
    `- JSON: ${execution.outputPath ?? "none"}`,
    `- Markdown: ${execution.markdownPath ?? "none"}`
  ].join("\n");
}
