export type RefreshEffect = "sync" | "timestamp" | "undo-clear" | "query" | "unlock" | "reconcile";
export type RefreshMode = "manual" | "auto" | "column";

export interface RefreshTrace {
  mode: RefreshMode;
  syncSucceeded: boolean;
  querySucceeded?: boolean;
  effects: RefreshEffect[];
}

export interface RefreshTraceIssue {
  code: "missing-sync" | "duplicate-effect" | "post-effect-after-sync-failure" | "query-after-sync-failure" | "missing-unlock" | "unlock-not-last" | "early-timestamp" | "early-undo" | "invalid-effect-order" | "missing-query";
  message: string;
}

export interface RefreshTraceReport {
  passed: boolean;
  issues: RefreshTraceIssue[];
}

/** Validate REFRESH side effects without executing application code. */
export function validateRefreshTrace(trace: RefreshTrace): RefreshTraceReport {
  const issues: RefreshTraceIssue[] = [];
  const effects = trace.effects;
  const syncIndex = effects.indexOf("sync");
  const unlockIndex = effects.lastIndexOf("unlock");
  if (syncIndex < 0) issues.push({ code: "missing-sync", message: "Refresh must execute sync before post-effects." });
  for (const effect of new Set(effects)) {
    if (effects.filter((candidate) => candidate === effect).length > 1) {
      issues.push({ code: "duplicate-effect", message: `${effect} must occur at most once.` });
    }
  }
  if (unlockIndex < 0) issues.push({ code: "missing-unlock", message: "Refresh must release its lock on every path." });
  else if (unlockIndex !== effects.length - 1) issues.push({ code: "unlock-not-last", message: "Lock release must be the final effect." });
  if (!trace.syncSucceeded && effects.includes("query")) {
    issues.push({ code: "query-after-sync-failure", message: "A failed sync must not query or publish refreshed data." });
  }
  if (!trace.syncSucceeded && effects.some((effect) => effect === "timestamp" || effect === "undo-clear" || effect === "reconcile")) {
    issues.push({ code: "post-effect-after-sync-failure", message: "A failed sync must skip timestamp, undo-clear, and reconcile." });
  }
  if (trace.syncSucceeded && trace.mode !== "column" && !effects.includes("query")) {
    issues.push({ code: "missing-query", message: "A successful panel refresh must query the refreshed result." });
  }
  for (const effect of ["timestamp", "undo-clear"] as const) {
    const index = effects.indexOf(effect);
    if (index >= 0 && (!trace.syncSucceeded || index < syncIndex)) {
      issues.push({ code: effect === "timestamp" ? "early-timestamp" : "early-undo", message: `${effect} is only valid after successful sync.` });
    }
  }
  const orderedEffects = effects.filter((effect) => effect !== "unlock");
  const orderRank: Partial<Record<RefreshEffect, number>> = {
    sync: 0,
    timestamp: 1,
    "undo-clear": 2,
    reconcile: 3,
    query: 4
  };
  if (orderedEffects.some((effect, index) => index > 0 && (orderRank[effect] ?? 0) < (orderRank[orderedEffects[index - 1]] ?? 0))) {
    issues.push({ code: "invalid-effect-order", message: "Effects must follow sync → timestamp → undo-clear → reconcile → query → unlock." });
  }
  return { passed: issues.length === 0, issues };
}

export interface RefreshClaim {
  panelId: string;
  mode: RefreshMode;
  fieldId?: string;
}

/** Deterministic single-process coordination model used by replay tests. */
export class RefreshCoordinator {
  private readonly manual = new Set<string>();
  private readonly automatic = new Set<string>();
  private readonly columns = new Set<string>();

  tryAcquire(claim: RefreshClaim): boolean {
    if (claim.mode === "column") {
      if (this.manual.has(claim.panelId) || !claim.fieldId) return false;
      const key = `${claim.panelId}:${claim.fieldId}`;
      if (this.columns.has(key)) return false;
      this.columns.add(key);
      return true;
    }
    if (claim.mode === "manual") {
      if (this.manual.has(claim.panelId) || this.automatic.has(claim.panelId)) return false;
      this.manual.add(claim.panelId);
      return true;
    }
    if (this.manual.has(claim.panelId)) return false;
    if (this.automatic.has(claim.panelId)) return false;
    this.automatic.add(claim.panelId);
    return true;
  }

  release(claim: RefreshClaim): void {
    if (claim.mode === "manual") this.manual.delete(claim.panelId);
    else if (claim.mode === "auto") this.automatic.delete(claim.panelId);
    else if (claim.fieldId) this.columns.delete(`${claim.panelId}:${claim.fieldId}`);
  }

  isHeld(panelId: string, mode: RefreshMode, fieldId?: string): boolean {
    return mode === "manual" ? this.manual.has(panelId)
      : mode === "auto" ? this.automatic.has(panelId)
        : fieldId ? this.columns.has(`${panelId}:${fieldId}`) : false;
  }
}

export interface LeaseLock {
  resource: string;
  ownerToken: string;
  expiresAt: number;
}

export type LeaseLockEvent = "lock-acquired" | "lock-rejected" | "lock-released" | "lock-release-rejected";

export interface LeaseLockRecord {
  event: LeaseLockEvent;
  resource: string;
  ownerToken: string;
  at: number;
}

/**
 * Deterministic contract model for the distributed lock required by real replay.
 * A production adapter must make acquire/release atomic in its shared store.
 */
export class LeaseLockStore {
  private readonly locks = new Map<string, LeaseLock>();
  readonly records: LeaseLockRecord[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  tryAcquire(resource: string, ownerToken: string, leaseMs: number): LeaseLock | undefined {
    if (!resource || !ownerToken) throw new Error("resource and ownerToken must not be empty");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
    const at = this.now();
    const current = this.locks.get(resource);
    if (current && current.expiresAt > at) {
      this.records.push({ event: "lock-rejected", resource, ownerToken, at });
      return undefined;
    }
    const lock = { resource, ownerToken, expiresAt: at + leaseMs };
    this.locks.set(resource, lock);
    this.records.push({ event: "lock-acquired", resource, ownerToken, at });
    return { ...lock };
  }

  release(resource: string, ownerToken: string): boolean {
    const at = this.now();
    const current = this.locks.get(resource);
    if (!current || current.ownerToken !== ownerToken) {
      this.records.push({ event: "lock-release-rejected", resource, ownerToken, at });
      return false;
    }
    this.locks.delete(resource);
    this.records.push({ event: "lock-released", resource, ownerToken, at });
    return true;
  }
}

export interface RefreshExecution {
  mode: RefreshMode;
  sync: () => void | Promise<void>;
  timestamp?: () => void | Promise<void>;
  clearUndo?: () => void | Promise<void>;
  reconcile?: () => void | Promise<void>;
  query?: () => void | Promise<void>;
  unlock: () => void | Promise<void>;
}

/** Execute the fixed REFRESH side-effect contract and always release the lock. */
export async function executeRefresh(execution: RefreshExecution): Promise<RefreshTrace> {
  const effects: RefreshEffect[] = [];
  let syncSucceeded = false;
  let querySucceeded: boolean | undefined;
  try {
    effects.push("sync");
    await execution.sync();
    syncSucceeded = true;
    if (execution.timestamp) { effects.push("timestamp"); await execution.timestamp(); }
    if (execution.clearUndo) { effects.push("undo-clear"); await execution.clearUndo(); }
    if (execution.reconcile) { effects.push("reconcile"); await execution.reconcile(); }
    if (execution.mode !== "column") {
      if (!execution.query) throw new Error("Panel refresh requires a query callback");
      effects.push("query");
      try {
        await execution.query();
        querySucceeded = true;
      } catch (error) {
        querySucceeded = false;
        throw error;
      }
    }
    return { mode: execution.mode, syncSucceeded, querySucceeded, effects };
  } finally {
    effects.push("unlock");
    await execution.unlock();
  }
}
