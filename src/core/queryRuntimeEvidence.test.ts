import test from "node:test";
import assert from "node:assert/strict";
import { gateQueryEvidence, type QueryRuntimeEvidenceInput } from "./queryRuntimeEvidence.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function completeEvidence(): QueryRuntimeEvidenceInput {
  return {
    effects: {
      writeCount: 2,
      committed: true,
      rolledBackOnFailure: true,
      transactionFingerprint: A,
      idempotencyKeyFingerprint: B,
      duplicateWriteCount: 0
    },
    cache: {
      cacheKeyFingerprint: C,
      cachedBaselineHash: A,
      responseBeforeEnrichmentHash: A,
      responseAfterEnrichmentHash: B,
      cachedValueAfterEnrichmentHash: A
    },
    async: {
      timedOut: true,
      cancellationRequested: true,
      activeTasksAfterReturn: 0,
      writesAfterReturn: 0,
      eventsAfterReturn: 0
    },
    compatibility: {
      entrypointResponseHashes: [A, A],
      entrypointEffectHashes: [B, B],
      legacyRequestSemanticHash: C,
      targetRequestSemanticHash: C
    }
  };
}

const allRequirements = {
  requireEffectAtomicity: true,
  requireIdempotency: true,
  requireCacheIsolation: true,
  requireAsyncQuiescence: true,
  requireEntrypointParity: true,
  requireRequestSemanticParity: true
};

test("query runtime gate accepts complete effect, cache, async and compatibility evidence", () => {
  assert.deepEqual(gateQueryEvidence(completeEvidence(), allRequirements), {
    passed: true,
    blockers: []
  });
});

test("query runtime gate fails closed on mutable cache aliases and effects after return", () => {
  const evidence = completeEvidence();
  evidence.cache!.cachedValueAfterEnrichmentHash = B;
  evidence.async!.activeTasksAfterReturn = 1;
  evidence.async!.writesAfterReturn = 1;
  const report = gateQueryEvidence(evidence, allRequirements);
  assert.equal(report.passed, false);
  assert.ok(report.blockers.includes("query-cache-mutated-by-response"));
  assert.ok(report.blockers.includes("query-async-task-after-return"));
  assert.ok(report.blockers.includes("query-write-after-return"));
});

test("query runtime gate requires atomic replay and entrypoint/request parity", () => {
  const evidence = completeEvidence();
  evidence.effects!.rolledBackOnFailure = false;
  evidence.effects!.duplicateWriteCount = 1;
  evidence.compatibility!.entrypointResponseHashes = [A, B];
  evidence.compatibility!.targetRequestSemanticHash = B;
  const report = gateQueryEvidence(evidence, allRequirements);
  assert.ok(report.blockers.includes("query-rollback-unproven"));
  assert.ok(report.blockers.includes("query-idempotent-replay-failed"));
  assert.ok(report.blockers.includes("query-entrypoint-response-mismatch"));
  assert.ok(report.blockers.includes("query-request-semantic-drift"));
});
