import { promises as fs } from "node:fs";
import path from "node:path";
import { compareSnapshots } from "./compare.js";
import { createCheckpoint } from "./checkpoint.js";
import { decisionsForCompareReport, evaluateDiffDecisionPolicy, formatPolicyLine } from "./diffDecision.js";
import { renderCompareReport } from "./markdown.js";
import { captureSnapshot, latestBaselinePath, loadSnapshot, saveSnapshot } from "./snapshot.js";
import { scanProject } from "./scan.js";
import { updateTaskStatus, insertFailureTask, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import { appendEvidence, createFailureIssue, createId, migrationRunDir, saveRunPackage, setRunStatus, syncIssueStatuses, writeRunReport } from "./migrationRun.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { selectProbeTemplate } from "./probeTemplateRegistry.js";
import type { LoadedConfig, MigrationAction, MigrationActionCheckReadiness, MigrationIssue, MigrationTask, ScanSummary } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export interface ExecuteTaskOptions {
  createCheckpoint?: boolean;
  verification?: boolean;
}

export async function executeReadyTasks(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  options: ExecuteTaskOptions = {}
): Promise<void> {
  let progress = true;
  setRunStatus(pkg, "running");

  while (progress) {
    progress = false;
    const ready = getReadyTasks(pkg.graph).sort((a, b) => a.priority - b.priority);
    for (const task of ready) {
      await executeTask(loaded, pkg, task.id, options);
      progress = true;
      if (pkg.run.mode !== "auto") {
        return;
      }
      if (pkg.run.status === "failed" || pkg.run.status === "blocked") {
        return;
      }
    }
  }

  if (pkg.graph.tasks.every((task) => task.status === "done")) {
    setRunStatus(pkg, "completed");
  }
  syncIssueStatuses(pkg);
  await saveRunPackage(loaded, pkg);
}

export async function executeTask(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  taskId: string,
  options: ExecuteTaskOptions = {}
): Promise<MigrationTask> {
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== "ready" && task.status !== "failed" && task.status !== "replanned") {
    throw new Error(`Task ${taskId} is not ready. Current status: ${task.status}`);
  }

  setRunStatus(pkg, "running");
  updateTaskStatus(pkg.graph, task.id, "running");
  syncIssueStatuses(pkg);
  await saveRunPackage(loaded, pkg);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: task.id,
    type: "task-updated",
    message: `Started task ${task.id}: ${task.title}`
  });

  if (options.createCheckpoint !== false) {
    await createCheckpoint(loaded, pkg, task.id, `Before ${task.id}`);
  }

  try {
    const result = await runTaskBody(loaded, pkg, task);
    updateTaskStatus(pkg.graph, task.id, "done", result);
    syncIssueStatuses(pkg);
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: task.id,
      type: "task-updated",
      message: `Completed task ${task.id}`,
      data: {
        result
      }
    });
    await saveRunPackage(loaded, pkg);
    return task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTaskStatus(pkg.graph, task.id, "failed", message);
    insertFailureTask(pkg.graph, task.id, `Replan after ${task.id} failed`, message);
    createFailureIssue(pkg, task.id, `Task failed: ${task.title}`, message);
    setRunStatus(pkg, "replanning");
    syncIssueStatuses(pkg);
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: task.id,
      type: "failure",
      message: `Task ${task.id} failed: ${message}`
    });
    await saveRunPackage(loaded, pkg);
    return task;
  }
}

async function runTaskBody(loaded: LoadedConfig, pkg: MigrationRunPackage, task: MigrationTask): Promise<string> {
  if (task.executor?.startsWith("js-vite:")) {
    return executeJsViteTask(loaded, pkg, task);
  }
  if (task.executor?.startsWith("md-monorepo:")) {
    return executeMdMonorepoTask(loaded, pkg, task);
  }
  if (task.executor?.startsWith("pnpm-vite-vue:")) {
    return executePnpmViteVueTask(loaded, pkg, task);
  }

  switch (task.type) {
    case "analyze":
      return executeAnalyze(loaded, pkg);
    case "baseline":
      return executeBaseline(loaded, pkg);
    case "plan":
      return executePlan(loaded, pkg);
    case "verify":
      return executeVerify(loaded, pkg);
    case "report":
      return executeReport(loaded, pkg);
    case "replan":
      return executeReplan(loaded, pkg, task);
    case "code-change":
      return "Manual or AI code-change task is tracked but not automatically modified in this execution mode.";
    default:
      return `Task type ${task.type} recorded as complete.`;
  }
}

async function executeAnalyze(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const scan = await scanProject({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  });
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "analysis", "scan.json");
  await writeJsonFile(outputPath, scan);
  return `Wrote scan analysis to ${outputPath}`;
}

async function executeBaseline(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const snapshot = await captureSnapshot({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  }, "baseline");
  const outputPath = await saveSnapshot(loaded, snapshot);
  const runSnapshotPath = path.join(migrationRunDir(loaded, pkg.run.id), "baselines", `${snapshot.id}.json`);
  await writeJsonFile(runSnapshotPath, snapshot);
  pkg.run.latestBaselineId = snapshot.id;
  return `Captured baseline ${snapshot.id} at ${outputPath}`;
}

async function executePlan(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const errors = validateTaskGraph(pkg.graph);
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "planning", "task-graph-validation.json");
  await writeJsonFile(outputPath, {
    passed: errors.length === 0,
    errors
  });
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return `Task graph validated at ${outputPath}`;
}

async function executeVerify(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  setRunStatus(pkg, "verifying");
  const snapshot = await captureSnapshot({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  }, "run");
  const outputPath = await saveSnapshot(loaded, snapshot);
  const runSnapshotPath = path.join(migrationRunDir(loaded, pkg.run.id), "verifications", `${snapshot.id}.json`);
  await writeJsonFile(runSnapshotPath, snapshot);
  pkg.run.latestVerificationId = snapshot.id;

  const baselineFile = latestBaselinePath(loaded);
  if (!await pathExists(baselineFile)) {
    return `Captured verification ${snapshot.id} at ${outputPath}; no baseline was available for comparison.`;
  }

  const baseline = await loadSnapshot(baselineFile);
  const report = compareSnapshots(baseline, snapshot, loaded.config.compare);
  const decisions = await decisionsForCompareReport(loaded, report, pkg.run.id);
  const decisionPolicy = evaluateDiffDecisionPolicy(report, decisions);
  const reportBase = path.join(migrationRunDir(loaded, pkg.run.id), "verifications", `${snapshot.id}-compare`);
  await writeJsonFile(`${reportBase}.json`, report);
  await writeTextFile(`${reportBase}.md`, [
    renderCompareReport(report, decisions),
    "",
    formatPolicyLine(decisionPolicy)
  ].join("\n"));

  if (!decisionPolicy.canContinue) {
    throw new Error(`Verification decision gate ${decisionPolicy.status}: ${decisionPolicy.reason}. See ${reportBase}.md`);
  }

  if (!report.passed) {
    return `Verification ${snapshot.id} raw compare failed but decision gate accepted the differences. Wrote ${reportBase}.md`;
  }

  return `Verification ${snapshot.id} passed. Wrote ${reportBase}.md`;
}

async function executeReport(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const reportPath = await writeRunReport(loaded, pkg, "final-report.md");
  return `Wrote final report to ${reportPath}`;
}

async function executeReplan(loaded: LoadedConfig, pkg: MigrationRunPackage, task: MigrationTask): Promise<string> {
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "planning", `${task.id}.json`);
  await writeJsonFile(outputPath, {
    taskId: task.id,
    status: "recorded",
    message: task.description,
    recommendation: "Review failure issue, add a scoped repair task, then rerun verification."
  });
  return `Recorded replanning note at ${outputPath}`;
}

async function executeJsViteTask(loaded: LoadedConfig, pkg: MigrationRunPackage, task: MigrationTask): Promise<string> {
  switch (task.executor) {
    case "js-vite:package":
      return updatePackageForVite(loaded, pkg);
    case "js-vite:config":
      return createViteConfig(loaded, pkg);
    case "js-vite:env":
      return inspectWebpackEnvUsage(loaded, pkg);
    default:
      return `No JS/Vite executor for ${task.executor}.`;
  }
}

async function executePnpmViteVueTask(loaded: LoadedConfig, pkg: MigrationRunPackage, task: MigrationTask): Promise<string> {
  switch (task.executor) {
    case "pnpm-vite-vue:workspace":
      return inventoryPnpmWorkspace(loaded, pkg);
    case "pnpm-vite-vue:configs":
      return inventoryPnpmViteVueConfigs(loaded, pkg);
    case "pnpm-vite-vue:risks":
      return createPnpmViteVueRiskIssues(loaded, pkg);
    default:
      return `No pnpm-vite-vue executor for ${task.executor}.`;
  }
}

async function executeMdMonorepoTask(loaded: LoadedConfig, pkg: MigrationRunPackage, task: MigrationTask): Promise<string> {
  switch (task.executor) {
    case "md-monorepo:plan":
      return createMdMonorepoTaskPlan(loaded, pkg);
    case "md-monorepo:actions":
      return createMdMonorepoActionPlan(loaded, pkg);
    default:
      return `No md-monorepo executor for ${task.executor}.`;
  }
}

interface MdRefactorTaskPlanItem {
  id: string;
  domain: string;
  title: string;
  risk: MigrationTask["risk"];
  owner: MigrationTask["owner"];
  affectedFiles: string[];
  recommendedChecks: string[];
  requiredProbes: string[];
  acceptanceCriteria: string[];
  rollbackBoundary: string;
}

interface MdRefactorTaskPlan {
  version: 1;
  runId: string;
  createdAt: string;
  goal: string;
  targetRoot: string;
  tasks: MdRefactorTaskPlanItem[];
}

async function createMdMonorepoTaskPlan(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const scan = await scanProject({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  });
  const plan = createMdMonorepoRefactorTaskPlan(pkg, scan);
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "adapter");
  const jsonPath = path.join(dir, "md-monorepo-task-plan.json");
  const markdownPath = path.join(dir, "md-monorepo-task-plan.md");
  await writeJsonFile(jsonPath, plan);
  await writeTextFile(markdownPath, renderMdMonorepoTaskPlan(plan));
  createMdMonorepoTaskIssues(pkg, plan);
  await saveRunPackage(loaded, pkg);
  return `Wrote md monorepo task plan to ${jsonPath} and ${markdownPath}`;
}

async function createMdMonorepoActionPlan(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const planPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "md-monorepo-task-plan.json");
  const plan = await pathExists(planPath)
    ? await readJsonFile<MdRefactorTaskPlan>(planPath)
    : createMdMonorepoRefactorTaskPlan(pkg, await scanProject({ ...loaded, targetRoot: pkg.run.targetRoot }));
  const actions = await createMdMonorepoActions(plan, pkg.run.targetRoot);
  const actionPlanPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "md-monorepo-action-plan.json");
  await writeJsonFile(actionPlanPath, {
    version: 1,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    goal: pkg.run.goal,
    actions
  });
  createMdMonorepoActionIssues(pkg, actions);
  await saveRunPackage(loaded, pkg);
  return `Wrote md monorepo action plan with ${actions.length} actions to ${actionPlanPath}`;
}

export function createMdMonorepoRefactorTaskPlan(pkg: MigrationRunPackage, scan: ScanSummary): MdRefactorTaskPlan {
  const riskByPrefix = createRiskLookup(scan);
  const tasks: MdRefactorTaskPlanItem[] = [
    {
      id: "md-task-core-renderer",
      domain: "packages/core",
      title: "Stabilize renderer and extension refactors",
      risk: riskFor(["packages/core/src/renderer", "packages/core/src/extensions"], riskByPrefix, "high"),
      owner: "ai",
      affectedFiles: ["packages/core/src/renderer", "packages/core/src/extensions", "packages/core/src/theme"],
      recommendedChecks: ["pnpm --filter @md/core test", "pnpm type-check:packages"],
      requiredProbes: ["md-renderer-behavior"],
      acceptanceCriteria: ["renderer behavior probe passes", "core tests pass", "no accidental behavior drift"],
      rollbackBoundary: "packages/core"
    },
    {
      id: "md-task-shared-contracts",
      domain: "packages/shared",
      title: "Consolidate shared configs, types, and editor utilities",
      risk: riskFor(["packages/shared/src"], riskByPrefix, "medium"),
      owner: "ai",
      affectedFiles: ["packages/shared/src/configs", "packages/shared/src/types", "packages/shared/src/editor", "packages/shared/src/utils"],
      recommendedChecks: ["pnpm type-check:packages", "pnpm --filter @md/web test"],
      requiredProbes: ["md-renderer-behavior", "md-web-static-contract"],
      acceptanceCriteria: ["shared type-check passes", "web tests pass", "web static contract remains stable"],
      rollbackBoundary: "packages/shared"
    },
    {
      id: "md-task-web-editor-shell",
      domain: "apps/web",
      title: "Split editor shell, command palette, and document orchestration",
      risk: riskFor(["apps/web/src/components/editor", "apps/web/src/composables"], riskByPrefix, "high"),
      owner: "ai",
      affectedFiles: ["apps/web/src/components/editor", "apps/web/src/composables", "apps/web/src/lib/markdown"],
      recommendedChecks: ["pnpm --filter @md/web test", "pnpm type-check:web"],
      requiredProbes: ["md-web-static-contract", "md-renderer-behavior"],
      acceptanceCriteria: ["web tests pass", "web type-check passes", "editor entry contract remains stable"],
      rollbackBoundary: "apps/web/src/components/editor"
    },
    {
      id: "md-task-web-ai-image",
      domain: "apps/web",
      title: "Decompose AI assistant and image generation panels",
      risk: riskFor(["apps/web/src/components/ai", "apps/web/src/services/upload"], riskByPrefix, "high"),
      owner: "ai",
      affectedFiles: ["apps/web/src/components/ai", "apps/web/src/services/upload", "apps/web/src/composables/useAIFetch.ts"],
      recommendedChecks: ["pnpm --filter @md/web test", "pnpm type-check:web"],
      requiredProbes: ["md-web-static-contract"],
      acceptanceCriteria: ["AI/image panel routes still build", "upload service contracts are unchanged", "web static contract passes"],
      rollbackBoundary: "apps/web/src/components/ai"
    },
    {
      id: "md-task-web-state-stores",
      domain: "apps/web",
      title: "Normalize Pinia stores and persistence boundaries",
      risk: riskFor(["apps/web/src/stores", "apps/web/src/storage"], riskByPrefix, "medium"),
      owner: "ai",
      affectedFiles: ["apps/web/src/stores", "apps/web/src/storage"],
      recommendedChecks: ["pnpm --filter @md/web test", "pnpm type-check:web"],
      requiredProbes: ["md-web-static-contract"],
      acceptanceCriteria: ["store imports stay stable", "web tests pass", "no app bootstrap drift"],
      rollbackBoundary: "apps/web/src/stores"
    },
    {
      id: "md-task-api-contracts",
      domain: "apps/api",
      title: "Refactor API route modules and shared contracts",
      risk: riskFor(["apps/api/src"], riskByPrefix, "high"),
      owner: "ai",
      affectedFiles: ["apps/api/src/index.ts", "apps/api/src/types.ts", "apps/api/src/share.ts", "apps/api/src/sync.ts", "apps/api/src/upload.ts"],
      recommendedChecks: ["pnpm type-check:packages"],
      requiredProbes: ["md-api-contract"],
      acceptanceCriteria: ["API contract probe passes", "package type-check passes", "public unauthenticated behavior stays explicit"],
      rollbackBoundary: "apps/api/src"
    },
    {
      id: "md-task-vscode-preview",
      domain: "apps/vscode",
      title: "Guard VSCode extension preview behavior before refactor",
      risk: riskFor(["apps/vscode/src"], riskByPrefix, "medium"),
      owner: "ai",
      affectedFiles: ["apps/vscode/src/extension.ts", "apps/vscode/src/previewRenderer.ts", "apps/vscode/scripts"],
      recommendedChecks: ["pnpm vscode:test"],
      requiredProbes: [],
      acceptanceCriteria: ["VSCode smoke scripts pass or produce actionable failure evidence"],
      rollbackBoundary: "apps/vscode"
    },
    {
      id: "md-task-cli-package",
      domain: "packages/md-cli",
      title: "Protect CLI packaging and static asset copy flow",
      risk: riskFor(["packages/md-cli"], riskByPrefix, "medium"),
      owner: "ai",
      affectedFiles: ["packages/md-cli", "scripts/release.js"],
      recommendedChecks: ["pnpm build:cli"],
      requiredProbes: ["md-web-static-contract"],
      acceptanceCriteria: ["CLI package build succeeds", "web static contract remains stable"],
      rollbackBoundary: "packages/md-cli"
    },
    {
      id: "md-task-mcp-render",
      domain: "packages/mcp-server",
      title: "Guard MCP render contract before server refactor",
      risk: riskFor(["packages/mcp-server"], riskByPrefix, "medium"),
      owner: "ai",
      affectedFiles: ["packages/mcp-server/src", "packages/mcp-server/run.mjs"],
      recommendedChecks: ["pnpm --filter @md/mcp-server exec tsx -e \"(async () => { const { buildRenderedOutput } = await import('./src/render-article.ts'); const result = await buildRenderedOutput({ markdown: '# Hi', codeBlockTheme: '' }); console.log(JSON.stringify({ hasHeading: result.html.includes('<h1'), words: result.readingTime.words, remoteCssFetch: false })); if (!result.html.includes('<h1')) process.exit(1); })();\""],
      requiredProbes: ["md-renderer-behavior"],
      acceptanceCriteria: ["MCP render runtime smoke passes", "renderer probe remains stable"],
      rollbackBoundary: "packages/mcp-server"
    },
    {
      id: "md-task-cross-package-verification",
      domain: "root",
      title: "Run cross-package verification and accepted-diff review",
      risk: "medium",
      owner: "engine",
      affectedFiles: ["package.json", "pnpm-workspace.yaml", "configs"],
      recommendedChecks: ["pnpm type-check", "pnpm test", "pnpm web build"],
      requiredProbes: ["md-renderer-behavior", "md-api-contract", "md-web-static-contract"],
      acceptanceCriteria: ["full lane passes", "all risk diffs classified", "final report generated"],
      rollbackBoundary: "workspace"
    }
  ];
  return {
    version: 1,
    runId: pkg.run.id,
    createdAt: new Date().toISOString(),
    goal: pkg.run.goal,
    targetRoot: pkg.run.targetRoot,
    tasks
  };
}

async function createMdMonorepoActions(plan: MdRefactorTaskPlan, targetRoot: string): Promise<MigrationAction[]> {
  const packageScripts = await collectPackageScripts(targetRoot);
  return plan.tasks
    .filter((task) => task.owner !== "engine")
    .map((task) => {
      const actionId = `action-${task.id.replace(/^md-task-/, "md-")}`;
      const templateSelection = selectProbeTemplate({
        id: actionId,
        domain: task.domain,
        affectedFiles: task.affectedFiles,
        requiredProbes: task.requiredProbes
      });
      return {
        id: actionId,
        title: `Prepare ${task.title}`,
        summary: [
          `Create a probe/review proposal for ${task.domain} before source edits.`,
          `Rollback boundary: ${task.rollbackBoundary}.`,
          `Required probes: ${task.requiredProbes.join(", ") || "none"}.`,
          `Probe template: ${templateSelection.template} (${templateSelection.reason}).`
        ].join(" "),
        risk: task.risk,
        affectedFiles: task.affectedFiles,
        recommendedChecks: task.recommendedChecks,
        checkReadiness: task.recommendedChecks.map((command) => evaluateActionCheckReadiness(command, packageScripts)),
        patchMode: task.risk === "high" ? "manual-approval-required" : "dry-run-only",
        patchTemplate: templateSelection.template,
        templateSelection
      };
    });
}

interface PackageScriptIndex {
  rootScripts: Set<string>;
  packageScriptsByName: Map<string, Set<string>>;
}

export async function collectPackageScripts(targetRoot: string): Promise<PackageScriptIndex> {
  const packageJsonPaths = await collectFiles(targetRoot, (file) => path.basename(file) === "package.json");
  const packageScriptsByName = new Map<string, Set<string>>();
  let rootScripts = new Set<string>();

  for (const packageJsonPath of packageJsonPaths) {
    if (packageJsonPath.includes(`${path.sep}node_modules${path.sep}`)) {
      continue;
    }
    const raw = await readJsonFile<Record<string, unknown>>(packageJsonPath).catch(() => undefined);
    if (!raw) {
      continue;
    }
    const scripts = new Set(Object.keys(readScripts(raw)));
    if (path.resolve(packageJsonPath) === path.resolve(targetRoot, "package.json")) {
      rootScripts = scripts;
    }
    if (typeof raw.name === "string") {
      packageScriptsByName.set(raw.name, scripts);
    }
  }

  return {
    rootScripts,
    packageScriptsByName
  };
}

export function evaluateActionCheckReadiness(command: string, packageScripts: PackageScriptIndex): MigrationActionCheckReadiness {
  const words = shellWords(command);
  if (words[0] !== "pnpm") {
    return {
      command,
      status: "unknown",
      reason: "non-pnpm command; runtime gate will validate it"
    };
  }

  const filterIndex = words.indexOf("--filter");
  if (filterIndex >= 0) {
    const packageName = words[filterIndex + 1];
    const afterFilter = words.slice(filterIndex + 2);
    if (!packageName || afterFilter.length === 0) {
      return {
        command,
        status: "unknown",
        reason: "pnpm filter command could not be statically resolved"
      };
    }
    if (afterFilter[0] === "exec") {
      return {
        command,
        status: "ready",
        reason: `direct pnpm exec for ${packageName}`
      };
    }
    const scriptName = afterFilter[0] === "run" ? afterFilter[1] : afterFilter[0];
    const scripts = packageScripts.packageScriptsByName.get(packageName);
    if (!scripts) {
      return {
        command,
        status: "unknown",
        reason: `package ${packageName} was not found in target package index`
      };
    }
    if (scripts.has(scriptName)) {
      return {
        command,
        status: "ready",
        reason: `package script exists: ${packageName}#${scriptName}`
      };
    }
    return {
      command,
      status: "no-op-risk",
      reason: `package ${packageName} has no script ${scriptName}`
    };
  }

  const scriptName = words[1] === "run" ? words[2] : words[1];
  if (!scriptName) {
    return {
      command,
      status: "unknown",
      reason: "pnpm command has no script or subcommand to validate"
    };
  }
  if (scriptName === "exec" || scriptName === "dlx" || scriptName === "install") {
    return {
      command,
      status: "ready",
      reason: `pnpm ${scriptName} command does not require a package script`
    };
  }
  if (packageScripts.rootScripts.has(scriptName)) {
    return {
      command,
      status: "ready",
      reason: `root script exists: ${scriptName}`
    };
  }
  return {
    command,
    status: "no-op-risk",
    reason: `root package has no script ${scriptName}`
  };
}

function shellWords(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^["']|["']$/g, "")) ?? [];
}

function readScripts(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  if (!packageJson || typeof packageJson.scripts !== "object" || packageJson.scripts === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(packageJson.scripts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function inferMdActionTemplate(task: MdRefactorTaskPlanItem): MigrationAction["patchTemplate"] {
  return selectProbeTemplate({
    id: `action-${task.id.replace(/^md-task-/, "md-")}`,
    domain: task.domain,
    affectedFiles: task.affectedFiles,
    requiredProbes: task.requiredProbes
  }).template;
}

function renderMdMonorepoTaskPlan(plan: MdRefactorTaskPlan): string {
  return [
    `# MD Monorepo Task Plan: ${plan.runId}`,
    "",
    `Goal: ${plan.goal}`,
    `Target: ${plan.targetRoot}`,
    `Tasks: ${plan.tasks.length}`,
    "",
    ...plan.tasks.flatMap((task) => [
      `## ${task.id}`,
      "",
      `- Domain: ${task.domain}`,
      `- Title: ${task.title}`,
      `- Risk: ${task.risk}`,
      `- Owner: ${task.owner}`,
      `- Rollback boundary: ${task.rollbackBoundary}`,
      `- Affected files: ${task.affectedFiles.join(", ") || "none"}`,
      `- Recommended checks: ${task.recommendedChecks.join(", ") || "none"}`,
      `- Required probes: ${task.requiredProbes.join(", ") || "none"}`,
      `- Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`,
      ""
    ])
  ].join("\n");
}

function createMdMonorepoTaskIssues(pkg: MigrationRunPackage, plan: MdRefactorTaskPlan): void {
  const existing = new Set(pkg.issues.map((issue) => `${issue.type}:${issue.title}`));
  const now = new Date().toISOString();
  for (const task of plan.tasks) {
    const issue: MigrationIssue = {
      id: createId("issue"),
      runId: pkg.run.id,
      type: "task",
      title: task.title,
      body: [
        `Domain: ${task.domain}`,
        `Rollback boundary: ${task.rollbackBoundary}`,
        `Recommended checks: ${task.recommendedChecks.join(", ") || "none"}`,
        `Required probes: ${task.requiredProbes.join(", ") || "none"}`,
        `Acceptance: ${task.acceptanceCriteria.join("; ")}`
      ].join("\n"),
      status: "planned",
      risk: task.risk,
      owner: task.owner,
      affectedFiles: task.affectedFiles,
      createdAt: now,
      updatedAt: now
    };
    if (!existing.has(`${issue.type}:${issue.title}`)) {
      pkg.issues.push(issue);
      existing.add(`${issue.type}:${issue.title}`);
    }
  }
}

function createMdMonorepoActionIssues(pkg: MigrationRunPackage, actions: MigrationAction[]): void {
  const existing = new Set(pkg.issues.map((issue) => `${issue.type}:${issue.title}`));
  const now = new Date().toISOString();
  for (const action of actions) {
    const issue: MigrationIssue = {
      id: createId("issue"),
      runId: pkg.run.id,
      type: "task",
      title: action.title,
      body: [
        action.summary,
        "",
        `Recommended checks: ${action.recommendedChecks.join(", ") || "none"}`,
        `Patch mode: ${action.patchMode}`
      ].join("\n"),
      status: "planned",
      risk: action.risk,
      owner: "ai",
      affectedFiles: action.affectedFiles,
      createdAt: now,
      updatedAt: now
    };
    if (!existing.has(`${issue.type}:${issue.title}`)) {
      pkg.issues.push(issue);
      existing.add(`${issue.type}:${issue.title}`);
    }
  }
}

function createRiskLookup(scan: ScanSummary): Map<string, number> {
  return new Map(scan.riskFiles.map((file) => [file.path, file.score]));
}

function riskFor(prefixes: string[], riskByPath: Map<string, number>, fallback: MigrationTask["risk"]): MigrationTask["risk"] {
  const maxScore = Math.max(
    0,
    ...[...riskByPath.entries()]
      .filter(([file]) => prefixes.some((prefix) => file.startsWith(prefix)))
      .map(([, score]) => score)
  );
  if (maxScore >= 40) {
    return "high";
  }
  if (maxScore >= 25) {
    return "medium";
  }
  return fallback;
}

async function inventoryPnpmWorkspace(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const root = pkg.run.targetRoot;
  const packageJsonPaths = await collectFiles(root, (file) => path.basename(file) === "package.json");
  const packages = [];

  for (const packageJsonPath of packageJsonPaths) {
    if (packageJsonPath.includes(`${path.sep}node_modules${path.sep}`)) {
      continue;
    }
    const packageJson = await readJsonFile<{
      name?: string;
      private?: boolean;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }>(packageJsonPath);
    const relativePath = path.relative(root, path.dirname(packageJsonPath)).replace(/\\/g, "/") || ".";
    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies
    };
    packages.push({
      name: packageJson.name ?? relativePath,
      path: relativePath,
      private: Boolean(packageJson.private),
      scripts: packageJson.scripts ?? {},
      workspaceDependencies: Object.entries(deps)
        .filter(([, version]) => version === "workspace:*" || version.startsWith("workspace:"))
        .map(([name]) => name),
      stackSignals: detectPackageStackSignals(deps, packageJson.scripts ?? {})
    });
  }

  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  const workspaceText = await pathExists(workspacePath) ? await fs.readFile(workspacePath, "utf8") : "";
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "pnpm-vite-vue-workspace.json");
  await writeJsonFile(outputPath, {
    root,
    packageCount: packages.length,
    workspaceGlobs: extractWorkspaceGlobs(workspaceText),
    packages: packages.sort((a, b) => a.path.localeCompare(b.path))
  });
  return `Wrote pnpm workspace inventory to ${outputPath}`;
}

async function inventoryPnpmViteVueConfigs(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const root = pkg.run.targetRoot;
  const configFiles = await collectFiles(root, (file) => {
    const name = path.basename(file);
    return /^vite\.config\.[cm]?[jt]s$/.test(name)
      || /^vitest\.config\.[cm]?[jt]s$/.test(name)
      || /^wxt\.config\.[cm]?[jt]s$/.test(name)
      || /^tsconfig.*\.json$/.test(name)
      || name === "pnpm-workspace.yaml"
      || name === "eslint.config.mjs";
  });
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "pnpm-vite-vue-config-inventory.json");
  await writeJsonFile(outputPath, {
    root,
    configCount: configFiles.length,
    configs: configFiles
      .map((file) => ({
        path: path.relative(root, file).replace(/\\/g, "/"),
        kind: classifyConfigFile(file)
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  });
  return `Wrote pnpm/Vite/Vue config inventory to ${outputPath}`;
}

async function createPnpmViteVueRiskIssues(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const scan = await scanProject({
    ...loaded,
    targetRoot: pkg.run.targetRoot
  });
  const existing = new Set(pkg.issues.map((issue) => `${issue.type}:${issue.title}`));
  const issues: MigrationIssue[] = [];
  const now = new Date().toISOString();

  for (const riskFile of scan.riskFiles.slice(0, 10)) {
    const issue: MigrationIssue = {
      id: createId("issue"),
      runId: pkg.run.id,
      type: "risk",
      title: `Review high-risk file: ${riskFile.path}`,
      body: [
        `Score: ${riskFile.score}`,
        `Lines: ${riskFile.lines}`,
        `Importers: ${riskFile.importerCount}`,
        `Reasons: ${riskFile.reasons.join(", ")}`
      ].join("\n"),
      status: "open",
      risk: riskFile.score >= 50 ? "high" : riskFile.score >= 30 ? "medium" : "low",
      owner: "human",
      affectedFiles: [riskFile.path],
      createdAt: now,
      updatedAt: now
    };
    if (!existing.has(`${issue.type}:${issue.title}`)) {
      pkg.issues.push(issue);
      issues.push(issue);
    }
  }

  const reportPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "pnpm-vite-vue-risk-report.json");
  const actionPlanPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "pnpm-vite-vue-action-plan.json");
  const actions = createPnpmViteVueActions(scan);
  await writeJsonFile(reportPath, {
    createdAt: now,
    riskIssueCount: issues.length,
    sourceFiles: scan.sourceFiles,
    testFiles: scan.testFiles,
    packageManager: scan.packageManager,
    stackHints: scan.stackHints,
    riskFiles: scan.riskFiles.slice(0, 10)
  });
  await writeJsonFile(actionPlanPath, {
    version: 1,
    runId: pkg.run.id,
    createdAt: now,
    goal: pkg.run.goal,
    actions
  });
  for (const action of actions) {
    const issue: MigrationIssue = {
      id: createId("issue"),
      runId: pkg.run.id,
      type: "task",
      title: action.title,
      body: [
        action.summary,
        "",
        `Recommended checks: ${action.recommendedChecks.join(", ")}`,
        `Patch mode: ${action.patchMode}`
      ].join("\n"),
      status: "planned",
      risk: action.risk,
      owner: "ai",
      affectedFiles: action.affectedFiles,
      createdAt: now,
      updatedAt: now
    };
    if (!existing.has(`${issue.type}:${issue.title}`)) {
      pkg.issues.push(issue);
    }
  }
  await saveRunPackage(loaded, pkg);
  return `Created ${issues.length} risk issues and wrote ${reportPath} plus ${actionPlanPath}`;
}

export function createPnpmViteVueActions(scan: ScanSummary): MigrationAction[] {
  const risks = scan.riskFiles;
  const renderer = risks.find((file) => file.path.includes("packages/core/src/renderer/renderer-impl.ts"));
  const apiTypes = risks.find((file) => file.path.includes("apps/api/src/types.ts"));
  const largeVue = risks.find((file) => file.path.endsWith(".vue"));
  const actions: MigrationAction[] = [
    {
      id: "action-adapter-fixture-inventory",
      title: "Add adapter fixture coverage before source edits",
      summary: "Create a low-risk proposal that records package/workspace fixture expectations before adapter-generated code changes.",
      risk: "low",
      affectedFiles: ["package.json", "pnpm-workspace.yaml"],
      recommendedChecks: [],
      patchMode: "dry-run-only" as const,
      patchTemplate: "adapter-fixture-probe"
    },
    {
      id: "action-normalize-check-noise",
      title: "Review noisy check output normalization before widening gates",
      summary: "Create a low-risk normalization probe so known stdout/stderr drift can be reviewed before broader automated changes.",
      risk: "low",
      affectedFiles: ["package.json"],
      recommendedChecks: [],
      patchMode: "dry-run-only" as const,
      patchTemplate: "normalization-probe"
    },
    {
      id: "action-renderer-probes",
      title: "Add/expand behavior probes before renderer refactor",
      summary: "Renderer changes are high leverage. Expand command probes and tests before any source edit.",
      risk: renderer ? "medium" as const : "low" as const,
      affectedFiles: renderer ? [renderer.path] : ["packages/core/src/renderer/renderer-impl.ts"],
      recommendedChecks: ["pnpm --filter @md/core test", "pnpm type-check:packages"],
      patchMode: "dry-run-only" as const,
      patchTemplate: "renderer-probe"
    },
    {
      id: "action-api-type-contract",
      title: "Create API type/schema review before shared type changes",
      summary: "Shared API types have many importers. Treat changes as contract work and require schema review.",
      risk: apiTypes ? "medium" as const : "low" as const,
      affectedFiles: apiTypes ? [apiTypes.path] : ["apps/api/src/types.ts"],
      recommendedChecks: ["pnpm type-check:packages"],
      patchMode: "dry-run-only" as const,
      patchTemplate: "api-contract-probe"
    }
  ];

  if (largeVue) {
    actions.push({
      id: "action-large-vue-ui-probe",
      title: `Add UI probe before splitting ${largeVue.path}`,
      summary: "Large Vue components should get a page or DOM smoke probe before structural refactoring.",
      risk: "high",
      affectedFiles: [largeVue.path],
      recommendedChecks: ["pnpm --filter @md/web test", "pnpm type-check:web"],
      patchMode: "manual-approval-required",
      patchTemplate: "ui-smoke-probe"
    });
  }

  return actions;
}

async function updatePackageForVite(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const packagePath = path.join(pkg.run.targetRoot, "package.json");
  if (!await pathExists(packagePath)) {
    return "No package.json found; skipped Vite package update.";
  }

  const packageJson = await readJsonFile<{
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(packagePath);
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  const hasWebpackSignal = Boolean(deps.webpack)
    || Object.values(packageJson.scripts ?? {}).some((script) => /webpack|webpack-dev-server/.test(script));

  if (!hasWebpackSignal) {
    return "No Webpack signal found in package.json; skipped package update.";
  }

  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    vite: packageJson.devDependencies?.vite ?? "^7.0.0"
  };
  packageJson.scripts = {
    ...packageJson.scripts
  };

  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (/webpack-dev-server|webpack serve/.test(script)) {
      packageJson.scripts[name] = "vite";
    } else if (/\bwebpack\b/.test(script)) {
      packageJson.scripts[name] = "vite build";
    }
  }

  if (!packageJson.scripts.dev) {
    packageJson.scripts.dev = "vite";
  }
  if (!packageJson.scripts.build) {
    packageJson.scripts.build = "vite build";
  }
  if (!packageJson.scripts.preview) {
    packageJson.scripts.preview = "vite preview";
  }

  await writeJsonFile(packagePath, packageJson);
  await writeJsonFile(path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "js-vite-package.json"), {
    packagePath,
    changed: true,
    scripts: packageJson.scripts
  });
  return "Updated package.json with conservative Vite scripts and devDependency.";
}

async function createViteConfig(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const tsConfig = path.join(pkg.run.targetRoot, "vite.config.ts");
  const jsConfig = path.join(pkg.run.targetRoot, "vite.config.js");
  if (await pathExists(tsConfig) || await pathExists(jsConfig)) {
    return "Existing Vite config found; skipped config scaffold.";
  }

  const content = [
    "import { defineConfig } from \"vite\";",
    "",
    "export default defineConfig({",
    "  server: {",
    "    host: \"0.0.0.0\"",
    "  }",
    "});",
    ""
  ].join("\n");

  await writeTextFile(tsConfig, content);
  await writeJsonFile(path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "js-vite-config.json"), {
    configPath: tsConfig,
    changed: true
  });
  return `Created ${tsConfig}.`;
}

async function inspectWebpackEnvUsage(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<string> {
  const findings: Array<{ file: string; matches: number }> = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (["node_modules", "dist", "build", ".git", ".migration-guard"].includes(entry.name)) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$|\.vue$/.test(entry.name)) {
        continue;
      }
      const content = await fs.readFile(absolutePath, "utf8");
      const matches = (content.match(/process\.env\./g) ?? []).length;
      if (matches > 0) {
        findings.push({
          file: path.relative(pkg.run.targetRoot, absolutePath).replace(/\\/g, "/"),
          matches
        });
      }
    }
  }

  await visit(pkg.run.targetRoot);
  const outputPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "js-vite-env-report.json");
  await writeJsonFile(outputPath, {
    findings,
    recommendation: findings.length > 0
      ? "Review process.env usage and migrate browser-exposed values to import.meta.env with explicit VITE_ prefixes."
      : "No process.env usage found in JS/TS/Vue files."
  });
  return `Wrote environment compatibility report to ${outputPath}`;
}

async function collectFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".wxt", ".output", ".migration-guard"]);

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && predicate(absolutePath)) {
        result.push(absolutePath);
      }
    }
  }

  await visit(root);
  return result;
}

function detectPackageStackSignals(deps: Record<string, string>, scripts: Record<string, string>): string[] {
  const signals = new Set<string>();
  for (const name of ["vue", "vite", "vitest", "wxt", "wrangler", "typescript", "vue-tsc", "hono", "tsx"]) {
    if (deps[name]) {
      signals.add(name);
    }
  }
  for (const script of Object.values(scripts)) {
    if (script.includes("vite")) {
      signals.add("vite-script");
    }
    if (script.includes("vitest")) {
      signals.add("vitest-script");
    }
    if (script.includes("vue-tsc")) {
      signals.add("vue-tsc-script");
    }
    if (script.includes("wrangler")) {
      signals.add("wrangler-script");
    }
    if (script.includes("wxt")) {
      signals.add("wxt-script");
    }
  }
  return [...signals].sort();
}

function extractWorkspaceGlobs(workspaceText: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of workspaceText.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line) && !line.trim().startsWith("-")) {
      break;
    }
    const match = line.match(/^\s*-\s+(.+)$/);
    if (inPackages && match) {
      globs.push(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return globs;
}

function classifyConfigFile(filePath: string): string {
  const name = path.basename(filePath);
  if (name.startsWith("vite.config")) {
    return "vite";
  }
  if (name.startsWith("vitest.config")) {
    return "vitest";
  }
  if (name.startsWith("wxt.config")) {
    return "wxt";
  }
  if (name.startsWith("tsconfig")) {
    return "typescript";
  }
  if (name === "pnpm-workspace.yaml") {
    return "workspace";
  }
  if (name.startsWith("eslint.config")) {
    return "eslint";
  }
  return "other";
}
