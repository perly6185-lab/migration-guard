import { promises as fs } from "node:fs";
import path from "node:path";
import { applyVerifiedMethodExtraction, type MethodExtractionApplyReport } from "./methodExtractionApply.js";
import {
  createMethodExtractionContract,
  createMethodExtractionEligibility,
  createMethodExtractionPatchPlan,
  renderMethodExtractionContract,
  renderMethodExtractionEligibility,
  renderMethodExtractionPatchPlan,
  type MethodExtractionPatchPlan
} from "./methodExtraction.js";
import { createMethodExtractionTestPlan, renderMethodExtractionTestPlan, type MethodExtractionTestPlan } from "./methodExtractionTest.js";
import {
  renderMethodExtractionVerification,
  verifyMethodExtractionTemporarily,
  type MethodExtractionVerificationReport
} from "./methodExtractionVerification.js";
import { migrationRunDir } from "./migrationRun.js";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { LoadedConfig } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import type { MethodRefactorPlan } from "./methodRefactor.js";

export interface MethodExtractionLayerSpec {
  symbol: string;
  startLine: number;
  endLine: number;
  extractedName: string;
}

export type MethodExtractionLayerStatus = "pending" | "ready" | "applied" | "blocked" | "rolled-back" | "failed";

export interface MethodExtractionLayerStep extends MethodExtractionLayerSpec {
  index: number;
  depth: number;
  status: MethodExtractionLayerStatus;
  artifactDir: string;
  sourceFile?: string;
  sourceHashBefore?: string;
  sourceHashAfter?: string;
  patchHash?: string;
  reason?: string;
  applyStatus?: MethodExtractionApplyReport["status"];
}

export interface MethodExtractionExecutionLedger {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: "planned" | "ready" | "completed" | "stopped" | "blocked";
  planHash: string;
  callDepth: number;
  steps: MethodExtractionLayerStep[];
  events: Array<{
    at: string;
    type: "opened" | "prepared" | "applied" | "blocked" | "stopped" | "completed";
    stepIndex?: number;
    message: string;
  }>;
}

export function extractMethodExtractionLayersFromGoal(goal: string): MethodExtractionLayerSpec[] {
  const specs: MethodExtractionLayerSpec[] = [];
  const pattern = /\bextract-layer\s*=\s*([A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*)@(\d+)-(\d+)@([A-Za-z_$][\w$]*)/gi;
  for (const match of goal.matchAll(pattern)) {
    specs.push({
      symbol: match[1]!.replace(/#/g, "."),
      startLine: Number(match[2]),
      endLine: Number(match[3]),
      extractedName: match[4]!
    });
  }
  return specs;
}

export function createMethodExtractionExecutionLedger(
  runId: string,
  plan: MethodRefactorPlan,
  specs: MethodExtractionLayerSpec[]
): MethodExtractionExecutionLedger {
  if (specs.length === 0) throw new Error("Layered extraction requires at least one extract-layer specification.");
  if (plan.callDepth.applied > 6 || plan.callGraph.nodes.length > 64) throw new Error("Method extraction call graph exceeds the supported safety budget.");
  const nodes = new Map(plan.callGraph.nodes.map((node) => [node.candidate.symbol, node]));
  const seen = new Set<string>();
  const steps = specs.map((spec) => {
    if (seen.has(spec.symbol)) throw new Error(`Duplicate extraction layer symbol: ${spec.symbol}`);
    seen.add(spec.symbol);
    const node = nodes.get(spec.symbol);
    if (!node) throw new Error(`Extraction layer is outside the planned call graph: ${spec.symbol}`);
    if (spec.startLine <= 0 || spec.endLine < spec.startLine) throw new Error(`Invalid extraction range for ${spec.symbol}`);
    return { spec, depth: node.depth };
  }).sort((a, b) => b.depth - a.depth || a.spec.symbol.localeCompare(b.spec.symbol));
  const planHash = ledgerPlanHash(runId, plan.callDepth.applied, steps.map((item) => ({ ...item.spec, depth: item.depth })));
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    createdAt: now,
    updatedAt: now,
    state: "planned",
    planHash,
    callDepth: plan.callDepth.applied,
    steps: steps.map((item, index) => ({
      ...item.spec,
      index,
      depth: item.depth,
      sourceFile: nodes.get(item.spec.symbol)?.candidate.file,
      status: "pending",
      artifactDir: `${String(index + 1).padStart(2, "0")}-${sanitize(item.spec.symbol)}`
    })),
    events: [{ at: now, type: "opened", message: `Opened layered extraction with ${steps.length} step(s).` }]
  };
}

export async function writeMethodExtractionExecutionLedger(
  loaded: LoadedConfig,
  ledger: MethodExtractionExecutionLedger
): Promise<void> {
  const dir = chainDir(loaded, ledger.runId);
  ledger.updatedAt = new Date().toISOString();
  await writeJsonFile(path.join(dir, "method-extraction-execution-ledger.json"), ledger);
  await writeTextFile(path.join(dir, "method-extraction-execution-ledger.md"), renderMethodExtractionExecutionLedger(ledger));
}

export async function readMethodExtractionExecutionLedger(
  loaded: LoadedConfig,
  runId: string
): Promise<MethodExtractionExecutionLedger> {
  return readJsonFile(path.join(chainDir(loaded, runId), "method-extraction-execution-ledger.json"));
}

export async function prepareNextMethodExtractionLayer(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  ledger: MethodExtractionExecutionLedger,
  recommendedChecks: string[]
): Promise<MethodExtractionExecutionLedger> {
  assertLedgerCanContinue(ledger);
  await validateLatestAppliedSource(pkg.run.targetRoot, ledger);
  const step = ledger.steps.find((candidate) => candidate.status === "pending");
  if (!step) {
    if (ledger.steps.every((candidate) => candidate.status === "applied")) {
      ledger.state = "completed";
      addEvent(ledger, "completed", undefined, "All extraction layers are applied and verified.");
      await writeMethodExtractionExecutionLedger(loaded, ledger);
    }
    return ledger;
  }
  const dir = path.join(chainDir(loaded, ledger.runId), "layers", step.artifactDir);
  const eligibility = await createMethodExtractionEligibility(pkg.run.targetRoot, step.symbol, {
    startLine: step.startLine,
    endLine: step.endLine
  }, undefined, step.sourceFile);
  const contract = await createMethodExtractionContract(eligibility);
  const patchPlan = await createMethodExtractionPatchPlan(contract, step.extractedName);
  const testPlan = await createMethodExtractionTestPlan(contract, patchPlan);
  const verification = await verifyMethodExtractionTemporarily(patchPlan, testPlan, {
    commands: recommendedChecks,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  await writeLayerArtifacts(dir, eligibility, contract, patchPlan, testPlan, verification);
  step.sourceFile = patchPlan.file;
  step.sourceHashBefore = patchPlan.sourceHash;
  step.patchHash = patchPlan.patchHash;
  if (verification.passed) {
    step.status = "ready";
    ledger.state = "ready";
    step.reason = verification.reason;
    addEvent(ledger, "prepared", step.index, `Prepared ${step.symbol} at depth ${step.depth}.`);
  } else {
    step.status = "blocked";
    ledger.state = "blocked";
    step.reason = verification.reason;
    addEvent(ledger, "blocked", step.index, `Blocked ${step.symbol}: ${verification.reason}`);
  }
  await writeMethodExtractionExecutionLedger(loaded, ledger);
  return ledger;
}

export async function applyNextMethodExtractionLayer(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  ledger: MethodExtractionExecutionLedger,
  confirmPatchHash: string,
  recommendedChecks: string[]
): Promise<MethodExtractionExecutionLedger> {
  assertLedgerCanContinue(ledger);
  const ready = ledger.steps.filter((step) => step.status === "ready");
  if (ready.length !== 1) throw new Error(`Expected exactly one ready extraction layer, found ${ready.length}.`);
  const step = ready[0]!;
  const dir = path.join(chainDir(loaded, ledger.runId), "layers", step.artifactDir);
  const patchPlan = await readJsonFile<MethodExtractionPatchPlan>(path.join(dir, "method-extraction-patch.json"));
  const testPlan = await readJsonFile<MethodExtractionTestPlan>(path.join(dir, "method-extraction-test-plan.json"));
  const verification = await readJsonFile<MethodExtractionVerificationReport>(path.join(dir, "method-extraction-verification.json"));
  const report = await applyVerifiedMethodExtraction(loaded, pkg, patchPlan, testPlan, verification, {
    confirmPatchHash,
    commands: recommendedChecks
  });
  await writeJsonFile(path.join(dir, "method-extraction-apply.json"), report);
  step.applyStatus = report.status;
  step.reason = report.reason;
  if (report.status === "applied") {
    step.status = "applied";
    step.sourceHashAfter = await fileHash(path.join(pkg.run.targetRoot, step.sourceFile!));
    addEvent(ledger, "applied", step.index, `Applied ${step.symbol}; next parent must be replanned.`);
    if (ledger.steps.every((candidate) => candidate.status === "applied")) {
      ledger.state = "completed";
      addEvent(ledger, "completed", undefined, "All extraction layers are applied and verified.");
    } else {
      ledger.state = "planned";
    }
  } else {
    if (report.status === "rejected") {
      step.status = "ready";
      ledger.state = "ready";
      addEvent(ledger, "prepared", step.index, `Apply rejected without mutation for ${step.symbol}; confirmation can be retried.`);
    } else {
      step.status = report.status === "rolled-back" ? "rolled-back" : "failed";
      ledger.state = "stopped";
      addEvent(ledger, "stopped", step.index, `Stopped at ${step.symbol}: ${report.status}.`);
    }
  }
  await writeMethodExtractionExecutionLedger(loaded, ledger);
  return ledger;
}

export function renderMethodExtractionExecutionLedger(ledger: MethodExtractionExecutionLedger): string {
  return [
    "# Method Extraction Execution Ledger",
    "",
    `- Run: ${ledger.runId}`,
    `- State: ${ledger.state}`,
    `- Plan hash: ${ledger.planHash}`,
    `- Call depth: ${ledger.callDepth}`,
    "",
    "## Steps",
    "",
    ...ledger.steps.map((step) => `- ${step.index + 1}. depth ${step.depth} ${step.symbol} ${step.startLine}-${step.endLine} -> ${step.extractedName}: ${step.status}${step.patchHash ? ` (${step.patchHash})` : ""}`),
    "",
    "## Events",
    "",
    ...ledger.events.map((event) => `- ${event.at} ${event.type}${event.stepIndex === undefined ? "" : ` step ${event.stepIndex + 1}`}: ${event.message}`),
    ""
  ].join("\n");
}

function assertLedgerCanContinue(ledger: MethodExtractionExecutionLedger): void {
  const currentPlanHash = ledgerPlanHash(ledger.runId, ledger.callDepth, ledger.steps.map((step) => ({
    symbol: step.symbol,
    startLine: step.startLine,
    endLine: step.endLine,
    extractedName: step.extractedName,
    depth: step.depth
  })));
  if (currentPlanHash !== ledger.planHash) throw new Error("Layered extraction ledger plan hash mismatch.");
  if (ledger.state === "completed" || ledger.state === "blocked" || ledger.state === "stopped") {
    throw new Error(`Layered extraction cannot continue from state: ${ledger.state}`);
  }
  if (ledger.callDepth > 6 || ledger.steps.length > 64) throw new Error("Layered extraction ledger exceeds safety limits.");
}

async function validateLatestAppliedSource(root: string, ledger: MethodExtractionExecutionLedger): Promise<void> {
  const latest = [...ledger.steps].reverse().find((step) => step.status === "applied");
  if (!latest?.sourceFile || !latest.sourceHashAfter) return;
  const current = await fileHash(path.join(root, latest.sourceFile));
  if (current !== latest.sourceHashAfter) throw new Error(`Source drift detected after applied layer: ${latest.symbol}`);
}

async function writeLayerArtifacts(
  dir: string,
  eligibility: Awaited<ReturnType<typeof createMethodExtractionEligibility>>,
  contract: Awaited<ReturnType<typeof createMethodExtractionContract>>,
  patchPlan: MethodExtractionPatchPlan,
  testPlan: MethodExtractionTestPlan,
  verification: MethodExtractionVerificationReport
): Promise<void> {
  await writeJsonFile(path.join(dir, "method-extraction-eligibility.json"), eligibility);
  await writeTextFile(path.join(dir, "method-extraction-eligibility.md"), renderMethodExtractionEligibility(eligibility));
  await writeJsonFile(path.join(dir, "method-extraction-contract.json"), contract);
  await writeTextFile(path.join(dir, "method-extraction-contract.md"), renderMethodExtractionContract(contract));
  await writeJsonFile(path.join(dir, "method-extraction-patch.json"), patchPlan);
  await writeTextFile(path.join(dir, "method-extraction-patch.md"), renderMethodExtractionPatchPlan(patchPlan));
  if (patchPlan.patch) await writeTextFile(path.join(dir, "method-extraction-patch.diff"), patchPlan.patch);
  await writeJsonFile(path.join(dir, "method-extraction-test-plan.json"), testPlan);
  await writeTextFile(path.join(dir, "method-extraction-test-plan.md"), renderMethodExtractionTestPlan(testPlan));
  if (testPlan.generatedTest) await writeTextFile(path.join(dir, testPlan.generatedTest.artifactFileName), testPlan.generatedTest.content);
  await writeJsonFile(path.join(dir, "method-extraction-verification.json"), verification);
  await writeTextFile(path.join(dir, "method-extraction-verification.md"), renderMethodExtractionVerification(verification));
}

function chainDir(loaded: LoadedConfig, runId: string): string {
  return path.join(migrationRunDir(loaded, runId), "adapter", "method-extraction-chain");
}

function addEvent(
  ledger: MethodExtractionExecutionLedger,
  type: MethodExtractionExecutionLedger["events"][number]["type"],
  stepIndex: number | undefined,
  message: string
): void {
  ledger.events.push({ at: new Date().toISOString(), type, stepIndex, message });
}

async function fileHash(file: string): Promise<string> {
  return sha256((await fs.readFile(file)).toString("utf8"));
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "method";
}

function ledgerPlanHash(
  runId: string,
  callDepth: number,
  steps: Array<MethodExtractionLayerSpec & { depth: number }>
): string {
  return sha256(stableStringify({ runId, callDepth, steps }));
}
