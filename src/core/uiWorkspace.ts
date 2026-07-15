import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { CONFIG_FILE_NAME, loadConfig } from "./config.js";
import { detectConfigPlan, type ConfigDetectionPlan } from "./configDoctor.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { createMigrationRun } from "./migrationRun.js";
import { loadRunPackage } from "./migrationRun.js";
import { latestBaselinePath, latestRunPath } from "./snapshot.js";
import { UiHttpError } from "./uiHttpError.js";
import type { LoadedConfig } from "../types.js";
import { collectDashboard } from "./dashboard.js";

export type UiWorkspaceStatus = "active" | "archived";

export interface UiWorkspace {
  version: 1;
  id: string;
  name: string;
  sourceRoot: string;
  targetRoot: string;
  goal: string;
  configPath: string;
  activeRunId: string;
  status: UiWorkspaceStatus;
  detected: string[];
  packageManager: ConfigDetectionPlan["packageManager"];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface UiWorkspaceRegistry {
  version: 1;
  activeWorkspaceId?: string;
  workspaces: UiWorkspace[];
}

export interface UiWorkspaceInput {
  name: string;
  sourceRoot: string;
  targetRoot: string;
  goal: string;
}

export interface UiWorkspacePreview {
  version: 1;
  valid: boolean;
  errors: string[];
  input: UiWorkspaceInput;
  source: { exists: boolean; git: boolean };
  target: { exists: boolean; git: boolean; configExists: boolean };
  detection?: ConfigDetectionPlan;
}

export interface UiWorkspaceOverview {
  version: 1;
  managed: boolean;
  workspace?: UiWorkspace;
  targetRoot: string;
  configPath: string;
  checks: string[];
  progress: Array<{ id: "registered" | "scan" | "baseline" | "execute" | "verify" | "report" | "checkpoint"; label: string; complete: boolean; evidence?: string }>;
}

export interface UiWorkspacePortfolio {
  version: 1;
  activeWorkspaceId?: string;
  projects: Array<{ id: string; name: string; goal: string; targetRoot: string; stage: "project" | "assess" | "baseline" | "execute" | "verify" | "report"; readiness: string; blockerCount: number; updatedAt: string }>;
}

const registryLocks = new Map<string, Promise<void>>();

export async function listUiWorkspaces(host: LoadedConfig): Promise<UiWorkspaceRegistry> {
  return await readJsonFile<UiWorkspaceRegistry>(workspaceRegistryPath(host)).catch(() => ({ version: 1, workspaces: [] }));
}

export async function previewUiWorkspace(input: UiWorkspaceInput): Promise<UiWorkspacePreview> {
  const normalized = normalizeInput(input);
  const errors: string[] = [];
  if (!normalized.name) errors.push("Project name is required.");
  if (!normalized.goal) errors.push("Refactoring goal is required.");
  const source = await inspectRoot(normalized.sourceRoot);
  const target = await inspectRoot(normalized.targetRoot);
  if (!source.exists) errors.push(`Source directory does not exist: ${normalized.sourceRoot}`);
  if (!target.exists) errors.push(`Target directory does not exist: ${normalized.targetRoot}`);
  if (source.exists && target.exists && pathsOverlap(normalized.sourceRoot, normalized.targetRoot)) {
    errors.push("Source and target directories must be separate and cannot contain one another.");
  }
  const detection = target.exists ? await detectConfigPlan(normalized.targetRoot) : undefined;
  return {
    version: 1,
    valid: errors.length === 0,
    errors,
    input: normalized,
    source: { exists: source.exists, git: source.git },
    target: { exists: target.exists, git: target.git, configExists: target.configExists },
    detection
  };
}

export async function createUiWorkspace(host: LoadedConfig, input: UiWorkspaceInput): Promise<UiWorkspace> {
  const preview = await previewUiWorkspace(input);
  if (!preview.valid || !preview.detection) throw new UiHttpError(preview.errors.join(" ") || "Workspace detection failed.", 400);
  const detection = preview.detection;
  return await withRegistryLock(host, async () => {
    const registry = await listUiWorkspaces(host);
    const duplicate = registry.workspaces.find((item) => item.status === "active" && pathKey(item.targetRoot) === pathKey(preview.input.targetRoot));
    if (duplicate) throw new UiHttpError(`Target is already registered as ${duplicate.name}.`, 409);
    const configPath = path.join(preview.input.targetRoot, CONFIG_FILE_NAME);
    if (!preview.target.configExists) {
      await writeJsonFile(configPath, { ...detection.config, targetRoot: ".", artifactsDir: ".migration-guard" });
    }
    const loaded = await loadConfig(configPath);
    const pkg = await createMigrationRun(loaded, {
      goal: preview.input.goal,
      sourceRoot: preview.input.sourceRoot,
      targetRoot: preview.input.targetRoot,
      mode: "dry-run",
      issueProvider: "local"
    });
    const now = new Date().toISOString();
    const workspace: UiWorkspace = {
      version: 1,
      id: createWorkspaceId(preview.input.name),
      ...preview.input,
      configPath,
      activeRunId: pkg.run.id,
      status: "active",
      detected: detection.detected,
      packageManager: detection.packageManager,
      createdAt: now,
      updatedAt: now
    };
    registry.workspaces.push(workspace);
    registry.activeWorkspaceId = workspace.id;
    await writeJsonFile(workspaceRegistryPath(host), registry);
    return workspace;
  });
}

export async function selectUiWorkspace(host: LoadedConfig, workspaceId: string): Promise<UiWorkspace> {
  return await updateWorkspaceRegistry(host, (registry) => {
    const workspace = requireWorkspace(registry, workspaceId);
    if (workspace.status === "archived") throw new UiHttpError("Archived projects cannot be selected.", 409);
    registry.activeWorkspaceId = workspace.id;
    workspace.updatedAt = new Date().toISOString();
    return workspace;
  });
}

export async function archiveUiWorkspace(host: LoadedConfig, workspaceId: string): Promise<UiWorkspace> {
  return await updateWorkspaceRegistry(host, (registry) => {
    const workspace = requireWorkspace(registry, workspaceId);
    const now = new Date().toISOString();
    workspace.status = "archived";
    workspace.archivedAt = now;
    workspace.updatedAt = now;
    if (registry.activeWorkspaceId === workspace.id) registry.activeWorkspaceId = undefined;
    return workspace;
  });
}

export async function resolveActiveUiWorkspace(host: LoadedConfig): Promise<{ workspace?: UiWorkspace; loaded: LoadedConfig }> {
  const registry = await listUiWorkspaces(host);
  const workspace = registry.workspaces.find((item) => item.id === registry.activeWorkspaceId && item.status === "active");
  if (!workspace) return { loaded: host };
  try {
    return { workspace, loaded: await loadConfig(workspace.configPath) };
  } catch (error) {
    throw new UiHttpError(`Active project config is unavailable: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
}

export async function collectActiveUiWorkspaceOverview(host: LoadedConfig): Promise<UiWorkspaceOverview> {
  const active = await resolveActiveUiWorkspace(host);
  const scanDir = path.join(active.loaded.artifactsDir, "scan");
  const scanFiles = (await fs.readdir(scanDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const baselinePath = latestBaselinePath(active.loaded);
  const verifyPath = latestRunPath(active.loaded);
  const run = await loadRunPackage(active.loaded, active.workspace?.activeRunId ?? "latest").catch(() => undefined);
  const checkpointId = run?.run.latestCheckpointId;
  const executionTasks = run?.graph.tasks.filter((task) => task.type === "code-change" || task.type === "adapter" || task.type === "replan") ?? [];
  const executionComplete = executionTasks.length > 0 && executionTasks.every((task) => task.status === "done" || task.status === "accepted-diff");
  const reportPath = run?.run.finalReportPath;
  const reportComplete = Boolean(reportPath && await fs.stat(reportPath).catch(() => undefined));
  return {
    version: 1,
    managed: Boolean(active.workspace),
    workspace: active.workspace,
    targetRoot: active.loaded.targetRoot,
    configPath: active.loaded.path,
    checks: active.loaded.config.checks.map((check) => check.name),
    progress: [
      { id: "registered", label: "Project registered", complete: Boolean(active.workspace) },
      { id: "scan", label: "Project scanned", complete: scanFiles.length > 0, evidence: scanFiles.length ? path.join(scanDir, scanFiles.at(-1) ?? "") : undefined },
      { id: "baseline", label: "Baseline captured", complete: Boolean(await fs.stat(baselinePath).catch(() => undefined)), evidence: baselinePath },
      { id: "execute", label: "Bounded tasks executed", complete: executionComplete },
      { id: "verify", label: "Verification captured", complete: Boolean(await fs.stat(verifyPath).catch(() => undefined)), evidence: verifyPath },
      { id: "report", label: "Final report written", complete: reportComplete, evidence: reportPath },
      { id: "checkpoint", label: "Recovery checkpoint", complete: Boolean(checkpointId), evidence: checkpointId }
    ]
  };
}

export async function collectUiWorkspacePortfolio(host: LoadedConfig): Promise<UiWorkspacePortfolio> {
  const registry = await listUiWorkspaces(host);
  const projects = await Promise.all(registry.workspaces.filter((item) => item.status === "active").map(async (workspace) => {
    const loaded = await loadConfig(workspace.configPath);
    const run = await loadRunPackage(loaded, workspace.activeRunId).catch(() => undefined);
    const scanDir = path.join(loaded.artifactsDir, "scan");
    const scanned = (await fs.readdir(scanDir).catch(() => [])).some((name) => name.endsWith(".json"));
    const baseline = Boolean(await fs.stat(latestBaselinePath(loaded)).catch(() => undefined));
    const executionTasks = run?.graph.tasks.filter((task) => task.type === "code-change" || task.type === "adapter" || task.type === "replan") ?? [];
    const executed = executionTasks.length > 0 && executionTasks.every((task) => task.status === "done" || task.status === "accepted-diff");
    const verified = Boolean(await fs.stat(latestRunPath(loaded)).catch(() => undefined));
    const reported = Boolean(run?.run.finalReportPath && await fs.stat(run.run.finalReportPath).catch(() => undefined));
    const stage: UiWorkspacePortfolio["projects"][number]["stage"] = !scanned
      ? "assess"
      : !baseline
        ? "baseline"
        : !executed
          ? "execute"
          : !verified
            ? "verify"
            : "report";
    const dashboard = await collectDashboard(loaded, { runId: workspace.activeRunId, checkTargetGit: false }).catch(() => undefined);
    return { id: workspace.id, name: workspace.name, goal: workspace.goal, targetRoot: workspace.targetRoot, stage, readiness: dashboard?.readiness?.status ?? "unknown", blockerCount: dashboard?.summary.blockerCount ?? 0, updatedAt: workspace.updatedAt };
  }));
  return { version: 1, activeWorkspaceId: registry.activeWorkspaceId, projects };
}

function workspaceRegistryPath(host: LoadedConfig): string {
  return path.join(host.artifactsDir, "ui-workspaces", "registry.json");
}

async function updateWorkspaceRegistry(host: LoadedConfig, update: (registry: UiWorkspaceRegistry) => UiWorkspace): Promise<UiWorkspace> {
  return await withRegistryLock(host, async () => {
    const registry = await listUiWorkspaces(host);
    const workspace = update(registry);
    await writeJsonFile(workspaceRegistryPath(host), registry);
    return workspace;
  });
}

async function withRegistryLock<T>(host: LoadedConfig, operation: () => Promise<T>): Promise<T> {
  const key = workspaceRegistryPath(host);
  const previous = registryLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  registryLocks.set(key, queued);
  await previous.catch(() => undefined);
  try { return await operation(); } finally { release(); if (registryLocks.get(key) === queued) registryLocks.delete(key); }
}

function requireWorkspace(registry: UiWorkspaceRegistry, workspaceId: string): UiWorkspace {
  const workspace = registry.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new UiHttpError("Project not found.", 404);
  return workspace;
}

function normalizeInput(input: UiWorkspaceInput): UiWorkspaceInput {
  return { name: input.name?.trim() ?? "", goal: input.goal?.trim() ?? "", sourceRoot: path.resolve(input.sourceRoot?.trim() || "."), targetRoot: path.resolve(input.targetRoot?.trim() || ".") };
}

async function inspectRoot(root: string): Promise<{ exists: boolean; git: boolean; configExists: boolean }> {
  const stats = await fs.stat(root).catch(() => undefined);
  const exists = Boolean(stats?.isDirectory());
  return { exists, git: exists && Boolean(await fs.stat(path.join(root, ".git")).catch(() => undefined)), configExists: exists && Boolean(await fs.stat(path.join(root, CONFIG_FILE_NAME)).catch(() => undefined)) };
}

function pathsOverlap(source: string, target: string): boolean {
  const sourceKey = pathKey(source); const targetKey = pathKey(target);
  const sourceToTarget = path.relative(sourceKey, targetKey);
  const targetToSource = path.relative(targetKey, sourceKey);
  return sourceKey === targetKey || (!sourceToTarget.startsWith("..") && !path.isAbsolute(sourceToTarget)) || (!targetToSource.startsWith("..") && !path.isAbsolute(targetToSource));
}

function pathKey(value: string): string { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
function createWorkspaceId(name: string): string { return `workspace-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "project"}-${randomUUID().slice(0, 8)}`; }
