import { sha256 } from "./hash.js";
import type { LeaseLockRecord, LeaseLockStore } from "./vmpRefresh.js";

export interface BatchPlanInput {
  postRows: Array<Record<string, unknown>>;
  headerRows?: Array<Record<string, unknown>>;
  failedRowIndexes: number[];
  primaryKeyField?: string;
  rowLimit?: number;
}

export interface BatchPlan {
  requested: number[];
  valid: number[];
  failed: number[];
  inserts: number[];
  updates: number[];
}

export function planBatchUpdate(input: BatchPlanInput): BatchPlan {
  const limit = input.rowLimit ?? 10_000;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Batch row limit must be a positive integer");
  if (input.postRows.length > limit) {
    throw new Error(`Batch row limit exceeded: ${limit}`);
  }
  if ((input.headerRows?.length ?? 0) > 0) {
    throw new Error("batchHeaderValueList is unsupported for batch update");
  }
  const failed = [...new Set(input.failedRowIndexes)].sort((a, b) => a - b);
  if (failed.some((index) => !Number.isInteger(index) || index < 0 || index >= input.postRows.length)) {
    throw new Error("Failed row index is outside the request");
  }
  const failedSet = new Set(failed);
  const requested = input.postRows.map((_, index) => index);
  const valid = requested.filter((index) => !failedSet.has(index));
  const primaryKey = input.primaryKeyField ?? "id";
  return {
    requested,
    valid,
    failed,
    inserts: valid.filter((index) => input.postRows[index][primaryKey] === null || input.postRows[index][primaryKey] === undefined),
    updates: valid.filter((index) => input.postRows[index][primaryKey] !== null && input.postRows[index][primaryKey] !== undefined)
  };
}

export interface BatchSideEffectEvidence {
  plan: BatchPlan;
  committed: number[];
  undoRows: number[];
}

export function validateBatchSideEffects(evidence: BatchSideEffectEvidence): string[] {
  const blockers: string[] = [];
  const valid = new Set(evidence.plan.valid);
  const failed = new Set(evidence.plan.failed);
  const committed = new Set(evidence.committed);
  const undo = new Set(evidence.undoRows);
  if (evidence.committed.some((index) => !valid.has(index))) blockers.push("committed-row-not-valid");
  if (evidence.committed.some((index) => failed.has(index))) blockers.push("failed-row-committed");
  if (evidence.undoRows.some((index) => !committed.has(index))) blockers.push("undo-row-not-committed");
  if (evidence.committed.some((index) => !undo.has(index))) blockers.push("committed-row-missing-undo");
  return blockers;
}

export type ChunkAcceptance = "accepted" | "replayed" | "conflict" | "out-of-order" | "missing";

export interface BatchChunkAttemptEvidence {
  tenantId: string;
  sessionId: string;
  chunkNo: number;
  requestHash: string;
  isLast: boolean;
  outcome: ChunkAcceptance;
  ledgerPersisted: boolean;
  effectsApplied: number;
  resultHash?: string;
}

export class BatchChunkLedger {
  private readonly chunks = new Map<string, { hash: string; last: boolean }>();
  private readonly nextBySession = new Map<string, number>();

  accept(tenantId: string, sessionId: string, chunkNo: number, request: unknown, isLast: boolean): ChunkAcceptance {
    if (!tenantId || !sessionId || !Number.isInteger(chunkNo) || chunkNo < 0) throw new Error("Invalid chunk identity");
    const session = `${tenantId}\u001f${sessionId}`;
    const key = `${session}\u001f${chunkNo}`;
    const hash = sha256(stableJson(request));
    const existing = this.chunks.get(key);
    if (existing) return existing.hash === hash && existing.last === isLast ? "replayed" : "conflict";
    if (chunkNo !== (this.nextBySession.get(session) ?? 0)) return "out-of-order";
    this.chunks.set(key, { hash, last: isLast });
    this.nextBySession.set(session, chunkNo + 1);
    return "accepted";
  }
}

export type BatchProgressStage =
  | "accepted"
  | "validating"
  | "writing"
  | "committed"
  | "success"
  | "partial-failed"
  | "failed";

export interface BatchProgressEvent {
  stage: BatchProgressStage;
  processed: number;
  failed: number;
  total: number;
  sequence?: number;
  eventId?: string;
  deliveryAttempt?: number;
}

export interface BatchTransactionEvent {
  transactionId: string;
  event: "begin" | "commit" | "rollback";
  sequence: number;
  rowIndex?: number;
}

export interface BatchUndoIntentEvidence {
  rowIndex: number;
  idempotencyKey: string;
  transactionId: string;
  sequence: number;
  status: "persisted" | "materialized" | "permanent-failure";
  observable?: boolean;
}

export interface BatchRequestValidationEvidence {
  caseId: "post-over-limit" | "post-at-limit" | "header-non-empty";
  postRowCount: number;
  headerRowCount: number;
  rowLimit: number;
  outcome: "accepted" | "rejected";
  writeCount: number;
  progressEventCount: number;
  coordinationEventCount: number;
  transactionEventCount: number;
  undoIntentCount: number;
}

export type BatchLeaseMode = "batch-shared" | "refresh-exclusive";
export type BatchLeaseEvent =
  | "lock-acquired"
  | "lock-rejected"
  | "lock-renewed"
  | "lock-expired"
  | "lock-released"
  | "lock-release-rejected";

export interface BatchLeaseRecord {
  event: BatchLeaseEvent;
  resource: string;
  tenantId: string;
  panelId: string;
  ownerToken: string;
  mode: BatchLeaseMode;
  at: number;
  expiresAt?: number;
}

export interface BatchGateRequirements {
  requireUndoCorrespondence?: boolean;
  requireProgressTerminal?: boolean;
  requireSharedLock?: boolean;
  requireChunkIdempotency?: boolean;
  requireTransactionTerminalOrdering?: boolean;
  requireRowLimitContract?: boolean;
  requireCompleteRowClassification?: boolean;
  requireReaderWriterLease?: boolean;
  requireUndoDurability?: boolean;
  requireProgressTerminalIdentity?: boolean;
}

export class BatchProgressStateMachine {
  readonly events: BatchProgressEvent[] = [];
  constructor(private readonly total: number) {
    if (!Number.isInteger(total) || total < 0) throw new Error("Progress total must be a non-negative integer");
    this.events.push({ stage: "accepted", processed: 0, failed: 0, total });
  }

  advance(stage: Exclude<BatchProgressStage, "accepted">, processed: number, failed: number): void {
    const previous = this.events[this.events.length - 1];
    if (isTerminalProgressStage(previous.stage)) throw new Error("Progress already reached a terminal stage");
    const rank = progressStageRank();
    if (rank[stage] < rank[previous.stage]) throw new Error("Progress stage cannot move backwards");
    if (processed < previous.processed || failed < previous.failed || processed + failed > this.total) {
      throw new Error("Progress counters are not monotonic or exceed total");
    }
    if (isTerminalProgressStage(stage) && processed + failed !== this.total) {
      throw new Error("Terminal progress counters must equal total");
    }
    this.events.push({ stage, processed, failed, total: this.total });
  }
}

export class BatchRefreshLeaseCoordinator {
  private readonly leases = new Map<string, {
    shared: Map<string, number>;
    exclusive?: { ownerToken: string; expiresAt: number };
  }>();
  private readonly history: BatchLeaseRecord[] = [];

  constructor(
    _legacyStore?: LeaseLockStore,
    private readonly now: () => number = Date.now
  ) {}

  acquire(tenantId: string, panelId: string, ownerToken: string, leaseMs: number): boolean {
    return this.acquireBatch(tenantId, panelId, ownerToken, leaseMs);
  }

  acquireBatch(tenantId: string, panelId: string, ownerToken: string, leaseMs: number): boolean {
    return this.acquireMode(tenantId, panelId, ownerToken, leaseMs, "batch-shared");
  }

  acquireRefresh(tenantId: string, panelId: string, ownerToken: string, leaseMs: number): boolean {
    return this.acquireMode(tenantId, panelId, ownerToken, leaseMs, "refresh-exclusive");
  }

  renew(tenantId: string, panelId: string, ownerToken: string, leaseMs: number, mode: BatchLeaseMode): boolean {
    validateLeaseInput(tenantId, panelId, ownerToken, leaseMs);
    const at = this.now();
    const resource = batchLeaseResource(tenantId, panelId);
    const state = this.activeState(resource, tenantId, panelId, at);
    const held = mode === "batch-shared"
      ? state.shared.has(ownerToken)
      : state.exclusive?.ownerToken === ownerToken;
    if (!held) {
      this.history.push({ event: "lock-rejected", resource, tenantId, panelId, ownerToken, mode, at });
      return false;
    }
    const expiresAt = at + leaseMs;
    if (mode === "batch-shared") state.shared.set(ownerToken, expiresAt);
    else state.exclusive = { ownerToken, expiresAt };
    this.history.push({ event: "lock-renewed", resource, tenantId, panelId, ownerToken, mode, at, expiresAt });
    return true;
  }

  release(tenantId: string, panelId: string, ownerToken: string, mode?: BatchLeaseMode): boolean {
    if (!tenantId || !panelId || !ownerToken) throw new Error("Lease identity must not be empty");
    const at = this.now();
    const resource = batchLeaseResource(tenantId, panelId);
    const state = this.activeState(resource, tenantId, panelId, at);
    const resolvedMode = mode ?? (state.shared.has(ownerToken) ? "batch-shared" : "refresh-exclusive");
    const held = resolvedMode === "batch-shared"
      ? state.shared.delete(ownerToken)
      : state.exclusive?.ownerToken === ownerToken;
    if (resolvedMode === "refresh-exclusive" && held) state.exclusive = undefined;
    const event = held ? "lock-released" : "lock-release-rejected";
    this.history.push({ event, resource, tenantId, panelId, ownerToken, mode: resolvedMode, at });
    return held;
  }

  records(): BatchLeaseRecord[] {
    return [...this.history];
  }

  private acquireMode(
    tenantId: string,
    panelId: string,
    ownerToken: string,
    leaseMs: number,
    mode: BatchLeaseMode
  ): boolean {
    validateLeaseInput(tenantId, panelId, ownerToken, leaseMs);
    const at = this.now();
    const resource = batchLeaseResource(tenantId, panelId);
    const state = this.activeState(resource, tenantId, panelId, at);
    const blocked = mode === "batch-shared"
      ? Boolean(state.exclusive)
      : Boolean(state.exclusive || state.shared.size > 0);
    if (blocked) {
      this.history.push({ event: "lock-rejected", resource, tenantId, panelId, ownerToken, mode, at });
      return false;
    }
    const expiresAt = at + leaseMs;
    if (mode === "batch-shared") state.shared.set(ownerToken, expiresAt);
    else state.exclusive = { ownerToken, expiresAt };
    this.history.push({ event: "lock-acquired", resource, tenantId, panelId, ownerToken, mode, at, expiresAt });
    return true;
  }

  private activeState(
    resource: string,
    tenantId: string,
    panelId: string,
    at: number
  ): { shared: Map<string, number>; exclusive?: { ownerToken: string; expiresAt: number } } {
    const state = this.leases.get(resource) ?? { shared: new Map<string, number>() };
    for (const [ownerToken, expiresAt] of state.shared) {
      if (expiresAt <= at) {
        state.shared.delete(ownerToken);
        this.history.push({
          event: "lock-expired", resource, tenantId, panelId, ownerToken,
          mode: "batch-shared", at, expiresAt
        });
      }
    }
    if (state.exclusive && state.exclusive.expiresAt <= at) {
      this.history.push({
        event: "lock-expired", resource, tenantId, panelId, ownerToken: state.exclusive.ownerToken,
        mode: "refresh-exclusive", at, expiresAt: state.exclusive.expiresAt
      });
      state.exclusive = undefined;
    }
    this.leases.set(resource, state);
    return state;
  }
}

export interface BatchEvidenceInput extends BatchSideEffectEvidence {
  progress: BatchProgressEvent[];
  lockRecords: Array<LeaseLockRecord | BatchLeaseRecord>;
  chunkAcceptance: ChunkAcceptance[];
  transactions?: BatchTransactionEvent[];
  requestValidations?: BatchRequestValidationEvidence[];
  responseFailedRows?: number[];
  chunkAttempts?: BatchChunkAttemptEvidence[];
  undoIntents?: BatchUndoIntentEvidence[];
}

export function validateBatchProgress(events: BatchProgressEvent[]): string[] {
  const blockers: string[] = [];
  if (!Array.isArray(events) || events.length === 0) return ["progress-events-missing"];
  const logicalEvents: BatchProgressEvent[] = [];
  const byEventId = new Map<string, BatchProgressEvent>();
  for (const event of events) {
    if (!event.eventId) {
      logicalEvents.push(event);
      continue;
    }
    const existing = byEventId.get(event.eventId);
    if (!existing) {
      byEventId.set(event.eventId, event);
      logicalEvents.push(event);
    } else if (!sameLogicalProgressEvent(existing, event)) {
      blockers.push("progress-event-identity-conflict");
    }
  }
  const rank = progressStageRank();
  const totals = new Set(logicalEvents.map((event) => event.total));
  if (totals.size !== 1) blockers.push("progress-total-changed");
  let previous: BatchProgressEvent | undefined;
  let terminals = 0;
  for (const event of logicalEvents) {
    if (!Number.isInteger(event.processed) || !Number.isInteger(event.failed) || !Number.isInteger(event.total)
      || event.processed < 0 || event.failed < 0 || event.total < 0 || event.processed + event.failed > event.total) {
      blockers.push("progress-counter-invalid");
    }
    if (isTerminalProgressStage(event.stage)) {
      terminals += 1;
      if (event.processed + event.failed !== event.total) blockers.push("progress-terminal-not-conserved");
    }
    if (previous) {
      if (rank[event.stage] < rank[previous.stage]) blockers.push("progress-stage-regressed");
      if (event.processed < previous.processed || event.failed < previous.failed) blockers.push("progress-counter-regressed");
      if (isTerminalProgressStage(previous.stage)) blockers.push("progress-after-terminal");
      if (event.sequence !== undefined && previous.sequence !== undefined && event.sequence <= previous.sequence) {
        blockers.push("progress-sequence-not-increasing");
      }
    }
    previous = event;
  }
  if (terminals !== 1 || !isTerminalProgressStage(logicalEvents.at(-1)!.stage)) {
    blockers.push("progress-terminal-not-exactly-once");
  }
  return [...new Set(blockers)];
}

export function gateBatchEvidence(
  input: BatchEvidenceInput,
  requirements: BatchGateRequirements = {
    requireUndoCorrespondence: true,
    requireProgressTerminal: true,
    requireSharedLock: true,
    requireChunkIdempotency: true,
    requireTransactionTerminalOrdering: false
  }
): { passed: boolean; blockers: string[] } {
  const blockers = requirements.requireUndoCorrespondence === true ? validateBatchSideEffects(input) : [];
  if (requirements.requireProgressTerminal === true) blockers.push(...validateBatchProgress(input.progress));
  if (requirements.requireRowLimitContract === true) blockers.push(...validateRowLimitContract(input.requestValidations));
  if (requirements.requireCompleteRowClassification === true) blockers.push(...validateCompleteRowClassification(input));
  if (requirements.requireChunkIdempotency === true) blockers.push(...validateChunkIdempotency(input.chunkAttempts));
  if (requirements.requireUndoDurability === true) blockers.push(...validateUndoDurability(input));
  if (requirements.requireReaderWriterLease === true) {
    blockers.push(...validateReaderWriterLease(input.lockRecords));
  } else if (requirements.requireSharedLock === true) {
    const acquired = input.lockRecords.find((record) => record.event === "lock-acquired");
    const released = input.lockRecords.find((record) =>
      record.event === "lock-released"
      && acquired
      && record.resource === acquired.resource
      && record.ownerToken === acquired.ownerToken
      && record.at >= acquired.at);
    if (!acquired) blockers.push("shared-lock-acquire-missing");
    if (!released) blockers.push("shared-lock-matching-release-missing");
  }
  if (requirements.requireProgressTerminalIdentity === true) blockers.push(...validateProgressTerminalIdentity(input.progress));
  if (requirements.requireTransactionTerminalOrdering === true) blockers.push(...validateTransactionTerminalOrdering(input));
  return { passed: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function validateRowLimitContract(evidence: BatchRequestValidationEvidence[] | undefined): string[] {
  if (!evidence?.length) return ["row-limit-evidence-missing"];
  const blockers: string[] = [];
  const cases = new Map(evidence.map((item) => [item.caseId, item]));
  const over = cases.get("post-over-limit");
  const boundary = cases.get("post-at-limit");
  const header = cases.get("header-non-empty");
  if (!over) blockers.push("row-limit-over-limit-case-missing");
  if (!boundary) blockers.push("row-limit-boundary-case-missing");
  if (!header) blockers.push("row-limit-header-case-missing");
  if (over && (over.postRowCount <= over.rowLimit || over.headerRowCount !== 0 || over.outcome !== "rejected")) {
    blockers.push("row-limit-over-limit-not-rejected");
  }
  if (boundary && (boundary.postRowCount !== boundary.rowLimit || boundary.headerRowCount !== 0 || boundary.outcome !== "accepted")) {
    blockers.push("row-limit-boundary-not-accepted");
  }
  if (header && (header.headerRowCount <= 0 || header.outcome !== "rejected")) {
    blockers.push("row-limit-header-not-rejected");
  }
  for (const item of evidence.filter((candidate) => candidate.outcome === "rejected")) {
    const effects = [
      item.writeCount,
      item.progressEventCount,
      item.coordinationEventCount,
      item.transactionEventCount,
      item.undoIntentCount
    ];
    if (effects.some((count) => !Number.isInteger(count) || count !== 0)) blockers.push("row-limit-rejection-has-effects");
  }
  return blockers;
}

function validateCompleteRowClassification(input: BatchEvidenceInput): string[] {
  const blockers: string[] = [];
  const requested = new Set(input.plan.requested);
  const committed = new Set(input.committed);
  const failed = new Set(input.plan.failed);
  if (input.committed.length !== committed.size || input.plan.failed.length !== failed.size) {
    blockers.push("row-classification-duplicates");
  }
  if ([...committed].some((row) => failed.has(row))) blockers.push("row-classification-overlap");
  if ([...committed, ...failed].some((row) => !requested.has(row))
    || [...requested].some((row) => !committed.has(row) && !failed.has(row))) {
    blockers.push("row-classification-incomplete");
  }
  if (!input.responseFailedRows) {
    blockers.push("response-failed-rows-missing");
  } else if (!sameNumberSet(input.responseFailedRows, input.plan.failed)) {
    blockers.push("response-failed-rows-mismatch");
  }
  return blockers;
}

function validateChunkIdempotency(attempts: BatchChunkAttemptEvidence[] | undefined): string[] {
  if (!attempts?.length) return ["chunk-attempt-evidence-missing"];
  const blockers: string[] = [];
  const accepted = attempts.filter((item) => item.outcome === "accepted");
  const replayed = attempts.filter((item) => item.outcome === "replayed");
  const conflicts = attempts.filter((item) => item.outcome === "conflict");
  const outOfOrder = attempts.filter((item) => item.outcome === "out-of-order" || item.outcome === "missing");
  if (!accepted.length) blockers.push("chunk-accepted-case-missing");
  if (!replayed.length) blockers.push("chunk-replay-case-missing");
  if (!conflicts.length) blockers.push("chunk-conflict-case-missing");
  if (!outOfOrder.length) blockers.push("chunk-out-of-order-case-missing");
  for (const item of attempts) {
    if (!item.tenantId || !item.sessionId || !Number.isInteger(item.chunkNo) || item.chunkNo < 0
      || !/^[a-f0-9]{64}$/.test(item.requestHash) || !Number.isInteger(item.effectsApplied) || item.effectsApplied < 0) {
      blockers.push("chunk-attempt-malformed");
    }
    if ((item.outcome === "replayed" || item.outcome === "conflict" || item.outcome === "out-of-order" || item.outcome === "missing")
      && item.effectsApplied !== 0) {
      blockers.push("chunk-rejected-or-replayed-has-effects");
    }
    if ((item.outcome === "accepted" || item.outcome === "replayed") && (!item.ledgerPersisted || !item.resultHash)) {
      blockers.push("chunk-durable-result-missing");
    }
  }
  for (const replay of replayed) {
    const original = accepted.find((item) =>
      sameChunkIdentity(item, replay) && item.requestHash === replay.requestHash && item.isLast === replay.isLast);
    if (!original || original.resultHash !== replay.resultHash) blockers.push("chunk-replay-result-mismatch");
  }
  for (const conflict of conflicts) {
    const original = accepted.find((item) => sameChunkIdentity(item, conflict));
    if (!original || original.requestHash === conflict.requestHash) blockers.push("chunk-conflict-not-proven");
  }
  const finalAccepted = accepted.filter((item) => item.isLast);
  if (!finalAccepted.some((item) => replayed.some((replay) =>
    sameChunkIdentity(item, replay)
    && replay.isLast
    && replay.requestHash === item.requestHash
    && replay.resultHash === item.resultHash))) {
    blockers.push("chunk-final-retry-replay-missing");
  }
  return blockers;
}

function validateUndoDurability(input: BatchEvidenceInput): string[] {
  if (!input.undoIntents) return ["undo-intent-evidence-missing"];
  const blockers: string[] = [];
  const committed = new Set(input.committed);
  const failed = new Set(input.plan.failed);
  const intentsByRow = new Map<number, BatchUndoIntentEvidence[]>();
  for (const intent of input.undoIntents) {
    const rowIntents = intentsByRow.get(intent.rowIndex) ?? [];
    rowIntents.push(intent);
    intentsByRow.set(intent.rowIndex, rowIntents);
    if (!committed.has(intent.rowIndex)) blockers.push("undo-intent-row-not-committed");
    if (failed.has(intent.rowIndex)) blockers.push("failed-row-has-undo-intent");
    if (!intent.idempotencyKey || !intent.transactionId || !Number.isInteger(intent.sequence)) {
      blockers.push("undo-intent-malformed");
    }
    if (intent.status === "permanent-failure" && intent.observable !== true) {
      blockers.push("undo-permanent-failure-not-observable");
    }
  }
  if ([...committed].some((row) => (intentsByRow.get(row)?.length ?? 0) !== 1)) {
    blockers.push("committed-row-undo-intent-not-exactly-once");
  }
  if (new Set(input.undoIntents.map((intent) => intent.idempotencyKey)).size !== input.undoIntents.length) {
    blockers.push("undo-idempotency-key-duplicate");
  }
  const commits = input.transactions?.filter((event) => event.event === "commit") ?? [];
  for (const intent of input.undoIntents) {
    const commit = commits.find((event) =>
      event.transactionId === intent.transactionId && event.rowIndex === intent.rowIndex);
    if (!commit || intent.sequence > commit.sequence) blockers.push("undo-intent-not-atomic-with-row-commit");
  }
  return blockers;
}

function validateReaderWriterLease(records: Array<LeaseLockRecord | BatchLeaseRecord>): string[] {
  const detailed = records.filter(isBatchLeaseRecord);
  if (!detailed.length) return ["reader-writer-lease-evidence-missing"];
  const blockers: string[] = [];
  const shared = detailed.filter((record) => record.event === "lock-acquired" && record.mode === "batch-shared");
  const sharedPair = shared.find((left) => shared.some((right) =>
    right.resource === left.resource
    && right.ownerToken !== left.ownerToken
    && right.at >= left.at
    && leaseHeldAt(left, detailed, right.at)));
  if (!sharedPair) blockers.push("reader-writer-shared-acquire-missing");
  const refreshRejected = detailed.some((record) =>
    record.event === "lock-rejected"
    && record.mode === "refresh-exclusive"
    && shared.some((held) => held.resource === record.resource && leaseHeldAt(held, detailed, record.at)));
  if (!refreshRejected) blockers.push("reader-writer-refresh-exclusion-missing");
  const refreshAcquired = detailed.find((record) =>
    record.event === "lock-acquired" && record.mode === "refresh-exclusive");
  if (!refreshAcquired) blockers.push("reader-writer-refresh-acquire-missing");
  if (refreshAcquired && !detailed.some((record) =>
    record.event === "lock-rejected"
    && record.mode === "batch-shared"
    && record.resource === refreshAcquired.resource
    && leaseHeldAt(refreshAcquired, detailed, record.at))) {
    blockers.push("reader-writer-batch-exclusion-missing");
  }
  if (!detailed.some((record) => record.event === "lock-renewed")) blockers.push("reader-writer-renewal-missing");
  if (!detailed.some((record) => record.event === "lock-expired")) blockers.push("reader-writer-expiry-missing");
  if (!detailed.some((record) => record.event === "lock-release-rejected")) {
    blockers.push("reader-writer-owner-check-missing");
  }
  const isolated = detailed.some((record) =>
    record.event === "lock-acquired"
    && detailed.some((other) =>
      other.event === "lock-acquired"
      && other.panelId === record.panelId
      && other.tenantId !== record.tenantId
      && other.at >= record.at
      && leaseHeldAt(record, detailed, other.at)));
  if (!isolated) blockers.push("reader-writer-tenant-isolation-missing");
  for (const acquired of detailed.filter((record) => record.event === "lock-acquired")) {
    if (!detailed.some((record) =>
      (record.event === "lock-released" || record.event === "lock-expired")
      && record.resource === acquired.resource
      && record.ownerToken === acquired.ownerToken
      && record.mode === acquired.mode
      && record.at >= acquired.at)) {
      blockers.push("reader-writer-matching-release-or-expiry-missing");
    }
  }
  return blockers;
}

function validateProgressTerminalIdentity(events: BatchProgressEvent[]): string[] {
  const blockers: string[] = [];
  const logical = new Map<string, BatchProgressEvent>();
  for (const event of events) {
    if (!event.eventId || !Number.isInteger(event.sequence)) {
      blockers.push("progress-event-identity-missing");
      continue;
    }
    const existing = logical.get(event.eventId);
    if (existing && !sameLogicalProgressEvent(existing, event)) blockers.push("progress-event-identity-conflict");
    else logical.set(event.eventId, event);
  }
  const terminals = [...logical.values()].filter((event) => isTerminalProgressStage(event.stage));
  if (terminals.length !== 1) return [...blockers, "progress-logical-terminal-not-exactly-once"];
  const terminal = terminals[0];
  const expected = terminal.failed === 0
    ? "success"
    : terminal.processed === 0
      ? "failed"
      : "partial-failed";
  if (terminal.stage !== expected) blockers.push("progress-terminal-outcome-mismatch");
  return blockers;
}

function validateTransactionTerminalOrdering(input: BatchEvidenceInput): string[] {
  const blockers: string[] = [];
  const transactions = input.transactions ?? [];
  if (!transactions.length) return ["transaction-events-missing"];
  const terminal = logicalTerminal(input.progress);
  if (!terminal || terminal.sequence === undefined) blockers.push("progress-terminal-sequence-missing");
  const terminalSequence = terminal?.sequence;
  const terminalTransactions = transactions.filter((event) => event.event === "commit" || event.event === "rollback");
  if (terminalSequence !== undefined && terminalTransactions.some((event) => event.sequence >= terminalSequence)) {
    blockers.push("progress-terminal-before-transaction-completion");
  }
  const commits = transactions.filter((event) => event.event === "commit");
  const rolledBack = new Set(transactions.filter((event) => event.event === "rollback").map((event) => event.transactionId));
  if (commits.some((event) => rolledBack.has(event.transactionId))) blockers.push("transaction-commit-rollback-conflict");
  for (const row of input.committed) {
    if (!commits.some((event) => event.rowIndex === row)) blockers.push("committed-row-transaction-commit-missing");
  }
  if (terminalSequence !== undefined && (input.undoIntents ?? []).some((intent) => intent.sequence >= terminalSequence)) {
    blockers.push("progress-terminal-before-durable-undo-intent");
  }
  return blockers;
}

function progressStageRank(): Record<BatchProgressStage, number> {
  return {
    accepted: 0,
    validating: 1,
    writing: 2,
    committed: 3,
    success: 3,
    "partial-failed": 3,
    failed: 3
  };
}

function isTerminalProgressStage(stage: BatchProgressStage): boolean {
  return stage === "committed" || stage === "success" || stage === "partial-failed" || stage === "failed";
}

function sameLogicalProgressEvent(left: BatchProgressEvent, right: BatchProgressEvent): boolean {
  return left.stage === right.stage
    && left.processed === right.processed
    && left.failed === right.failed
    && left.total === right.total
    && left.sequence === right.sequence;
}

function logicalTerminal(events: BatchProgressEvent[]): BatchProgressEvent | undefined {
  const seen = new Set<string>();
  return events.find((event) => {
    if (!isTerminalProgressStage(event.stage)) return false;
    if (!event.eventId) return true;
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
}

function sameNumberSet(left: number[], right: number[]): boolean {
  return left.length === new Set(left).size
    && right.length === new Set(right).size
    && left.length === right.length
    && left.every((item) => right.includes(item));
}

function sameChunkIdentity(left: BatchChunkAttemptEvidence, right: BatchChunkAttemptEvidence): boolean {
  return left.tenantId === right.tenantId
    && left.sessionId === right.sessionId
    && left.chunkNo === right.chunkNo;
}

function isBatchLeaseRecord(record: LeaseLockRecord | BatchLeaseRecord): record is BatchLeaseRecord {
  return "mode" in record && "tenantId" in record && "panelId" in record;
}

function leaseHeldAt(
  acquired: BatchLeaseRecord,
  records: BatchLeaseRecord[],
  at: number
): boolean {
  if (at < acquired.at || (acquired.expiresAt !== undefined && acquired.expiresAt <= at)) return false;
  return !records.some((record) =>
    (record.event === "lock-released" || record.event === "lock-expired")
    && record.resource === acquired.resource
    && record.ownerToken === acquired.ownerToken
    && record.mode === acquired.mode
    && record.at >= acquired.at
    && record.at <= at);
}

function validateLeaseInput(
  tenantId: string,
  panelId: string,
  ownerToken: string,
  leaseMs: number
): void {
  if (!tenantId || !panelId || !ownerToken) throw new Error("Lease identity must not be empty");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
}

function batchLeaseResource(tenantId: string, panelId: string): string {
  return `batch-refresh:${tenantId}:${panelId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
