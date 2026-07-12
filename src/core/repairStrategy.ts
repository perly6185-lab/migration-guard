import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists, readJsonFile, writeJsonFile } from "./files.js";
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
  id: "patch-missing-package-script",
  label: "Patch missing package script alias",
  kind: "deterministic",
  action: "patch-package-script",
  autoFixable: true,
  behaviorDiffRequired: true,
  reason: "A missing package-manager script can be repaired by adding a conservative alias to an existing script.",
  recommendedNextCommand: "edit package.json scripts and rerun verification",
  canHandle: (failure) => failure.category === "missing-script",
  apply: async ({ loaded, plan }) => {
    const packageJsonPath = path.join(loaded.targetRoot, "package.json");
    if (!await pathExists(packageJsonPath)) {
      return {
        status: "blocked",
        action: "patch-package-script",
        reason: "Missing script repair requires package.json in the target root."
      };
    }
    const missingScript = inferMissingScriptName(plan);
    if (!missingScript) {
      return {
        status: "blocked",
        action: "patch-package-script",
        reason: "Could not infer the missing script name from recovery evidence."
      };
    }
    const packageJson = await readJsonFile<{ scripts?: Record<string, string> } & Record<string, unknown>>(packageJsonPath);
    const scripts = packageJson.scripts ?? {};
    if (scripts[missingScript]) {
      return {
        status: "executed",
        action: "patch-package-script",
        reason: `Script ${missingScript} already exists.`,
        artifactPath: packageJsonPath
      };
    }
    const alias = findScriptAlias(missingScript, scripts);
    if (!alias) {
      return {
        status: "blocked",
        action: "patch-package-script",
        reason: `Could not find a safe existing script alias for ${missingScript}.`
      };
    }
    packageJson.scripts = {
      ...scripts,
      [missingScript]: await packageManagerRunCommand(loaded.targetRoot, alias)
    };
    await writeJsonFile(packageJsonPath, packageJson);
    return {
      status: "executed",
      action: "patch-package-script",
      reason: `Added package.json script ${missingScript} as an alias for ${alias}.`,
      artifactPath: packageJsonPath
    };
  }
}, {
  id: "rewrite-drifted-probe-path",
  label: "Rewrite drifted probe path",
  kind: "deterministic",
  action: "rewrite-probe-path",
  autoFixable: true,
  behaviorDiffRequired: true,
  reason: "A stale probe path can be repaired when the referenced basename exists at exactly one new target path.",
  recommendedNextCommand: "edit .migration-guard.json probe path and rerun verification",
  canHandle: (failure) => failure.category === "probe-path-drift",
  apply: async ({ loaded, plan }) => {
    const stalePath = inferMissingPath(plan);
    if (!stalePath) {
      return {
        status: "blocked",
        action: "rewrite-probe-path",
        reason: "Could not infer the stale probe path from recovery evidence."
      };
    }
    const replacement = await findUniqueFileByBasename(loaded.targetRoot, path.basename(stalePath));
    if (!replacement) {
      return {
        status: "blocked",
        action: "rewrite-probe-path",
        reason: `Could not find a unique replacement for ${stalePath}.`
      };
    }
    const config = await readJsonFile<Record<string, unknown> & { probes?: Array<Record<string, unknown>> }>(loaded.path);
    const replacementRelative = path.relative(loaded.targetRoot, replacement).replace(/\\/g, "/");
    let changed = false;
    config.probes = (config.probes ?? []).map((probe) => {
      const next = { ...probe };
      if (typeof next.command === "string") {
        const rewritten = replacePathReference(next.command, stalePath, replacementRelative);
        changed ||= rewritten !== next.command;
        next.command = rewritten;
      }
      return next;
    });
    if (!changed) {
      return {
        status: "blocked",
        action: "rewrite-probe-path",
        reason: `No probe command referenced ${stalePath}.`
      };
    }
    await writeJsonFile(loaded.path, config);
    loaded.config.probes = config.probes as unknown as typeof loaded.config.probes;
    return {
      status: "executed",
      action: "rewrite-probe-path",
      reason: `Rewrote stale probe path ${stalePath} to ${replacementRelative}.`,
      artifactPath: loaded.path
    };
  }
}, {
  id: "confirm-formatting-noop",
  label: "Confirm formatting no-op",
  kind: "deterministic",
  action: "confirm-formatting-noop",
  autoFixable: true,
  behaviorDiffRequired: true,
  reason: "Formatting-only no-op recoveries are safe only after an explicit behavior diff guard passes.",
  recommendedNextCommand: "rerun supervisor with --repair-on-fail --verify-each",
  canHandle: (failure) => failure.category === "formatting-noop",
  apply: async ({ loaded, plan }) => {
    const artifactPath = path.join(loaded.artifactsDir, "issue-control", `${plan.id}-formatting-noop.json`);
    await writeJsonFile(artifactPath, {
      version: 1,
      id: `${plan.id}-formatting-noop`,
      createdAt: new Date().toISOString(),
      sourceRecoveryPlanId: plan.id,
      failureCategory: plan.failureCategory,
      status: "confirmed",
      reason: "No source mutation was required; behavior diff guard must pass before continuation."
    });
    return {
      status: "executed",
      action: "confirm-formatting-noop",
      reason: "Confirmed formatting-only no-op recovery for behavior diff guarding.",
      artifactPath
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

function inferMissingScriptName(plan: IssueControlRecoveryPlan): string | undefined {
  const text = recoveryEvidenceText(plan);
  const patterns = [
    /missing script:\s*["']?([a-z0-9:_-]+)["']?/i,
    /missing script\s+["']?([a-z0-9:_-]+)["']?/i,
    /script ["'`]([a-z0-9:_-]+)["'`] (?:was )?not found/i,
    /command ["'`]([a-z0-9:_-]+)["'`] not found/i,
    /(?:pnpm|npm|yarn|bun) (?:run )?([a-z0-9:_-]+).*not found/i
  ];
  return firstPatternCapture(text, patterns);
}

function findScriptAlias(missingScript: string, scripts: Record<string, string>): string | undefined {
  const aliases: Record<string, string[]> = {
    test: ["test:unit", "test:run", "check"],
    "test:ci": ["test", "test:unit"],
    build: ["compile"],
    typecheck: ["type-check", "check:types", "tsc", "check"],
    lint: ["eslint", "check"],
    format: ["fmt", "prettier", "format:write"]
  };
  const base = missingScript.split(":")[0];
  const candidates = [
    ...(base && base !== missingScript ? [base] : []),
    ...(aliases[missingScript] ?? []),
    ...(base ? aliases[base] ?? [] : []),
    ...Object.keys(scripts).filter((script) => script.startsWith(`${missingScript}:`))
  ];
  return candidates.find((candidate) => Boolean(scripts[candidate]));
}

async function packageManagerRunCommand(targetRoot: string, script: string): Promise<string> {
  if (await pathExists(path.join(targetRoot, "pnpm-lock.yaml"))) {
    return `pnpm run ${script}`;
  }
  if (await pathExists(path.join(targetRoot, "yarn.lock"))) {
    return `yarn ${script}`;
  }
  if (await pathExists(path.join(targetRoot, "bun.lockb"))) {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

function inferMissingPath(plan: IssueControlRecoveryPlan): string | undefined {
  const text = recoveryEvidenceText(plan);
  const patterns = [
    /enoent[^\n]*?["'`]([^"'`]+)["'`]/i,
    /no such file(?: or directory)?[^\n]*?["'`]([^"'`]+)["'`]/i,
    /cannot find module ["'`]([^"'`]+)["'`]/i,
    /open ["'`]([^"'`]+)["'`]/i
  ];
  return firstPatternCapture(text, patterns);
}

async function findUniqueFileByBasename(root: string, basename: string): Promise<string | undefined> {
  const matches: string[] = [];
  await collectFilesByBasename(root, basename, matches);
  return matches.length === 1 ? matches[0] : undefined;
}

async function collectFilesByBasename(root: string, basename: string, matches: string[]): Promise<void> {
  if (matches.length > 1 || !await pathExists(root)) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length > 1) {
      return;
    }
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".migration-guard") {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFilesByBasename(fullPath, basename, matches);
    } else if (entry.isFile() && entry.name === basename) {
      matches.push(fullPath);
    }
  }
}

function replacePathReference(command: string, stalePath: string, replacementPath: string): string {
  const variants = [...new Set([
    stalePath,
    stalePath.replace(/\\/g, "/"),
    stalePath.replace(/\//g, "\\")
  ])].filter(Boolean);
  return variants.reduce((current, variant) => current.split(variant).join(replacementPath), command);
}

function recoveryEvidenceText(plan: IssueControlRecoveryPlan): string {
  return [
    plan.failureCategory,
    plan.failedIteration?.command,
    plan.failedIteration?.reason,
    plan.failedIteration?.error,
    plan.failedIteration?.verification?.reason
  ].filter(Boolean).join("\n");
}

function firstPatternCapture(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

function runIdFromCommand(command?: string): string | undefined {
  return command?.match(/--run\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}

function proposalFromCommand(command?: string): string | undefined {
  return command?.match(/--proposal\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}
