import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { pathExists, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { CommandExecutionResult } from "../types.js";
import type { MethodExtractionPatchPlan } from "./methodExtraction.js";
import type { MethodExtractionTestPlan } from "./methodExtractionTest.js";

export type MethodExtractionVerificationStatus = "passed" | "failed" | "blocked";

export interface MethodExtractionVerificationReport {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  status: MethodExtractionVerificationStatus;
  passed: boolean;
  reason: string;
  sourceHash?: string;
  patchHash?: string;
  testHash?: string;
  commands: Array<{
    phase: "baseline" | "current";
    command: string;
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    stdoutHash: string;
    stderrHash: string;
  }>;
  behavior: {
    marker?: string;
    baseline?: string;
    current?: string;
    baselineHash?: string;
    currentHash?: string;
    equal: boolean;
  };
  temporaryApply: {
    testWritten: boolean;
    patchApplied: boolean;
  };
  restoration: {
    reversePatchPassed: boolean;
    fallbackSourceRestoreUsed: boolean;
    sourceRestored: boolean;
    testRemoved: boolean;
    observationRemoved: boolean;
  };
}

export interface MethodExtractionVerificationOptions {
  commands?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function verifyMethodExtractionTemporarily(
  patchPlan: MethodExtractionPatchPlan,
  testPlan: MethodExtractionTestPlan,
  options: MethodExtractionVerificationOptions = {}
): Promise<MethodExtractionVerificationReport> {
  const base = baseReport(patchPlan, testPlan);
  if (!patchPlan.ready || !patchPlan.patch || !patchPlan.file || !patchPlan.patchHash) {
    return { ...base, status: "blocked", reason: "Extraction patch is not ready." };
  }
  if (!testPlan.ready || !testPlan.generatedTest || !testPlan.testCommand) {
    return { ...base, status: "blocked", reason: "Executable characterization coverage is not ready." };
  }
  if (testPlan.patchHash !== patchPlan.patchHash) {
    return { ...base, status: "blocked", reason: "Test plan patch hash does not match the extraction patch." };
  }
  if (sha256(patchPlan.patch) !== patchPlan.patchHash
    || sha256(testPlan.generatedTest.content) !== testPlan.generatedTest.contentHash) {
    return { ...base, status: "blocked", reason: "Patch or generated test content hash mismatch." };
  }

  const root = path.resolve(patchPlan.root);
  const sourcePath = safeTargetPath(root, patchPlan.file);
  const testPath = safeTargetPath(root, testPlan.generatedTest.targetPath);
  const observationPath = safeTargetPath(root, testPlan.generatedTest.observationFile);
  if (await pathExists(testPath)) {
    return { ...base, status: "blocked", reason: `Generated test target already exists: ${testPlan.generatedTest.targetPath}` };
  }
  const originalSource = await fs.readFile(sourcePath);
  if (sha256(originalSource.toString("utf8")) !== patchPlan.sourceHash) {
    return { ...base, status: "blocked", reason: "Target source hash changed after patch planning." };
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 262_144;
  const commands = [...new Set([testPlan.testCommand, ...(options.commands ?? [])])];
  const patchDir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-guard-extraction-verify-"));
  const patchPath = path.join(patchDir, "method-extraction.diff");
  const report = baseReport(patchPlan, testPlan);
  let baselineResult: CommandExecutionResult | undefined;
  let patchApplied = false;
  try {
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, testPlan.generatedTest.content, "utf8");
    report.temporaryApply.testWritten = true;
    await fs.rm(observationPath, { force: true });
    baselineResult = await runVerificationCommand(testPlan.testCommand, root, timeoutMs, maxOutputBytes);
    report.commands.push(commandEvidence("baseline", baselineResult));
    report.behavior.baseline = await readObservation(observationPath)
      ?? extractObservation(baselineResult.stdout, testPlan.generatedTest.observationMarker);
    report.behavior.baselineHash = report.behavior.baseline ? sha256(report.behavior.baseline) : undefined;
    if (!commandPassed(baselineResult) || !report.behavior.baseline) {
      report.reason = `Baseline characterization command failed or produced no observation: ${baselineResult.stderr || baselineResult.stdout || baselineResult.error || "no output"}`.slice(0, 2000);
      return report;
    }

    await fs.writeFile(patchPath, patchPlan.patch, "utf8");
    const apply = await runShellCommand(`git apply "${patchPath}"`, { cwd: root, timeoutMs: 30_000, maxOutputBytes });
    patchApplied = commandPassed(apply);
    report.temporaryApply.patchApplied = patchApplied;
    if (!patchApplied) {
      report.reason = `Temporary patch apply failed: ${apply.stderr || apply.stdout || apply.error || "unknown error"}`;
      return report;
    }

    let currentTestResult: CommandExecutionResult | undefined;
    await fs.rm(observationPath, { force: true });
    for (const command of commands) {
      const result = await runVerificationCommand(command, root, timeoutMs, maxOutputBytes);
      report.commands.push(commandEvidence("current", result));
      if (command === testPlan.testCommand) currentTestResult = result;
      if (!commandPassed(result)) {
        report.reason = `Verification command failed: ${command}`;
        return report;
      }
    }
    report.behavior.current = currentTestResult
      ? await readObservation(observationPath)
        ?? extractObservation(currentTestResult.stdout, testPlan.generatedTest.observationMarker)
      : undefined;
    report.behavior.currentHash = report.behavior.current ? sha256(report.behavior.current) : undefined;
    report.behavior.equal = Boolean(report.behavior.baseline && report.behavior.baseline === report.behavior.current);
    if (!report.behavior.equal) {
      report.reason = "Characterization behavior changed after temporary extraction.";
      return report;
    }
    report.status = "passed";
    report.passed = true;
    report.reason = "Temporary source/test apply, checks and behavior comparison passed.";
    return report;
  } catch (error) {
    report.reason = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    if (patchApplied) {
      const reverse = await runShellCommand(`git apply -R "${patchPath}"`, { cwd: root, timeoutMs: 30_000, maxOutputBytes });
      report.restoration.reversePatchPassed = commandPassed(reverse);
    }
    const currentSource = await fs.readFile(sourcePath).catch(() => undefined);
    if (!currentSource || !currentSource.equals(originalSource)) {
      await fs.writeFile(sourcePath, originalSource);
      report.restoration.fallbackSourceRestoreUsed = true;
    }
    report.restoration.sourceRestored = (await fs.readFile(sourcePath)).equals(originalSource);
    await fs.rm(testPath, { force: true }).catch(() => undefined);
    report.restoration.testRemoved = !(await pathExists(testPath));
    await fs.rm(observationPath, { force: true }).catch(() => undefined);
    report.restoration.observationRemoved = !(await pathExists(observationPath));
    await fs.rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
    if (!report.restoration.sourceRestored || !report.restoration.testRemoved || !report.restoration.observationRemoved) {
      report.status = "failed";
      report.passed = false;
      report.reason = "Temporary verification could not fully restore the target workspace.";
    }
  }
}

export function renderMethodExtractionVerification(report: MethodExtractionVerificationReport): string {
  return [
    "# Method Extraction Verification",
    "",
    `- Status: ${report.status}`,
    `- Passed: ${report.passed}`,
    `- Reason: ${report.reason}`,
    `- Symbol: ${report.requestedSymbol}`,
    `- Source hash: ${report.sourceHash ?? "unavailable"}`,
    `- Patch hash: ${report.patchHash ?? "unavailable"}`,
    `- Test hash: ${report.testHash ?? "unavailable"}`,
    `- Behavior equal: ${report.behavior.equal}`,
    `- Source restored: ${report.restoration.sourceRestored}`,
    `- Test removed: ${report.restoration.testRemoved}`,
    `- Observation removed: ${report.restoration.observationRemoved}`,
    "",
    "## Commands",
    "",
    ...(report.commands.length
      ? report.commands.map((command) => `- ${command.phase}: ${command.command} -> ${command.passed ? "passed" : "failed"} (${command.durationMs}ms)`)
      : ["- none"]),
    ""
  ].join("\n");
}

function baseReport(patchPlan: MethodExtractionPatchPlan, testPlan: MethodExtractionTestPlan): MethodExtractionVerificationReport {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    root: patchPlan.root,
    requestedSymbol: patchPlan.requestedSymbol,
    status: "failed",
    passed: false,
    reason: "Verification did not complete.",
    sourceHash: patchPlan.sourceHash,
    patchHash: patchPlan.patchHash,
    testHash: testPlan.generatedTest?.contentHash,
    commands: [],
    behavior: { marker: testPlan.generatedTest?.observationMarker, equal: false },
    temporaryApply: { testWritten: false, patchApplied: false },
    restoration: {
      reversePatchPassed: false,
      fallbackSourceRestoreUsed: false,
      sourceRestored: false,
      testRemoved: false,
      observationRemoved: false
    }
  };
}

function safeTargetPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe method extraction target path: ${relativePath}`);
  }
  return resolved;
}

function runVerificationCommand(command: string, root: string, timeoutMs: number, maxOutputBytes: number) {
  const isolatedCommand = process.platform === "win32"
    ? `set "NODE_TEST_CONTEXT=" && set "MG_METHOD_OBSERVATION_ROOT=${escapeWindowsEnvValue(root)}" && ${command}`
    : `env -u NODE_TEST_CONTEXT MG_METHOD_OBSERVATION_ROOT=${shellQuote(root)} ${command}`;
  return runShellCommand(isolatedCommand, { cwd: root, timeoutMs, maxOutputBytes });
}

function escapeWindowsEnvValue(value: string): string {
  return value.replace(/"/g, "\"\"");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPassed(result: CommandExecutionResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.error;
}

function commandEvidence(phase: "baseline" | "current", result: CommandExecutionResult) {
  return {
    phase,
    command: result.command,
    passed: commandPassed(result),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutHash: sha256(result.stdout),
    stderrHash: sha256(result.stderr)
  };
}

function extractObservation(stdout: string, marker: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index < 0) continue;
    const value = line.slice(index + marker.length).trim();
    if (value) return value;
  }
  return undefined;
}

async function readObservation(observationPath: string): Promise<string | undefined> {
  const content = await fs.readFile(observationPath, "utf8").catch(() => undefined);
  if (!content) return undefined;
  try {
    return stableStringify(JSON.parse(content));
  } catch {
    return undefined;
  }
}
