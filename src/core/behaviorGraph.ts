import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { JavaEndpointAnalysisReport, JavaEndpointCallGraphNode } from "./javaEndpointAnalysis.js";
import type {
  BehaviorGraph,
  BehaviorKind,
  BehaviorNode,
  ContextRequirement,
  EffectRequirement,
  EndpointReplacementContracts,
  EndpointWorkloadKind,
  StateRequirement
} from "./endpointReplacementModel.js";

const CONTEXT_SIGNALS: Array<[RegExp, string, string]> = [
  [/tenant/i, "tenant", "tenant context"],
  [/security|user|auth/i, "user", "security context"],
  [/datasource/i, "datasource", "data source routing"],
  [/request|webframework|http/i, "request", "request context"],
  [/device/i, "device", "device context"],
  [/locale|timezone/i, "locale", "locale/timezone context"]
];

export function createBehaviorGraphFromJava(report: JavaEndpointAnalysisReport): BehaviorGraph {
  if (!report.selectedRoute) throw new Error("A selected Java route is required to create a behavior graph.");
  const entryId = report.callGraph.nodes.find((node) => node.route?.path === report.endpoint.path)?.id
    ?? report.callGraph.nodes[0]?.id;
  const nodes = report.callGraph.nodes.map((node) => classifyNode(node, node.id === entryId));
  const edges = report.callGraph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edge.to || edge.resolution === "static-or-external" ? "call" as const : "unresolved" as const,
    evidence: {
      file: edge.call.file,
      line: edge.call.line,
      symbol: edge.unresolvedTarget ?? edge.call.expression,
      detail: edge.resolution
    }
  }));
  const unresolvedEdges = report.callGraph.edges.filter((edge) => edge.resolution === "unresolved").length;
  const truncation = report.callGraph.truncation;
  const findings = [
    ...(truncation.edgeCapHit ? ["RP-GRAPH-EDGE-CAP"] : []),
    ...(truncation.depthCapHit ? ["RP-GRAPH-DEPTH-CAP"] : []),
    ...(truncation.unexpandedBoundaryNodes.length ? ["RP-GRAPH-UNEXPANDED-NODES"] : []),
    ...(unresolvedEdges ? ["RP-GRAPH-UNRESOLVED-EDGES"] : [])
  ];
  const workload = inferWorkload(report, nodes);
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    endpoint: {
      runtime: "java",
      method: report.endpoint.method,
      path: report.endpoint.path,
      symbol: `${report.selectedRoute.className}.${report.selectedRoute.methodName}`,
      file: report.selectedRoute.file,
      line: report.selectedRoute.line
    },
    workload,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || (a.to ?? "").localeCompare(b.to ?? "")),
    completeness: {
      complete: findings.length === 0,
      edgeCapHit: truncation.edgeCapHit,
      depthCapHit: truncation.depthCapHit,
      unresolvedEdges,
      unexpandedNodes: [...truncation.unexpandedBoundaryNodes].sort(),
      findings
    }
  };
  return { ...base, graphHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function deriveReplacementContracts(graph: BehaviorGraph, report?: JavaEndpointAnalysisReport): EndpointReplacementContracts {
  const contexts = deriveContexts(graph, report);
  const states = deriveStates(graph);
  const effects = deriveEffects(graph);
  return {
    contexts,
    states,
    effects,
    contractHash: sha256(stableStringify({ contexts, states, effects }))
  };
}

function classifyNode(node: JavaEndpointCallGraphNode, entry: boolean): BehaviorNode {
  const text = `${node.className}.${node.methodName} ${node.file} ${node.signature ?? ""}`;
  const [kind, reasons] = entry ? ["entrypoint" as const, ["selected endpoint entry"]] : classifyBehavior(text, node.kind);
  const stateful = ["state-read", "state-write", "transaction", "compensation"].includes(kind);
  const sideEffecting = ["state-write", "external-call", "transaction", "event-publish", "compensation"].includes(kind);
  return {
    id: node.id,
    kind,
    sourceKind: node.kind,
    evidence: { file: node.file, line: node.line, symbol: `${node.className}.${node.methodName}`, detail: node.signature },
    stateful,
    sideEffecting,
    confidence: kind === "unknown" ? "low" : reasons.length > 1 ? "high" : "medium",
    reasons
  };
}

function classifyBehavior(text: string, sourceKind: string): [BehaviorKind, string[]] {
  const rules: Array<[BehaviorKind, RegExp, string]> = [
    ["compensation", /undo|rollback|reconcile|compensat|restore/i, "compensation semantics"],
    ["transaction", /transaction|commit|unitofwork/i, "transaction boundary"],
    ["event-publish", /publish|emit|event|progress|notify/i, "event publication"],
    ["validation", /validat|assert|check|required|unique|permission/i, "validation or policy check"],
    ["context-resolution", /tenant|security|auth|datasource|requestcontext|webframework|device|locale/i, "runtime context access"],
    ["state-write", /insert|save|create|update|delete|remove|clear|write|upsert|persist|record|set|lock|acquire/i, "state mutation"],
    ["state-read", /select|query|find|get|list|load|read|count|exists/i, "state lookup"],
    ["external-call", /client|rpc|gateway|adapter|repository|mapper|cache/i, "external or infrastructure boundary"],
    ["decision", /(^|\.)(is|has|should|can|allow|resolve)[A-Z_]/, "branch decision"],
    ["calculation", /calculate|compute|derive|convert|assemble|build|map|normalize|fill|evaluate/i, "deterministic transformation"]
  ];
  for (const [kind, pattern, reason] of rules) if (pattern.test(text)) return [kind, [reason, `source kind ${sourceKind}`]];
  return ["unknown", [`unclassified source kind ${sourceKind}`]];
}

function inferWorkload(report: JavaEndpointAnalysisReport, nodes: BehaviorNode[]): EndpointWorkloadKind {
  if (report.goldenCasePlan.model === "batch-command") return "batch";
  if (report.goldenCasePlan.model === "sync-command") return "sync";
  if (report.goldenCasePlan.model === "page-query") {
    const mutations = nodes.filter((node) => node.kind === "state-write" || node.kind === "transaction").length;
    if (nodes.some((node) => node.kind === "compensation") || mutations / Math.max(1, nodes.length) >= 0.2) return "command";
    if (mutations > 0) return "query-with-effects";
    return "query";
  }
  if (nodes.some((node) => node.kind === "state-write" || node.kind === "transaction" || node.kind === "compensation")) return "command";
  return "unknown";
}

function deriveContexts(graph: BehaviorGraph, report?: JavaEndpointAnalysisReport): ContextRequirement[] {
  const values = new Map<string, ContextRequirement>();
  const evidence = [
    ...graph.nodes.filter((node) => node.kind === "context-resolution").map((node) => node.evidence.symbol),
    ...(report?.riskSignals.flatMap((signal) => signal.evidence) ?? [])
  ];
  for (const value of evidence) {
    for (const [pattern, name, provenance] of CONTEXT_SIGNALS) {
      if (!pattern.test(value)) continue;
      const existing = values.get(name) ?? { name, provenance, required: true, consumers: [], source: "ambient" as const };
      existing.consumers.push(value);
      values.set(name, existing);
    }
  }
  return [...values.values()].map((item) => ({ ...item, consumers: [...new Set(item.consumers)].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

function deriveStates(graph: BehaviorGraph): StateRequirement[] {
  const values = new Map<string, StateRequirement>();
  for (const node of graph.nodes.filter((item) => item.stateful)) {
    const resource = resourceFor(node);
    const operation = node.kind === "state-read" ? "read" : /lock|acquire/i.test(node.evidence.symbol) ? "lock" : /delete|clear|remove/i.test(node.evidence.symbol) ? "delete" : "write";
    const existing = values.get(resource) ?? { resource, operations: [], consumers: [], transactional: false };
    existing.operations.push(operation);
    existing.consumers.push(node.id);
    existing.transactional ||= node.kind === "transaction";
    values.set(resource, existing);
  }
  return [...values.values()].map((item) => ({
    ...item,
    operations: [...new Set(item.operations)].sort() as StateRequirement["operations"],
    consumers: [...new Set(item.consumers)].sort()
  })).sort((a, b) => a.resource.localeCompare(b.resource));
}

function deriveEffects(graph: BehaviorGraph): EffectRequirement[] {
  return graph.nodes.filter((node) => node.sideEffecting).map((node) => ({
    kind: effectKindFor(node),
    operation: node.evidence.symbol,
    sourceNode: node.id,
    orderingRequired: node.kind !== "external-call",
    compensationRequired: node.kind === "state-write" || node.kind === "transaction"
  })).sort((a, b) => a.sourceNode.localeCompare(b.sourceNode));
}

function resourceFor(node: BehaviorNode): string {
  const text = `${node.evidence.symbol} ${node.evidence.file}`;
  if (/cache|redis/i.test(text)) return "cache";
  if (/lock|registry|lease/i.test(text)) return "coordination";
  if (/undo/i.test(text)) return "undo";
  if (/event|progress|publish/i.test(text)) return "event-stream";
  if (/repository|mapper|table|sql|data/i.test(text)) return "database";
  return "application-state";
}

function effectKindFor(node: BehaviorNode): EffectRequirement["kind"] {
  const text = `${node.evidence.symbol} ${node.evidence.file}`;
  if (/undo/i.test(text)) return "undo";
  if (/audit|log/i.test(text)) return "audit";
  if (/event|publish|progress|notify/i.test(text)) return "event";
  if (/cache|redis/i.test(text)) return "cache";
  if (/lock|lease|registry/i.test(text)) return "lock";
  if (/sequence|rownum|number/i.test(text)) return "sequence";
  if (node.kind === "transaction") return "transaction";
  if (/repository|mapper|table|sql|data/i.test(text) || node.kind === "state-write") return "database";
  if (node.kind === "external-call") return "external";
  return "unknown";
}
