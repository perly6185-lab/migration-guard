import path from "node:path";
import type { LoadedConfig } from "../../types.js";
import { executeTask } from "../executor.js";
import { proposalFromCommand } from "../issueControlModel.js";
import { loadRunPackage } from "../migrationRun.js";
import { proposeActionPatch, repairProposal } from "../patch.js";
import type { IssueControlPlanItem, IssueControlRunItem, IssueControlRunOptions } from "../issueControl.js";

export async function runIssueControlPlanItem(
  loaded: LoadedConfig,
  item: IssueControlPlanItem,
  options: IssueControlRunOptions
): Promise<IssueControlRunItem> {
  const command = item.recommendedCommand;
  const base = {
    issueNumber: item.issueNumber,
    issueId: item.issueId,
    title: item.title,
    action: item.action,
    command
  };
  if (!options.execute) {
    return {
      ...base,
      status: "planned",
      reason: item.reason
    };
  }
  try {
    switch (item.action) {
      case "execute-task": {
        const runId = item.runId ?? options.runId;
        if (!runId) {
          return { ...base, status: "blocked", reason: "execute-task requires a run id from the issue or --run." };
        }
        if (!item.taskId) {
          return { ...base, status: "blocked", reason: "execute-task requires mg_task_id." };
        }
        const pkg = await loadRunPackage(loaded, runId);
        const task = await executeTask(loaded, pkg, item.taskId, { createCheckpoint: true });
        return {
          ...base,
          status: task.status === "done" ? "executed" : "failed",
          reason: `Task ${task.id} finished with status ${task.status}.`,
          result: task.result
        };
      }
      case "propose-action": {
        const runId = item.runId ?? options.runId;
        if (!runId) {
          return { ...base, status: "blocked", reason: "propose-action requires a run id from the issue or --run." };
        }
        if (!item.actionId) {
          return { ...base, status: "blocked", reason: "propose-action requires mg_action_id or a matching action plan title." };
        }
        const pkg = await loadRunPackage(loaded, runId);
        const proposal = await proposeActionPatch(loaded, pkg, item.actionId);
        return {
          ...base,
          status: "executed",
          reason: `Created proposal ${proposal.id} for action ${item.actionId}.`,
          result: proposal.summary,
          artifactPath: proposal.patchPath
        };
      }
      case "repair-proposal": {
        const runId = item.runId ?? options.runId;
        if (!runId) {
          return { ...base, status: "blocked", reason: "repair-proposal requires a run id from the issue or --run." };
        }
        const proposal = proposalFromCommand(command);
        if (!proposal) {
          return { ...base, status: "blocked", reason: "repair-proposal requires a proposal id." };
        }
        const pkg = await loadRunPackage(loaded, runId);
        const result = await repairProposal(loaded, pkg, proposal, {
          runChecks: true,
          accept: true,
          notes: `issue-control run for ${item.issueId ?? `#${item.issueNumber}`}`
        });
        const passed = result.verification?.passed !== false && result.acceptance?.acceptanceReport.accepted !== false;
        return {
          ...base,
          status: passed ? "executed" : "failed",
          reason: result.message,
          result: result.nextAction,
          artifactPath: result.verification?.outputPath ?? result.retry.proposal.patchPath
        };
      }
      case "bootstrap-target": {
        const sourceRoot = resolveIssueControlBootstrapSourceRoot(loaded);
        if (!sourceRoot) {
          return { ...base, status: "blocked", reason: "bootstrap-target requires config variable MG_SOURCE_ROOT." };
        }
        const { bootstrapMd2Target, verifyBootstrapMd2Target } = await import("../bootstrap.js");
        const manifest = await bootstrapMd2Target(loaded, {
          sourceRoot,
          targetRoot: loaded.targetRoot,
          execute: true
        });
        const verify = await verifyBootstrapMd2Target(loaded, {
          sourceRoot,
          targetRoot: loaded.targetRoot,
          runIssueAuto: false
        });
        return {
          ...base,
          status: verify.status === "passed" ? "executed" : verify.status,
          reason: `Bootstrap import finished with verify status ${verify.status}.`,
          artifactPath: verify.outputPath ?? manifest.outputPath
        };
      }
      default:
        return { ...base, status: "blocked", reason: `Action ${item.action} is not executable in Phase 99.` };
    }
  } catch (error) {
    return {
      ...base,
      status: "failed",
      reason: item.reason,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveIssueControlBootstrapSourceRoot(loaded: LoadedConfig): string | undefined {
  const value = loaded.config.variables?.MG_SOURCE_ROOT;
  return value ? path.resolve(loaded.baseDir, value) : undefined;
}
