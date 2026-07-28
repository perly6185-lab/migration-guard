import { compareVmpResponses, type VmpBehaviorKind, type VmpCompareReport, type VmpResponse } from "./vmpBehavior.js";
import { sha256 } from "./hash.js";

export const VMP_REPLAY_BEHAVIORS = [
  "standard-page",
  "refresh",
  "child-table",
  "horizontal-table",
  "quality-filter",
  "temporary-table",
  "tenant-permission"
] as const satisfies readonly VmpBehaviorKind[];

export type VmpReplayBehavior = typeof VMP_REPLAY_BEHAVIORS[number];

export interface VmpReplayCase {
  id: string;
  behavior: VmpReplayBehavior;
  request: Record<string, unknown>;
  expectedStatus?: number;
  volatilePaths?: string[];
}

export interface VmpReadinessInput {
  oldService: boolean;
  newService: boolean;
  oldDatabase: boolean;
  newDatabase: boolean;
  token: boolean;
  cases: VmpReplayCase[];
}

export interface VmpReadinessReport {
  ready: boolean;
  blockers: string[];
  caseCount: number;
}

export interface VmpReplayResult {
  caseId: string;
  behavior: VmpReplayBehavior;
  oldResponse?: VmpResponse;
  newResponse?: VmpResponse;
  compare?: VmpCompareReport;
  requestHash: string;
  oldSnapshotHash?: string;
  newSnapshotHash?: string;
  oldContext?: VmpReplayContext;
  newContext?: VmpReplayContext;
  error?: string;
}

export interface VmpReplayContext {
  tenantId: string;
  userId: string;
}

export interface VmpReplayObservation {
  response: VmpResponse;
  snapshotHash: string;
  context: VmpReplayContext;
}

export interface VmpDifferenceDecision {
  caseId: string;
  path: string;
  classification: "accepted-equivalent" | "intentional-risk";
  reason: string;
}

export interface VmpEvidenceBundle {
  version: 1;
  createdAt: string;
  readiness: VmpReadinessReport;
  results: VmpReplayResult[];
  decisions: VmpDifferenceDecision[];
  passed: boolean;
  blockers: string[];
}

export function checkVmpReadiness(input: VmpReadinessInput): VmpReadinessReport {
  const blockers: string[] = [];
  if (!input.oldService) blockers.push("old-service-unavailable");
  if (!input.newService) blockers.push("new-service-unavailable");
  if (!input.oldDatabase) blockers.push("old-database-unavailable");
  if (!input.newDatabase) blockers.push("new-database-unavailable");
  if (!input.token) blockers.push("有效 token 缺失");
  if (input.cases.length === 0) blockers.push("七类真实请求数据缺失");
  const caseIds = new Set<string>();
  for (const testCase of input.cases) {
    if (!testCase.id || caseIds.has(testCase.id)) blockers.push(`用例 ID 无效或重复:${testCase.id}`);
    caseIds.add(testCase.id);
    if (containsSensitiveKey(testCase.request)) blockers.push(`用例包含敏感字段:${testCase.id}`);
  }
  const behaviors = new Set(input.cases.map((item) => item.behavior));
  for (const behavior of VMP_REPLAY_BEHAVIORS) if (!behaviors.has(behavior)) blockers.push(`行为用例缺失:${behavior}`);
  return { ready: blockers.length === 0, blockers, caseCount: input.cases.length };
}

export async function replayVmpCases(
  cases: VmpReplayCase[],
  oldExecutor: (request: Record<string, unknown>, testCase: VmpReplayCase) => Promise<VmpReplayObservation>,
  newExecutor: (request: Record<string, unknown>, testCase: VmpReplayCase) => Promise<VmpReplayObservation>
): Promise<VmpReplayResult[]> {
  const results: VmpReplayResult[] = [];
  for (const testCase of cases) {
    const request = sanitizeVmpFixture(testCase.request);
    const requestHash = sha256(stableJson(request));
    try {
      const [oldObservation, newObservation] = await Promise.all([
        oldExecutor(request, testCase),
        newExecutor(request, testCase)
      ]);
      const compare = compareVmpResponses(testCase.behavior, oldObservation.response, newObservation.response, {
        ignorePaths: testCase.volatilePaths,
        expectedStatus: testCase.expectedStatus
      });
      results.push({
        caseId: testCase.id,
        behavior: testCase.behavior,
        requestHash,
        oldResponse: oldObservation.response,
        newResponse: newObservation.response,
        oldSnapshotHash: oldObservation.snapshotHash,
        newSnapshotHash: newObservation.snapshotHash,
        oldContext: oldObservation.context,
        newContext: newObservation.context,
        compare
      });
    } catch (error) {
      results.push({ caseId: testCase.id, behavior: testCase.behavior, requestHash, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function buildVmpEvidenceBundle(
  readiness: VmpReadinessReport,
  results: VmpReplayResult[],
  decisions: VmpDifferenceDecision[] = []
): VmpEvidenceBundle {
  const blockers = [...readiness.blockers];
  const resultBehaviors = new Set(results.map((result) => result.behavior));
  for (const behavior of VMP_REPLAY_BEHAVIORS) if (!resultBehaviors.has(behavior)) blockers.push(`回放结果缺失:${behavior}`);
  if (new Set(results.map((result) => result.caseId)).size !== results.length) blockers.push("回放结果包含重复 caseId");
  if (results.some((result) => result.error)) blockers.push("回放执行异常");
  if (results.some((result) => !result.compare && !result.error)) blockers.push("回放比较证据缺失");
  if (results.some((result) => !result.oldSnapshotHash || !result.newSnapshotHash)) blockers.push("快照证据缺失");
  if (results.some((result) => result.oldSnapshotHash !== result.newSnapshotHash)) blockers.push("旧链/新链快照不一致");
  if (results.some((result) => !sameContext(result.oldContext, result.newContext))) blockers.push("旧链/新链租户或用户上下文不一致");
  const decisionKeys = new Set(decisions.filter((decision) => decision.reason.trim()).map((decision) => `${decision.caseId}\u001f${decision.path}`));
  const unclassified = results.flatMap((result) => result.compare?.differences
    .filter((difference) => !decisionKeys.has(`${result.caseId}\u001f${difference.path}`)) ?? []);
  if (unclassified.length) blockers.push("旧链/新链存在未分类差异");
  return { version: 1, createdAt: new Date().toISOString(), readiness, results, decisions, passed: readiness.ready && blockers.length === 0, blockers: [...new Set(blockers)] };
}

function sameContext(left?: VmpReplayContext, right?: VmpReplayContext): boolean {
  return Boolean(left && right && left.tenantId && left.userId && left.tenantId === right.tenantId && left.userId === right.userId);
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    /authorization|token|cookie|password|phone|mobile/i.test(key) || containsSensitiveKey(item));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sanitizeVmpFixture<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitizeVmpFixture(item)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/authorization|token|cookie|password|phone|mobile/i.test(key)) output[key] = "<redacted>";
    else output[key] = sanitizeVmpFixture(item);
  }
  return output as T;
}
