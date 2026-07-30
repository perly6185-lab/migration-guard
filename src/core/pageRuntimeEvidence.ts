const HASH = /^[a-f0-9]{64}$/;

export interface PageResponseEvidence {
  status: number;
  pageNumber: number;
  pageSize: number;
  total: number;
  returnedRows: number;
  rowKeys: string[];
  rowsHash: string;
  orderHash?: string;
}

export interface PageQueryEvidence {
  whereFields: string[];
  havingFields: string[];
  aggregateFields: string[];
  groupByFields?: string[];
  orderByFields?: string[];
  distinct?: boolean;
  dataFilterHash?: string;
  totalFilterHash?: string;
}

export interface PageHorizontalEvidence {
  pageKeys: string[];
  cellRowKeys: string[];
  distinctTotal: number;
  pivotKeys?: string[];
}

export type PageRefreshEffect =
  | "sync"
  | "timestamp"
  | "undo-clear"
  | "reconcile"
  | "query"
  | "terminal-event"
  | "unlock";

export interface PageRefreshEvidence {
  mode: "manual" | "auto" | "column";
  syncSucceeded: boolean;
  querySucceeded?: boolean;
  effects: PageRefreshEffect[];
  lock?: {
    resource: string;
    ownerFingerprint: string;
    acquired: boolean;
    released: boolean;
    releaseOwnerFingerprint?: string;
  };
  terminalEvent?: "completed" | "failed" | "rejected";
}

export interface PageEvidenceInput {
  response: PageResponseEvidence;
  query?: PageQueryEvidence;
  horizontal?: PageHorizontalEvidence;
  refresh?: PageRefreshEvidence;
}

export interface PageGateRequirements {
  expectedStatus?: number;
  requirePagination?: boolean;
  preserveRowOrder?: boolean;
  requireTotalFilterParity?: boolean;
  aggregateRouting?: {
    fields: string[];
    destination: "where" | "having";
  };
  requireHorizontalConsistency?: boolean;
  requireRefreshTrace?: boolean;
  requireRefreshTerminal?: boolean;
  requireRefreshLock?: boolean;
}

export interface PageGateReport {
  passed: boolean;
  blockers: string[];
}

export function gatePageEvidence(
  input: PageEvidenceInput,
  requirements: PageGateRequirements = { requirePagination: true }
): PageGateReport {
  const blockers: string[] = [];
  const response = input?.response;
  if (!response || typeof response !== "object") {
    return { passed: false, blockers: ["response-missing"] };
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    blockers.push("response-status-invalid");
  }
  if (requirements.expectedStatus !== undefined && response.status !== requirements.expectedStatus) {
    blockers.push("response-status-mismatch");
  }
  if (requirements.requirePagination !== false) validatePagination(response, requirements, blockers);
  if (requirements.requireTotalFilterParity) validateFilterParity(input.query, blockers);
  if (requirements.aggregateRouting) validateAggregateRouting(input.query, requirements.aggregateRouting, blockers);
  if (requirements.requireHorizontalConsistency) validateHorizontal(input, blockers);
  if (requirements.requireRefreshTrace || requirements.requireRefreshTerminal || requirements.requireRefreshLock) {
    validateRefresh(input.refresh, requirements, blockers);
  }
  const unique = [...new Set(blockers)].sort();
  return { passed: unique.length === 0, blockers: unique };
}

function validatePagination(
  response: PageResponseEvidence,
  requirements: PageGateRequirements,
  blockers: string[]
): void {
  if (!positiveInteger(response.pageNumber)) blockers.push("pagination-page-number-invalid");
  if (!positiveInteger(response.pageSize)) blockers.push("pagination-page-size-invalid");
  if (!nonNegativeInteger(response.total)) blockers.push("pagination-total-invalid");
  if (!nonNegativeInteger(response.returnedRows)) blockers.push("pagination-returned-rows-invalid");
  if (positiveInteger(response.pageSize) && response.returnedRows > response.pageSize) {
    blockers.push("pagination-page-size-exceeded");
  }
  if (nonNegativeInteger(response.total) && response.returnedRows > response.total) {
    blockers.push("pagination-returned-rows-exceed-total");
  }
  if (!Array.isArray(response.rowKeys) || response.rowKeys.some((key) => typeof key !== "string" || !key)) {
    blockers.push("pagination-row-keys-invalid");
  } else {
    if (response.rowKeys.length !== response.returnedRows) blockers.push("pagination-row-key-count-mismatch");
    if (new Set(response.rowKeys).size !== response.rowKeys.length) blockers.push("pagination-row-keys-duplicate");
  }
  if (!HASH.test(response.rowsHash)) blockers.push("pagination-rows-hash-invalid");
  if (requirements.preserveRowOrder !== false && !HASH.test(response.orderHash ?? "")) {
    blockers.push("pagination-order-hash-missing");
  }
}

function validateFilterParity(query: PageQueryEvidence | undefined, blockers: string[]): void {
  if (!query) {
    blockers.push("query-evidence-missing");
    return;
  }
  if (!HASH.test(query.dataFilterHash ?? "") || !HASH.test(query.totalFilterHash ?? "")) {
    blockers.push("query-filter-hash-missing");
  } else if (query.dataFilterHash !== query.totalFilterHash) {
    blockers.push("query-total-filter-mismatch");
  }
}

function validateAggregateRouting(
  query: PageQueryEvidence | undefined,
  routing: NonNullable<PageGateRequirements["aggregateRouting"]>,
  blockers: string[]
): void {
  if (!query) {
    blockers.push("query-evidence-missing");
    return;
  }
  if (!stringList(query.whereFields) || !stringList(query.havingFields) || !stringList(query.aggregateFields)) {
    blockers.push("query-field-routing-invalid");
    return;
  }
  const destination = new Set(routing.destination === "having" ? query.havingFields : query.whereFields);
  const opposite = new Set(routing.destination === "having" ? query.whereFields : query.havingFields);
  const aggregate = new Set(query.aggregateFields);
  for (const field of routing.fields) {
    if (!aggregate.has(field)) blockers.push(`query-aggregate-field-unproven:${field}`);
    if (!destination.has(field)) blockers.push(`query-aggregate-route-missing:${field}:${routing.destination}`);
    if (opposite.has(field)) blockers.push(`query-aggregate-route-conflict:${field}`);
  }
}

function validateHorizontal(input: PageEvidenceInput, blockers: string[]): void {
  const horizontal = input.horizontal;
  if (!horizontal) {
    blockers.push("horizontal-evidence-missing");
    return;
  }
  if (!stringList(horizontal.pageKeys) || !stringList(horizontal.cellRowKeys)) {
    blockers.push("horizontal-row-keys-invalid");
    return;
  }
  if (!nonNegativeInteger(horizontal.distinctTotal)) blockers.push("horizontal-distinct-total-invalid");
  if (new Set(horizontal.pageKeys).size !== horizontal.pageKeys.length) blockers.push("horizontal-page-keys-duplicate");
  const pageKeySet = new Set(horizontal.pageKeys);
  if (horizontal.cellRowKeys.some((key) => !pageKeySet.has(key))) blockers.push("horizontal-cell-outside-page");
  if (nonNegativeInteger(horizontal.distinctTotal) && horizontal.pageKeys.length > horizontal.distinctTotal) {
    blockers.push("horizontal-page-keys-exceed-total");
  }
  if (!sameStringArray(input.response.rowKeys, horizontal.pageKeys)) {
    blockers.push("horizontal-response-page-key-mismatch");
  }
}

function validateRefresh(
  refresh: PageRefreshEvidence | undefined,
  requirements: PageGateRequirements,
  blockers: string[]
): void {
  if (!refresh) {
    blockers.push("refresh-evidence-missing");
    return;
  }
  if (!["manual", "auto", "column"].includes(refresh.mode)) blockers.push("refresh-mode-invalid");
  if (!Array.isArray(refresh.effects) || refresh.effects.length === 0) {
    blockers.push("refresh-effects-missing");
    return;
  }
  if (new Set(refresh.effects).size !== refresh.effects.length) blockers.push("refresh-effect-duplicate");
  const ranks: Record<PageRefreshEffect, number> = {
    sync: 0,
    timestamp: 1,
    "undo-clear": 2,
    reconcile: 3,
    query: 4,
    "terminal-event": 5,
    unlock: 6
  };
  if (refresh.effects.some((effect, index) =>
    index > 0 && ranks[effect] < ranks[refresh.effects[index - 1]!]!)) {
    blockers.push("refresh-effect-order-invalid");
  }
  if (!refresh.effects.includes("sync")) blockers.push("refresh-sync-missing");
  if (!refresh.syncSucceeded && refresh.effects.some((effect) =>
    effect === "timestamp" || effect === "undo-clear" || effect === "reconcile" || effect === "query")) {
    blockers.push("refresh-post-effect-after-sync-failure");
  }
  if (refresh.syncSucceeded && refresh.mode !== "column" && !refresh.effects.includes("query")) {
    blockers.push("refresh-query-missing");
  }
  if (requirements.requireRefreshTerminal) {
    if (!refresh.terminalEvent || !refresh.effects.includes("terminal-event")) blockers.push("refresh-terminal-event-missing");
    if (refresh.terminalEvent === "completed" && (!refresh.syncSucceeded || refresh.querySucceeded === false)) {
      blockers.push("refresh-terminal-event-inconsistent");
    }
  }
  if (requirements.requireRefreshLock) {
    const lock = refresh.lock;
    if (!lock?.acquired) blockers.push("refresh-lock-acquire-missing");
    if (!lock?.released || !refresh.effects.includes("unlock")) blockers.push("refresh-lock-release-missing");
    if (lock && (!HASH.test(lock.ownerFingerprint)
      || lock.releaseOwnerFingerprint !== undefined && !HASH.test(lock.releaseOwnerFingerprint))) {
      blockers.push("refresh-lock-owner-fingerprint-invalid");
    }
    if (lock?.released && lock.releaseOwnerFingerprint !== lock.ownerFingerprint) {
      blockers.push("refresh-lock-owner-mismatch");
    }
    if (refresh.effects.includes("unlock") && refresh.effects.at(-1) !== "unlock") {
      blockers.push("refresh-unlock-not-last");
    }
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
