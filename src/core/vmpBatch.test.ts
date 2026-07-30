import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchChunkLedger,
  BatchProgressStateMachine,
  BatchRefreshLeaseCoordinator,
  gateBatchEvidence,
  planBatchUpdate,
  validateBatchProgress,
  validateBatchSideEffects,
  type BatchEvidenceInput
} from "./vmpBatch.js";

test("batch update planner accepts the post-row boundary and rejects any header rows", () => {
  const plan = planBatchUpdate({
    postRows: [{ id: 1 }, { name: "insert" }],
    failedRowIndexes: [1],
    rowLimit: 2
  });
  assert.deepEqual(plan, { requested: [0, 1], valid: [0], failed: [1], inserts: [], updates: [0] });
  assert.throws(
    () => planBatchUpdate({ postRows: [{}, {}, {}], failedRowIndexes: [], rowLimit: 2 }),
    /limit exceeded/
  );
  assert.throws(
    () => planBatchUpdate({ postRows: [{}], headerRows: [{}], failedRowIndexes: [], rowLimit: 2 }),
    /unsupported/
  );
});

test("side-effect evidence requires undo to equal committed valid rows", () => {
  const plan = planBatchUpdate({ postRows: [{ id: 1 }, { id: 2 }], failedRowIndexes: [1] });
  assert.deepEqual(validateBatchSideEffects({ plan, committed: [0], undoRows: [0] }), []);
  assert.ok(validateBatchSideEffects({ plan, committed: [0], undoRows: [] }).includes("committed-row-missing-undo"));
});

test("chunk ledger replays identical requests and rejects conflicts or out-of-order chunks", () => {
  const ledger = new BatchChunkLedger();
  assert.equal(ledger.accept("t1", "s1", 0, { rows: [1] }, false), "accepted");
  assert.equal(ledger.accept("t1", "s1", 0, { rows: [1] }, false), "replayed");
  assert.equal(ledger.accept("t1", "s1", 0, { rows: [2] }, false), "conflict");
  assert.equal(ledger.accept("t1", "s1", 2, { rows: [3] }, true), "out-of-order");
  assert.equal(ledger.accept("t1", "s1", 1, { rows: [3] }, true), "accepted");
});

test("progress accepts one logical partial-failure terminal and idempotent redelivery", () => {
  const progress = [
    { stage: "accepted" as const, processed: 0, failed: 0, total: 2, sequence: 1, eventId: "evt-1" },
    { stage: "writing" as const, processed: 1, failed: 1, total: 2, sequence: 2, eventId: "evt-2" },
    { stage: "partial-failed" as const, processed: 1, failed: 1, total: 2, sequence: 3, eventId: "evt-3", deliveryAttempt: 1 },
    { stage: "partial-failed" as const, processed: 1, failed: 1, total: 2, sequence: 3, eventId: "evt-3", deliveryAttempt: 2 }
  ];
  assert.deepEqual(validateBatchProgress(progress), []);
  assert.equal(gateBatchEvidence(emptyEvidence({ progress }), {
    requireProgressTerminal: true,
    requireProgressTerminalIdentity: true
  }).passed, true);

  const state = new BatchProgressStateMachine(2);
  state.advance("validating", 0, 1);
  state.advance("partial-failed", 1, 1);
  assert.throws(() => state.advance("failed", 1, 1), /terminal/);
});

test("row-limit gate proves boundary acceptance and rejection before every side effect", () => {
  const gate = gateBatchEvidence(emptyEvidence({
    requestValidations: [
      validationCase("post-over-limit", 10_001, 0, "rejected"),
      validationCase("post-at-limit", 10_000, 0, "accepted"),
      validationCase("header-non-empty", 1, 1, "rejected")
    ]
  }), { requireRowLimitContract: true });
  assert.equal(gate.passed, true);

  const blocked = gateBatchEvidence(emptyEvidence({
    requestValidations: [
      { ...validationCase("post-over-limit", 10_001, 0, "rejected"), progressEventCount: 1 },
      validationCase("post-at-limit", 10_000, 0, "accepted"),
      validationCase("header-non-empty", 1, 1, "rejected")
    ]
  }), { requireRowLimitContract: true });
  assert.ok(blocked.blockers.includes("row-limit-rejection-has-effects"));
});

test("partial-commit gate requires a complete partition and response failures", () => {
  const input = batchEvidence();
  assert.equal(gateBatchEvidence(input, { requireCompleteRowClassification: true }).passed, true);
  const blocked = gateBatchEvidence({ ...input, responseFailedRows: [] }, {
    requireCompleteRowClassification: true
  });
  assert.ok(blocked.blockers.includes("response-failed-rows-mismatch"));
});

test("chunk gate treats conflict and out-of-order as safe no-effect outcomes and proves final replay", () => {
  const firstHash = "a".repeat(64);
  const conflictHash = "b".repeat(64);
  const finalHash = "c".repeat(64);
  const firstResult = "d".repeat(64);
  const finalResult = "e".repeat(64);
  const input = emptyEvidence({
    chunkAcceptance: ["accepted", "replayed", "conflict", "out-of-order"],
    chunkAttempts: [
      chunkAttempt(0, firstHash, false, "accepted", 1, firstResult),
      chunkAttempt(0, firstHash, false, "replayed", 0, firstResult),
      chunkAttempt(0, conflictHash, false, "conflict", 0),
      chunkAttempt(2, finalHash, true, "out-of-order", 0),
      chunkAttempt(1, finalHash, true, "accepted", 1, finalResult),
      chunkAttempt(1, finalHash, true, "replayed", 0, finalResult)
    ]
  });
  assert.equal(gateBatchEvidence(input, { requireChunkIdempotency: true }).passed, true);
  const unsafe = structuredClone(input);
  unsafe.chunkAttempts![2].effectsApplied = 1;
  assert.ok(gateBatchEvidence(unsafe, {
    requireChunkIdempotency: true
  }).blockers.includes("chunk-rejected-or-replayed-has-effects"));
});

test("reader-writer lease allows shared batch owners and excludes refresh atomically", () => {
  let now = 1;
  const coordinator = new BatchRefreshLeaseCoordinator(undefined, () => now);
  assert.equal(coordinator.acquireBatch("t1", "p1", "batch-a", 100), true);
  now += 1;
  assert.equal(coordinator.acquireBatch("t1", "p1", "batch-b", 100), true);
  now += 1;
  assert.equal(coordinator.acquireRefresh("t1", "p1", "refresh-a", 100), false);
  now += 1;
  assert.equal(coordinator.renew("t1", "p1", "batch-a", 100, "batch-shared"), true);
  now += 1;
  assert.equal(coordinator.release("t1", "p1", "wrong-owner", "batch-shared"), false);
  assert.equal(coordinator.release("t1", "p1", "batch-a", "batch-shared"), true);
  assert.equal(coordinator.release("t1", "p1", "batch-b", "batch-shared"), true);
  now += 1;
  assert.equal(coordinator.acquireRefresh("t1", "p1", "refresh-a", 10), true);
  assert.equal(coordinator.acquireBatch("t1", "p1", "batch-c", 100), false);
  assert.equal(coordinator.acquireBatch("t2", "p1", "tenant-two", 100), true);
  assert.equal(coordinator.release("t2", "p1", "tenant-two", "batch-shared"), true);
  now += 20;
  assert.equal(coordinator.acquireBatch("t1", "p1", "batch-d", 100), true);
  assert.equal(coordinator.release("t1", "p1", "batch-d", "batch-shared"), true);

  const gate = gateBatchEvidence(emptyEvidence({ lockRecords: coordinator.records() }), {
    requireReaderWriterLease: true
  });
  assert.equal(gate.passed, true, gate.blockers.join(", "));
  const sequentialOnly = gateBatchEvidence(emptyEvidence({
    lockRecords: [
      {
        event: "lock-acquired", resource: "batch-refresh:t1:p1", tenantId: "t1", panelId: "p1",
        ownerToken: "a", mode: "batch-shared", at: 1, expiresAt: 100
      },
      {
        event: "lock-released", resource: "batch-refresh:t1:p1", tenantId: "t1", panelId: "p1",
        ownerToken: "a", mode: "batch-shared", at: 2
      },
      {
        event: "lock-acquired", resource: "batch-refresh:t1:p1", tenantId: "t1", panelId: "p1",
        ownerToken: "b", mode: "batch-shared", at: 3, expiresAt: 100
      },
      {
        event: "lock-released", resource: "batch-refresh:t1:p1", tenantId: "t1", panelId: "p1",
        ownerToken: "b", mode: "batch-shared", at: 4
      }
    ]
  }), { requireReaderWriterLease: true });
  assert.ok(sequentialOnly.blockers.includes("reader-writer-shared-acquire-missing"));
});

test("durable undo and terminal gates require per-row commits and intent-before-terminal ordering", () => {
  const input = batchEvidence();
  const gate = gateBatchEvidence(input, {
    requireCompleteRowClassification: true,
    requireUndoDurability: true,
    requireProgressTerminal: true,
    requireProgressTerminalIdentity: true,
    requireTransactionTerminalOrdering: true
  });
  assert.equal(gate.passed, true, gate.blockers.join(", "));

  const unsafe = structuredClone(input);
  unsafe.undoIntents![0].sequence = 7;
  const blocked = gateBatchEvidence(unsafe, {
    requireUndoDurability: true,
    requireTransactionTerminalOrdering: true
  });
  assert.ok(blocked.blockers.includes("undo-intent-not-atomic-with-row-commit"));
  assert.ok(blocked.blockers.includes("progress-terminal-before-durable-undo-intent"));
});

function emptyEvidence(overrides: Partial<BatchEvidenceInput> = {}): BatchEvidenceInput {
  return {
    plan: { requested: [], valid: [], failed: [], inserts: [], updates: [] },
    committed: [],
    undoRows: [],
    progress: [],
    lockRecords: [],
    chunkAcceptance: [],
    ...overrides
  };
}

function batchEvidence(): BatchEvidenceInput {
  return {
    plan: { requested: [0, 1], valid: [0], failed: [1], inserts: [], updates: [0] },
    committed: [0],
    undoRows: [],
    responseFailedRows: [1],
    progress: [
      { stage: "accepted", processed: 0, failed: 0, total: 2, sequence: 1, eventId: "evt-1" },
      { stage: "writing", processed: 1, failed: 1, total: 2, sequence: 3, eventId: "evt-2" },
      { stage: "partial-failed", processed: 1, failed: 1, total: 2, sequence: 6, eventId: "evt-3" }
    ],
    lockRecords: [],
    chunkAcceptance: [],
    transactions: [
      { transactionId: "tx-1", event: "begin", rowIndex: 0, sequence: 2 },
      { transactionId: "tx-1", event: "commit", rowIndex: 0, sequence: 4 },
      { transactionId: "tx-2", event: "rollback", rowIndex: 1, sequence: 5 }
    ],
    undoIntents: [{
      rowIndex: 0,
      idempotencyKey: "batch-1:row-0",
      transactionId: "tx-1",
      sequence: 4,
      status: "persisted"
    }]
  };
}

function validationCase(
  caseId: "post-over-limit" | "post-at-limit" | "header-non-empty",
  postRowCount: number,
  headerRowCount: number,
  outcome: "accepted" | "rejected"
) {
  return {
    caseId,
    postRowCount,
    headerRowCount,
    rowLimit: 10_000,
    outcome,
    writeCount: 0,
    progressEventCount: 0,
    coordinationEventCount: 0,
    transactionEventCount: 0,
    undoIntentCount: 0
  };
}

function chunkAttempt(
  chunkNo: number,
  requestHash: string,
  isLast: boolean,
  outcome: "accepted" | "replayed" | "conflict" | "out-of-order",
  effectsApplied: number,
  resultHash?: string
) {
  return {
    tenantId: "tenant-1",
    sessionId: "session-1",
    chunkNo,
    requestHash,
    isLast,
    outcome,
    ledgerPersisted: outcome === "accepted" || outcome === "replayed",
    effectsApplied,
    resultHash
  };
}
