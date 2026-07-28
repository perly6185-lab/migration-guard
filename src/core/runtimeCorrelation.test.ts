import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeCorrelationTrace, validateRuntimeCorrelationTrace } from "./runtimeCorrelation.js";
import { sha256 } from "./hash.js";

test("runtime correlation requires HTTP and every scenario collector", () => {
  const fingerprint = sha256("request-1");
  const trace = createRuntimeCorrelationTrace("quality-page", fingerprint, ["sql-trace", "mysql"]);
  assert.deepEqual(validateRuntimeCorrelationTrace(trace, "quality-page", ["sql-trace", "mysql"], {
    "sql-trace": {
      version: 1,
      collector: "sql-trace",
      status: "passed",
      capturedAt: new Date().toISOString(),
      specHash: "a".repeat(64),
      payload: { correlationFingerprint: fingerprint },
      payloadHash: "b".repeat(64),
      findings: [],
      evidenceHash: "c".repeat(64)
    }
  }), []);
});

test("runtime correlation blocks missing, crossed and tampered sources", () => {
  const fingerprint = sha256("request-1");
  const trace = createRuntimeCorrelationTrace("refresh", fingerprint, ["events", "redis"]);
  trace.sources = trace.sources
    .filter((source) => source.source !== "redis")
    .map((source) => source.source === "events" ? { ...source, requestFingerprint: sha256("request-2") } : source);
  const findings = validateRuntimeCorrelationTrace(trace, "refresh", ["events", "redis"]);
  assert.ok(findings.includes("MG-CORRELATION-SOURCE-MISSING:redis"));
  assert.ok(findings.includes("MG-CORRELATION-SOURCE-FINGERPRINT-MISMATCH:events"));
  assert.ok(findings.includes("MG-CORRELATION-TRACE-HASH-MISMATCH"));
});
