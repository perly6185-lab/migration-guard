import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { JavaEndpointAnalysisReport } from "./javaEndpointAnalysis.js";
import { createBehaviorGraphFromJava, deriveReplacementContracts } from "./behaviorGraph.js";
import type {
  BehaviorGraph,
  EndpointReplacementEvidence,
  EndpointReplacementPlan,
  EndpointReplacementReadiness,
  ReplacementBoundaryCandidate,
  ReplacementImplementationWave,
  ReplacementOwnership,
  ReplacementScenario
} from "./endpointReplacementModel.js";

export interface EndpointReplacementPlanOptions {
  ownership?: Record<string, ReplacementOwnership>;
}

export interface EndpointPilotPlan {
  version: 1;
  endpoint: EndpointReplacementPlan["endpoint"];
  sourceRoot?: string;
  targetRoot?: string;
  requiredScenarios: string[];
  requiredDimensions: ReplacementScenario["requiredDimensions"];
  requiredCapabilities: string[];
  sourceOffRequired: true;
  status: "ready-to-run" | "blocked";
  blockers: string[];
  planHash: string;
}

export function createEndpointReplacementPlan(
  graph: BehaviorGraph,
  options: EndpointReplacementPlanOptions = {},
  sourceReport?: JavaEndpointAnalysisReport
): EndpointReplacementPlan {
  const contracts = deriveReplacementContracts(graph, sourceReport);
  const boundaries = createBoundaries(graph, options.ownership ?? {});
  const scenarios = synthesizeReplacementScenarios(graph, sourceReport);
  const waves = createImplementationWaves(boundaries, contracts.contexts.length > 0);
  const findings = [
    ...graph.completeness.findings,
    ...boundaries.flatMap((boundary) => boundary.blockers),
    ...(contracts.effects.some((effect) => effect.kind === "unknown") ? ["RP-CONTRACT-UNKNOWN-EFFECT"] : [])
  ].sort();
  const blocked = !graph.completeness.complete;
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    endpoint: graph.endpoint,
    workload: graph.workload,
    status: blocked ? "blocked" as const : "ready" as const,
    behaviorGraphHash: graph.graphHash,
    contracts,
    boundaries,
    scenarios,
    waves,
    findings,
    nextAction: blocked ? graph.completeness.findings[0] : boundaries.find((item) => !item.executable)?.blockers[0]
  };
  return { ...base, planHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function createEndpointReplacementPlanFromJava(
  report: JavaEndpointAnalysisReport,
  options: EndpointReplacementPlanOptions = {}
): { graph: BehaviorGraph; plan: EndpointReplacementPlan } {
  const graph = createBehaviorGraphFromJava(report);
  return { graph, plan: createEndpointReplacementPlan(graph, options, report) };
}

export function synthesizeReplacementScenarios(graph: BehaviorGraph, report?: JavaEndpointAnalysisReport): ReplacementScenario[] {
  const dimensions: ReplacementScenario["requiredDimensions"] = ["http", "context", "decisions", "effects", "state", "events", "failures"];
  const scenarios = new Map<string, ReplacementScenario>();
  addScenario(scenarios, {
    id: "primary-success",
    title: "Primary successful execution",
    category: "success",
    sourceNodes: graph.nodes.map((node) => node.id),
    requiredDimensions: dimensions,
    reason: "Every endpoint requires one complete successful replay."
  });
  for (const item of report?.goldenCasePlan.cases ?? []) {
    addScenario(scenarios, {
      id: item.id,
      title: item.title,
      category: categoryForText(`${item.id} ${item.title} ${item.requestFocus.join(" ")}`),
      sourceNodes: graph.nodes.filter((node) => matchesScenarioNode(node.evidence.symbol, item.requestFocus)).map((node) => node.id),
      requiredDimensions: dimensions,
      reason: item.reason
    });
  }
  if (graph.nodes.some((node) => node.kind === "validation")) addGeneratedScenario(scenarios, graph, "validation-failure", "Validation rejection", "validation", "Validation behavior must match before target ownership.");
  if (graph.nodes.some((node) => node.kind === "context-resolution")) addGeneratedScenario(scenarios, graph, "context-isolation", "Runtime context isolation", "context", "Ambient context must become explicit and isolated.");
  if (graph.nodes.some((node) => node.kind === "decision")) addGeneratedScenario(scenarios, graph, "branch-coverage", "Decision branch coverage", "branch", "Every reachable decision requires positive and negative evidence.");
  if (graph.nodes.some((node) => node.kind === "state-write" || node.kind === "transaction")) {
    addGeneratedScenario(scenarios, graph, "concurrent-write", "Concurrent state mutation", "concurrency", "State mutation requires deterministic conflict behavior.");
    addGeneratedScenario(scenarios, graph, "transaction-failure", "Transaction failure and rollback", "fault", "Partial writes and rollback must be observable.");
  }
  if (graph.nodes.some((node) => node.kind === "external-call" || node.kind === "event-publish")) addGeneratedScenario(scenarios, graph, "dependency-failure", "External dependency failure", "fault", "Dependency failure policy must be replayed.");
  if (report && report.matches.length > 1) addGeneratedScenario(scenarios, graph, "entrypoint-parity", "Parallel entrypoint parity", "compatibility", "Equivalent entrypoints require compatible results.");
  addGeneratedScenario(scenarios, graph, "scale-boundary", "Scale and performance boundary", "scale", "Target execution must meet an explicit resource budget.", ["performance"]);
  return [...scenarios.values()].map((item) => ({ ...item, sourceNodes: [...new Set(item.sourceNodes)].sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

export function evaluateEndpointReplacementReadiness(evidence: EndpointReplacementEvidence, now = Date.now()): EndpointReplacementReadiness {
  const fresh = Number.isFinite(Date.parse(evidence.evidenceCreatedAt))
    && now >= Date.parse(evidence.evidenceCreatedAt)
    && now - Date.parse(evidence.evidenceCreatedAt) <= evidence.maxEvidenceAgeMs;
  const levels: EndpointReplacementReadiness["levels"] = [
    { level: "RP1", passed: evidence.graphComplete, findings: evidence.graphComplete ? [] : ["RP1-GRAPH-INCOMPLETE"] },
    { level: "RP2", passed: evidence.contractsComplete, findings: evidence.contractsComplete ? [] : ["RP2-CONTRACTS-INCOMPLETE"] },
    { level: "RP3", passed: evidence.ownershipComplete, findings: evidence.ownershipComplete ? [] : ["RP3-OWNERSHIP-INCOMPLETE"] },
    { level: "RP4", passed: evidence.replayPassed, findings: evidence.replayPassed ? [] : ["RP4-REPLAY-BLOCKED"] },
    { level: "RP5", passed: evidence.concurrencyPassed && evidence.faultPassed && evidence.performancePassed, findings: [
      ...(evidence.concurrencyPassed ? [] : ["RP5-CONCURRENCY-BLOCKED"]),
      ...(evidence.faultPassed ? [] : ["RP5-FAULT-BLOCKED"]),
      ...(evidence.performancePassed ? [] : ["RP5-PERFORMANCE-BLOCKED"])
    ] },
    { level: "RP6", passed: evidence.sourceOffPassed && evidence.rollbackPassed && fresh, findings: [
      ...(evidence.sourceOffPassed ? [] : ["RP6-SOURCE-OFF-BLOCKED"]),
      ...(evidence.rollbackPassed ? [] : ["RP6-ROLLBACK-BLOCKED"]),
      ...(fresh ? [] : ["RP6-EVIDENCE-STALE"])
    ] }
  ];
  let achieved: EndpointReplacementReadiness["achievedLevel"] = "RP0";
  for (const level of levels) { if (!level.passed) break; achieved = level.level; }
  const issuePlan = levels.flatMap((level) => level.findings.map((finding) => ({
    id: `rp-${finding.toLowerCase()}`,
    level: level.level,
    finding,
    title: `Resolve ${finding} for ${level.level}`
  })));
  const first = levels.find((level) => !level.passed);
  return {
    version: 1,
    status: achieved === "RP6" ? "ready" : "blocked",
    achievedLevel: achieved,
    levels,
    issuePlan,
    nextAction: first ? `Resolve ${first.findings[0]} before ${first.level}.` : undefined
  };
}

export function createEndpointPilotPlan(
  plan: EndpointReplacementPlan,
  roots: { sourceRoot?: string; targetRoot?: string }
): EndpointPilotPlan {
  const blockers = [
    ...(!roots.sourceRoot ? ["RP-PILOT-SOURCE-ROOT-MISSING"] : []),
    ...(!roots.targetRoot ? ["RP-PILOT-TARGET-ROOT-MISSING"] : []),
    ...(plan.status === "blocked" ? ["RP-PILOT-PLAN-BLOCKED"] : [])
  ];
  const requiredDimensions = [...new Set(plan.scenarios.flatMap((scenario) => scenario.requiredDimensions))].sort() as ReplacementScenario["requiredDimensions"];
  const requiredCapabilities = [
    "setup", "start", "health", "seed", "invoke", "snapshot", "collect", "cleanup", "stop",
    ...(plan.scenarios.some((scenario) => scenario.category === "fault") ? ["inject-fault"] : [])
  ];
  const base = {
    version: 1 as const,
    endpoint: plan.endpoint,
    sourceRoot: roots.sourceRoot,
    targetRoot: roots.targetRoot,
    requiredScenarios: plan.scenarios.map((scenario) => scenario.id),
    requiredDimensions,
    requiredCapabilities,
    sourceOffRequired: true as const,
    status: blockers.length ? "blocked" as const : "ready-to-run" as const,
    blockers
  };
  return { ...base, planHash: sha256(stableStringify(base)) };
}

export function renderEndpointReplacementPlan(plan: EndpointReplacementPlan): string {
  return [
    "# Endpoint Replacement Plan", "",
    `- Endpoint: ${plan.endpoint.method} ${plan.endpoint.path}`,
    `- Workload: ${plan.workload}`,
    `- Status: ${plan.status}`,
    `- Plan hash: ${plan.planHash}`,
    `- Boundaries: ${plan.boundaries.length}`,
    `- Scenarios: ${plan.scenarios.length}`, "",
    "## Boundaries", "",
    ...plan.boundaries.map((item) => `- [${item.ownership}] ${item.title}: ${item.nodeIds.length} node(s)${item.blockers.length ? `; ${item.blockers.join(", ")}` : ""}`), "",
    "## Implementation Waves", "",
    ...plan.waves.map((wave) => `- ${wave.index}. ${wave.title}: ${wave.objective}`), "",
    "## Findings", "",
    ...(plan.findings.length ? plan.findings.map((finding) => `- ${finding}`) : ["- none"]), ""
  ].join("\n");
}

export function renderEndpointReplacementReadiness(readiness: EndpointReplacementReadiness): string {
  return [
    "# Endpoint Replacement Readiness", "",
    `- Status: ${readiness.status}`,
    `- Achieved: ${readiness.achievedLevel}`, "",
    ...readiness.levels.map((level) => `- [${level.passed ? "passed" : "blocked"}] ${level.level}${level.findings.length ? `: ${level.findings.join(", ")}` : ""}`), "",
    readiness.nextAction ?? "All replacement readiness levels passed.", ""
  ].join("\n");
}

function createBoundaries(graph: BehaviorGraph, ownership: Record<string, ReplacementOwnership>): ReplacementBoundaryCandidate[] {
  const groups: Array<{ id: string; title: string; kinds: string[]; proposed: ReplacementOwnership }> = [
    { id: "pure-logic", title: "Pure validation, decisions and calculation", kinds: ["validation", "decision", "calculation"], proposed: "target-owned" },
    { id: "application-orchestration", title: "Entrypoint, context and transaction orchestration", kinds: ["entrypoint", "context-resolution", "transaction"], proposed: "target-owned" },
    { id: "infrastructure", title: "State and external infrastructure", kinds: ["state-read", "state-write", "external-call"], proposed: "infrastructure-port" },
    { id: "observable-effects", title: "Events and compensation", kinds: ["event-publish", "compensation"], proposed: "target-owned" },
    { id: "unclassified", title: "Unclassified behavior", kinds: ["unknown"], proposed: "unresolved" }
  ];
  return groups.flatMap((group) => {
    const nodes = graph.nodes.filter((node) => group.kinds.includes(node.kind));
    if (!nodes.length) return [];
    const explicit = [...new Set(nodes.map((node) => ownership[node.id]).filter(Boolean))];
    const selected = explicit.length === 1 ? explicit[0]! : explicit.length > 1 ? "unresolved" : group.proposed;
    const blockers = [
      ...(selected === "source-owned" ? [`RP-BOUNDARY-SOURCE-OWNED:${group.id}`] : []),
      ...(selected === "unresolved" ? [`RP-BOUNDARY-UNRESOLVED:${group.id}`] : []),
      ...(!graph.completeness.complete ? ["RP-BOUNDARY-GRAPH-INCOMPLETE"] : [])
    ];
    const stateCount = nodes.filter((node) => node.stateful).length;
    const effectCount = nodes.filter((node) => node.sideEffecting).length;
    return [{
      id: group.id,
      title: group.title,
      nodeIds: nodes.map((node) => node.id).sort(),
      ownership: selected,
      benefit: clamp(100 - nodes.length),
      coupling: clamp(graph.edges.filter((edge) => nodes.some((node) => node.id === edge.from || node.id === edge.to)).length),
      stateRisk: clamp(stateCount * 15),
      effectRisk: clamp(effectCount * 15),
      executable: blockers.length === 0,
      blockers
    }];
  });
}

function createImplementationWaves(boundaries: ReplacementBoundaryCandidate[], hasContexts: boolean): ReplacementImplementationWave[] {
  const byId = new Map(boundaries.map((boundary) => [boundary.id, boundary]));
  const specs = [
    { title: "Make runtime contracts explicit", objective: "Replace ambient context and implicit effects with explicit contracts.", ids: ["application-orchestration"], evidence: ["context-contract", "effect-contract"] },
    { title: "Move deterministic behavior", objective: "Port validation, decisions and calculation behind parity tests.", ids: ["pure-logic"], evidence: ["unit-parity", "branch-coverage"] },
    { title: "Introduce infrastructure ports", objective: "Isolate state and external systems behind target-neutral ports.", ids: ["infrastructure"], evidence: ["port-contracts", "state-fixtures"] },
    { title: "Move orchestration and observable effects", objective: "Transfer transaction, event and compensation ownership.", ids: ["application-orchestration", "observable-effects"], evidence: ["stateful-replay", "fault-replay"] },
    { title: "Cut over and prove source-off", objective: "Route directly to the target and execute rollback drills.", ids: boundaries.map((item) => item.id), evidence: ["performance", "source-off", "rollback"] }
  ];
  return specs.map((spec, index) => ({
    index: index + 1,
    title: spec.title,
    objective: spec.objective,
    boundaryIds: [...new Set(spec.ids.filter((id) => byId.has(id)))],
    requiredEvidence: [...spec.evidence, ...(index === 0 && hasContexts ? ["ambient-context-elimination"] : [])],
    rollbackBoundary: index < 3 ? "source endpoint remains authoritative" : index === 3 ? "route-level fallback to source" : "reviewed production rollback plan"
  }));
}

function addGeneratedScenario(
  target: Map<string, ReplacementScenario>,
  graph: BehaviorGraph,
  id: string,
  title: string,
  category: ReplacementScenario["category"],
  reason: string,
  extra: ReplacementScenario["requiredDimensions"] = []
): void {
  const kinds: Record<ReplacementScenario["category"], string[]> = {
    success: [], validation: ["validation"], context: ["context-resolution"], branch: ["decision"],
    concurrency: ["state-write", "transaction"], fault: ["state-write", "external-call", "transaction", "event-publish", "compensation"],
    compatibility: ["entrypoint"], scale: graph.nodes.map((node) => node.kind)
  };
  addScenario(target, {
    id, title, category,
    sourceNodes: graph.nodes.filter((node) => kinds[category].includes(node.kind)).map((node) => node.id),
    requiredDimensions: [...new Set(["http", "context", "decisions", "effects", "state", "events", "failures", ...extra])] as ReplacementScenario["requiredDimensions"],
    reason
  });
}

function addScenario(target: Map<string, ReplacementScenario>, scenario: ReplacementScenario): void {
  const existing = target.get(scenario.id);
  if (!existing) target.set(scenario.id, scenario);
  else target.set(scenario.id, {
    ...existing,
    sourceNodes: [...existing.sourceNodes, ...scenario.sourceNodes],
    requiredDimensions: [...new Set([...existing.requiredDimensions, ...scenario.requiredDimensions])] as ReplacementScenario["requiredDimensions"]
  });
}

function categoryForText(text: string): ReplacementScenario["category"] {
  if (/tenant|user|context|auth|datasource/i.test(text)) return "context";
  if (/invalid|missing|required|validation/i.test(text)) return "validation";
  if (/concurrent|duplicate|batch|lock|lease/i.test(text)) return "concurrency";
  if (/failure|fault|timeout|rollback|undo|reconcile/i.test(text)) return "fault";
  if (/entrypoint|compat|rpc/i.test(text)) return "compatibility";
  if (/large|scale|performance|page/i.test(text)) return "scale";
  if (/branch|operator|condition/i.test(text)) return "branch";
  return "success";
}

function matchesScenarioNode(symbol: string, focus: string[]): boolean {
  const words = focus.join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
  const lower = symbol.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
