import type { LoadedConfig } from "../../types.js";
import { runShellCommand } from "../exec.js";
import { selectRepairStrategy, summarizeRepairStrategy } from "../repairStrategy.js";
import type {
  IssueControlRecoveryExecution,
  IssueControlRecoveryPlan,
  IssueControlSuperviseOptions,
  IssueControlSuperviseReport
} from "../issueControl.js";

export async function executeIssueControlRecoveryPlan(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport,
  plan: IssueControlRecoveryPlan,
  options: IssueControlSuperviseOptions,
  applyBehaviorDiffGuard: (loaded: LoadedConfig, execution: IssueControlRecoveryExecution) => Promise<IssueControlRecoveryExecution>
): Promise<IssueControlRecoveryExecution> {
  const now = new Date().toISOString();
  const base: IssueControlRecoveryExecution = {
    version: 1,
    id: `issue-control-recovery-execution-${now.replace(/[:.]/g, "-")}`,
    createdAt: now,
    provider: report.provider,
    repo: report.repo,
    sourceSuperviseId: report.id,
    sourceRecoveryPlanId: plan.id,
    mode: options.execute ? "execute" : "dry-run",
    status: "blocked",
    failureCategory: plan.failureCategory,
    autoFixable: plan.autoFixable,
    autoRepairEligible: plan.autoRepairEligible,
    repairStrategy: plan.repairStrategy,
    behaviorDiffRequired: plan.behaviorDiffRequired,
    action: plan.repairStrategy.action,
    reason: "No recovery action selected.",
    recommendedNextCommand: plan.recommendedNextCommand
  };
  const strategy = selectRepairStrategy({ category: plan.failureCategory, plan });
  if (options.repairAgentCommand) {
    if (!options.execute) {
      return {
        ...base,
        status: "planned",
        action: "repair-agent",
        behaviorDiffRequired: true,
        reason: "Recovery can call the configured repair agent when rerun with --execute.",
        recommendedNextCommand: options.repairAgentCommand
      };
    }
    const agent = await runShellCommand(options.repairAgentCommand, {
      cwd: loaded.targetRoot,
      timeoutMs: 120000,
      maxOutputBytes: loaded.config.output.maxOutputBytes,
      env: {
        MG_RECOVERY_PLAN: plan.outputPath ?? "",
        MG_RECOVERY_CATEGORY: plan.failureCategory,
        MG_FAILED_ISSUE_ID: plan.failedIssueId ?? "",
        MG_FAILED_ISSUE_NUMBER: plan.failedIssueNumber ? String(plan.failedIssueNumber) : ""
      }
    });
    return applyBehaviorDiffGuard(loaded, {
      ...base,
      status: agent.exitCode === 0 ? "executed" : "failed",
      action: "repair-agent",
      behaviorDiffRequired: true,
      reason: agent.exitCode === 0
        ? "Repair agent completed successfully."
        : "Repair agent failed.",
      recommendedNextCommand: options.repairAgentCommand,
      error: agent.exitCode === 0 ? undefined : agent.stderr || agent.stdout || agent.error || "repair agent failed"
    });
  }
  if (!strategy.autoFixable) {
    return {
      ...base,
      status: "blocked",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: `Recovery category ${plan.failureCategory} is not auto-fixable.`
    };
  }
  if (!options.execute) {
    return {
      ...base,
      status: "planned",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: "Recovery is eligible; rerun supervisor with --execute --repair-on-fail to attempt it."
    };
  }
  try {
    const applied = await strategy.apply({
      loaded,
      report,
      plan,
      options
    });
    const verified = strategy.verify ? await strategy.verify({ loaded, report, plan, options }, applied) : applied;
    return applyBehaviorDiffGuard(loaded, {
      ...base,
      ...verified,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired
    });
  } catch (error) {
    return {
      ...base,
      status: "failed",
      action: strategy.action,
      repairStrategy: summarizeRepairStrategy(strategy),
      behaviorDiffRequired: strategy.behaviorDiffRequired,
      reason: "Automatic recovery failed.",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

