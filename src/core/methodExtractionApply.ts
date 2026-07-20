import { promises as fs } from "node:fs";
import path from "node:path";
import { createCheckpoint } from "./checkpoint.js";
import { runShellCommand } from "./exec.js";
import { pathExists, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { appendEvidence, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import { stableStringify } from "./normalize.js";
import type { CommandExecutionResult, LoadedConfig } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import type { MethodExtractionPatchPlan } from "./methodExtraction.js";
import type { MethodExtractionTestPlan } from "./methodExtractionTest.js";
import type { MethodExtractionVerificationReport } from "./methodExtractionVerification.js";

export type MethodExtractionApplyStatus = "applied" | "rejected" | "failed" | "rolled-back" | "rollback-failed";

export interface MethodExtractionApplyReport {
  version: 1;
  createdAt: string;
  runId: string;
  requestedSymbol: string;
  status: MethodExtractionApplyStatus;
  passed: boolean;
  reason: string;
  patchHash?: string;
  verificationHash: string;
  checkpointId?: string;
  commands: Array<{
    command: string;
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    stdoutHash: string;
    stderrHash: string;
  }>;
  behavior: {
    baseline?: string;
    current?: string;
    equal: boolean;
  };
  cleanup: {
    testRemoved: boolean;
    observationRemoved: boolean;
    rollbackAttempted: boolean;
    rollbackPassed: boolean;
    fallbackSourceRestoreUsed: boolean;
    sourceMatchesBefore: boolean;
  };
  outputPath?: string;
}

export interface ApplyMethodExtractionOptions {
  confirmPatchHash: string;
  commands?: string[];
  maxVerificationAgeMs?: number;
  timeoutMs?: number;
}

export async function applyVerifiedMethodExtraction(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  patchPlan: MethodExtractionPatchPlan,
  testPlan: MethodExtractionTestPlan,
  verification: MethodExtractionVerificationReport,
  options: ApplyMethodExtractionOptions
): Promise<MethodExtractionApplyReport> {
  const report = baseReport(pkg.run.id, patchPlan, verification);
  const rejection = validateApplyEvidence(patchPlan, testPlan, verification, options);
  if (rejection) return persistApplyReport(loaded, pkg, { ...report, status: "rejected", reason: rejection });

  const root = path.resolve(pkg.run.targetRoot);
  const sourcePath = safeTargetPath(root, patchPlan.file!);
  const testPath = safeTargetPath(root, testPlan.generatedTest!.targetPath);
  const observationPath = safeTargetPath(root, testPlan.generatedTest!.observationFile);
  if (await pathExists(testPath)) {
    return persistApplyReport(loaded, pkg, { ...report, status: "rejected", reason: `Generated test target already exists: ${testPlan.generatedTest!.targetPath}` });
  }
  const before = await fs.readFile(sourcePath);
  if (sha256(before.toString("utf8")) !== patchPlan.sourceHash) {
    return persistApplyReport(loaded, pkg, { ...report, status: "rejected", reason: "Target source changed after verification." });
  }

  const checkpoint = await createCheckpoint(loaded, pkg, undefined, `Before applying verified extraction ${patchPlan.requestedSymbol}`);
  report.checkpointId = checkpoint.id;
  const adapterDir = path.join(migrationRunDir(loaded, pkg.run.id), "adapter");
  const patchPath = path.join(adapterDir, "method-extraction-apply.patch");
  await writeTextFile(patchPath, patchPlan.patch!);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = loaded.config.output.maxOutputBytes;
  const apply = await runShellCommand(`git apply "${patchPath}"`, { cwd: root, timeoutMs: 30_000, maxOutputBytes });
  if (!commandPassed(apply)) {
    report.status = "failed";
    report.reason = `Patch apply failed: ${apply.stderr || apply.stdout || apply.error || "unknown error"}`;
    return persistApplyReport(loaded, pkg, report);
  }

  let shouldRollback = false;
  try {
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, testPlan.generatedTest!.content, "utf8");
    await fs.rm(observationPath, { force: true });
    const commands = [...new Set([testPlan.testCommand!, ...(options.commands ?? [])])];
    let characterization: CommandExecutionResult | undefined;
    for (const command of commands) {
      const result = await runIsolatedCommand(command, root, timeoutMs, maxOutputBytes);
      report.commands.push(commandEvidence(result));
      if (command === testPlan.testCommand) characterization = result;
      if (!commandPassed(result)) {
        shouldRollback = true;
        report.reason = `Post-apply verification command failed: ${command}`;
        break;
      }
    }
    report.behavior.current = characterization
      ? await readObservation(observationPath)
        ?? extractObservation(characterization.stdout, testPlan.generatedTest!.observationMarker)
      : undefined;
    report.behavior.equal = Boolean(report.behavior.baseline && report.behavior.current === report.behavior.baseline);
    if (!shouldRollback && !report.behavior.equal) {
      shouldRollback = true;
      report.reason = "Post-apply characterization behavior differs from the verified baseline.";
    }
    if (!shouldRollback) {
      report.status = "applied";
      report.passed = true;
      report.reason = "Verified extraction applied and post-apply verification passed.";
    }
  } catch (error) {
    shouldRollback = true;
    report.reason = error instanceof Error ? error.message : String(error);
  } finally {
    await fs.rm(testPath, { force: true }).catch(() => undefined);
    report.cleanup.testRemoved = !(await pathExists(testPath));
    await fs.rm(observationPath, { force: true }).catch(() => undefined);
    report.cleanup.observationRemoved = !(await pathExists(observationPath));
  }

  if (shouldRollback) {
    report.cleanup.rollbackAttempted = true;
    const rollback = await runShellCommand(`git apply -R "${patchPath}"`, { cwd: root, timeoutMs: 30_000, maxOutputBytes });
    report.cleanup.rollbackPassed = commandPassed(rollback);
    let current = await fs.readFile(sourcePath).catch(() => undefined);
    if (!current?.equals(before)) {
      await fs.writeFile(sourcePath, before);
      report.cleanup.fallbackSourceRestoreUsed = true;
      current = await fs.readFile(sourcePath).catch(() => undefined);
    }
    report.cleanup.sourceMatchesBefore = Boolean(current?.equals(before));
    report.status = report.cleanup.rollbackPassed && report.cleanup.sourceMatchesBefore && report.cleanup.testRemoved && report.cleanup.observationRemoved
      ? "rolled-back"
      : "rollback-failed";
    report.passed = false;
    if (report.status === "rollback-failed") {
      report.reason = `${report.reason} Automatic rollback did not restore the checkpointed source exactly.`;
    }
  }
  return persistApplyReport(loaded, pkg, report);
}

export function renderMethodExtractionApply(report: MethodExtractionApplyReport): string {
  return [
    "# Method Extraction Apply",
    "",
    `- Status: ${report.status}`,
    `- Passed: ${report.passed}`,
    `- Reason: ${report.reason}`,
    `- Run: ${report.runId}`,
    `- Symbol: ${report.requestedSymbol}`,
    `- Patch hash: ${report.patchHash ?? "unavailable"}`,
    `- Verification hash: ${report.verificationHash}`,
    `- Checkpoint: ${report.checkpointId ?? "none"}`,
    `- Behavior equal: ${report.behavior.equal}`,
    `- Test removed: ${report.cleanup.testRemoved}`,
    `- Observation removed: ${report.cleanup.observationRemoved}`,
    `- Rollback attempted: ${report.cleanup.rollbackAttempted}`,
    `- Rollback passed: ${report.cleanup.rollbackPassed}`,
    `- Fallback source restore: ${report.cleanup.fallbackSourceRestoreUsed}`,
    "",
    "## Commands",
    "",
    ...(report.commands.length
      ? report.commands.map((command) => `- ${command.command}: ${command.passed ? "passed" : "failed"} (${command.durationMs}ms)`)
      : ["- none"]),
    ""
  ].join("\n");
}

function validateApplyEvidence(
  patchPlan: MethodExtractionPatchPlan,
  testPlan: MethodExtractionTestPlan,
  verification: MethodExtractionVerificationReport,
  options: ApplyMethodExtractionOptions
): string | undefined {
  if (!patchPlan.ready || !patchPlan.patch || !patchPlan.patchHash || !patchPlan.file) return "Extraction patch is not ready.";
  if (!testPlan.ready || !testPlan.generatedTest || !testPlan.testCommand) return "Executable characterization coverage is not ready.";
  if (!verification.passed || verification.status !== "passed") return "A passing temporary verification is required.";
  if (!verification.restoration.sourceRestored || !verification.restoration.testRemoved || !verification.restoration.observationRemoved) return "Temporary verification restoration evidence is incomplete.";
  if (options.confirmPatchHash !== patchPlan.patchHash) return "Explicit confirmation must equal the planned patch hash.";
  if (sha256(patchPlan.patch) !== patchPlan.patchHash) return "Patch content hash mismatch.";
  if (sha256(testPlan.generatedTest.content) !== testPlan.generatedTest.contentHash) return "Generated test content hash mismatch.";
  if (testPlan.patchHash !== patchPlan.patchHash || verification.patchHash !== patchPlan.patchHash) return "Patch lineage mismatch.";
  if (verification.testHash !== testPlan.generatedTest.contentHash) return "Generated test lineage mismatch.";
  const age = Date.now() - Date.parse(verification.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > (options.maxVerificationAgeMs ?? 30 * 60_000)) return "Temporary verification is stale.";
  return undefined;
}

async function persistApplyReport(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  report: MethodExtractionApplyReport
): Promise<MethodExtractionApplyReport> {
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "adapter");
  const jsonPath = path.join(dir, "method-extraction-apply.json");
  const markdownPath = path.join(dir, "method-extraction-apply.md");
  report.outputPath = jsonPath;
  await writeJsonFile(jsonPath, report);
  await writeTextFile(markdownPath, renderMethodExtractionApply(report));
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "proposal",
    message: `Method extraction apply ${report.status}: ${report.requestedSymbol}`,
    data: { status: report.status, patchHash: report.patchHash, checkpointId: report.checkpointId, outputPath: jsonPath }
  });
  await saveRunPackage(loaded, pkg);
  return report;
}

function baseReport(
  runId: string,
  patchPlan: MethodExtractionPatchPlan,
  verification: MethodExtractionVerificationReport
): MethodExtractionApplyReport {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    runId,
    requestedSymbol: patchPlan.requestedSymbol,
    status: "failed",
    passed: false,
    reason: "Apply did not complete.",
    patchHash: patchPlan.patchHash,
    verificationHash: sha256(stableStringify(verification)),
    commands: [],
    behavior: { baseline: verification.behavior.baseline, equal: false },
    cleanup: { testRemoved: false, observationRemoved: false, rollbackAttempted: false, rollbackPassed: false, fallbackSourceRestoreUsed: false, sourceMatchesBefore: false }
  };
}

function safeTargetPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe method extraction target path: ${relativePath}`);
  return resolved;
}

function runIsolatedCommand(command: string, root: string, timeoutMs: number, maxOutputBytes: number) {
  const isolated = process.platform === "win32" ? `set "NODE_TEST_CONTEXT=" && ${command}` : `env -u NODE_TEST_CONTEXT ${command}`;
  return runShellCommand(isolated, { cwd: root, timeoutMs, maxOutputBytes });
}

function commandPassed(result: CommandExecutionResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.error;
}

function commandEvidence(result: CommandExecutionResult) {
  return {
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
    if (index >= 0) return line.slice(index + marker.length).trim() || undefined;
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
