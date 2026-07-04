import { promises as fs } from "node:fs";
import path from "node:path";
import { compareSnapshots } from "./compare.js";
import { createCheckpoint } from "./checkpoint.js";
import { renderCompareReport } from "./markdown.js";
import { captureSnapshot, latestBaselinePath, loadSnapshot, saveSnapshot } from "./snapshot.js";
import { scanProject } from "./scan.js";
import { updateTaskStatus, insertFailureTask, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import { appendEvidence, createFailureIssue, createId, migrationRunDir, saveRunPackage, setRunStatus, syncIssueStatuses, writeRunReport } from "./migrationRun.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type { LoadedConfig, MigrationIssue, MigrationTask, ScanSummary } from "../types.js";
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
  const reportBase = path.join(migrationRunDir(loaded, pkg.run.id), "verifications", `${snapshot.id}-compare`);
  await writeJsonFile(`${reportBase}.json`, report);
  await writeTextFile(`${reportBase}.md`, renderCompareReport(report));

  if (!report.passed) {
    throw new Error(`Verification failed with ${report.differences.filter((difference) => difference.severity === "error").length} error differences. See ${reportBase}.md`);
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
  await writeJsonFile(reportPath, {
    createdAt: now,
    riskIssueCount: issues.length,
    sourceFiles: scan.sourceFiles,
    testFiles: scan.testFiles,
    packageManager: scan.packageManager,
    stackHints: scan.stackHints,
    riskFiles: scan.riskFiles.slice(0, 10)
  });
  await saveRunPackage(loaded, pkg);
  return `Created ${issues.length} risk issues and wrote ${reportPath}`;
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
