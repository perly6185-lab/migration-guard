import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists } from "./files.js";
import { loadRunPackage } from "./migrationRun.js";
import { repairProposal } from "./patch.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";
import type { LoadedConfig } from "../types.js";
import type {
  IssueControlRecoveryExecution,
  IssueControlRecoveryPlan,
  IssueControlSuperviseOptions,
  IssueControlSuperviseReport,
  SupervisorFailureCategory
} from "./issueControl.js";

export type RepairStrategyKind = "deterministic" | "manual" | "proposal";

export interface RepairFailure {
  category: SupervisorFailureCategory;
  plan?: IssueControlRecoveryPlan;
}

export interface RepairStrategyContext {
  loaded: LoadedConfig;
  report: IssueControlSuperviseReport;
  plan: IssueControlRecoveryPlan;
  options: IssueControlSuperviseOptions;
}

export interface RepairStrategyResult {
  status: IssueControlRecoveryExecution["status"];
  action: IssueControlRecoveryExecution["action"];
  reason: string;
  recommendedNextCommand?: string;
  artifactPath?: string;
  error?: string;
}

export interface RepairStrategy {
  id: string;
  label: string;
  kind: RepairStrategyKind;
  action: IssueControlRecoveryExecution["action"];
  autoFixable: boolean;
  behaviorDiffRequired: boolean;
  reason: string;
  recommendedNextCommand: string;
  canHandle(failure: RepairFailure): boolean;
  apply(context: RepairStrategyContext): Promise<RepairStrategyResult>;
  verify?(context: RepairStrategyContext, result: RepairStrategyResult): Promise<RepairStrategyResult>;
}

export interface RepairStrategySummary {
  id: string;
  label: string;
  kind: RepairStrategyKind;
  action: IssueControlRecoveryExecution["action"];
  autoFixable: boolean;
  behaviorDiffRequired: boolean;
  reason: string;
  recommendedNextCommand: string;
}

export const deterministicRepairStrategies: RepairStrategy[] = [{
  id: "capture-missing-baseline",
  label: "Capture missing baseline snapshot",
  kind: "deterministic",
  action: "capture-baseline",
  autoFixable: true,
  behaviorDiffRequired: false,
  reason: "Missing baseline can be repaired by capturing a fresh baseline snapshot under the active config.",
  recommendedNextCommand: "node dist/cli.js baseline --config configs/md2-fast.migration-guard.json",
  canHandle: (failure) => failure.category === "missing-baseline",
  apply: async ({ loaded }) => {
    const outputPath = await saveSnapshot(loaded, await captureSnapshot(loaded, "baseline"));
    return {
      status: "executed",
      action: "capture-baseline",
      reason: `Captured baseline snapshot ${outputPath}.`,
      artifactPath: outputPath
    };
  }
}, {
  id: "install-dependencies",
  label: "Install target dependencies",
  kind: "deterministic",
  action: "install-dependencies",
  autoFixable: true,
  behaviorDiffRequired: false,
  reason: "Missing dependencies can be repaired by running the detected package-manager install command.",
  recommendedNextCommand: "pnpm --dir <targetRoot> install",
  canHandle: (failure) => failure.category === "install-required",
  apply: async ({ loaded }) => {
    const command = await detectInstallCommand(loaded.targetRoot);
    const result = await runShellCommand(command, {
      cwd: loaded.targetRoot,
      timeoutMs: 120000,
      maxOutputBytes: loaded.config.output.maxOutputBytes
    });
    return {
      status: result.exitCode === 0 ? "executed" : "failed",
      action: "install-dependencies",
      reason: result.exitCode === 0
        ? `Installed dependencies with ${command}.`
        : `Dependency install failed with ${command}.`,
      recommendedNextCommand: command,
      error: result.exitCode === 0 ? undefined : result.stderr || result.stdout || result.error || "install command failed"
    };
  }
}, {
  id: "repair-failed-proposal",
  label: "Repair failed proposal",
  kind: "proposal",
  action: "proposal-repair",
  autoFixable: true,
  behaviorDiffRequired: true,
  reason: "Failed proposal gates can be repaired by creating, verifying, and accepting a retry proposal.",
  recommendedNextCommand: "node dist/cli.js proposal repair --config configs/md2-fast.migration-guard.json --run <run-id> --proposal <proposal-id> --checks --accept --behavior-diff",
  canHandle: (failure) => failure.category === "proposal-repair-needed",
  apply: async ({ loaded, plan }) => {
    const command = plan.failedIteration?.command;
    const runId = runIdFromCommand(command);
    const proposalId = proposalFromCommand(command);
    if (!runId || !proposalId) {
      return {
        status: "blocked",
        action: "proposal-repair",
        reason: "Proposal repair requires a concrete --run and --proposal from the failed iteration command."
      };
    }
    try {
      const pkg = await loadRunPackage(loaded, runId);
      const repaired = await repairProposal(loaded, pkg, proposalId, {
        runChecks: true,
        accept: true,
        notes: `supervisor recovery for ${plan.failedIssueId ?? `#${plan.failedIssueNumber ?? "unknown"}`}`
      });
      const accepted = repaired.acceptance?.acceptanceReport.accepted !== false
        && repaired.verification?.passed !== false;
      return {
        status: accepted ? "executed" : "failed",
        action: "proposal-repair",
        reason: repaired.message,
        artifactPath: repaired.acceptance?.acceptanceReport.outputPath ?? repaired.verification?.outputPath ?? repaired.retry.proposal.patchPath
      };
    } catch (error) {
      return {
        status: "failed",
        action: "proposal-repair",
        reason: "Proposal repair recovery failed.",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}];

export const manualRepairStrategy: RepairStrategy = {
  id: "manual-review",
  label: "Manual review",
  kind: "manual",
  action: "none",
  autoFixable: false,
  behaviorDiffRequired: false,
  reason: "No deterministic repair strategy can safely handle this failure.",
  recommendedNextCommand: "Inspect the recovery plan evidence and choose the next approved command.",
  canHandle: () => true,
  apply: async ({ plan }) => ({
    status: "blocked",
    action: "none",
    reason: `Recovery category ${plan.failureCategory} is not auto-fixable.`
  })
};

export function selectRepairStrategy(
  failure: RepairFailure,
  strategies: RepairStrategy[] = deterministicRepairStrategies
): RepairStrategy {
  return strategies.find((strategy) => strategy.canHandle(failure)) ?? manualRepairStrategy;
}

export function summarizeRepairStrategy(strategy: RepairStrategy): RepairStrategySummary {
  return {
    id: strategy.id,
    label: strategy.label,
    kind: strategy.kind,
    action: strategy.action,
    autoFixable: strategy.autoFixable,
    behaviorDiffRequired: strategy.behaviorDiffRequired,
    reason: strategy.reason,
    recommendedNextCommand: strategy.recommendedNextCommand
  };
}

async function detectInstallCommand(targetRoot: string): Promise<string> {
  if (await pathExists(path.join(targetRoot, "pnpm-lock.yaml"))) {
    return "pnpm install";
  }
  if (await pathExists(path.join(targetRoot, "yarn.lock"))) {
    return "yarn install --frozen-lockfile";
  }
  if (await pathExists(path.join(targetRoot, "bun.lockb"))) {
    return "bun install";
  }
  if (await pathExists(path.join(targetRoot, "package-lock.json"))) {
    return "npm install";
  }
  return "npm install";
}

function runIdFromCommand(command?: string): string | undefined {
  return command?.match(/--run\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}

function proposalFromCommand(command?: string): string | undefined {
  return command?.match(/--proposal\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}
