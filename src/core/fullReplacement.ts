import path from "node:path";
import { sha256 } from "./hash.js";
import { runShellCommand } from "./exec.js";
import { writeJsonFile, writeTextFile } from "./files.js";
import type { JavaEndpointAnalysisReport, JavaEndpointGoldenCasePlan } from "./javaEndpointAnalysis.js";
import type { CrossLanguageProjectInventory } from "./crossLanguageAdapters.js";

export type ClosureClassification = "rust-owned" | "infrastructure-port" | "source-java-owned" | "unresolved" | "reviewed-exclusion";
export interface TargetEvidence { kind: "handler" | "branch" | "port" | "side-effect"; file: string; line?: number; symbol: string; hash?: string }
export interface InfrastructurePort { protocol: string; resource: string; operation: string; targetAdapter: string }
export interface ReviewedExclusion { reason: string; category: "read-only-compatibility" | "dead-code" | "test-only" }
export interface ReplacementClosureNode {
  id: string; source: { file: string; line: number; symbol: string; kind: string };
  classification: ClosureClassification; required: boolean; evidence?: TargetEvidence[];
  infrastructurePort?: InfrastructurePort; exclusion?: ReviewedExclusion; reason: string;
}
export interface ReplacementFinding { code: string; severity: "error" | "warning"; nodeId?: string; message: string }
export interface FullReplacementClosure {
  version: 1; createdAt: string; endpoint: { method: string; path: string }; status: "passed" | "blocked";
  nodes: ReplacementClosureNode[]; findings: ReplacementFinding[];
  summary: Record<ClosureClassification, number> & { required: number; blocking: number };
  manifestHash: string;
}

export function createFullReplacementClosure(input: {
  java: JavaEndpointAnalysisReport; rust: CrossLanguageProjectInventory;
  targetEvidence?: Record<string, TargetEvidence[]>; infrastructurePorts?: Record<string, InfrastructurePort>;
  exclusions?: Record<string, ReviewedExclusion>;
}): FullReplacementClosure {
  const evidence = input.targetEvidence ?? {};
  const ports = input.infrastructurePorts ?? {};
  const exclusions = input.exclusions ?? {};
  const findings: ReplacementFinding[] = [];
  const nodes = input.java.callGraph.nodes.map((node): ReplacementClosureNode => {
    const nodeEvidence = evidence[node.id] ?? [];
    const port = ports[node.id];
    const exclusion = exclusions[node.id];
    let classification: ClosureClassification = "source-java-owned";
    let reason = "reachable behavior has no Rust ownership evidence";
    if (nodeEvidence.length > 0) {
      classification = "rust-owned";
      reason = "target implementation evidence supplied";
    } else if (port) {
      classification = "infrastructure-port";
      reason = "behavior terminates at a declared infrastructure boundary";
    } else if (exclusion) {
      classification = "reviewed-exclusion";
      reason = exclusion.reason;
    }
    return {
      id: node.id,
      source: { file: node.file, line: node.line, symbol: `${node.className}.${node.methodName}`, kind: node.kind },
      classification, required: true, evidence: nodeEvidence.length ? nodeEvidence : undefined,
      infrastructurePort: port, exclusion, reason
    };
  });
  for (const edge of input.java.callGraph.edges.filter((item) => !item.to)) {
    const id = `unresolved:${edge.from}:${edge.call.file}:${edge.call.line}:${edge.call.method}`;
    nodes.push({
      id, source: { file: edge.call.file, line: edge.call.line, symbol: edge.unresolvedTarget ?? edge.call.expression, kind: "unknown" },
      classification: "unresolved", required: true, reason: "Java call target was not resolved"
    });
  }
  for (const unresolved of input.rust.unresolvedRoutes) {
    findings.push({ code: "FR-CLOSURE-RUST-ROUTE-UNRESOLVED", severity: "error", message: `${unresolved.file}:${unresolved.line} ${unresolved.reason}` });
  }
  if (input.java.callGraph.truncation.edgeCapHit) findings.push({ code: "FR-CLOSURE-EDGE-CAP", severity: "error", message: "Java call graph hit the configured edge cap" });
  if (input.java.callGraph.truncation.depthCapHit) findings.push({ code: "FR-CLOSURE-DEPTH-CAP", severity: "error", message: "Java call graph hit the configured depth cap" });
  if (input.java.callGraph.truncation.unexpandedBoundaryNodes.length > 0) findings.push({ code: "FR-CLOSURE-UNEXPANDED-BOUNDARY", severity: "error", message: `Unexpanded nodes: ${input.java.callGraph.truncation.unexpandedBoundaryNodes.join(", ")}` });
  for (const node of nodes) {
    if (node.classification === "source-java-owned") findings.push({ code: "FR-CLOSURE-JAVA-TAIL", severity: "error", nodeId: node.id, message: `${node.source.symbol} remains Java-owned` });
    if (node.classification === "unresolved") findings.push({ code: "FR-CLOSURE-UNRESOLVED", severity: "error", nodeId: node.id, message: `${node.source.symbol} is unresolved` });
    if (node.classification === "infrastructure-port" && !validPort(node.infrastructurePort)) findings.push({ code: "FR-CLOSURE-INVALID-PORT", severity: "error", nodeId: node.id, message: "Infrastructure port is incomplete" });
    if (node.classification === "reviewed-exclusion" && (!node.exclusion?.reason || /write|save|update|delete|clear|lock|context|event|progress|undo|reconcile/i.test(node.source.symbol))) findings.push({ code: "FR-CLOSURE-INVALID-EXCLUSION", severity: "error", nodeId: node.id, message: "Exclusion is missing a reason or hides protected behavior" });
  }
  const counts = Object.fromEntries(["rust-owned", "infrastructure-port", "source-java-owned", "unresolved", "reviewed-exclusion"].map((key) => [key, nodes.filter((node) => node.classification === key).length])) as Record<ClosureClassification, number>;
  const base = {
    version: 1 as const, createdAt: new Date().toISOString(), endpoint: input.java.endpoint,
    status: findings.some((finding) => finding.severity === "error") ? "blocked" as const : "passed" as const,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)), findings: findings.sort((a, b) => a.code.localeCompare(b.code) || (a.nodeId ?? "").localeCompare(b.nodeId ?? "")),
    summary: { ...counts, required: nodes.filter((node) => node.required).length, blocking: findings.filter((finding) => finding.severity === "error").length }
  };
  return { ...base, manifestHash: stableHash({ ...base, createdAt: undefined }) };
}

function validPort(port: InfrastructurePort | undefined): boolean { return Boolean(port?.protocol && port.resource && port.operation && port.targetAdapter); }

export type ContextFieldName = "tenant" | "user" | "request" | "trace" | "datasource" | "device" | "locale" | "timezone" | "authorizationClaims" | "compatibilityFlags";
export interface ContextField { value?: unknown; provenance: string; required: boolean; defaultBehavior: "reject" | "explicit-default" | "optional"; consumedBy?: string[] }
export interface RuntimeContextEnvelope { version: 1; fields: Partial<Record<ContextFieldName, ContextField>>; ambientSources?: string[] }
export interface ContextValidation { passed: boolean; findings: Array<{ code: string; field?: string; message: string }>; sanitized: RuntimeContextEnvelope; hash: string }
const SECRET_KEY = /authorization|token|cookie|secret|password|api[-_]?key/i;

export function validateContextEnvelope(envelope: RuntimeContextEnvelope): ContextValidation {
  const sanitized = redactSecrets(envelope) as RuntimeContextEnvelope;
  const findings: ContextValidation["findings"] = [];
  for (const [name, field] of Object.entries(envelope.fields)) {
    if (field?.required && field.value === undefined && field.defaultBehavior === "reject") findings.push({ code: "FR-CONTEXT-REQUIRED-MISSING", field: name, message: `${name} is required` });
    if (!field?.provenance) findings.push({ code: "FR-CONTEXT-PROVENANCE-MISSING", field: name, message: `${name} has no provenance` });
    if (field?.required && !field.consumedBy?.length) findings.push({ code: "FR-CONTEXT-TARGET-CONSUMPTION-MISSING", field: name, message: `${name} has no target consumption evidence` });
  }
  for (const source of envelope.ambientSources ?? []) findings.push({ code: "FR-CONTEXT-AMBIENT-UNCLASSIFIED", message: `Unclassified ambient context: ${source}` });
  return { passed: findings.length === 0, findings, sanitized, hash: stableHash(sanitized) };
}

export function compareContextEnvelopes(source: RuntimeContextEnvelope, target: RuntimeContextEnvelope): Array<{ field: string; source: unknown; target: unknown }> {
  const left = validateContextEnvelope(source).sanitized.fields;
  const right = validateContextEnvelope(target).sanitized.fields;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((field) => {
    const a = left[field as ContextFieldName]?.value; const b = right[field as ContextFieldName]?.value;
    return stableHash(a) === stableHash(b) ? [] : [{ field, source: a, target: b }];
  });
}

export type EffectKind = "database" | "cache" | "coordination" | "progress" | "undo" | "reconcile" | "clock" | "external-call";
export interface ExecutionEffect {
  kind: EffectKind | string; phase: string; sequence: number; resourceKey: string; operation: string;
  beforeHash?: string; afterHash?: string; outcome: "applied" | "skipped" | "failed" | "ignored-failure";
  errorPolicy: "result-affecting" | "ignored" | "retryable"; transactionGroup?: string; idempotencyKey?: string; logicalTimestamp: string;
}
export interface EffectTrace { version: 1; fixtureHash: string; effects: ExecutionEffect[]; bounded: boolean; redacted: boolean; complete: boolean }
export interface EffectValidation { passed: boolean; findings: Array<{ code: string; sequence?: number; message: string }>; normalized: EffectTrace; traceHash: string }
const EFFECT_KINDS = new Set<EffectKind>(["database", "cache", "coordination", "progress", "undo", "reconcile", "clock", "external-call"]);

export function validateEffectTrace(trace: EffectTrace): EffectValidation {
  const normalized = redactSecrets({ ...trace, effects: [...trace.effects].sort((a, b) => a.sequence - b.sequence) }) as EffectTrace;
  const findings: EffectValidation["findings"] = [];
  if (!trace.bounded) findings.push({ code: "FR-EFFECT-UNBOUNDED", message: "Effect trace is not bounded" });
  if (!trace.redacted) findings.push({ code: "FR-EFFECT-NOT-REDACTED", message: "Effect trace is not marked redacted" });
  if (!trace.complete) findings.push({ code: "FR-EFFECT-INCOMPLETE", message: "Effect trace is incomplete" });
  if (trace.effects.length > 10_000) findings.push({ code: "FR-EFFECT-LIMIT", message: "Effect trace exceeds the 10000 item bound" });
  trace.effects.forEach((effect, index) => {
    if (!EFFECT_KINDS.has(effect.kind as EffectKind)) findings.push({ code: "FR-EFFECT-KIND-UNKNOWN", sequence: effect.sequence, message: `Unknown effect kind ${effect.kind}` });
    if (effect.sequence !== index + 1) findings.push({ code: "FR-EFFECT-SEQUENCE", sequence: effect.sequence, message: "Effect sequence must be contiguous and one-based" });
    if (!effect.resourceKey || !effect.operation || !effect.logicalTimestamp) findings.push({ code: "FR-EFFECT-FIELD-MISSING", sequence: effect.sequence, message: "Effect identity or timestamp is missing" });
    if (effect.outcome === "ignored-failure" && effect.errorPolicy !== "ignored") findings.push({ code: "FR-EFFECT-ERROR-POLICY", sequence: effect.sequence, message: "Ignored failure requires ignored error policy" });
  });
  return { passed: findings.length === 0, findings, normalized, traceHash: stableHash(normalized) };
}

export type ObservationDimension = "http" | "context" | "decisions" | "effects" | "state" | "events" | "concurrency" | "failures";
export interface FullReplacementGoldenCase { id: string; title: string; requestFocus: string[]; observations: Array<{ dimension: ObservationDimension; required: boolean; sourceCapture: "required"; targetReplay: "required" }>; expectedComparison: string[]; ownership: "target-owned" }
export interface FullReplacementGoldenPlan { version: 2; model: JavaEndpointGoldenCasePlan["model"]; endpoint: JavaEndpointGoldenCasePlan["endpoint"]; cases: FullReplacementGoldenCase[]; fixtureTemplate: JavaEndpointGoldenCasePlan["fixtureTemplate"]; requiredDimensions: ObservationDimension[]; strict: true }

export function upgradeGoldenPlan(plan: JavaEndpointGoldenCasePlan): FullReplacementGoldenPlan {
  const requiredDimensions: ObservationDimension[] = ["http", "context", "decisions", "effects", "state", "events", "concurrency", "failures"];
  const cases = plan.cases.map((item) => ({
    id: item.id, title: item.title, requestFocus: item.requestFocus,
    observations: requiredDimensions.map((dimension) => ({ dimension, required: true, sourceCapture: "required" as const, targetReplay: "required" as const })),
    expectedComparison: item.expectedComparison, ownership: "target-owned" as const
  }));
  if (plan.model === "sync-command") {
    const additions = [
      ...["progress-publish-failure", "sync-failure", "timestamp-update-failure", "undo-clear-failure", "reconcile-failure"].map((id) => ({ id, focus: `inject fault at ${id.replace("-failure", "")}` })),
      ...["tenant-context", "user-context", "datasource-context"].map((id) => ({ id, focus: `positive and negative ${id.replace("-context", "")} isolation fixture` }))
    ];
    for (const { id, focus } of additions) cases.push({
      id, title: id.replaceAll("-", " "), requestFocus: [focus],
      observations: requiredDimensions.map((dimension) => ({ dimension, required: true, sourceCapture: "required", targetReplay: "required" })),
      expectedComparison: ["return value", "partial state", "ordered effects", "terminal events", "retry policy"], ownership: "target-owned"
    });
  }
  return { version: 2, model: plan.model, endpoint: plan.endpoint, cases, fixtureTemplate: redactSecrets(plan.fixtureTemplate) as JavaEndpointGoldenCasePlan["fixtureTemplate"], requiredDimensions, strict: true };
}

export interface ReplayObservation {
  caseId: string; fixtureHash: string; http: unknown; context: RuntimeContextEnvelope; decisions: string[];
  effects: EffectTrace; state: Record<string, string>; events: Array<{ name: string; sequence: number; terminal?: boolean }>;
  concurrency: unknown; failures: unknown; cleanup: { passed: boolean }; performance?: { throughput: number; p95Ms: number; p99Ms: number; memoryMb: number; errorRate: number };
}
export interface RuntimeDriverConfig { id: string; root: string; timeoutMs: number; operations: Record<"start" | "health" | "reset" | "invoke" | "snapshot" | "collect" | "injectFault" | "stop", string> }
export interface RuntimeDriverRun { status: "passed" | "blocked"; driverId: string; operationHashes: Record<string, string>; observations?: ReplayObservation; findings: string[] }

export async function runRuntimeDriver(config: RuntimeDriverConfig, caseId: string): Promise<RuntimeDriverRun> {
  const root = path.resolve(config.root); const findings: string[] = []; const operationHashes: Record<string, string> = {};
  const required = ["start", "health", "reset", "invoke", "snapshot", "collect", "stop"] as const;
  let observations: ReplayObservation | undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(caseId)) {
    return { status: "blocked", driverId: config.id, operationHashes, findings: ["FR-DRIVER-CASE-ID-UNSAFE"] };
  }
  const renderCommand = (operation: keyof RuntimeDriverConfig["operations"]): string | undefined => {
    const template = config.operations[operation];
    if (!template || SECRET_KEY.test(template) || template.includes("..") || /[\r\n\0]/.test(template)) {
      findings.push(`FR-DRIVER-UNSAFE-COMMAND:${operation}`);
      return undefined;
    }
    operationHashes[operation] = sha256(template);
    return template.replaceAll("{caseId}", caseId);
  };
  try {
    for (const operation of required) {
      const command = renderCommand(operation);
      if (!command) break;
      const result = await runShellCommand(command, { cwd: root, timeoutMs: config.timeoutMs, maxOutputBytes: 1024 * 1024 });
      if (result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) { findings.push(`FR-DRIVER-OPERATION-FAILED:${operation}`); break; }
      if (operation === "collect") {
        try {
          observations = JSON.parse(result.stdout) as ReplayObservation;
          findings.push(...validateReplayObservation(observations, caseId));
        } catch { findings.push("FR-DRIVER-MALFORMED-OUTPUT"); }
      }
      if (operation === "stop") break;
    }
  } finally {
    if (!operationHashes.stop) {
      const stop = renderCommand("stop");
      if (stop) await runShellCommand(stop, { cwd: root, timeoutMs: config.timeoutMs, maxOutputBytes: 64 * 1024 });
    }
  }
  if (!observations) findings.push("FR-DRIVER-OBSERVATION-MISSING");
  return { status: findings.length ? "blocked" : "passed", driverId: config.id, operationHashes, observations, findings };
}

function validateReplayObservation(value: ReplayObservation, caseId: string): string[] {
  const findings: string[] = [];
  if (!value || value.caseId !== caseId || !value.fixtureHash) findings.push("FR-DRIVER-CASE-LINEAGE-INVALID");
  if (!value.context || !validateContextEnvelope(value.context).passed) findings.push("FR-DRIVER-CONTEXT-INVALID");
  if (!value.effects || !validateEffectTrace(value.effects).passed || value.effects.fixtureHash !== value.fixtureHash) findings.push("FR-DRIVER-EFFECTS-INVALID");
  if (!Array.isArray(value.decisions) || !Array.isArray(value.events) || !value.state || value.http === undefined || value.concurrency === undefined || value.failures === undefined) findings.push("FR-DRIVER-DIMENSION-MISSING");
  if (!value.cleanup?.passed) findings.push("FR-DRIVER-CLEANUP-UNPROVEN");
  return findings;
}

export interface ReplayDifference { dimension: ObservationDimension; code: string; message: string; classification: "accidental" | "unresolved" | "intentional"; evidence?: string }
export interface StatefulReplayComparison { status: "passed" | "failed"; caseId: string; differences: ReplayDifference[]; comparedDimensions: ObservationDimension[]; comparisonHash: string }

export function compareStatefulReplay(source: ReplayObservation, target: ReplayObservation, normalization: { generatedIds?: Record<string, string>; timestamps?: Record<string, string>; classifications?: Record<string, { classification: ReplayDifference["classification"]; evidence?: string }> } = {}): StatefulReplayComparison {
  const dimensions: ObservationDimension[] = ["http", "context", "decisions", "effects", "state", "events", "concurrency", "failures"];
  const differences: ReplayDifference[] = [];
  if (source.fixtureHash !== target.fixtureHash) differences.push(diff("failures", "FR-REPLAY-FIXTURE-MISMATCH", "Source and target fixture hashes differ"));
  if (!source.cleanup.passed || !target.cleanup.passed) differences.push(diff("state", "FR-REPLAY-CLEANUP-FAILED", "Fixture cleanup was not proven"));
  for (const dimension of dimensions) {
    const left = normalizeObservation(dimensionValue(source, dimension), normalization);
    const right = normalizeObservation(dimensionValue(target, dimension), normalization);
    if (stableHash(left) !== stableHash(right)) differences.push(diff(dimension, `FR-REPLAY-${dimension.toUpperCase()}-DRIFT`, `${dimension} observations differ`));
  }
  const terminalCount = (value: ReplayObservation) => value.events.filter((event) => event.terminal).length;
  if (terminalCount(source) !== 1 || terminalCount(target) !== 1) differences.push(diff("events", "FR-REPLAY-TERMINAL-CARDINALITY", "Each replay requires exactly one terminal event"));
  for (const difference of differences) {
    const review = normalization.classifications?.[difference.code];
    if (review?.classification === "intentional" && !review.evidence) {
      difference.classification = "unresolved";
    } else if (review) {
      difference.classification = review.classification; difference.evidence = review.evidence;
    }
  }
  const base = { status: differences.some((item) => item.classification !== "intentional") ? "failed" as const : "passed" as const, caseId: source.caseId, differences, comparedDimensions: dimensions };
  return { ...base, comparisonHash: stableHash(base) };
}

function diff(dimension: ObservationDimension, code: string, message: string): ReplayDifference { return { dimension, code, message, classification: "accidental" }; }
function dimensionValue(value: ReplayObservation, dimension: ObservationDimension): unknown { return value[dimension]; }
function normalizeObservation(value: unknown, rules: { generatedIds?: Record<string, string>; timestamps?: Record<string, string> }): unknown {
  let text = stableStringify(redactSecrets(value));
  for (const [from, to] of Object.entries({ ...rules.generatedIds, ...rules.timestamps })) text = text.replaceAll(from, to);
  return JSON.parse(text) as unknown;
}

export type ScheduleKind = "manual-manual" | "auto-auto" | "manual-before-auto" | "auto-before-manual" | "batch-inflight";
export interface ConcurrencySchedule { kind: ScheduleKind; steps: Array<{ actor: string; barrier: string; action: "acquire" | "invoke" | "release" | "crash" | "expire" }> }
export interface ScheduleResult { passed: boolean; executions: number; eventStreams: number; effects: string[]; blockedActors: string[]; leaseReleased: boolean }

export type RefreshMode = "manual" | "auto";
export interface Lease { owner: string; mode: RefreshMode; fencingToken: number; expiresAtTick: number }
export class DeterministicRefreshCoordinator {
  private tick = 0; private token = 0; private lease?: Lease;
  acquire(owner: string, mode: RefreshMode, ttlTicks: number): { acquired: boolean; lease?: Lease; preempted?: string } {
    this.expireIfNeeded();
    if (!this.lease) return { acquired: true, lease: this.grant(owner, mode, ttlTicks) };
    if (mode === "manual" && this.lease.mode === "auto") {
      const preempted = this.lease.owner; return { acquired: true, lease: this.grant(owner, mode, ttlTicks), preempted };
    }
    return { acquired: false };
  }
  heartbeat(owner: string, fencingToken: number, ttlTicks: number): boolean {
    this.expireIfNeeded();
    if (!this.lease || this.lease.owner !== owner || this.lease.fencingToken !== fencingToken) return false;
    this.lease.expiresAtTick = this.tick + ttlTicks; return true;
  }
  release(owner: string, fencingToken: number): boolean {
    if (!this.lease || this.lease.owner !== owner || this.lease.fencingToken !== fencingToken) return false;
    this.lease = undefined; return true;
  }
  crash(_owner: string): void { /* Lease remains until deterministic expiry. */ }
  advance(ticks: number): void { this.tick += Math.max(0, ticks); this.expireIfNeeded(); }
  current(): Lease | undefined { this.expireIfNeeded(); return this.lease ? { ...this.lease } : undefined; }
  private grant(owner: string, mode: RefreshMode, ttlTicks: number): Lease { this.lease = { owner, mode, fencingToken: ++this.token, expiresAtTick: this.tick + ttlTicks }; return { ...this.lease }; }
  private expireIfNeeded(): void { if (this.lease && this.lease.expiresAtTick <= this.tick) this.lease = undefined; }
}

export type RefreshFaultPoint = "progress-publish" | "sync" | "timestamp-update" | "undo-clear" | "reconcile";
export interface FaultReplayResult { point: RefreshFaultPoint; result: "success" | "failed"; committedPhases: string[]; retryable: boolean; terminalEvents: number; effects: ExecutionEffect[] }
export function replayRefreshFault(point: RefreshFaultPoint): FaultReplayResult {
  const phases: Array<{ name: string; kind: EffectKind; policy: ExecutionEffect["errorPolicy"] }> = [
    { name: "progress-publish", kind: "progress", policy: "retryable" }, { name: "sync", kind: "database", policy: "result-affecting" },
    { name: "timestamp-update", kind: "database", policy: "result-affecting" }, { name: "undo-clear", kind: "undo", policy: "result-affecting" },
    { name: "reconcile", kind: "reconcile", policy: "ignored" }
  ];
  const effects: ExecutionEffect[] = []; const committedPhases: string[] = [];
  for (const [index, phase] of phases.entries()) {
    if (phase.name === point) {
      effects.push({ kind: phase.kind, phase: phase.name, sequence: effects.length + 1, resourceKey: "panel:fixture", operation: phase.name, outcome: phase.policy === "ignored" ? "ignored-failure" : "failed", errorPolicy: phase.policy, logicalTimestamp: `t${index + 1}` });
      if (phase.policy !== "ignored") return { point, result: "failed", committedPhases, retryable: phase.policy === "retryable", terminalEvents: 1, effects };
      continue;
    }
    effects.push({ kind: phase.kind, phase: phase.name, sequence: effects.length + 1, resourceKey: "panel:fixture", operation: phase.name, outcome: "applied", errorPolicy: phase.policy, logicalTimestamp: `t${index + 1}` });
    committedPhases.push(phase.name);
  }
  return { point, result: "success", committedPhases, retryable: false, terminalEvents: 1, effects };
}

export function replayConcurrencySchedule(schedule: ConcurrencySchedule): ScheduleResult {
  let owner: string | undefined; let executions = 0; let eventStreams = 0; let batch = schedule.kind === "batch-inflight"; const blockedActors: string[] = []; const effects: string[] = [];
  for (const step of schedule.steps) {
    if (step.action === "acquire") {
      if (batch || owner) blockedActors.push(step.actor); else owner = step.actor;
    } else if (step.action === "invoke" && owner === step.actor && !batch) {
      executions += 1; eventStreams += 1; effects.push("sync", "timestamp", "undo", "reconcile", "progress");
    } else if (step.action === "release" && owner === step.actor) owner = undefined;
    else if (step.action === "crash" && owner === step.actor) owner = step.actor;
    else if (step.action === "expire") { owner = undefined; batch = false; }
  }
  const expectedExecutions = schedule.kind === "batch-inflight" ? 0 : 1;
  return { passed: executions === expectedExecutions && eventStreams === expectedExecutions, executions, eventStreams, effects, blockedActors, leaseReleased: owner === undefined };
}

export interface FullReplacementEvidence {
  routeMatched: boolean; closure: FullReplacementClosure; contextsPassed: boolean; statefulComparisons: StatefulReplayComparison[];
  concurrencyPassed: boolean; faultReplayPassed: boolean; sourceOff: { sourceUnavailable: boolean; targetHealthy: boolean; callbacksToJava: number };
  performance?: ReplayObservation["performance"]; performanceBudget?: { minThroughput: number; maxP95Ms: number; maxP99Ms: number; maxMemoryMb: number; maxErrorRate: number };
  rollback?: { target: string; triggers: string[]; reviewedAt: string }; evidenceCreatedAt: string; maxEvidenceAgeMs: number;
}
export interface FullReplacementReadiness { version: 1; status: "ready" | "blocked"; achievedLevel: "FR0" | "FR1" | "FR2" | "FR3" | "FR4" | "FR5"; levels: Array<{ level: "FR1" | "FR2" | "FR3" | "FR4" | "FR5"; passed: boolean; findings: string[] }>; issuePlan: Array<{ id: string; level: string; finding: string; title: string }>; nextAction?: string }

export function evaluateFullReplacementReadiness(evidence: FullReplacementEvidence, now = Date.now()): FullReplacementReadiness {
  const performancePassed = Boolean(evidence.performance && evidence.performanceBudget && evidence.performance.throughput >= evidence.performanceBudget.minThroughput && evidence.performance.p95Ms <= evidence.performanceBudget.maxP95Ms && evidence.performance.p99Ms <= evidence.performanceBudget.maxP99Ms && evidence.performance.memoryMb <= evidence.performanceBudget.maxMemoryMb && evidence.performance.errorRate <= evidence.performanceBudget.maxErrorRate);
  const fresh = now - Date.parse(evidence.evidenceCreatedAt) <= evidence.maxEvidenceAgeMs;
  const levels: FullReplacementReadiness["levels"] = [
    { level: "FR1", passed: evidence.routeMatched, findings: evidence.routeMatched ? [] : ["FR1-TARGET-ROUTE-MISSING"] },
    { level: "FR2", passed: evidence.closure.status === "passed" && evidence.contextsPassed, findings: [...(evidence.closure.status === "passed" ? [] : ["FR2-CLOSURE-BLOCKED"]), ...(evidence.contextsPassed ? [] : ["FR2-CONTEXT-BLOCKED"])] },
    { level: "FR3", passed: evidence.statefulComparisons.length > 0 && evidence.statefulComparisons.every((item) => item.status === "passed"), findings: evidence.statefulComparisons.length > 0 && evidence.statefulComparisons.every((item) => item.status === "passed") ? [] : ["FR3-STATEFUL-PARITY-BLOCKED"] },
    { level: "FR4", passed: evidence.concurrencyPassed && evidence.faultReplayPassed, findings: [...(evidence.concurrencyPassed ? [] : ["FR4-CONCURRENCY-BLOCKED"]), ...(evidence.faultReplayPassed ? [] : ["FR4-FAULT-BLOCKED"])] },
    { level: "FR5", passed: evidence.sourceOff.sourceUnavailable && evidence.sourceOff.targetHealthy && evidence.sourceOff.callbacksToJava === 0 && performancePassed && fresh && Boolean(evidence.rollback?.target && evidence.rollback.triggers.length && evidence.rollback.reviewedAt), findings: [
      ...(!evidence.sourceOff.sourceUnavailable ? ["FR5-SOURCE-STILL-AVAILABLE"] : []), ...(!evidence.sourceOff.targetHealthy ? ["FR5-TARGET-UNHEALTHY"] : []), ...(evidence.sourceOff.callbacksToJava ? ["FR5-JAVA-CALLBACK"] : []), ...(performancePassed ? [] : ["FR5-PERFORMANCE-BUDGET"]), ...(fresh ? [] : ["FR5-EVIDENCE-STALE"]), ...(evidence.rollback?.target && evidence.rollback.triggers.length && evidence.rollback.reviewedAt ? [] : ["FR5-ROLLBACK-PLAN-MISSING"])
    ] }
  ];
  let achieved: FullReplacementReadiness["achievedLevel"] = "FR0";
  for (const level of levels) { if (!level.passed) break; achieved = level.level; }
  const first = levels.find((level) => !level.passed);
  const issuePlan = levels.flatMap((level) => level.findings.map((finding) => ({ id: `fr-issue-${finding.toLowerCase()}`, level: level.level, finding, title: `Resolve ${finding} for ${level.level}` })));
  return { version: 1, status: achieved === "FR5" ? "ready" : "blocked", achievedLevel: achieved, levels, issuePlan, nextAction: first ? `Resolve ${first.findings[0]} before ${first.level}` : undefined };
}

export interface RefreshSyncPilotPlan { version: 1; endpoint: { method: "POST"; path: string }; requiredCases: string[]; requiredSchedules: ScheduleKind[]; requiredFaults: string[]; requiredDimensions: ObservationDimension[]; sourceOffRequired: true; status: "ready-to-run" | "blocked"; blockers: string[] }
export function createRefreshSyncPilotPlan(input: { javaRoot?: string; rustRoot?: string }): RefreshSyncPilotPlan {
  const blockers = [...(!input.javaRoot ? ["MG201-JAVA-ROOT-MISSING"] : []), ...(!input.rustRoot ? ["MG201-RUST-ROOT-MISSING"] : [])];
  return {
    version: 1, endpoint: { method: "POST", path: "/zboss/data/view/dynamic/engine/use/engine-use-page/refreshSync" },
    requiredCases: ["manual-refresh-success", "auto-refresh-incremental", "missing-id-resolution", "batch-inflight-skip", "duplicate-refresh-dedup", "progress-event-shape", "sync-boundary-timestamp", "manual-post-side-effects", "tenant-context", "user-context", "datasource-context"],
    requiredSchedules: ["manual-manual", "auto-auto", "manual-before-auto", "auto-before-manual", "batch-inflight"],
    requiredFaults: ["progress-publish", "sync", "timestamp-update", "undo-clear", "reconcile"], requiredDimensions: ["http", "context", "decisions", "effects", "state", "events", "concurrency", "failures"], sourceOffRequired: true,
    status: blockers.length ? "blocked" : "ready-to-run", blockers
  };
}

export interface RefreshSyncPilotEvidence { readinessEvidence: FullReplacementEvidence; scheduleResults: Partial<Record<ScheduleKind, ScheduleResult>>; faultResults: Partial<Record<RefreshFaultPoint, FaultReplayResult>> }
export interface RefreshSyncPilotReport { version: 1; status: "passed" | "blocked"; readiness: FullReplacementReadiness; caseCoverage: { required: string[]; observed: string[]; missing: string[] }; scheduleCoverage: { missing: ScheduleKind[] }; faultCoverage: { missing: RefreshFaultPoint[] }; findings: string[] }
export function evaluateRefreshSyncPilot(plan: RefreshSyncPilotPlan, evidence: RefreshSyncPilotEvidence, now = Date.now()): RefreshSyncPilotReport {
  const readiness = evaluateFullReplacementReadiness(evidence.readinessEvidence, now);
  const observed = [...new Set(evidence.readinessEvidence.statefulComparisons.filter((item) => item.status === "passed").map((item) => item.caseId))].sort();
  const missingCases = plan.requiredCases.filter((id) => !observed.includes(id));
  const missingSchedules = plan.requiredSchedules.filter((kind) => !evidence.scheduleResults[kind]?.passed);
  const missingFaults = plan.requiredFaults.filter((point) => {
    const result = evidence.faultResults[point as RefreshFaultPoint]; return !result || result.terminalEvents !== 1;
  }) as RefreshFaultPoint[];
  const findings = [...plan.blockers, ...missingCases.map((id) => `MG201-CASE-MISSING:${id}`), ...missingSchedules.map((id) => `MG201-SCHEDULE-MISSING:${id}`), ...missingFaults.map((id) => `MG201-FAULT-MISSING:${id}`), ...(readiness.status === "ready" ? [] : ["MG201-FR5-BLOCKED"])];
  return { version: 1, status: findings.length ? "blocked" : "passed", readiness, caseCoverage: { required: plan.requiredCases, observed, missing: missingCases }, scheduleCoverage: { missing: missingSchedules }, faultCoverage: { missing: missingFaults }, findings };
}

export async function writeFullReplacementArtifact(name: string, value: unknown, dir: string, markdown: string): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = path.join(dir, `${name}.json`); const markdownPath = path.join(dir, `${name}.md`);
  await writeJsonFile(jsonPath, value); await writeTextFile(markdownPath, markdown); return { jsonPath, markdownPath };
}
export function renderFullReplacementClosure(value: FullReplacementClosure): string { return ["# Full Replacement Closure", "", `- Status: ${value.status}`, `- Hash: ${value.manifestHash}`, `- Blocking findings: ${value.summary.blocking}`, "", "## Findings", "", ...(value.findings.length ? value.findings.map((item) => `- [${item.code}] ${item.message}`) : ["No blocking findings."]), "", "## Nodes", "", ...value.nodes.map((node) => `- [${node.classification}] ${node.source.symbol} (${node.source.file}:${node.source.line})`)].join("\n"); }
export function renderFullReplacementReadiness(value: FullReplacementReadiness): string { return ["# Full Replacement Readiness", "", `- Status: ${value.status}`, `- Achieved: ${value.achievedLevel}`, "", ...value.levels.map((level) => `- [${level.passed ? "passed" : "blocked"}] ${level.level}${level.findings.length ? `: ${level.findings.join(", ")}` : ""}`), "", value.nextAction ? `Next action: ${value.nextAction}` : "All FR gates passed."].join("\n"); }

function redactSecrets(value: unknown, key = ""): unknown {
  if (key !== "authorizationClaims" && SECRET_KEY.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name)]));
  if (typeof value === "string" && /^(?:Bearer\s+|eyJ)[A-Za-z0-9._-]+/i.test(value)) return "<redacted>";
  return value;
}
function stableHash(value: unknown): string { return sha256(stableStringify(value)); }
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
