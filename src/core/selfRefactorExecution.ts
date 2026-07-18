import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { collectSelfRefactorInventory, selfRefactorInventoryHash, selfRefactorPlanHash, validateSelfRefactorPlan, type SelfRefactorDriverEvidence, type SelfRefactorInventory, type SelfRefactorPlan } from "./selfRefactor.js";

export interface SelfRefactorCheckpoint {
  version: 1;
  id: string;
  createdAt: string;
  root: string;
  gitHead: string;
  gitStatus: string;
  patchPath: string;
  patchHash: string;
  untrackedDir: string;
  untrackedFiles: Array<{ path: string; hash: string }>;
  checkpointHash: string;
  metadataPath: string;
}

export interface SelfRefactorRunReport {
  version: 1;
  id: string;
  createdAt: string;
  mode: "dry-run" | "execute";
  status: "planned" | "passed" | "failed" | "blocked";
  planId: string;
  planHash: string;
  driverId: string;
  driverHash: string;
  driverEvidenceHash: string;
  checkpoint: SelfRefactorCheckpoint;
  selectedTask?: SelfRefactorPlan["tasks"][number];
  checks: Array<{ command: string; passed: boolean; exitCode: number | null; durationMs: number; error?: string }>;
  driverVerification: { passed: boolean; command?: string; error?: string };
  changedPaths: string[];
  scope: { passed: boolean; maxChangedFiles: number; violations: string[] };
  structure?: { passed: boolean; beforeHash: string; afterHash: string; newCycles: string[][]; exportDrift: string[]; oversizedGrowth: string[] };
  outputPath?: string;
  reportHash?: string;
}

export interface SelfRefactorCrossValidationReport {
  version: 1;
  id: string;
  createdAt: string;
  status: "passed" | "failed";
  driverId: string;
  driverHash: string;
  driverEvidenceHash: string;
  runId: string;
  runHash: string;
  candidatePath: string;
  candidateHash: string;
  checks: Array<{ id: string; passed: boolean; evidence: string }>;
  reportHash: string;
  outputPath?: string;
}

export interface SelfRefactorPromotionHandoff {
  version: 1;
  id: string;
  createdAt: string;
  status: "ready-for-review";
  crossValidationId: string;
  crossValidationHash: string;
  candidatePath: string;
  candidateHash: string;
  publish: "manual";
  tag: "manual";
  nextActions: string[];
  outputPath?: string;
}

export interface SelfRefactorRollbackReport {
  version: 1;
  checkpointId: string;
  restored: boolean;
  gitHead: string;
  restoredUntrackedFiles: string[];
}

export async function runSelfRefactorStep(options: {
  root: string;
  artifactsDir: string;
  planPath: string;
  driverEvidencePath: string;
  execute?: boolean;
  taskId?: string;
  confirmation?: string;
  editCommand?: string;
  maxChangedFiles?: number;
}): Promise<SelfRefactorRunReport> {
  const root = path.resolve(options.root);
  const planValue = await readJsonFile<unknown>(path.resolve(options.planPath));
  validateSelfRefactorPlan(planValue);
  const plan = planValue;
  if (path.resolve(plan.root) !== root) throw new Error("Self-refactor plan root does not match the execution root.");
  const beforeInventory = await collectSelfRefactorInventory(root);
  if (selfRefactorInventoryHash(beforeInventory) !== plan.inventoryHash) throw new Error("Self-refactor inventory changed; create and review a fresh plan.");
  const planHash = selfRefactorPlanHash(plan);
  if (options.execute && options.confirmation !== planHash) throw new Error("Self-refactor execution requires the reviewed plan hash via --confirm.");
  const driver = await readJsonFile<SelfRefactorDriverEvidence>(path.resolve(options.driverEvidencePath));
  await validateDriver(driver);
  const checkpoint = await createSelfRefactorCheckpoint(root, options.artifactsDir);
  const selectedTask = options.taskId ? plan.tasks.find((task) => task.id === options.taskId) : plan.tasks[1] ?? plan.tasks[0];
  if (!selectedTask) throw new Error("Self-refactor plan has no executable task.");
  if (options.taskId && selectedTask.id !== options.taskId) throw new Error(`Self-refactor task not found: ${options.taskId}`);
  const report: SelfRefactorRunReport = {
    version: 1,
    id: `self-refactor-run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    mode: options.execute ? "execute" : "dry-run",
    status: "planned",
    planId: plan.id,
    planHash,
    driverId: driver.id,
    driverHash: driver.tarballHash,
    driverEvidenceHash: driver.evidenceHash,
    checkpoint,
    selectedTask,
    checks: [],
    driverVerification: { passed: false },
    changedPaths: [],
    scope: { passed: true, maxChangedFiles: options.maxChangedFiles ?? 8, violations: [] }
  };
  if (options.execute) {
    report.driverVerification = await verifyInstalledDriver(driver);
    if (report.driverVerification.passed) report.driverVerification = await verifyWorkspaceAgainstDriver(root, driver);
    if (!report.driverVerification.passed) report.status = "blocked";
    else {
      const beforeFiles = await captureFileFingerprints(root);
      if (selectedTask.id === "extract-one-responsibility" && !options.editCommand) throw new Error("The extraction task requires --edit-command.");
      if (options.editCommand) {
        const edit = await runShellCommand(options.editCommand, { cwd: root, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 1024 * 1024 });
        if (edit.exitCode !== 0 || edit.timedOut) {
          report.status = "failed";
          report.checks.push({ command: options.editCommand, passed: false, exitCode: edit.exitCode, durationMs: edit.durationMs, error: edit.stderr || edit.stdout || edit.error || "edit failed" });
        }
      }
      const afterFiles = await captureFileFingerprints(root);
      report.changedPaths = changedFingerprintPaths(beforeFiles, afterFiles);
      report.scope = evaluateSelfRefactorScope(report.changedPaths, selectedTask.affectedPaths, options.maxChangedFiles ?? 8);
      const afterInventory = await collectSelfRefactorInventory(root);
      report.structure = compareSelfRefactorStructure(beforeInventory, afterInventory);
      if (!report.scope.passed || !report.structure.passed) report.status = "failed";
      if (report.status === "failed") {
        report.reportHash = selfRefactorRunReportHash(report);
        report.outputPath = await writeExecutionArtifact(options.artifactsDir, `${report.id}.json`, report);
        return report;
      }
      for (const command of selectedTask.requiredChecks) {
        const result = await runShellCommand(command, { cwd: root, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 1024 * 1024 });
        report.checks.push({ command, passed: result.exitCode === 0 && !result.timedOut, exitCode: result.exitCode, durationMs: result.durationMs, ...(result.exitCode === 0 && !result.timedOut ? {} : { error: result.stderr || result.stdout || result.error || "check failed" }) });
        if (!report.checks.at(-1)?.passed) break;
      }
      report.status = report.checks.length === selectedTask.requiredChecks.length && report.checks.every((check) => check.passed) && report.scope.passed && report.structure.passed ? "passed" : "failed";
    }
  }
  report.reportHash = selfRefactorRunReportHash(report);
  report.outputPath = await writeExecutionArtifact(options.artifactsDir, `${report.id}.json`, report);
  return report;
}

export async function crossValidateSelfRefactor(options: {
  artifactsDir: string;
  driverEvidencePath: string;
  candidatePath: string;
  runReportPath: string;
}): Promise<SelfRefactorCrossValidationReport> {
  const driver = await readJsonFile<SelfRefactorDriverEvidence>(path.resolve(options.driverEvidencePath));
  await validateDriver(driver);
  const runReport = await readJsonFile<SelfRefactorRunReport>(path.resolve(options.runReportPath));
  if (runReport.status !== "passed" || !runReport.reportHash || selfRefactorRunReportHash(runReport) !== runReport.reportHash) throw new Error("Cross-validation requires a hash-valid passing self-refactor run report.");
  if (runReport.driverId !== driver.id || runReport.driverHash !== driver.tarballHash || runReport.driverEvidenceHash !== driver.evidenceHash) throw new Error("Self-refactor run report does not match the selected driver.");
  const candidatePath = path.resolve(options.candidatePath);
  if (!await pathExists(candidatePath)) throw new Error(`Candidate tarball not found: ${candidatePath}`);
  const candidateHash = await hashFile(candidatePath);
  const [driverInspection, candidateInspection] = await Promise.all([inspectInstalledPackage(driver.tarballPath), inspectInstalledPackage(candidatePath)]);
  const checks = [
    { id: "driver-tarball-hash", passed: true, evidence: driver.tarballHash },
    { id: "passing-run-evidence", passed: true, evidence: runReport.reportHash },
    { id: "candidate-tarball-hash", passed: /^[a-f0-9]{64}$/.test(candidateHash), evidence: candidateHash },
    { id: "cli-help-compatible", passed: driverInspection.help === candidateInspection.help, evidence: driverInspection.help === candidateInspection.help ? "exact match" : "CLI help changed" },
    { id: "init-contract-compatible", passed: driverInspection.initContract === candidateInspection.initContract, evidence: driverInspection.initContract === candidateInspection.initContract ? "exact match" : "init detection contract changed" },
    { id: "candidate-package-surface", passed: candidateInspection.forbiddenFiles.length === 0, evidence: candidateInspection.forbiddenFiles.join(", ") || `${candidateInspection.fileCount} packaged files inspected` }
  ];
  const core = {
    version: 1 as const,
    id: `self-refactor-cross-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? "passed" as const : "failed" as const,
    driverId: driver.id,
    driverHash: driver.tarballHash,
    driverEvidenceHash: driver.evidenceHash,
    runId: runReport.id,
    runHash: runReport.reportHash,
    candidatePath,
    candidateHash,
    checks
  };
  const report: SelfRefactorCrossValidationReport = { ...core, reportHash: hashJson(core) };
  report.outputPath = await writeExecutionArtifact(options.artifactsDir, `${report.id}.json`, report);
  return report;
}

export async function createSelfRefactorPromotionHandoff(options: {
  artifactsDir: string;
  crossValidationPath: string;
  confirmation: string;
}): Promise<SelfRefactorPromotionHandoff> {
  const report = await readJsonFile<SelfRefactorCrossValidationReport>(path.resolve(options.crossValidationPath));
  if (report.status !== "passed") throw new Error("Only a passing cross-validation report can be promoted.");
  const requiredChecks = ["driver-tarball-hash", "passing-run-evidence", "candidate-tarball-hash", "cli-help-compatible", "init-contract-compatible", "candidate-package-surface"];
  if (requiredChecks.some((id) => !report.checks.some((check) => check.id === id && check.passed))) throw new Error("Cross-validation report is missing required passing checks.");
  if (hashJson(crossValidationCore(report)) !== report.reportHash) throw new Error("Cross-validation report content hash is invalid.");
  if (report.reportHash !== options.confirmation) throw new Error("Promotion confirmation does not match the cross-validation hash.");
  if (!await pathExists(report.candidatePath) || await hashFile(report.candidatePath) !== report.candidateHash) throw new Error("Promotion candidate is missing or its hash changed.");
  const handoff: SelfRefactorPromotionHandoff = {
    version: 1,
    id: `self-refactor-promotion-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    status: "ready-for-review",
    crossValidationId: report.id,
    crossValidationHash: report.reportHash,
    candidatePath: report.candidatePath,
    candidateHash: report.candidateHash,
    publish: "manual",
    tag: "manual",
    nextActions: ["Review the candidate and cross-validation evidence.", "Publish manually after approval.", "Create the release tag manually after post-publish verification."]
  };
  handoff.outputPath = await writeExecutionArtifact(options.artifactsDir, `${handoff.id}.json`, handoff);
  await writeTextFile(handoff.outputPath.replace(/\.json$/, ".md"), renderPromotionHandoff(handoff));
  return handoff;
}

async function createSelfRefactorCheckpoint(root: string, artifactsDir: string): Promise<SelfRefactorCheckpoint> {
  const id = `checkpoint-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(path.resolve(artifactsDir), "self-refactor", id);
  const [head, status, patch, untrackedText] = await Promise.all([
    checkedGit("git rev-parse HEAD", root),
    checkedGit("git status --porcelain=v1 --untracked-files=all", root),
    checkedGit("git diff --binary HEAD", root),
    checkedGit("git ls-files --others --exclude-standard", root)
  ]);
  await ensureDir(dir);
  const patchPath = path.join(dir, "workspace.patch");
  const untrackedDir = path.join(dir, "untracked");
  await fs.writeFile(patchPath, patch, "utf8");
  const untrackedFiles: Array<{ path: string; hash: string }> = [];
  for (const relative of untrackedText.split(/\r?\n/).filter(Boolean)) {
    const source = path.join(root, relative);
    const stats = await fs.stat(source).catch(() => undefined);
    if (!stats?.isFile()) continue;
    const destination = path.join(untrackedDir, relative);
    await ensureDir(path.dirname(destination));
    await fs.copyFile(source, destination);
    untrackedFiles.push({ path: relative.replace(/\\/g, "/"), hash: await hashFile(source) });
  }
  const metadataPath = path.join(dir, "checkpoint.json");
  const core = { version: 1 as const, id, createdAt: new Date().toISOString(), root, gitHead: head.trim(), gitStatus: status, patchPath, patchHash: createHash("sha256").update(patch).digest("hex"), untrackedDir, untrackedFiles, metadataPath };
  const checkpoint: SelfRefactorCheckpoint = { ...core, checkpointHash: hashJson(core) };
  await writeJsonFile(metadataPath, checkpoint);
  return checkpoint;
}

export async function rollbackSelfRefactorCheckpoint(checkpointPath: string, confirmation: string): Promise<SelfRefactorRollbackReport> {
  const checkpoint = await readJsonFile<SelfRefactorCheckpoint>(path.resolve(checkpointPath));
  const { checkpointHash: _stored, ...core } = checkpoint;
  if (hashJson(core) !== checkpoint.checkpointHash || confirmation !== checkpoint.checkpointHash) throw new Error("Self-refactor rollback confirmation or checkpoint hash is invalid.");
  const patch = await fs.readFile(checkpoint.patchPath, "utf8");
  if (createHash("sha256").update(patch).digest("hex") !== checkpoint.patchHash) throw new Error("Self-refactor checkpoint patch hash changed.");
  const snapshots = await Promise.all(checkpoint.untrackedFiles.map(async (item) => {
    const content = await fs.readFile(path.join(checkpoint.untrackedDir, item.path));
    if (createHash("sha256").update(content).digest("hex") !== item.hash) throw new Error(`Self-refactor untracked snapshot hash changed: ${item.path}`);
    return { path: item.path, content };
  }));
  await checkedGit(`git reset --hard ${checkpoint.gitHead}`, checkpoint.root);
  await checkedGit("git clean -fd", checkpoint.root);
  if (patch.trim()) await checkedGit(`git apply --binary "${checkpoint.patchPath}"`, checkpoint.root).catch(async () => {
    const tempPatch = path.join(os.tmpdir(), `migration-guard-rollback-${randomUUID()}.patch`);
    try { await fs.writeFile(tempPatch, patch); await checkedGit(`git apply --binary "${tempPatch}"`, checkpoint.root); }
    finally { await fs.rm(tempPatch, { force: true }); }
  });
  for (const snapshot of snapshots) {
    const destination = path.join(checkpoint.root, snapshot.path);
    await ensureDir(path.dirname(destination));
    await fs.writeFile(destination, snapshot.content);
  }
  return { version: 1, checkpointId: checkpoint.id, restored: true, gitHead: checkpoint.gitHead, restoredUntrackedFiles: snapshots.map((item) => item.path) };
}

async function validateDriver(driver: SelfRefactorDriverEvidence): Promise<void> {
  const { evidenceHash, ...core } = driver;
  if (!driver.workingTreeClean || !/^[a-f0-9]{64}$/.test(driver.tarballHash) || hashJson(core) !== evidenceHash) throw new Error("Invalid self-refactor driver evidence.");
  if (!await pathExists(driver.tarballPath)) throw new Error(`Driver tarball not found: ${driver.tarballPath}`);
  if (await hashFile(driver.tarballPath) !== driver.tarballHash) throw new Error("Self-refactor driver tarball hash changed.");
}

async function verifyInstalledDriver(driver: SelfRefactorDriverEvidence) {
  try {
    await inspectInstalledPackage(driver.tarballPath);
    return { passed: true, command: "migration-guard --help + init --detect" };
  } catch (error) {
    return { passed: false, command: "migration-guard --help", error: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyWorkspaceAgainstDriver(root: string, driver: SelfRefactorDriverEvidence) {
  try {
    for (const descriptor of driver.verificationFiles ?? []) {
      const absolute = path.join(root, descriptor.path);
      if (!await pathExists(absolute) || await hashFile(absolute) !== descriptor.hash) throw new Error(`Stable verification file changed: ${descriptor.path}`);
    }
    return { passed: true, command: "stable verification file hashes" };
  } catch (error) {
    return { passed: false, command: "stable verification file hashes", error: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectInstalledPackage(tarballPath: string): Promise<{ help: string; initContract: string; fileCount: number; forbiddenFiles: string[] }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "migration-guard-self-driver-"));
  try {
    await fs.writeFile(path.join(temp, "package.json"), '{"private":true}\n');
    await checkedCommand(`npm install --ignore-scripts "${tarballPath}"`, temp, 120000);
    const packageRoot = path.join(temp, "node_modules", "migration-guard");
    const cli = path.join(packageRoot, "dist", "cli.js");
    const help = (await checkedCommand(`"${process.execPath}" "${cli}" --help`, temp, 30000)).stdout.replace(/\r\n/g, "\n");
    const fixture = path.join(temp, "fixture");
    await ensureDir(fixture);
    await fs.writeFile(path.join(fixture, "package.json"), '{"name":"self-refactor-fixture","scripts":{"test":"node --test"}}\n');
    const initOutput = (await checkedCommand(`"${process.execPath}" "${cli}" init --detect --json`, fixture, 30000)).stdout;
    const initContract = normalizeSelfRefactorInitContract(initOutput, fixture);
    const files = await listRelativeFiles(packageRoot);
    const forbiddenFiles = files.filter((file) => file.startsWith("src/") || file.startsWith("pilots/") || file.includes(".test."));
    return { help, initContract, fileCount: files.length, forbiddenFiles };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export function normalizeSelfRefactorInitContract(output: string, fixtureRoot: string): string {
  const root = path.resolve(fixtureRoot);
  try {
    const normalized = normalizeInitContractValue(JSON.parse(output) as unknown, root);
    return `${JSON.stringify(normalized)}\n`;
  } catch {
    return output.replace(/\r\n/g, "\n")
      .split(root).join("<fixture>")
      .split(root.replace(/\\/g, "/")).join("<fixture>");
  }
}

function normalizeInitContractValue(value: unknown, fixtureRoot: string): unknown {
  if (typeof value === "string") {
    const resolved = path.resolve(value);
    const relative = path.relative(fixtureRoot, resolved);
    if (value === fixtureRoot || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return relative ? `<fixture>/${relative.replace(/\\/g, "/")}` : "<fixture>";
    }
    return value
      .split(fixtureRoot).join("<fixture>")
      .split(fixtureRoot.replace(/\\/g, "/")).join("<fixture>");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeInitContractValue(item, fixtureRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, normalizeInitContractValue(item, fixtureRoot)]));
  }
  return value;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) result.push(path.relative(root, entryPath).replace(/\\/g, "/"));
    }
  };
  await visit(root);
  return result.sort();
}

async function checkedGit(command: string, cwd: string): Promise<string> {
  return (await checkedCommand(command, cwd, 30000)).stdout;
}

async function checkedCommand(command: string, cwd: string, timeoutMs: number) {
  const result = await runShellCommand(command, { cwd, timeoutMs, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error || "unknown error"}`);
  return result;
}

async function writeExecutionArtifact(artifactsDir: string, name: string, value: unknown): Promise<string> {
  const outputPath = path.join(path.resolve(artifactsDir), "self-refactor", name);
  await writeJsonFile(outputPath, value);
  return outputPath;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function captureFileFingerprints(root: string): Promise<Map<string, string>> {
  const listed = await checkedGit("git ls-files --cached --others --exclude-standard", root);
  const result = new Map<string, string>();
  for (const relative of listed.split(/\r?\n/).filter(Boolean)) {
    const normalized = relative.replace(/\\/g, "/");
    const absolute = path.join(root, relative);
    const stats = await fs.stat(absolute).catch(() => undefined);
    if (stats?.isFile()) result.set(normalized, await hashFile(absolute));
  }
  return result;
}

function changedFingerprintPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();
}

export function evaluateSelfRefactorScope(changedPaths: string[], affectedPaths: string[], maxChangedFiles: number) {
  const allowed = affectedPaths.map((item) => item.replace(/\\/g, "/").replace(/\/$/, ""));
  const violations = changedPaths.filter((changed) => !allowed.some((candidate) => changed === candidate || !path.posix.extname(candidate) && changed.startsWith(`${candidate}/`)));
  if (changedPaths.length > maxChangedFiles) violations.push(`changed file count ${changedPaths.length} exceeds ${maxChangedFiles}`);
  return { passed: violations.length === 0, maxChangedFiles, violations };
}

export function compareSelfRefactorStructure(before: SelfRefactorInventory, after: SelfRefactorInventory) {
  const beforeModules = new Map(before.modules.map((module) => [module.path, module]));
  const afterModules = new Map(after.modules.map((module) => [module.path, module]));
  const beforeCycles = new Set(before.cycles.map((cycle) => cycle.join(" -> ")));
  const newCycles = after.cycles.filter((cycle) => !beforeCycles.has(cycle.join(" -> ")));
  const exportDrift: string[] = [];
  const oversizedGrowth: string[] = [];
  for (const [filePath, previous] of beforeModules) {
    const current = afterModules.get(filePath);
    if (!current) { exportDrift.push(`${filePath}: module removed`); continue; }
    if (JSON.stringify(previous.runtimeExports) !== JSON.stringify(current.runtimeExports)) exportDrift.push(filePath);
    if (previous.lines > before.policy.maxFileLines && current.lines > previous.lines) oversizedGrowth.push(filePath);
  }
  for (const current of after.modules) if (!beforeModules.has(current.path) && current.lines > after.policy.maxFileLines) oversizedGrowth.push(current.path);
  return {
    passed: newCycles.length === 0 && exportDrift.length === 0 && oversizedGrowth.length === 0,
    beforeHash: selfRefactorInventoryHash(before),
    afterHash: selfRefactorInventoryHash(after),
    newCycles,
    exportDrift,
    oversizedGrowth
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function selfRefactorRunReportHash(report: SelfRefactorRunReport): string {
  const { outputPath: _outputPath, reportHash: _reportHash, ...core } = report;
  return hashJson(core);
}

function crossValidationCore(report: SelfRefactorCrossValidationReport): unknown {
  return {
    version: report.version,
    id: report.id,
    createdAt: report.createdAt,
    status: report.status,
    driverId: report.driverId,
    driverHash: report.driverHash,
    driverEvidenceHash: report.driverEvidenceHash,
    runId: report.runId,
    runHash: report.runHash,
    candidatePath: report.candidatePath,
    candidateHash: report.candidateHash,
    checks: report.checks
  };
}

function renderPromotionHandoff(handoff: SelfRefactorPromotionHandoff): string {
  return ["# Self-refactor Promotion Handoff", "", `- Status: ${handoff.status}`, `- Cross-validation: ${handoff.crossValidationId}`, `- Evidence hash: ${handoff.crossValidationHash}`, `- Candidate: ${handoff.candidatePath}`, `- Candidate hash: ${handoff.candidateHash}`, `- Publish: ${handoff.publish}`, `- Tag: ${handoff.tag}`, "", "## Next Actions", "", ...handoff.nextActions.map((item) => `- ${item}`), ""].join("\n");
}
