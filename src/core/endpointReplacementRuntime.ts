import path from "node:path";
import { runShellCommand } from "./exec.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { ReplacementScenario } from "./endpointReplacementModel.js";

export type EndpointRuntimeOperation = "setup" | "start" | "health" | "seed" | "invoke" | "inject-fault" | "snapshot" | "collect" | "cleanup" | "stop";

export interface EndpointRuntimeDriverConfig {
  id: string;
  root: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  operations: Partial<Record<EndpointRuntimeOperation, string>>;
}

export interface EndpointRuntimeObservation {
  scenarioId: string;
  fixtureHash: string;
  dimensions: Partial<Record<ReplacementScenario["requiredDimensions"][number], unknown>>;
  cleanup: { passed: boolean };
}

export interface EndpointRuntimeOperationEvidence {
  operation: EndpointRuntimeOperation;
  commandHash: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutHash: string;
  stderrHash: string;
}

export interface EndpointRuntimeDriverResult {
  version: 1;
  status: "passed" | "blocked";
  driverId: string;
  scenarioId: string;
  evidence: EndpointRuntimeOperationEvidence[];
  observation?: EndpointRuntimeObservation;
  findings: string[];
  resultHash: string;
}

const REQUIRED_OPERATIONS: EndpointRuntimeOperation[] = ["setup", "start", "health", "seed", "invoke", "snapshot", "collect", "cleanup", "stop"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_COMMAND = /authorization|bearer|token|cookie|secret|password|api[-_]?key/i;

export async function runEndpointRuntimeDriver(
  config: EndpointRuntimeDriverConfig,
  scenario: ReplacementScenario,
  options: { fault?: string } = {}
): Promise<EndpointRuntimeDriverResult> {
  const findings: string[] = [];
  const evidence: EndpointRuntimeOperationEvidence[] = [];
  let observation: EndpointRuntimeObservation | undefined;
  if (!SAFE_ID.test(scenario.id)) findings.push("RP-DRIVER-SCENARIO-ID-UNSAFE");
  if (options.fault && !SAFE_ID.test(options.fault)) findings.push("RP-DRIVER-FAULT-ID-UNSAFE");
  for (const operation of REQUIRED_OPERATIONS) if (!config.operations[operation]) findings.push(`RP-DRIVER-OPERATION-MISSING:${operation}`);
  if (options.fault && !config.operations["inject-fault"]) findings.push("RP-DRIVER-OPERATION-MISSING:inject-fault");
  if (findings.length) return finish(config.id, scenario.id, evidence, observation, findings);

  const root = path.resolve(config.root);
  const normal: EndpointRuntimeOperation[] = ["setup", "start", "health", "seed", "invoke", ...(options.fault ? ["inject-fault" as const] : []), "snapshot", "collect"];
  try {
    for (const operation of normal) {
      const execution = await executeOperation(config, root, operation, scenario.id, options.fault);
      if (!execution) { findings.push(`RP-DRIVER-COMMAND-UNSAFE:${operation}`); break; }
      evidence.push(execution.evidence);
      if (!execution.evidence.passed) { findings.push(`RP-DRIVER-OPERATION-FAILED:${operation}`); break; }
      if (operation === "collect") {
        try {
          observation = JSON.parse(execution.stdout) as EndpointRuntimeObservation;
          findings.push(...validateObservation(observation, scenario));
        } catch {
          findings.push("RP-DRIVER-OBSERVATION-MALFORMED");
        }
      }
    }
  } finally {
    for (const operation of ["cleanup", "stop"] as const) {
      const execution = await executeOperation(config, root, operation, scenario.id, options.fault);
      if (!execution) { findings.push(`RP-DRIVER-COMMAND-UNSAFE:${operation}`); continue; }
      evidence.push(execution.evidence);
      if (!execution.evidence.passed) findings.push(`RP-DRIVER-OPERATION-FAILED:${operation}`);
    }
  }
  if (!observation) findings.push("RP-DRIVER-OBSERVATION-MISSING");
  return finish(config.id, scenario.id, evidence, observation, [...new Set(findings)]);
}

function validateObservation(value: EndpointRuntimeObservation, scenario: ReplacementScenario): string[] {
  if (!value || value.scenarioId !== scenario.id || !value.fixtureHash) return ["RP-DRIVER-OBSERVATION-LINEAGE"];
  const findings = scenario.requiredDimensions
    .filter((dimension) => value.dimensions?.[dimension] === undefined)
    .map((dimension) => `RP-DRIVER-DIMENSION-MISSING:${dimension}`);
  if (!value.cleanup?.passed) findings.push("RP-DRIVER-CLEANUP-UNPROVEN");
  return findings;
}

async function executeOperation(
  config: EndpointRuntimeDriverConfig,
  root: string,
  operation: EndpointRuntimeOperation,
  scenarioId: string,
  fault?: string
): Promise<{ evidence: EndpointRuntimeOperationEvidence; stdout: string } | undefined> {
  const template = config.operations[operation];
  if (!template || template.includes("..") || /[\r\n\0]/.test(template) || SECRET_COMMAND.test(template)) return undefined;
  const command = template.replaceAll("{scenarioId}", scenarioId).replaceAll("{fault}", fault ?? "none");
  const result = await runShellCommand(command, {
    cwd: root,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024
  });
  return {
    stdout: result.stdout,
    evidence: {
      operation,
      commandHash: sha256(template),
      passed: result.exitCode === 0 && !result.timedOut && !result.error && !result.stdoutTruncated && !result.stderrTruncated,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutHash: sha256(result.stdout),
      stderrHash: sha256(result.stderr)
    }
  };
}

function finish(
  driverId: string,
  scenarioId: string,
  evidence: EndpointRuntimeOperationEvidence[],
  observation: EndpointRuntimeObservation | undefined,
  findings: string[]
): EndpointRuntimeDriverResult {
  const base = {
    version: 1 as const,
    status: findings.length ? "blocked" as const : "passed" as const,
    driverId,
    scenarioId,
    evidence,
    observation,
    findings
  };
  return { ...base, resultHash: sha256(stableStringify(base)) };
}
