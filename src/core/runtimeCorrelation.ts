import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { RuntimeCollectorKind, RuntimeCollectorEvidence } from "./runtimeCollectors.js";

const HASH = /^[a-f0-9]{64}$/;
export type RuntimeCorrelationSource = "http" | RuntimeCollectorKind;

export interface RuntimeCorrelationTrace {
  version: 1;
  scenarioId: string;
  requestFingerprint: string;
  sources: Array<{
    source: RuntimeCorrelationSource;
    scenarioId: string;
    requestFingerprint: string;
  }>;
  traceHash: string;
}

export function createRuntimeCorrelationTrace(
  scenarioId: string,
  requestFingerprint: string,
  sources: RuntimeCorrelationSource[]
): RuntimeCorrelationTrace {
  const base = {
    version: 1 as const,
    scenarioId,
    requestFingerprint,
    sources: [...new Set(["http" as const, ...sources])].sort().map((source) => ({
      source,
      scenarioId,
      requestFingerprint
    }))
  };
  return { ...base, traceHash: sha256(stableStringify(base)) };
}

export function validateRuntimeCorrelationTrace(
  trace: RuntimeCorrelationTrace | undefined,
  scenarioId: string,
  requiredCollectors: RuntimeCollectorKind[],
  collectors: Partial<Record<RuntimeCollectorKind, RuntimeCollectorEvidence>> = {}
): string[] {
  if (!trace) return ["MG-CORRELATION-TRACE-MISSING"];
  const findings: string[] = [];
  if (trace.version !== 1) findings.push("MG-CORRELATION-VERSION-UNSUPPORTED");
  if (trace.scenarioId !== scenarioId) findings.push("MG-CORRELATION-SCENARIO-MISMATCH");
  if (!HASH.test(trace.requestFingerprint)) findings.push("MG-CORRELATION-FINGERPRINT-INVALID");
  const expectedHash = sha256(stableStringify({
    version: trace.version,
    scenarioId: trace.scenarioId,
    requestFingerprint: trace.requestFingerprint,
    sources: trace.sources
  }));
  if (trace.traceHash !== expectedHash) findings.push("MG-CORRELATION-TRACE-HASH-MISMATCH");
  const expectedSources = new Set<RuntimeCorrelationSource>(["http", ...requiredCollectors]);
  const observedSources = new Set<RuntimeCorrelationSource>();
  for (const source of trace.sources ?? []) {
    if (observedSources.has(source.source)) findings.push(`MG-CORRELATION-SOURCE-DUPLICATE:${source.source}`);
    observedSources.add(source.source);
    if (source.scenarioId !== scenarioId) findings.push(`MG-CORRELATION-SOURCE-SCENARIO-MISMATCH:${source.source}`);
    if (source.requestFingerprint !== trace.requestFingerprint) {
      findings.push(`MG-CORRELATION-SOURCE-FINGERPRINT-MISMATCH:${source.source}`);
    }
  }
  for (const source of expectedSources) {
    if (!observedSources.has(source)) findings.push(`MG-CORRELATION-SOURCE-MISSING:${source}`);
  }
  for (const source of observedSources) {
    if (!expectedSources.has(source)) findings.push(`MG-CORRELATION-SOURCE-UNEXPECTED:${source}`);
  }
  const sqlTrace = collectors["sql-trace"];
  if (sqlTrace) {
    const payloadFingerprint = (sqlTrace.payload as { correlationFingerprint?: unknown })?.correlationFingerprint;
    if (payloadFingerprint !== trace.requestFingerprint) {
      findings.push("MG-CORRELATION-SQL-TRACE-FINGERPRINT-MISMATCH");
    }
  }
  return [...new Set(findings)].sort();
}
