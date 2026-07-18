import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { ensureDir, toPosixPath, writeJsonFile } from "./files.js";

export interface SelfRefactorModuleInventory {
  path: string;
  lines: number;
  runtimeExports: string[];
  imports: string[];
  sourceHash: string;
}

export interface SelfRefactorInventory {
  version: 1;
  root: string;
  createdAt: string;
  modules: SelfRefactorModuleInventory[];
  cycles: string[][];
  policy: { maxFileLines: number; oversizedFiles: string[] };
}

export interface SelfRefactorPlan {
  version: 1;
  id: string;
  createdAt: string;
  root: string;
  target: string;
  goal: string;
  status: "planned";
  tasks: Array<{
    id: string;
    title: string;
    affectedPaths: string[];
    requiredChecks: string[];
    acceptance: string[];
  }>;
  inventoryHash: string;
}

export const SELF_REFACTOR_ALLOWED_CHECKS = ["npm run build", "npm test", "npm run package:golden", "git diff --check"] as const;

export interface SelfRefactorDriverEvidence {
  version: 1;
  id: string;
  createdAt: string;
  workspace: string;
  commit: string;
  packageVersion: string;
  tarballPath: string;
  tarballHash: string;
  workingTreeClean: true;
  evidenceHash: string;
  verificationFiles: Array<{ path: string; hash: string }>;
}

export async function collectSelfRefactorInventory(root = process.cwd(), maxFileLines = 700): Promise<SelfRefactorInventory> {
  const resolvedRoot = path.resolve(root);
  const sourceRoot = path.join(resolvedRoot, "src");
  const files = await collectTypeScriptFiles(sourceRoot);
  const ts = await import("typescript");
  const modules = await Promise.all(files.map(async (filePath) => {
    const source = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return {
      path: toPosixPath(path.relative(resolvedRoot, filePath)),
      lines: source.split(/\r?\n/).length,
      runtimeExports: collectRuntimeExports(sourceFile, ts),
      imports: collectLocalImports(sourceFile, filePath, resolvedRoot, ts),
      sourceHash: createHash("sha256").update(source).digest("hex")
    };
  }));
  modules.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    version: 1,
    root: resolvedRoot,
    createdAt: new Date().toISOString(),
    modules,
    cycles: findCycles(modules),
    policy: {
      maxFileLines,
      oversizedFiles: modules.filter((module) => module.lines > maxFileLines).map((module) => module.path)
    }
  };
}

export function createSelfRefactorPlan(
  inventory: SelfRefactorInventory,
  target: string,
  goal: string
): SelfRefactorPlan {
  const normalizedTarget = target.trim();
  const normalizedGoal = goal.trim();
  if (!normalizedTarget || !normalizedGoal) throw new Error("Self-refactor plan requires non-empty target and goal.");
  const targetModules = inventory.modules.filter((module) => module.path.toLowerCase().includes(normalizedTarget.toLowerCase()));
  if (targetModules.length === 0) throw new Error(`Self-refactor target did not match any source module: ${normalizedTarget}`);
  const checks = [...SELF_REFACTOR_ALLOWED_CHECKS];
  const inferredPrefix = targetModules.map((item) => item.path.replace(/\.ts$/, ""));
  const affectedPaths = [...new Set([...targetModules.map((item) => item.path), ...inferredPrefix])];
  return {
    version: 1,
    id: `self-refactor-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    root: inventory.root,
    target: normalizedTarget,
    goal: normalizedGoal,
    status: "planned",
    inventoryHash: stableHash(inventoryCore(inventory)),
    tasks: [
      { id: "lock-contracts", title: "Lock public and structural contracts", affectedPaths, requiredChecks: ["npm test"], acceptance: ["Runtime exports and CLI command contracts are unchanged."] },
      { id: "extract-one-responsibility", title: "Extract one bounded responsibility", affectedPaths, requiredChecks: checks, acceptance: ["One responsibility moves behind an explicit module boundary.", "No unrelated behavior changes are included."] },
      { id: "verify-stable-driver", title: "Verify candidate with the stable driver", affectedPaths: [], requiredChecks: checks, acceptance: ["Stable-driver verification passes.", "Artifact and package compatibility remain unchanged."] }
    ]
  };
}

export function selfRefactorInventoryHash(inventory: SelfRefactorInventory): string {
  return stableHash(inventoryCore(inventory));
}

export function selfRefactorPlanHash(plan: SelfRefactorPlan): string {
  return stableHash(plan);
}

export function validateSelfRefactorPlan(value: unknown): asserts value is SelfRefactorPlan {
  if (!value || typeof value !== "object") throw new Error("Invalid self-refactor plan: expected an object.");
  const plan = value as Partial<SelfRefactorPlan>;
  if (plan.version !== 1 || plan.status !== "planned" || typeof plan.id !== "string" || typeof plan.root !== "string" || typeof plan.inventoryHash !== "string" || !Array.isArray(plan.tasks)) throw new Error("Invalid self-refactor plan schema.");
  for (const task of plan.tasks) {
    if (!task || typeof task.id !== "string" || !Array.isArray(task.affectedPaths) || !Array.isArray(task.requiredChecks) || !Array.isArray(task.acceptance)) throw new Error("Invalid self-refactor task schema.");
    if (task.requiredChecks.some((command) => !(SELF_REFACTOR_ALLOWED_CHECKS as readonly string[]).includes(command))) throw new Error(`Self-refactor plan contains a disallowed check command: ${task.requiredChecks.join(", ")}`);
  }
}

export async function writeSelfRefactorArtifact(artifactsDir: string, name: string, value: unknown): Promise<string> {
  const outputPath = path.join(path.resolve(artifactsDir), "self-refactor", name);
  await writeJsonFile(outputPath, value);
  return outputPath;
}

export async function createSelfRefactorDriver(
  workspace = process.cwd(),
  artifactsDir = path.join(workspace, ".migration-guard")
): Promise<SelfRefactorDriverEvidence> {
  const root = path.resolve(workspace);
  const status = await checkedCommand("git status --porcelain=v1 --untracked-files=all", root);
  if (status.stdout.trim()) throw new Error("Self-refactor driver requires a clean Git worktree.");
  const commit = (await checkedCommand("git rev-parse HEAD", root)).stdout.trim();
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("Self-refactor driver requires package.json version.");
  const packed = JSON.parse((await checkedCommand("npm pack --json --ignore-scripts", root)).stdout) as Array<{ filename?: string }>;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a driver tarball filename.");
  const sourceTarball = path.join(root, filename);
  const id = `driver-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const driverDir = path.join(path.resolve(artifactsDir), "self-refactor", id);
  const tarballPath = path.join(driverDir, filename);
  try {
    await ensureDir(driverDir);
    await fs.copyFile(sourceTarball, tarballPath);
    const verificationFiles = await collectDriverVerificationFiles(root);
    const core = {
      version: 1 as const,
      id,
      createdAt: new Date().toISOString(),
      workspace: root,
      commit,
      packageVersion: packageJson.version,
      tarballPath,
      tarballHash: createHash("sha256").update(await fs.readFile(tarballPath)).digest("hex"),
      workingTreeClean: true as const,
      verificationFiles
    };
    const evidence: SelfRefactorDriverEvidence = { ...core, evidenceHash: stableHash(core) };
    await writeJsonFile(path.join(driverDir, "driver.json"), evidence);
    return evidence;
  } finally {
    await fs.rm(sourceTarball, { force: true });
  }
}

async function collectDriverVerificationFiles(root: string): Promise<Array<{ path: string; hash: string }>> {
  const relativePaths = ["package.json", "scripts/ci/run-tests.mjs", "scripts/ci/test-discovery.mjs", "scripts/ci/test-manifest.json", "scripts/ci/audit-package.mjs", "scripts/smoke/golden-path-smoke.mjs", "scripts/smoke/ui-server-smoke.mjs"];
  const descriptors: Array<{ path: string; hash: string }> = [];
  for (const relative of relativePaths) {
    const content = await fs.readFile(path.join(root, relative));
    descriptors.push({ path: relative, hash: createHash("sha256").update(content).digest("hex") });
  }
  return descriptors;
}

function collectRuntimeExports(sourceFile: import("typescript").SourceFile, ts: typeof import("typescript")): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))) {
      names.push(isDefault ? "default" : statement.name?.text ?? "default");
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    } else if (ts.isExportAssignment(statement)) names.push("default");
    else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (!statement.exportClause) names.push("*");
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.push(element.name.text);
      }
    }
  }
  return [...new Set(names)].sort();
}

function collectLocalImports(sourceFile: import("typescript").SourceFile, filePath: string, root: string, ts: typeof import("typescript")): string[] {
  const imports: string[] = [];
  const add = (value: string): void => { if (value.startsWith(".")) imports.push(value); };
  const visit = (node: import("typescript").Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const allNamedTypeOnly = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
        : false;
      if (!clause?.isTypeOnly && !allNamedTypeOnly) add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(imports.map((specifier) => {
    const resolved = path.resolve(path.dirname(filePath), specifier.replace(/\.js$/, ".ts"));
    return toPosixPath(path.relative(root, resolved));
  }))].sort();
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(entryPath);
    }
  };
  await visit(directory);
  return files;
}

function findCycles(modules: SelfRefactorModuleInventory[]): string[][] {
  const graph = new Map(modules.map((module) => [module.path, module.imports.filter((item) => modules.some((candidate) => candidate.path === item))]));
  const cycles = new Set<string>();
  const completed = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    const index = stack.indexOf(node);
    if (index >= 0) { cycles.add([...stack.slice(index), node].join(" -> ")); return; }
    if (completed.has(node)) return;
    for (const next of graph.get(node) ?? []) visit(next, [...stack, node]);
    completed.add(node);
  };
  for (const node of graph.keys()) visit(node, []);
  return [...cycles].sort().map((cycle) => cycle.split(" -> "));
}

function inventoryCore(inventory: SelfRefactorInventory): unknown {
  return { version: inventory.version, modules: inventory.modules, cycles: inventory.cycles, policy: inventory.policy };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function checkedCommand(command: string, cwd: string) {
  const result = await runShellCommand(command, { cwd, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error || "unknown error"}`);
  return result;
}
