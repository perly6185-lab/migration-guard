import { sha256 } from "./hash.js";

/** The eight page behaviors covered by the ViewMeta migration contract. */
export type VmpBehaviorKind =
  | "standard-page"
  | "refresh"
  | "child-table"
  | "horizontal-table"
  | "quality-filter"
  | "temporary-table"
  | "tenant-permission"
  | "response-comparator";

export interface VmpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface VmpCompareOptions {
  /** JSON paths ignored because they are expected to vary between runs. */
  ignorePaths?: string[];
  /** When true, compare row order; otherwise rows are compared as multisets. */
  preserveRowOrder?: boolean;
  /** Optional status required from both routes, reported as evidence rather than a bare pass mutation. */
  expectedStatus?: number;
}

export interface VmpDifference {
  kind: "status" | "header" | "body" | "pagination" | "row";
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

export interface VmpCompareReport {
  behavior: VmpBehaviorKind;
  passed: boolean;
  baselineFingerprint: string;
  currentFingerprint: string;
  differences: VmpDifference[];
}

/**
 * Compare two endpoint responses without depending on the source implementation.
 *
 * The comparator deliberately treats pagination metadata and data rows as first-class
 * semantics. It is usable for old/new HTTP replay and does not mutate either response.
 */
export function compareVmpResponses(
  behavior: VmpBehaviorKind,
  baseline: VmpResponse,
  current: VmpResponse,
  options: VmpCompareOptions = {}
): VmpCompareReport {
  const ignorePaths = new Set(options.ignorePaths ?? ["$.body.requestId", "$.body.traceId", "$.body.timestamp"]);
  const before = normalizeResponse(baseline, ignorePaths);
  const after = normalizeResponse(current, ignorePaths);
  const differences: VmpDifference[] = [];

  if (before.status !== after.status) {
    differences.push({ kind: "status", path: "$.status", message: "HTTP status changed.", before: before.status, after: after.status });
  }
  if (options.expectedStatus !== undefined) {
    if (before.status !== options.expectedStatus) {
      differences.push({ kind: "status", path: "$.baseline.status", message: "Baseline HTTP status did not match the case expectation.", before: options.expectedStatus, after: before.status });
    }
    if (after.status !== options.expectedStatus) {
      differences.push({ kind: "status", path: "$.current.status", message: "Current HTTP status did not match the case expectation.", before: options.expectedStatus, after: after.status });
    }
  }

  const beforeHeaders = before.headers ?? {};
  const afterHeaders = after.headers ?? {};
  for (const name of new Set([...Object.keys(beforeHeaders), ...Object.keys(afterHeaders)])) {
    if (beforeHeaders[name] !== afterHeaders[name]) {
      differences.push({ kind: "header", path: `$.headers.${name}`, message: "Response header changed.", before: beforeHeaders[name], after: afterHeaders[name] });
    }
  }

  const beforePage = pagination(before.body);
  const afterPage = pagination(after.body);
  for (const field of ["pageNo", "pageSize", "total"] as const) {
    if (beforePage[field] !== afterPage[field]) {
      differences.push({ kind: "pagination", path: `$.body.${field}`, message: "Pagination metadata changed.", before: beforePage[field], after: afterPage[field] });
    }
  }

  const beforeRows = rows(before.body);
  const afterRows = rows(after.body);
  const comparableBefore = options.preserveRowOrder === false ? [...beforeRows].sort(rowSort) : beforeRows;
  const comparableAfter = options.preserveRowOrder === false ? [...afterRows].sort(rowSort) : afterRows;
  if (JSON.stringify(comparableBefore) !== JSON.stringify(comparableAfter)) {
    differences.push({ kind: "row", path: "$.body.data", message: "Response rows changed.", before: comparableBefore, after: comparableAfter });
  }

  const beforeBody = withoutRows(before.body);
  const afterBody = withoutRows(after.body);
  if (JSON.stringify(beforeBody) !== JSON.stringify(afterBody)) {
    differences.push({ kind: "body", path: "$.body", message: "Response body changed.", before: beforeBody, after: afterBody });
  }

  return {
    behavior,
    passed: differences.length === 0,
    baselineFingerprint: sha256(JSON.stringify(fingerprintResponse(before, options.preserveRowOrder !== false))),
    currentFingerprint: sha256(JSON.stringify(fingerprintResponse(after, options.preserveRowOrder !== false))),
    differences
  };
}

function fingerprintResponse(response: VmpResponse, preserveRowOrder: boolean): VmpResponse {
  if (preserveRowOrder || !response.body || typeof response.body !== "object") return response;
  const body = { ...(response.body as Record<string, unknown>) };
  if (Array.isArray(body.data)) body.data = [...body.data].sort(rowSort);
  if (Array.isArray(body.rows)) body.rows = [...body.rows].sort(rowSort);
  return { ...response, body };
}

function withoutRows(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const value = { ...(body as Record<string, unknown>) };
  delete value.data;
  delete value.rows;
  delete value.pageNo;
  delete value.page;
  delete value.current;
  delete value.pageSize;
  delete value.size;
  delete value.total;
  delete value.totalCount;
  return value;
}

function normalizeResponse(response: VmpResponse, ignorePaths: Set<string>): VmpResponse {
  return {
    status: response.status,
    headers: Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
    body: normalizeValue(response.body, "$.body", ignorePaths)
  };
}

function normalizeValue(value: unknown, path: string, ignorePaths: Set<string>): unknown {
  if (ignorePaths.has(path)) return undefined;
  if (Array.isArray(value)) return value.map((item, index) => normalizeValue(item, `${path}[${index}]`, ignorePaths));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !ignorePaths.has(`${path}.${key}`))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item, `${path}.${key}`, ignorePaths)]));
  }
  return value;
}

function pagination(body: unknown): { pageNo?: unknown; pageSize?: unknown; total?: unknown } {
  if (!body || typeof body !== "object") return {};
  const value = body as Record<string, unknown>;
  return {
    pageNo: value.pageNo ?? value.page ?? value.current,
    pageSize: value.pageSize ?? value.size,
    total: value.total ?? value.totalCount
  };
}

function rows(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const value = body as Record<string, unknown>;
  return Array.isArray(value.data) ? value.data : Array.isArray(value.rows) ? value.rows : [];
}

function rowSort(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
