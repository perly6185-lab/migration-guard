import { selectRepairStrategy, summarizeRepairStrategy, type RepairStrategySummary } from "../repairStrategy.js";
import type {
  IssueControlRecoveryPlan,
  IssueControlSuperviseIteration,
  IssueControlSuperviseReport,
  SupervisorFailureCategory
} from "../issueControl.js";

export function createIssueControlRecoveryPlan(
  report: IssueControlSuperviseReport,
  iteration?: IssueControlSuperviseIteration
): IssueControlRecoveryPlan {
  const failedIteration = iteration ?? report.iterations.find((item) => item.status === "failed" || item.status === "blocked");
  const category = classifySupervisorFailure(report, failedIteration);
  const evidencePaths = collectRecoveryEvidencePaths(report, failedIteration);
  const now = new Date().toISOString();
  const decision = recoveryDecision(category, failedIteration);
  return {
    version: 1,
    id: `issue-control-recovery-plan-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    provider: report.provider,
    repo: report.repo,
    sourceSuperviseId: report.id,
    status: "planned",
    failureCategory: category,
    failedIteration,
    failedIssueId: failedIteration?.issueId,
    failedIssueNumber: failedIteration?.issueNumber,
    failedAction: failedIteration?.action,
    evidencePaths,
    autoFixable: decision.autoFixable,
    autoFixableReason: decision.autoFixableReason,
    autoRepairEligible: decision.autoRepairEligible,
    humanActionRequired: decision.humanActionRequired,
    repairStrategy: decision.repairStrategy,
    behaviorDiffRequired: decision.behaviorDiffRequired,
    recommendedNextCommand: decision.recommendedNextCommand,
    recommendedActions: decision.recommendedActions
  };
}

function classifySupervisorFailure(
  report: IssueControlSuperviseReport,
  iteration: IssueControlSuperviseIteration | undefined
): SupervisorFailureCategory {
  const haystack = [
    report.stopReason,
    iteration?.reason,
    iteration?.error,
    iteration?.verification?.reason
  ].filter(Boolean).join("\n").toLowerCase();
  if (iteration?.verification?.status === "blocked" && haystack.includes("no baseline")) {
    return "missing-baseline";
  }
  if (haystack.includes("missing script") || haystack.includes("script not found") || /command .+ not found/.test(haystack)) {
    return "missing-script";
  }
  if (haystack.includes("install required") || haystack.includes("node_modules") || haystack.includes("pnpm install")) {
    return "install-required";
  }
  if (
    (haystack.includes("enoent") || haystack.includes("no such file") || haystack.includes("cannot find module"))
    && (haystack.includes("probe") || iteration?.verification?.differenceAreas?.includes("probe"))
  ) {
    return "probe-path-drift";
  }
  if (
    haystack.includes("format")
    && (haystack.includes("no-op") || haystack.includes("no changes") || haystack.includes("already formatted"))
  ) {
    return "formatting-noop";
  }
  if (iteration?.verification?.status === "failed") {
    return classifyCompareFailure(iteration);
  }
  if (iteration?.action === "repair-proposal" || haystack.includes("proposal")) {
    return "proposal-repair-needed";
  }
  if (iteration?.action === "bootstrap-target") {
    return "bootstrap-blocked";
  }
  if (iteration?.action === "execute-task" && iteration.status === "failed") {
    return "task-execution-failed";
  }
  if (haystack.includes("github") || haystack.includes("rate limit") || haystack.includes("api.github.com")) {
    return "github-read-blocked";
  }
  if (haystack.includes("human") || haystack.includes("approval")) {
    return "human-approval-required";
  }
  return "unknown";
}

function classifyCompareFailure(iteration: IssueControlSuperviseIteration): SupervisorFailureCategory {
  if (iteration.verification?.differenceAreas?.includes("check")) {
    return "check-regression";
  }
  if (iteration.verification?.differenceAreas?.includes("probe")) {
    return "probe-diff";
  }
  const reason = iteration.verification?.reason.toLowerCase() ?? "";
  if (reason.includes("check")) {
    return "check-regression";
  }
  if (reason.includes("probe")) {
    return "probe-diff";
  }
  return "compare-diff";
}

function collectRecoveryEvidencePaths(
  report: IssueControlSuperviseReport,
  iteration: IssueControlSuperviseIteration | undefined
): string[] {
  return [
    report.pullPath,
    report.planPath,
    iteration?.runPath,
    iteration?.runMarkdownPath,
    iteration?.artifactPath,
    iteration?.verification?.baselineSnapshotPath,
    iteration?.verification?.runSnapshotPath,
    iteration?.verification?.compareReportPath,
    iteration?.verification?.compareMarkdownPath
  ].filter((item): item is string => Boolean(item));
}

function recoveryDecision(
  category: SupervisorFailureCategory,
  iteration: IssueControlSuperviseIteration | undefined
): {
  autoFixable: boolean;
  autoFixableReason: string;
  autoRepairEligible: boolean;
  humanActionRequired: boolean;
  repairStrategy: RepairStrategySummary;
  behaviorDiffRequired: boolean;
  recommendedNextCommand: string;
  recommendedActions: string[];
} {
  const strategy = selectRepairStrategy({ category });
  const repairStrategy = summarizeRepairStrategy(strategy);
  const strategyFields = {
    autoFixable: repairStrategy.autoFixable,
    autoFixableReason: repairStrategy.reason,
    autoRepairEligible: repairStrategy.autoFixable,
    humanActionRequired: !repairStrategy.autoFixable,
    repairStrategy,
    behaviorDiffRequired: repairStrategy.behaviorDiffRequired
  };
  switch (category) {
    case "missing-baseline":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Capture a fresh baseline with the active config, review it, then rerun issue-control supervise with --verify-each."]
      };
    case "install-required":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Install dependencies using the detected package manager, then rerun the blocked command."]
      };
    case "missing-script":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Add a conservative package.json script alias for the missing script, then rerun verification."]
      };
    case "probe-path-drift":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Rewrite the stale probe path only when a unique target file replacement is found, then rerun behavior verification."]
      };
    case "formatting-noop":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Confirm the formatting-only recovery with a behavior diff guard before continuing automation."]
      };
    case "check-regression":
    case "probe-diff":
    case "compare-diff":
      return {
        ...strategyFields,
        recommendedNextCommand: `node dist/cli.js diff list --compare ${iteration?.verification?.compareReportPath ?? "<compare.json>"}`,
        recommendedActions: ["Review the compare report, classify intentional differences, or create a repair issue before continuing."]
      };
    case "proposal-repair-needed":
      return {
        ...strategyFields,
        recommendedNextCommand: repairStrategy.recommendedNextCommand,
        recommendedActions: ["Run the proposal repair loop, verify the retry proposal with behavior-diff gates, then rerun supervisor."]
      };
    case "task-execution-failed":
      return {
        ...strategyFields,
        recommendedNextCommand: `node dist/cli.js issue-control run --input <plan.json> --only-issue ${iteration?.issueId ?? "<mg_issue_id>"} --execute`,
        recommendedActions: ["Inspect the failed task run artifact, resolve the task failure, then rerun the same issue."]
      };
    case "bootstrap-blocked":
      return {
        ...strategyFields,
        recommendedNextCommand: "node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --verify",
        recommendedActions: ["Inspect bootstrap readiness, resolve target/import blockers, then rerun supervisor."]
      };
    case "github-read-blocked":
      return {
        ...strategyFields,
        recommendedNextCommand: "node dist/cli.js issue-control pull --config configs/md2-fast.migration-guard.json --labels team:migration",
        recommendedActions: ["Check GitHub token, repo access, labels and rate limit before retrying."]
      };
    case "human-approval-required":
      return {
        ...strategyFields,
        recommendedNextCommand: "Review the recovery plan evidence and approve the next bounded action.",
        recommendedActions: ["Review the evidence and choose the next approved command."]
      };
    default:
      return {
        ...strategyFields,
        recommendedNextCommand: "Inspect the supervisor and child run artifacts.",
        recommendedActions: ["Inspect artifacts, classify the failure manually, then rerun supervisor with a narrower issue selection."]
      };
  }
}


