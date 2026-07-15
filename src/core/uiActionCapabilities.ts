import { pathExists } from "./files.js";
import { validateGitHubRepo } from "./githubIssueAdapter.js";
import { loadRunPackage } from "./migrationRun.js";
import { trimmedParam } from "./uiRequest.js";
import type { UiActionId } from "./uiJobTypes.js";
import type { LoadedConfig } from "../types.js";

export interface UiActionCapability {
  id: UiActionId;
  label: string;
  enabled: boolean;
  reason?: string;
  writesArtifacts: boolean;
  dryRunOnly: boolean;
  requiresConfirmation: boolean;
  confirmMessage?: string;
  requiresConfig?: string[];
  defaults?: Record<string, string | number | string[]>;
}

export interface UiActionCapabilitiesReport {
  version: 1;
  runId?: string;
  repo?: string;
  actions: UiActionCapability[];
}

export async function requireActionCapability(
  loaded: LoadedConfig,
  searchParams: URLSearchParams,
  actionId: UiActionId
): Promise<{ error: string; action: UiActionCapability } | undefined> {
  const report = await collectActionCapabilities(loaded, searchParams);
  const action = report.actions.find((candidate) => candidate.id === actionId);
  if (!action || action.enabled) {
    return undefined;
  }
  return { error: action.reason ?? `Action is unavailable: ${action.label}`, action };
}

export async function collectActionCapabilities(
  loaded: LoadedConfig,
  searchParams: URLSearchParams
): Promise<UiActionCapabilitiesReport> {
  const runSelector = searchParams.get("run") ?? "latest";
  const runResult = await loadRunPackage(loaded, runSelector)
    .then((pkg) => ({ runId: pkg.run.id }))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  const repo = trimmedParam(searchParams, "repo") ?? loaded.config.issueSync?.githubRepo;
  const repoProblem = validateOptionalGitHubRepo(repo);
  const targetExists = await pathExists(loaded.targetRoot);
  const runEnabled = "runId" in runResult;
  const maxIterations = Number(searchParams.get("maxIterations") ?? 3);

  return {
    version: 1,
    runId: "runId" in runResult ? runResult.runId : undefined,
    repo,
    actions: [{
      id: "scan",
      label: "Scan Project",
      enabled: targetExists,
      reason: targetExists ? undefined : `Target root does not exist: ${loaded.targetRoot}`,
      writesArtifacts: true,
      dryRunOnly: false,
      requiresConfirmation: false,
      defaults: { targetRoot: loaded.targetRoot }
    }, {
      id: "baseline",
      label: "Capture Baseline",
      enabled: targetExists,
      reason: targetExists ? undefined : `Target root does not exist: ${loaded.targetRoot}`,
      writesArtifacts: true,
      dryRunOnly: false,
      requiresConfirmation: true,
      confirmMessage: "Run configured checks and capture the behavior baseline for this project?",
      defaults: { targetRoot: loaded.targetRoot }
    }, {
      id: "checkpoint",
      label: "Create Checkpoint",
      enabled: runEnabled && targetExists,
      reason: !runEnabled ? `Run is unavailable: ${runResult.error}` : targetExists ? undefined : `Target root does not exist: ${loaded.targetRoot}`,
      writesArtifacts: true,
      dryRunOnly: false,
      requiresConfirmation: true,
      confirmMessage: "Capture current Git and filesystem recovery evidence for this run?"
    }, {
      id: "readiness",
      label: "Write Readiness",
      enabled: runEnabled,
      reason: runEnabled ? undefined : `Run is unavailable: ${runResult.error}`,
      writesArtifacts: true,
      dryRunOnly: false,
      requiresConfirmation: false
    }, {
      id: "verify",
      label: "Verify Changes",
      enabled: targetExists,
      reason: targetExists ? undefined : `Target root does not exist: ${loaded.targetRoot}`,
      writesArtifacts: true,
      dryRunOnly: false,
      requiresConfirmation: true,
      confirmMessage: "Capture a verification snapshot for the configured target. This writes a run artifact and may take a while. Continue?",
      defaults: { targetRoot: loaded.targetRoot }
    }, {
      id: "issue-control-dry-run",
      label: "Issue Dry-run",
      enabled: !repoProblem && Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= 10,
      reason: repoProblem ?? (Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= 10
        ? undefined
        : "Max iterations must be an integer from 1 to 10."),
      writesArtifacts: true,
      dryRunOnly: true,
      requiresConfirmation: false,
      requiresConfig: repo ? undefined : ["issueSync.githubRepo"],
      defaults: {
        repo: repo ?? "",
        labels: searchParams.get("labels")?.split(",").map((label) => label.trim()).filter(Boolean) ?? [],
        maxIterations: Number.isFinite(maxIterations) ? maxIterations : 3
      }
    }]
  };
}

function validateOptionalGitHubRepo(repo: string | undefined): string | undefined {
  if (!repo) {
    return "GitHub repo is required. Configure issueSync.githubRepo or enter owner/name.";
  }
  try {
    validateGitHubRepo(repo);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
