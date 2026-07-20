import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoadedConfig } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import { migrationRunDir } from "./migrationRun.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { runShellCommand } from "./exec.js";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan,
  resolveMethodExtractionAnchor,
  suggestMethodExtractionCandidates,
  type MethodExtractionCandidate,
  type MethodExtractionSuggestionReport
} from "./methodExtraction.js";
import { createMethodExtractionTestPlan } from "./methodExtractionTest.js";
import { verifyMethodExtractionTemporarily } from "./methodExtractionVerification.js";
import { applyVerifiedMethodExtraction, type MethodExtractionApplyStatus } from "./methodExtractionApply.js";
import {
  createMethodExtractionQualityReport,
  captureMethodAdvancedGateBaseline,
  renderMethodExtractionQualityReport,
  type MethodAdvancedGateConfig,
  type MethodExtractionQualityReport
} from "./methodExtractionQuality.js";

export type MethodExtractionTrustTier = "manual" | "supervised" | "unattended";
export type MethodExtractionSessionState = "discovering" | "planning" | "verifying" | "awaiting-confirmation" | "applying" | "post-verifying" | "completed" | "blocked" | "rolled-back";

export interface MethodExtractionSession {
  version: 1;
  id: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: MethodExtractionSessionState;
  trustTier: MethodExtractionTrustTier;
  candidateIndex: number;
  candidate?: MethodExtractionCandidate;
  extractedName?: string;
  patchHash?: string;
  applyStatus?: MethodExtractionApplyStatus;
  quality?: MethodExtractionQualityReport;
  nextAction?: { command: string; reason: string };
  events: Array<{ at: string; state: MethodExtractionSessionState; message: string }>;
  sessionHash: string;
}

export interface ExecuteMethodExtractionSessionOptions {
  trustTier?: MethodExtractionTrustTier;
  candidateIndex?: number;
  extractedName?: string;
  confirmPatchHash?: string;
  recommendedChecks?: string[];
  advancedGates?: MethodAdvancedGateConfig[];
}

export async function executeMethodExtractionSession(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  requestedSymbol: string,
  options: ExecuteMethodExtractionSessionOptions = {}
): Promise<MethodExtractionSession> {
  const dir = sessionDir(loaded, pkg.run.id);
  const sessionPath = path.join(dir, "method-extraction-session.json");
  let session = await pathExists(sessionPath)
    ? await readJsonFile<MethodExtractionSession>(sessionPath)
    : createSession(pkg.run.id, options.trustTier ?? "manual", options.candidateIndex ?? 0);
  validateSessionHash(session);
  if (["completed", "blocked", "rolled-back"].includes(session.state)) return session;
  if (session.trustTier !== (options.trustTier ?? session.trustTier)) throw new Error("Trust tier cannot change after a method extraction session is opened.");

  const suggestionsPath = path.join(migrationRunDir(loaded, pkg.run.id), "adapter", "method-extraction-suggestions.json");
  const suggestions = await pathExists(suggestionsPath)
    ? await readJsonFile<MethodExtractionSuggestionReport>(suggestionsPath)
    : await suggestMethodExtractionCandidates(pkg.run.targetRoot, requestedSymbol, Math.max(3, session.candidateIndex + 1));
  const candidate = suggestions.candidates[session.candidateIndex];
  if (!candidate || !candidate.executable) return persistSession(dir, block(session, candidate?.blockedReason ?? "Selected extraction candidate is unavailable or blocked."));
  session.candidate = candidate;
  session.extractedName = options.extractedName ?? candidate.suggestedNames[0];
  if (!session.extractedName) return persistSession(dir, block(session, "No conflict-free extracted method name is available."));

  let range = candidate.range;
  if (suggestions.sourceHash && suggestions.sourceHash !== await sourceHash(pkg.run.targetRoot, candidate.anchor.file)) {
    range = await resolveMethodExtractionAnchor(pkg.run.targetRoot, candidate.anchor);
  }
  transition(session, "planning", `Planning candidate ${session.candidateIndex + 1} at ${range.startLine}-${range.endLine}.`);
  const eligibility = await createMethodExtractionEligibility(pkg.run.targetRoot, requestedSymbol, range);
  const contract = await createMethodExtractionContract(eligibility);
  const patchPlan = await createMethodExtractionPatchPlan(contract, session.extractedName);
  const testPlan = await createMethodExtractionTestPlan(contract, patchPlan);
  await writeJsonFile(path.join(dir, "method-extraction-eligibility.json"), eligibility);
  await writeJsonFile(path.join(dir, "method-extraction-contract.json"), contract);
  await writeJsonFile(path.join(dir, "method-extraction-patch.json"), patchPlan);
  await writeJsonFile(path.join(dir, "method-extraction-test-plan.json"), testPlan);
  if (!patchPlan.ready || !testPlan.ready) return persistSession(dir, block(session, patchPlan.findings[0]?.message ?? testPlan.findings[0]?.message ?? "Extraction planning is blocked."));

  transition(session, "verifying", "Running temporary baseline, patch, checks and behavior comparison.");
  const verification = await verifyMethodExtractionTemporarily(patchPlan, testPlan, {
    commands: options.recommendedChecks ?? [],
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  await writeJsonFile(path.join(dir, "method-extraction-verification.json"), verification);
  if (!verification.passed) return persistSession(dir, block(session, verification.reason));
  session.patchHash = patchPlan.patchHash;

  const canAutoApply = permitsAutomaticApply(session.trustTier, candidate, eligibility.findings.length);
  if (!canAutoApply && options.confirmPatchHash !== patchPlan.patchHash) {
    transition(session, "awaiting-confirmation", "Passing verification requires exact patch-hash confirmation at this trust tier.");
    session.nextAction = {
      command: `migration-guard method-extraction execute --run ${pkg.run.id} --trust-tier ${session.trustTier} --confirm ${patchPlan.patchHash}`,
      reason: "Review the generated patch and confirm its exact hash."
    };
    return persistSession(dir, session);
  }
  if (options.confirmPatchHash && options.confirmPatchHash !== patchPlan.patchHash) throw new Error("Method extraction session confirmation does not match the prepared patch hash.");

  const sourcePath = path.join(pkg.run.targetRoot, patchPlan.file!);
  const beforeSource = await fs.readFile(sourcePath, "utf8");
  const advancedGateBaseline = await captureMethodAdvancedGateBaseline(
    pkg.run.targetRoot,
    options.advancedGates ?? [],
    undefined,
    loaded.config.output.maxOutputBytes
  );
  transition(session, "applying", canAutoApply ? `Applying under ${session.trustTier} policy.` : "Applying explicitly confirmed patch.");
  const apply = await applyVerifiedMethodExtraction(loaded, pkg, patchPlan, testPlan, verification, {
    confirmPatchHash: patchPlan.patchHash!,
    commands: options.recommendedChecks ?? []
  });
  session.applyStatus = apply.status;
  await writeJsonFile(path.join(dir, "method-extraction-apply.json"), apply);
  if (apply.status !== "applied") {
    transition(session, apply.status === "rolled-back" ? "rolled-back" : "blocked", apply.reason);
    return persistSession(dir, session);
  }

  transition(session, "post-verifying", "Computing structural, behavioral and configured advanced evaluation evidence.");
  const afterSource = await fs.readFile(sourcePath, "utf8");
  const quality = await createMethodExtractionQualityReport({
    root: pkg.run.targetRoot,
    symbol: requestedSymbol,
    fileName: patchPlan.file,
    beforeSource,
    afterSource,
    behaviorPassed: apply.behavior.equal,
    advancedGates: options.advancedGates,
    advancedGateBaseline
  });
  session.quality = quality;
  await writeJsonFile(path.join(dir, "method-extraction-quality.json"), quality);
  await writeTextFile(path.join(dir, "method-extraction-quality.md"), renderMethodExtractionQualityReport(quality));
  if (!quality.passed) {
    const reversePatchPath = path.join(dir, "method-extraction-quality-rollback.patch");
    await writeTextFile(reversePatchPath, patchPlan.patch!);
    await runShellCommand(`git apply -R "${reversePatchPath}"`, {
      cwd: pkg.run.targetRoot,
      timeoutMs: 30_000,
      maxOutputBytes: loaded.config.output.maxOutputBytes
    });
    const restored = await fs.readFile(sourcePath).catch(() => undefined);
    if (!restored || restored.toString("utf8") !== beforeSource) await fs.writeFile(sourcePath, beforeSource, "utf8");
    transition(session, "rolled-back", "Post-apply quality evaluation failed and the source was restored.");
    return persistSession(dir, session);
  }
  transition(session, "completed", "Method extraction applied, behavior verified and quality evaluated.");
  session.nextAction = undefined;
  return persistSession(dir, session);
}

export async function readMethodExtractionSession(loaded: LoadedConfig, runId: string): Promise<MethodExtractionSession> {
  const session = await readJsonFile<MethodExtractionSession>(path.join(sessionDir(loaded, runId), "method-extraction-session.json"));
  validateSessionHash(session);
  return session;
}

export function renderMethodExtractionSession(session: MethodExtractionSession): string {
  return [
    "# Method Extraction Session", "",
    `- Session: ${session.id}`,
    `- Run: ${session.runId}`,
    `- State: ${session.state}`,
    `- Trust tier: ${session.trustTier}`,
    `- Candidate: ${session.candidateIndex + 1}`,
    `- Extracted name: ${session.extractedName ?? "unselected"}`,
    `- Patch hash: ${session.patchHash ?? "unavailable"}`,
    `- Apply status: ${session.applyStatus ?? "not applied"}`,
    `- Next: ${session.nextAction?.command ?? "none"}`, "",
    ...session.events.map((event) => `- ${event.at} [${event.state}] ${event.message}`), ""
  ].join("\n");
}

function createSession(runId: string, trustTier: MethodExtractionTrustTier, candidateIndex: number): MethodExtractionSession {
  const now = new Date().toISOString();
  const session: MethodExtractionSession = {
    version: 1,
    id: `method-extraction-session-${Date.now()}`,
    runId,
    createdAt: now,
    updatedAt: now,
    state: "discovering",
    trustTier,
    candidateIndex,
    events: [{ at: now, state: "discovering", message: "Opened method extraction automation session." }],
    sessionHash: ""
  };
  return withSessionHash(session);
}

function permitsAutomaticApply(tier: MethodExtractionTrustTier, candidate: MethodExtractionCandidate, findingCount: number): boolean {
  if (tier === "manual") return false;
  if (!candidate.executable || candidate.risk !== "low" || findingCount !== 1) return false;
  if (tier === "supervised") return true;
  return candidate.confidence >= 0.8 && candidate.inputs <= 3 && candidate.outputs <= 1 && candidate.anchor.statementKinds.length <= 6;
}

function transition(session: MethodExtractionSession, state: MethodExtractionSessionState, message: string): void {
  const now = new Date().toISOString();
  session.state = state;
  session.updatedAt = now;
  session.events.push({ at: now, state, message });
}

function block(session: MethodExtractionSession, reason: string): MethodExtractionSession {
  transition(session, "blocked", reason);
  session.nextAction = undefined;
  return session;
}

async function persistSession(dir: string, session: MethodExtractionSession): Promise<MethodExtractionSession> {
  await fs.mkdir(dir, { recursive: true });
  withSessionHash(session);
  await writeJsonFile(path.join(dir, "method-extraction-session.json"), session);
  await writeTextFile(path.join(dir, "method-extraction-session.md"), renderMethodExtractionSession(session));
  return session;
}

function withSessionHash(session: MethodExtractionSession): MethodExtractionSession {
  session.sessionHash = sha256(stableStringify({ ...session, sessionHash: undefined }));
  return session;
}

function validateSessionHash(session: MethodExtractionSession): void {
  if (session.sessionHash !== sha256(stableStringify({ ...session, sessionHash: undefined }))) throw new Error("Method extraction session hash mismatch; the ledger may have been changed.");
}

function sessionDir(loaded: LoadedConfig, runId: string): string {
  return path.join(migrationRunDir(loaded, runId), "adapter", "method-extraction-session");
}

async function sourceHash(root: string, file: string): Promise<string> {
  return sha256(await fs.readFile(path.join(root, file), "utf8"));
}
