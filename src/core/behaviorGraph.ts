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
  FrameworkRequirement,
  DataContractRequirement,
  StateRequirement
} from "./endpointReplacementModel.js";
import { classifyJavaSemantic } from "./javaSemanticRegistry.js";

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
  const unresolvedCalls = report.callGraph.edges.filter((edge) => edge.resolution === "unresolved").length;
  const ambiguousEdges = report.callGraph.edges.filter((edge) => edge.resolution === "ambiguous").length;
  const unresolvedEdges = unresolvedCalls + ambiguousEdges;
  const truncation = report.callGraph.truncation;
  const sqlSources = report.sqlSources ?? [];
  const missingSqlContracts = new Set(sqlSources.flatMap((source) => source.ownershipEvidence?.missingContracts ?? []));
  const findings = [
    ...(truncation.edgeCapHit ? ["RP-GRAPH-EDGE-CAP"] : []),
    ...(truncation.depthCapHit ? ["RP-GRAPH-DEPTH-CAP"] : []),
    ...(truncation.unexpandedBoundaryNodes.length ? ["RP-GRAPH-UNEXPANDED-NODES"] : []),
    ...(unresolvedCalls ? ["RP-GRAPH-UNRESOLVED-EDGES"] : []),
    ...(ambiguousEdges ? ["RP-GRAPH-AMBIGUOUS-CALLS"] : []),
    ...(report.callGraph.edges.some((edge) => edge.resolution === "same-class" && nodes.find((node) => node.id === edge.to)?.evidence.detail?.includes("@Transactional")) ? ["RP-GRAPH-TRANSACTION-SELF-INVOCATION"] : []),
    ...(sqlSources.some((source) => source.dynamic) ? ["RP-SQL-DYNAMIC-SOURCE"] : []),
    ...(missingSqlContracts.has("table-expansion") ? ["RP-SQL-MISSING-TABLE-EXPANSION"] : []),
    ...(missingSqlContracts.has("branch-fixture") ? ["RP-SQL-MISSING-BRANCH-FIXTURE"] : []),
    ...(missingSqlContracts.has("provider-fragment") ? ["RP-SQL-MISSING-PROVIDER-FRAGMENT"] : []),
    ...(missingSqlContracts.has("routing-contract") ? ["RP-SQL-MISSING-ROUTING-CONTRACT"] : []),
    ...(sqlSources.some((source) => source.source === "base-mapper" && !source.generatedContract) ? ["RP-SQL-BASE-MAPPER-GENERATED"] : []),
    ...(sqlSources.some((source) => source.source === "provider") ? ["RP-SQL-PROVIDER-SOURCE"] : [])
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
  const framework = deriveFramework(report, graph);
  const data = deriveDataContracts(report, graph);
  return {
    contexts,
    states,
    effects,
    framework,
    data,
    contractHash: sha256(stableStringify({ contexts, states, effects, framework, data }))
  };
}

function classifyNode(node: JavaEndpointCallGraphNode, entry: boolean): BehaviorNode {
  const text = `${node.className}.${node.methodName} ${node.file} ${node.signature ?? ""}`;
  const [kind, reasons] = entry ? ["entrypoint" as const, ["selected endpoint entry"]] : classifyBehavior(text, node.role ?? node.kind);
  const stateful = ["state-read", "state-write", "transaction", "compensation", "coordination"].includes(kind);
  const sideEffecting = ["state-write", "external-call", "transaction", "event-publish", "compensation", "observability", "clock-read", "coordination", "async-boundary"].includes(kind);
  return {
    id: node.id,
    kind,
    sourceKind: node.kind,
    sourceRole: node.role,
    evidence: { file: node.file, line: node.line, symbol: `${node.className}.${node.methodName}`, detail: node.signature },
    stateful,
    sideEffecting,
    confidence: kind === "unknown" ? "low" : reasons.length > 1 ? "high" : "medium",
    reasons
  };
}

function classifyBehavior(text: string, sourceKind: string): [BehaviorKind, string[]] {
  const semantic = classifyJavaSemantic(text);
  if (semantic) return [semantic.kind, [semantic.reason, `registry ${semantic.id}`]];
  const rules: Array<[BehaviorKind, RegExp, string]> = [
    ["compensation", /undo|rollback|reconcile|compensat|restore/i, "compensation semantics"],
    ["transaction", /transaction|commit|unitofwork/i, "transaction boundary"],
    ["event-publish", /publish|emit|event|progress|notify/i, "event publication"],
    ["validation", /validat|assert|check|required|unique|permission/i, "validation or policy check"],
    ["context-resolution", /tenant|security|auth|datasource|requestcontext|webframework|device|locale|SecurityFramework/i, "runtime context access"],
    ["external-call", /client|\bapi\.|gateway|adapter|storage|fileApi|http|rpc/i, "external service boundary"],
    ["state-write", /\bddl\b|create\s+table|alter\s+table|drop\s+table|truncate\s+table/i, "database schema mutation"],
    ["state-write", /insert|save|create|update|delete|remove|clear|write|upsert|persist|record|set|lock|acquire|cancel|terminate|submit|enable|disable|approve|reject|archive/i, "state mutation"],
    ["state-read", /select|query|find|get|list|load|read|count|exists/i, "state lookup"],
    ["external-call", /repository|mapper|cache|upload|download|file/i, "external or infrastructure boundary"],
    ["decision", /(^|\.)(is|has|should|can|allow|resolve)[A-Z_]/, "branch decision"],
    ["calculation", /calculate|compute|derive|convert|assemble|build|map|normalize|fill|evaluate|copyProperties|BeanUtils|CommonResult|success/i, "deterministic transformation"]
  ];
  for (const [kind, pattern, reason] of rules) if (pattern.test(text)) return [kind, [reason, `source kind ${sourceKind}`]];
  if (sourceKind === "assembler" || sourceKind === "mapper" || sourceKind === "support") return ["calculation", [`${sourceKind} role`, "role inference"]];
  if (sourceKind === "policy") return ["decision", ["policy role", "role inference"]];
  if (sourceKind === "coordinator") return ["coordination", ["coordination role", "role inference"]];
  if (sourceKind === "adapter" || sourceKind === "infrastructure-client") return ["external-call", [`${sourceKind} role`, "role inference"]];
  return ["unknown", [`unclassified source kind ${sourceKind}`]];
}

function inferWorkload(report: JavaEndpointAnalysisReport, nodes: BehaviorNode[]): EndpointWorkloadKind {
  const entry = `${report.selectedRoute?.methodName ?? ""} ${report.selectedRoute?.signature ?? ""}`;
  if (/batch|bulk|chunk/i.test(entry) && nodes.some((node) => node.sideEffecting)) return "batch";
  if (/refresh.*sync|synchronize|sync(?:By|With|Data|Record|Task)/i.test(entry) && nodes.some((node) => node.sideEffecting)) return "sync";
  if (/upload|import/i.test(entry) && nodes.some((node) => node.kind === "external-call" || node.kind === "state-write")) return "upload";
  if (/export|download|stream/i.test(entry)) return "export";
  if (/start|submit|enqueue|dispatch|schedule/i.test(entry) && nodes.some((node) => node.kind === "event-publish" || node.kind === "state-write")) return "async-job";
  if (/cancel|enable|disable|archive|restore/i.test(entry) && nodes.some((node) => node.sideEffecting)) return "idempotent-command";
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
    ...graph.nodes.map((node) => node.evidence.detail ?? "").filter((detail) => /contexts=|tenant|datasource|transaction/i.test(detail)),
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
    existing.transactional ||= node.kind === "transaction" || /transactional=true|@Transactional/i.test(node.evidence.detail ?? "");
    values.set(resource, existing);
  }
  return [...values.values()].map((item) => ({
    ...item,
    operations: [...new Set(item.operations)].sort() as StateRequirement["operations"],
    consumers: [...new Set(item.consumers)].sort()
  })).sort((a, b) => a.resource.localeCompare(b.resource));
}

function deriveEffects(graph: BehaviorGraph): EffectRequirement[] {
  return reachableNodes(graph).filter((node) => node.sideEffecting).map((node, sequence) => ({
    kind: effectKindFor(node),
    operation: node.evidence.symbol,
    sourceNode: node.id,
    orderingRequired: node.kind !== "external-call",
    compensationRequired: node.kind === "state-write" || node.kind === "transaction",
    sequence: sequence + 1,
    failurePolicy: failurePolicyFor(node)
  }));
}

function reachableNodes(graph: BehaviorGraph): BehaviorNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const entry = graph.nodes.find((node) => node.kind === "entrypoint");
  if (!entry) return graph.nodes;
  const result: BehaviorNode[] = [];
  const queue = [entry.id];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    queue.push(...graph.edges.filter((edge) => edge.from === id && edge.to).map((edge) => edge.to as string).sort());
  }
  result.push(...graph.nodes.filter((node) => !visited.has(node.id)));
  return result;
}

function failurePolicyFor(node: BehaviorNode): EffectRequirement["failurePolicy"] {
  if (node.kind === "compensation") return "compensate";
  if (/retry/i.test(node.evidence.symbol)) return "retry";
  if (/audit|notify/i.test(node.evidence.symbol)) return "ignore";
  return node.confidence === "low" ? "unknown" : "fail";
}

function deriveFramework(report: JavaEndpointAnalysisReport | undefined, graph: BehaviorGraph): FrameworkRequirement[] {
  if (!report?.selectedRoute) return [];
  const annotations = report.selectedRoute.annotations ?? [];
  const signature = report.selectedRoute.signature;
  const values: FrameworkRequirement[] = [];
  const add = (kind: FrameworkRequirement["kind"], evidence: string) => values.push({ kind, evidence, required: true });
  if (annotations.some((item) => /@Valid|@Validated/.test(item)) || /@Valid\b/.test(signature)) add("validation", "Jakarta/Spring validation");
  if (annotations.some((item) => /PreAuthorize|Secured|RolesAllowed|PermitAll/.test(item))) add("authorization", "method authorization annotation");
  if (annotations.some((item) => /OperationLog|Audit/.test(item))) add("audit", "operation audit annotation");
  if (annotations.some((item) => /Transactional/.test(item)) || graph.nodes.some((node) => node.kind === "transaction") || (report.sqlSources ?? []).some((source) => source.transactional)) add("transaction", "transaction boundary");
  if (/MultipartFile|FileReq|multipart/i.test(signature)) add("multipart", "multipart request binding");
  if (/CommonResult|ResponseEntity|HttpServletResponse/.test(signature)) add("response-envelope", "HTTP response envelope");
  if (graph.nodes.some((node) => /exception|throw/i.test(node.evidence.symbol))) add("exception-mapping", "exception-to-response mapping");
  return values.sort((a, b) => a.kind.localeCompare(b.kind));
}

function deriveDataContracts(report: JavaEndpointAnalysisReport | undefined, graph: BehaviorGraph): DataContractRequirement[] {
  if (!report?.selectedRoute) return [];
  const signature = report.selectedRoute.signature;
  const returnType = signature.match(/^(?:public|protected|private)?\s*(?:static\s+)?(.+?)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/)?.[1]?.trim() ?? "unknown";
  const mappingText = graph.nodes.map((node) => node.evidence.symbol).join(" ");
  const mapping: DataContractRequirement["mapping"] = /copyProperties|BeanUtils/i.test(mappingText) ? "bean-copy" : /convert|map|assemble|to[A-Z]/.test(mappingText) ? "conversion" : "direct";
  return [
    ...(report.requestModel ? [{ direction: "request" as const, type: report.requestModel.className, fields: report.requestModel.fields, mapping }] : []),
    { direction: "response" as const, type: returnType, fields: [], mapping }
  ];
}

function resourceFor(node: BehaviorNode): string {
  const text = `${node.evidence.symbol} ${node.evidence.file}`;
  if (/cache|redis/i.test(text)) return "cache";
  if (/lock|registry|lease/i.test(text)) return "coordination";
  if (/undo/i.test(text)) return "undo";
  if (/event|progress|publish/i.test(text)) return "event-stream";
  if (node.kind === "coordination") return "coordination";
  if (/repository|mapper|table|sql|data/i.test(text)) return "database";
  return "application-state";
}

function effectKindFor(node: BehaviorNode): EffectRequirement["kind"] {
  const text = `${node.evidence.symbol} ${node.evidence.file}`;
  if (/undo/i.test(text)) return "undo";
  if (node.kind === "clock-read") return "clock";
  if (node.kind === "observability") return "audit";
  if (node.kind === "coordination") return /cache|redis/i.test(text) ? "cache" : "lock";
  if (node.kind === "async-boundary") return "event";
  if (/event|publish|progress|notify/i.test(text)) return "event";
  if (/cache|redis/i.test(text)) return "cache";
  if (/lock|lease|registry/i.test(text)) return "lock";
  if (/sequence|rownum|number/i.test(text)) return "sequence";
  if (node.kind === "transaction") return "transaction";
  if (node.kind === "external-call") return "external";
  if (node.kind === "state-write" || /repository|mapper|table|sql|data/i.test(text)) return "database";
  if (/audit/i.test(text)) return "audit";
  return "unknown";
}
