import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { loadActionPlan } from "./actionPlan.js";
import { appendEvidence, createId, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type { LoadedConfig, MigrationAction, MigrationActionPatchTemplate, ProposedPatch } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import { runShellCommand } from "./exec.js";

export async function proposePatch(loaded: LoadedConfig, pkg: MigrationRunPackage, taskId: string): Promise<ProposedPatch> {
  const task = pkg.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const proposed: ProposedPatch = {
    version: 1,
    id,
    runId: pkg.run.id,
    taskId,
    createdAt: new Date().toISOString(),
    title: `Dry-run proposal for ${task.title}`,
    summary: createPatchSummary(task.title, task.affectedFiles),
    risk: task.risk,
    patchPath,
    affectedFiles: task.affectedFiles,
    recommendedChecks: task.verificationCommands,
    patchKind: "task-placeholder",
    applyState: "proposed"
  };
  await writeTextFile(patchPath, createPatchContent(pkg.run.goal, task.title, task.affectedFiles));
  await writeJsonFile(path.join(dir, "proposal.json"), proposed);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId,
    type: "task-updated",
    message: `Created dry-run patch proposal ${id}`,
    data: {
      patchPath
    }
  });
  return proposed;
}

export async function proposeActionPatch(loaded: LoadedConfig, pkg: MigrationRunPackage, actionId: string): Promise<ProposedPatch> {
  const plan = await loadActionPlan(loaded, pkg);
  const action = plan.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`Action not found: ${actionId}`);
  }

  const id = createId("patch");
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(dir, "patch.diff");
  const generatedFile = createActionProbePath(action);
  if (await pathExists(path.join(pkg.run.targetRoot, generatedFile))) {
    throw new Error(`Generated probe already exists in target: ${generatedFile}`);
  }

  const probeContent = createActionProbeScript(pkg.run.goal, action);
  const patchContent = createAddFilePatch(generatedFile, probeContent);
  const recommendedChecks = [...new Set([...action.recommendedChecks, `node ${generatedFile}`])];
  const proposed: ProposedPatch = {
    version: 1,
    id,
    runId: pkg.run.id,
    actionId: action.id,
    createdAt: new Date().toISOString(),
    title: `Action proposal for ${action.title}`,
    summary: action.summary,
    risk: action.risk,
    patchPath,
    affectedFiles: action.affectedFiles,
    generatedFiles: [generatedFile],
    recommendedChecks,
    patchKind: "action-probe",
    applyState: "proposed"
  };

  await writeTextFile(patchPath, patchContent);
  await writeJsonFile(path.join(dir, "proposal.json"), proposed);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "task-updated",
    message: `Created action patch proposal ${id} for ${action.id}`,
    data: {
      actionId: action.id,
      patchPath,
      generatedFiles: proposed.generatedFiles,
      recommendedChecks
    }
  });
  return proposed;
}

export async function applyProposedPatch(loaded: LoadedConfig, pkg: MigrationRunPackage, proposalId: string): Promise<string> {
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", proposalId);
  const proposalPath = path.join(dir, "proposal.json");
  const proposal = await readJsonFile<ProposedPatch>(proposalPath);
  const patchContent = await fs.readFile(proposal.patchPath, "utf8");

  if (!isGitPatchContent(patchContent)) {
    proposal.applyState = "applied";
    await writeJsonFile(proposalPath, proposal);
    await appendEvidence(loaded, pkg.run.id, {
      runId: pkg.run.id,
      taskId: proposal.taskId,
      type: "task-updated",
      message: `Marked non-mutating patch proposal ${proposal.id} as applied`,
      data: {
        patchPath: proposal.patchPath,
        noOp: true
      }
    });
    await saveRunPackage(loaded, pkg);
    return `Proposal ${proposal.id} is non-mutating; marked applied.`;
  }

  const check = await runShellCommand(`git apply --check "${proposal.patchPath}"`, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });

  if (check.exitCode !== 0) {
    throw new Error(`Patch check failed:\n${check.stderr || check.stdout || check.error || "unknown error"}`);
  }

  const apply = await runShellCommand(`git apply "${proposal.patchPath}"`, {
    cwd: pkg.run.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });

  if (apply.exitCode !== 0) {
    throw new Error(`Patch apply failed:\n${apply.stderr || apply.stdout || apply.error || "unknown error"}`);
  }

  proposal.applyState = "applied";
  await writeJsonFile(proposalPath, proposal);
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    taskId: proposal.taskId,
    type: "task-updated",
    message: `Applied patch proposal ${proposal.id}`,
    data: {
      patchPath: proposal.patchPath
    }
  });
  await saveRunPackage(loaded, pkg);
  return `Applied proposal ${proposal.id}.`;
}

function createPatchSummary(title: string, affectedFiles: string[]): string {
  if (affectedFiles.length === 0) {
    return `${title}. This first proposal is intentionally empty and records the checks that should run before any source edit.`;
  }
  return `${title}. Review affected files before applying: ${affectedFiles.join(", ")}.`;
}

function createPatchContent(goal: string, title: string, affectedFiles: string[]): string {
  return [
    "# Dry-run patch proposal",
    "#",
    `# Goal: ${goal}`,
    `# Task: ${title}`,
    `# Affected files: ${affectedFiles.join(", ") || "none"}`,
    "#",
    "# This proposal is intentionally non-mutating. It is a placeholder patch that lets the run",
    "# record review intent, recommended checks, and approval before future adapters emit source edits.",
    ""
  ].join("\n");
}

export function createAddFilePatch(filePath: string, content: string): string {
  const normalizedPath = normalizePatchPath(filePath);
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  const lines = normalizedContent.slice(0, -1).split("\n");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
}

function isGitPatchContent(input: string): boolean {
  return input
    .split(/\r?\n/)
    .some((line) => line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ "));
}

function createActionProbePath(action: MigrationAction): string {
  return `scripts/migration-guard/${sanitizeFileName(action.id)}.mjs`;
}

function createActionProbeScript(goal: string, action: MigrationAction): string {
  const template = inferPatchTemplate(action);
  const requiredFiles = action.affectedFiles.length > 0 ? action.affectedFiles : ["package.json"];
  const checks = createProbeChecks(template);

  return [
    "import { existsSync, readFileSync } from \"node:fs\";",
    "import path from \"node:path\";",
    "",
    `const action = ${JSON.stringify({
      id: action.id,
      title: action.title,
      goal,
      template,
      requiredFiles
    }, null, 2)};`,
    "",
    "const root = process.cwd();",
    "const results = [];",
    "",
    "for (const relativeFile of action.requiredFiles) {",
    "  const absoluteFile = path.join(root, relativeFile);",
    "  const exists = existsSync(absoluteFile);",
    "  const result = { file: relativeFile, exists, checks: [] };",
    "  if (exists) {",
    "    const text = readFileSync(absoluteFile, \"utf8\");",
    ...checks.map((check) => `    result.checks.push({ name: ${JSON.stringify(check.name)}, passed: ${check.pattern}.test(text) });`),
    "  }",
    "  results.push(result);",
    "}",
    "",
    "const failed = results.flatMap((result) => {",
    "  if (!result.exists) {",
    "    return [`missing:${result.file}`];",
    "  }",
    "  return result.checks.filter((check) => !check.passed).map((check) => `${result.file}:${check.name}`);",
    "});",
    "",
    "console.log(JSON.stringify({",
    "  actionId: action.id,",
    "  title: action.title,",
    "  goal: action.goal,",
    "  template: action.template,",
    "  passed: failed.length === 0,",
    "  results,",
    "  failed",
    "}, null, 2));",
    "",
    "if (failed.length > 0) {",
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n");
}

function createProbeChecks(template: MigrationActionPatchTemplate): Array<{ name: string; pattern: string }> {
  switch (template) {
    case "renderer-probe":
      return [
        { name: "has-renderer-signal", pattern: "/render|renderer|markdown|Marked|marked/i" },
        { name: "has-export-signal", pattern: "/export\\s+/" }
      ];
    case "api-contract-probe":
      return [
        { name: "has-export-signal", pattern: "/export\\s+/" },
        { name: "has-type-signal", pattern: "/interface|type|enum|schema/i" }
      ];
    case "ui-smoke-probe":
      return [
        { name: "has-template", pattern: "/<template[\\s>]/i" },
        { name: "has-script", pattern: "/<script[\\s>]/i" }
      ];
    default:
      return [{ name: "has-content", pattern: "/\\S/" }];
  }
}

function inferPatchTemplate(action: MigrationAction): MigrationActionPatchTemplate {
  if (action.patchTemplate) {
    return action.patchTemplate;
  }
  if (action.id.includes("renderer")) {
    return "renderer-probe";
  }
  if (action.id.includes("api")) {
    return "api-contract-probe";
  }
  return "ui-smoke-probe";
}

function normalizePatchPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.isAbsolute(filePath) || normalizedPath.split("/").includes("..")) {
    throw new Error(`Unsafe patch path: ${filePath}`);
  }
  return normalizedPath;
}

function sanitizeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "migration-action";
}
