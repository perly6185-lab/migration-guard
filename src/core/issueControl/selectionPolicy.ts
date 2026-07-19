import { proposalFromCommand } from "../issueControlModel.js";
import type {
  IssueControlAction,
  IssueControlAutoSelectionItem,
  IssueControlPlanItem,
  IssueControlPlanReport,
  IssueControlSuperviseSelectionItem,
  IssueControlTrustTier
} from "../issueControl.js";

const actionPriority: Record<IssueControlAction, number> = {
  "bootstrap-target": 0,
  "repair-proposal": 1,
  "execute-task": 2,
  "propose-action": 3,
  "classify-risk": 4,
  "review-external": 5,
  "track": 6
};

export function selectIssueControlAutoItem(
  plan: IssueControlPlanReport,
  options: { allowHighRisk: boolean; trustTier: IssueControlTrustTier }
): IssueControlAutoSelectionItem[] {
  const ranked = rankItems(plan, options);
  const selected = ranked.find((candidate) => candidate.selectable)?.item;
  return plan.items.map((item) => ({
    issueNumber: item.issueNumber, issueId: item.issueId, runId: item.runId, title: item.title,
    action: item.action, risk: item.risk, selected: selected === item,
    reason: selected === item ? "Selected as the highest-priority safe executable issue." : autoSelectionReason(item, options)
  }));
}

export function selectIssueControlSuperviseItems(
  plan: IssueControlPlanReport,
  options: { allowHighRisk: boolean; maxIterations: number; trustTier: IssueControlTrustTier; riskBudget: number }
): IssueControlSuperviseSelectionItem[] {
  const selected = new Set<IssueControlPlanItem>();
  let spentRisk = 0;
  for (const candidate of rankItems(plan, options).filter((item) => item.selectable)) {
    if (selected.size >= options.maxIterations) break;
    const risk = riskWeight(candidate.item.risk);
    if (spentRisk + risk > options.riskBudget) continue;
    selected.add(candidate.item);
    spentRisk += risk;
  }
  return plan.items.map((item) => ({
    issueNumber: item.issueNumber, issueId: item.issueId, runId: item.runId, title: item.title,
    action: item.action, risk: item.risk, selected: selected.has(item),
    reason: selected.has(item) ? "Selected for supervised issue-control iteration." : autoSelectionReason(item, options)
  }));
}

export function createIssueControlTrustPolicy(
  trustTier: IssueControlTrustTier,
  maxIterations: number,
  allowHighRisk: boolean
): { riskBudget: number; maxBatchSize: number; allowHighRisk: boolean } {
  if (trustTier === "manual") return { riskBudget: 1, maxBatchSize: 1, allowHighRisk: false };
  if (trustTier === "unattended") return { riskBudget: Math.max(1, maxIterations), maxBatchSize: maxIterations, allowHighRisk: false };
  return { riskBudget: Math.max(1, maxIterations * 3), maxBatchSize: maxIterations, allowHighRisk };
}

function rankItems(plan: IssueControlPlanReport, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }) {
  return plan.items.map((item, index) => ({ item, index, selectable: isAutoSelectable(item, options) }))
    .sort((a, b) => actionPriority[a.item.action] - actionPriority[b.item.action] || a.index - b.index);
}

function riskWeight(risk?: "low" | "medium" | "high"): number {
  return risk === "high" ? 8 : risk === "medium" ? 3 : 1;
}

function isRiskAllowed(item: IssueControlPlanItem, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }): boolean {
  if (options.trustTier === "unattended" && item.risk && item.risk !== "low") return false;
  return item.risk !== "high" || options.allowHighRisk;
}

function isAutoSelectable(item: IssueControlPlanItem, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }): boolean {
  if (!item.executable || !item.issueId || !isRiskAllowed(item, options)) return false;
  if (!["bootstrap-target", "repair-proposal", "execute-task", "propose-action"].includes(item.action)) return false;
  if (item.action === "execute-task" && (!item.runId || !item.taskId)) return false;
  if (item.action === "propose-action" && (!item.runId || !item.actionId)) return false;
  return item.action !== "repair-proposal" || Boolean(item.runId && proposalFromCommand(item.recommendedCommand));
}

function autoSelectionReason(item: IssueControlPlanItem, options: { allowHighRisk: boolean; trustTier?: IssueControlTrustTier }): string {
  if (!item.executable) return "Not executable by issue-control plan.";
  if (!item.issueId) return "Missing mg_issue_id.";
  if (!isRiskAllowed(item, options)) {
    return options.trustTier === "unattended"
      ? "Unattended trust tier only selects low-risk issues."
      : "High risk item skipped; rerun with --allow-high-risk to select it.";
  }
  if (!["bootstrap-target", "repair-proposal", "execute-task", "propose-action"].includes(item.action)) return `Action ${item.action} is not auto-selectable.`;
  if (item.action === "execute-task" && (!item.runId || !item.taskId)) return "execute-task requires mg_run_id and mg_task_id.";
  if (item.action === "propose-action" && (!item.runId || !item.actionId)) return "propose-action requires mg_run_id and mg_action_id or a matching action plan title.";
  if (item.action === "repair-proposal" && (!item.runId || !proposalFromCommand(item.recommendedCommand))) return "repair-proposal requires mg_run_id and proposal id.";
  return "Selectable but lower priority than the selected issue.";
}
