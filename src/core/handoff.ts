import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export type HandoffPermission = "read-only" | "target-edit" | "github-mutation" | "release-mutation";

export interface HandoffArtifactReference {
  path: string;
  sha256: string;
  kind: string;
}

export interface AiHandoffContract {
  schema: "migration-guard.ai-handoff";
  version: 1;
  id: string;
  createdAt: string;
  goal: string;
  task: { id: string; title: string; description: string; source: "task" | "proposal-replan" | "one-shot" };
  permissions: { granted: HandoffPermission[]; denied: HandoffPermission[] };
  scope: { root: string; allowedPaths: string[]; maxChangedFiles: number };
  forbiddenActions: string[];
  evidence: HandoffArtifactReference[];
  suggestedCommands: string[];
  acceptanceCriteria: string[];
  budget: { maxChangedFiles: number; maxCommands: number; note?: string };
  lineage: { runId?: string; taskId?: string; proposalId?: string; parentHandoffId?: string };
  contractHash: string;
  output?: { jsonPath: string; markdownPath: string; promptPath: string };
}

export type HandoffDraft = Omit<AiHandoffContract, "schema" | "version" | "id" | "createdAt" | "contractHash" | "output"> & { id?: string; createdAt?: string };

export async function createHandoffContract(draft: HandoffDraft): Promise<AiHandoffContract> {
  const createdAt = draft.createdAt ?? new Date().toISOString();
  const core = { schema: "migration-guard.ai-handoff" as const, version: 1 as const, id: draft.id ?? `handoff-${createdAt.replace(/[:.]/g, "-")}`, createdAt, ...draft };
  const contract = { ...core, contractHash: sha256(stableStringify(core)) };
  const validation = await validateHandoffContract(contract, { verifyEvidence: false });
  if (!validation.valid) throw new Error(`Invalid handoff: ${validation.errors.join(" ")}`);
  return contract;
}

export async function referenceHandoffArtifact(root: string, filePath: string, kind: string): Promise<HandoffArtifactReference> {
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Evidence must be inside handoff root: ${filePath}`);
  return { path: relative, sha256: sha256(await fs.readFile(absolute, "utf8")), kind };
}

export async function writeHandoffContract(root: string, contract: AiHandoffContract, outputDir: string): Promise<AiHandoffContract> {
  const dir = path.resolve(outputDir);
  const output = { jsonPath: path.join(dir, `${contract.id}.json`), markdownPath: path.join(dir, `${contract.id}.md`), promptPath: path.join(dir, `${contract.id}.prompt.txt`) };
  const written = { ...contract, output };
  await ensureDir(dir);
  await writeJsonFile(output.jsonPath, written);
  await writeTextFile(output.markdownPath, renderHandoffMarkdown(written));
  await writeTextFile(output.promptPath, renderHandoffCompactPrompt(written));
  return written;
}

export async function readHandoffContract(filePath: string): Promise<AiHandoffContract> {
  return await readJsonFile<AiHandoffContract>(filePath);
}

export async function validateHandoffContract(contract: AiHandoffContract, options: { verifyEvidence?: boolean } = {}): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (contract.schema !== "migration-guard.ai-handoff" || contract.version !== 1) errors.push("Unsupported handoff schema or version.");
  if (!contract.goal?.trim() || !contract.task?.id || !contract.task?.title) errors.push("Goal and task identity are required.");
  if (!contract.permissions?.granted?.length) errors.push("At least one explicit permission is required.");
  if (contract.scope.maxChangedFiles < 0 || contract.scope.allowedPaths.length > contract.scope.maxChangedFiles) errors.push("Allowed paths exceed the changed-file budget.");
  for (const value of contract.scope.allowedPaths) if (!value || path.isAbsolute(value) || value.replace(/\\/g, "/").split("/").includes("..")) errors.push(`Unsafe allowed path: ${value || "<empty>"}`);
  const { contractHash, output: _output, ...core } = contract;
  if (sha256(stableStringify(core)) !== contractHash) errors.push("Contract hash mismatch.");
  if (options.verifyEvidence !== false) {
    for (const item of contract.evidence) {
      const absolute = path.resolve(contract.scope.root, item.path);
      const relative = path.relative(contract.scope.root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) { errors.push(`Evidence escapes scope root: ${item.path}`); continue; }
      const content = await fs.readFile(absolute, "utf8").catch(() => undefined);
      if (content === undefined) errors.push(`Evidence is missing: ${item.path}`);
      else if (sha256(content) !== item.sha256) errors.push(`Evidence hash mismatch: ${item.path}`);
    }
  }
  if (contract.permissions.granted.includes("github-mutation") || contract.permissions.granted.includes("release-mutation")) warnings.push("Remote or release mutation requires separate operator confirmation.");
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings };
}

export function redactHandoffContract(contract: AiHandoffContract): AiHandoffContract {
  const sensitive = /(authorization\s*:|bearer\s+|token=|api[_-]?key=|password=)[^\s,;]+/gi;
  const redact = (value: unknown): unknown => Array.isArray(value) ? value.map(redact) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /token|secret|password|authorization|api[_-]?key/i.test(key) ? "[REDACTED]" : redact(item)]))
    : typeof value === "string" ? value.replace(sensitive, "$1[REDACTED]") : value;
  const redacted = redact(contract) as AiHandoffContract;
  const { contractHash: _hash, output: _output, ...core } = redacted;
  return { ...redacted, contractHash: sha256(stableStringify(core)) };
}

export function explainHandoffContract(contract: AiHandoffContract): Record<string, unknown> {
  return { id: contract.id, task: `${contract.task.id}: ${contract.task.title}`, goal: contract.goal, source: contract.task.source, grantedPermissions: contract.permissions.granted, deniedPermissions: contract.permissions.denied, allowedPathCount: contract.scope.allowedPaths.length, maxChangedFiles: contract.scope.maxChangedFiles, evidenceCount: contract.evidence.length, acceptanceCriteria: contract.acceptanceCriteria, lineage: contract.lineage };
}

export function renderHandoffMarkdown(contract: AiHandoffContract): string {
  return [`# AI Handoff: ${contract.task.title}`, "", `- ID: ${contract.id}`, `- Goal: ${contract.goal}`, `- Source: ${contract.task.source}`, `- Contract hash: ${contract.contractHash}`, "", "## Scope", "", `- Root: ${contract.scope.root}`, `- Changed-file budget: ${contract.scope.maxChangedFiles}`, ...contract.scope.allowedPaths.map((item) => `- Allowed: ${item}`), "", "## Permissions", "", ...contract.permissions.granted.map((item) => `- Granted: ${item}`), ...contract.permissions.denied.map((item) => `- Denied: ${item}`), "", "## Forbidden Actions", "", ...contract.forbiddenActions.map((item) => `- ${item}`), "", "## Evidence", "", ...contract.evidence.map((item) => `- ${item.kind}: ${item.path} (${item.sha256})`), "", "## Suggested Commands", "", ...contract.suggestedCommands.map((item) => `- \`${item}\``), "", "## Acceptance Criteria", "", ...contract.acceptanceCriteria.map((item) => `- ${item}`), ""].join("\n");
}

export function renderHandoffCompactPrompt(contract: AiHandoffContract): string {
  return [`Task: ${contract.task.title}`, `Goal: ${contract.goal}`, `Edit only: ${contract.scope.allowedPaths.join(", ") || "no files"}`, `Permission: ${contract.permissions.granted.join(", ")}`, `Never: ${contract.forbiddenActions.join("; ")}`, `Verify: ${contract.suggestedCommands.join("; ") || "none"}`, `Accept when: ${contract.acceptanceCriteria.join("; ")}`, `Evidence: ${contract.evidence.map((item) => `${item.path}#${item.sha256}`).join(", ") || "none"}`, `Handoff: ${contract.id} / ${contract.contractHash}`].join("\n");
}
