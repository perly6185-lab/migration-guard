import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCheckpoint } from "./checkpoint.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { readHandoffContract, validateHandoffContract, type AiHandoffContract } from "./handoff.js";
import { sha256 } from "./hash.js";
import { appendEvidence, loadRunPackage, migrationRunDir } from "./migrationRun.js";
import { stableStringify } from "./normalize.js";
import type { LoadedConfig } from "../types.js";

const execFileAsync = promisify(execFile);

export interface HandoffResultManifest {
  schema: "migration-guard.ai-result";
  version: 1;
  id: string;
  createdAt: string;
  handoff: { id: string; contractHash: string; path: string };
  patch: { path: string; sha256: string };
  changedFiles: string[];
  commands: Array<{ command: string; claimedStatus: "passed" | "failed" | "not-run" }>;
  declaration: "completed" | "partial" | "failed";
  agent: { provider?: string; model?: string; sessionId?: string };
}

export interface HandoffResultImportPlan {
  version: 1;
  resultId: string;
  runId: string;
  handoffId: string;
  patchPath: string;
  patchHash: string;
  changedFiles: string[];
  gitHead?: string;
  gitStatusFingerprint: string;
  passed: boolean;
  blockers: string[];
  warnings: string[];
  nextAction: string;
  planHash: string;
  outputPath: string;
  markdownPath: string;
}

export async function planHandoffResultImport(loaded: LoadedConfig, manifestPath: string, runSelector = "latest"): Promise<HandoffResultImportPlan> {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJsonFile<HandoffResultManifest>(absoluteManifest);
  const pkg = await loadRunPackage(loaded, runSelector);
  const blockers: string[] = [];
  const warnings: string[] = [];
  validateManifestShape(manifest, blockers);
  const handoffPath = resolveBesideManifest(absoluteManifest, manifest.handoff?.path);
  const patchPath = resolveBesideManifest(absoluteManifest, manifest.patch?.path);
  const handoff = await readHandoffContract(handoffPath).catch(() => undefined);
  if (!handoff) blockers.push(`Handoff is missing or invalid: ${handoffPath}`);
  else {
    const validation = await validateHandoffContract(handoff);
    blockers.push(...validation.errors.map((item) => `Handoff: ${item}`));
    warnings.push(...validation.warnings);
    if (manifest.handoff.id !== handoff.id || manifest.handoff.contractHash !== handoff.contractHash) blockers.push("Handoff lineage does not match the referenced contract.");
    if (handoff.lineage.runId && handoff.lineage.runId !== pkg.run.id) blockers.push(`Handoff belongs to run ${handoff.lineage.runId}, not ${pkg.run.id}.`);
    if (handoff.lineage.policyHash && handoff.lineage.policyHash !== loaded.policy?.hash) blockers.push("Policy changed after handoff creation; create a fresh handoff.");
    if (path.resolve(handoff.scope.root) !== path.resolve(pkg.run.targetRoot)) blockers.push("Handoff scope root does not match the selected run target.");
    if (!handoff.permissions.granted.includes("target-edit")) blockers.push("Handoff does not grant target-edit permission.");
    if ((manifest.commands?.length ?? 0) > handoff.budget.maxCommands) blockers.push("Result declares more commands than the handoff command budget.");
  }
  const patchContent = await fs.readFile(patchPath, "utf8").catch(() => undefined);
  const patchHash = patchContent === undefined ? "missing" : sha256(patchContent);
  if (patchContent === undefined) blockers.push(`Patch is missing: ${patchPath}`);
  else if (manifest.patch?.sha256 !== patchHash) blockers.push("Patch hash does not match the result manifest.");
  const changedFiles = patchContent === undefined ? [] : parsePatchPaths(patchContent, blockers);
  if (!sameStringSet(changedFiles, manifest.changedFiles ?? [])) blockers.push("Manifest changedFiles do not match paths parsed from the patch.");
  if (handoff) validateChangedFiles(loaded, handoff, changedFiles, blockers);
  const git = await readGitState(pkg.run.targetRoot, loaded.artifactsDir);
  if (git.status) blockers.push("Target Git worktree has business-file changes; import requires a clean reviewed baseline.");
  if (patchContent !== undefined && blockers.length === 0) {
    const check = await gitApply(pkg.run.targetRoot, patchPath, true);
    if (!check.passed) blockers.push(`Patch does not apply cleanly: ${check.message}`);
  }
  for (const command of manifest.commands ?? []) if (command.claimedStatus === "passed") warnings.push(`Agent-reported pass is untrusted and must be verified locally: ${command.command}`);
  if (manifest.declaration !== "completed") blockers.push(`Result declaration is ${manifest.declaration ?? "missing"}; only completed results can be applied.`);
  const core = { version: 1 as const, resultId: manifest.id, runId: pkg.run.id, handoffId: manifest.handoff?.id ?? "unknown", patchPath, patchHash, changedFiles, gitHead: git.head, gitStatusFingerprint: sha256(git.status), passed: blockers.length === 0, blockers, warnings, nextAction: blockers.length ? repairCommand(handoff, pkg.run.id) : `migration-guard verify --config "${loaded.path}"` };
  const planHash = sha256(stableStringify(core));
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "handoff-results", safeId(manifest.id));
  const plan = { ...core, planHash, outputPath: path.join(dir, `import-plan-${planHash}.json`), markdownPath: path.join(dir, `import-plan-${planHash}.md`) };
  await writeJsonFile(plan.outputPath, plan);
  await writeTextFile(plan.markdownPath, renderHandoffResultImportPlan(plan));
  return plan;
}

export async function applyHandoffResultImport(loaded: LoadedConfig, manifestPath: string, applyConfirm: string, runSelector = "latest"): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(applyConfirm)) throw new Error("Result import requires a valid --apply-confirm plan hash.");
  const manifest = await readJsonFile<HandoffResultManifest>(path.resolve(manifestPath));
  const pkg = await loadRunPackage(loaded, runSelector);
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "handoff-results", safeId(manifest.id));
  const appliedPath = path.join(dir, "applied.json");
  if (await pathExists(appliedPath)) return { ...(await readJsonFile<Record<string, unknown>>(appliedPath)), idempotent: true };
  const plan = await planHandoffResultImport(loaded, manifestPath, pkg.run.id);
  if (plan.planHash !== applyConfirm) throw new Error(`Result import state changed or confirmation mismatched. Review the fresh plan and use --apply-confirm ${plan.planHash}.`);
  if (!plan.passed) throw new Error(`Result import is blocked: ${plan.blockers.join(" ")}`);
  const checkpoint = await createCheckpoint(loaded, pkg, undefined, `Before external result ${manifest.id}`);
  const applied = await gitApply(pkg.run.targetRoot, plan.patchPath, false);
  if (!applied.passed) throw new Error(`Patch apply failed after preflight: ${applied.message}`);
  const result = { version: 1, status: "applied", resultId: manifest.id, handoffId: manifest.handoff.id, runId: pkg.run.id, planHash: plan.planHash, patchHash: plan.patchHash, changedFiles: plan.changedFiles, checkpointId: checkpoint.id, localVerificationRequired: true, nextAction: plan.nextAction, appliedAt: new Date().toISOString(), outputPath: appliedPath };
  await writeJsonFile(appliedPath, result);
  await writeTextFile(path.join(dir, "applied.md"), renderAppliedResult(result));
  await appendEvidence(loaded, pkg.run.id, { runId: pkg.run.id, taskId: (await readHandoffContract(resolveBesideManifest(path.resolve(manifestPath), manifest.handoff.path))).lineage.taskId, type: "proposal", message: `Imported external AI result ${manifest.id}; local verification required.`, data: result });
  return result;
}

function validateManifestShape(manifest: HandoffResultManifest, blockers: string[]): void {
  if (manifest.schema !== "migration-guard.ai-result" || manifest.version !== 1) blockers.push("Unsupported result manifest schema or version.");
  if (!manifest.id?.trim() || !manifest.handoff?.path || !manifest.patch?.path || !manifest.patch?.sha256) blockers.push("Result id, handoff reference and patch reference are required.");
  if (!Array.isArray(manifest.changedFiles) || !Array.isArray(manifest.commands)) blockers.push("changedFiles and commands must be arrays.");
}

function resolveBesideManifest(manifestPath: string, value: string | undefined): string {
  if (!value) return path.join(path.dirname(manifestPath), "missing");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(path.dirname(manifestPath), value);
}

function parsePatchPaths(content: string, blockers: string[]): string[] {
  const paths: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    if (match[1] !== match[2]) blockers.push(`Renames are not supported by result import: ${match[1]} -> ${match[2]}`);
    const value = (match[2] ?? "").replace(/\\/g, "/");
    if (!value || path.isAbsolute(value) || value.split("/").includes("..")) blockers.push(`Unsafe patch path: ${value || "<empty>"}`);
    else paths.push(value);
  }
  if (paths.length === 0) blockers.push("Patch contains no diff --git file entries.");
  return [...new Set(paths)].sort();
}

function validateChangedFiles(loaded: LoadedConfig, handoff: AiHandoffContract, files: string[], blockers: string[]): void {
  const allowed = new Set(handoff.scope.allowedPaths.map(normalizePath));
  if (files.length > handoff.scope.maxChangedFiles || files.length > handoff.budget.maxChangedFiles) blockers.push("Patch exceeds the handoff changed-file budget.");
  if (loaded.policy && files.length > loaded.policy.policy.maxChangedFiles) blockers.push("Patch exceeds the active organization policy changed-file budget.");
  if (loaded.policy && !loaded.policy.policy.allowTargetEdit) blockers.push("Active organization policy denies target edits.");
  const artifactRelative = normalizePath(path.relative(handoff.scope.root, loaded.artifactsDir));
  for (const file of files) {
    const normalized = normalizePath(file);
    if (!allowed.has(normalized)) blockers.push(`Patch path is outside handoff scope: ${file}`);
    if (normalized === ".git" || normalized.startsWith(".git/") || normalized === artifactRelative || normalized.startsWith(`${artifactRelative}/`) || /(^|\/)(\.env|credentials|secrets?)(\.|\/|$)/i.test(normalized)) blockers.push(`Patch targets a forbidden file: ${file}`);
  }
}

async function readGitState(root: string, artifactsDir: string): Promise<{ head?: string; status: string }> {
  const head = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }).catch(() => undefined);
  const status = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }).catch(() => undefined);
  const artifactRelative = normalizePath(path.relative(root, artifactsDir));
  const filtered = (status?.stdout ?? "git-status-unavailable").split(/\r?\n/).filter((line) => { const file = normalizePath(line.slice(3).replace(/^"|"$/g, "")); return file && file !== artifactRelative && !file.startsWith(`${artifactRelative}/`); }).join("\n");
  return { head: head?.stdout.trim() || undefined, status: filtered };
}

async function gitApply(root: string, patchPath: string, check: boolean): Promise<{ passed: boolean; message: string }> {
  try { const result = await execFileAsync("git", ["apply", ...(check ? ["--check"] : []), patchPath], { cwd: root }); return { passed: true, message: result.stdout.trim() }; }
  catch (error) { const value = error as { stderr?: string; message?: string }; return { passed: false, message: value.stderr?.trim() || value.message || "git apply failed" }; }
}

function sameStringSet(left: string[], right: string[]): boolean { return stableStringify([...new Set(left.map(normalizePath))].sort()) === stableStringify([...new Set(right.map(normalizePath))].sort()); }
function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, ""); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96) || "result"; }
function repairCommand(handoff: AiHandoffContract | undefined, runId: string): string { return handoff?.lineage.taskId ? `migration-guard handoff create --run ${runId} --task ${handoff.lineage.taskId}` : "Review the rejected import evidence and create a corrected result manifest."; }

export function renderHandoffResultImportPlan(plan: HandoffResultImportPlan): string { return [`# Handoff Result Import: ${plan.resultId}`, "", `- Status: ${plan.passed ? "ready" : "blocked"}`, `- Handoff: ${plan.handoffId}`, `- Plan hash: ${plan.planHash}`, `- Patch hash: ${plan.patchHash}`, `- Files: ${plan.changedFiles.join(", ") || "none"}`, "", "## Blockers", "", ...(plan.blockers.length ? plan.blockers.map((item) => `- ${item}`) : ["- none"]), "", "## Warnings", "", ...(plan.warnings.length ? plan.warnings.map((item) => `- ${item}`) : ["- none"]), "", `Next: ${plan.nextAction}`, ""].join("\n"); }
function renderAppliedResult(result: Record<string, unknown>): string { return [`# Applied Handoff Result: ${result.resultId}`, "", `- Handoff: ${result.handoffId}`, `- Checkpoint: ${result.checkpointId}`, `- Local verification required: yes`, `- Next: ${result.nextAction}`, ""].join("\n"); }
