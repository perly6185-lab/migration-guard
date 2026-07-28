import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { JavaEndpointAnalysisReport, JavaEndpointCallGraphNode, JavaSqlSourceInfo } from "./javaEndpointAnalysis.js";
import type {
  BehaviorGraph,
  BehaviorClassificationCoverage,
  BehaviorClassificationSource,
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
import { classifyJavaSemanticPackagesWithTrace } from "./javaSemanticPackages.js";

const CONTEXT_SIGNALS: Array<[RegExp, string, string]> = [
  [/tenant/i, "tenant", "tenant context"],
  [/security|user|auth/i, "user", "security context"],
  [/datasource/i, "datasource", "data source routing"],
  [/request|webframework|http/i, "request", "request context"],
  [/device/i, "device", "device context"],
  [/locale|timezone/i, "locale", "locale/timezone context"]
];

export interface BehaviorClassificationRule {
  id: string;
  symbolPattern: string;
  behavior: BehaviorKind;
  reason: string;
}

interface BehaviorClassificationResult {
  kind: BehaviorKind;
  reasons: string[];
  source: BehaviorClassificationSource;
  strength: "authoritative" | "heuristic" | "inferred" | "unresolved";
  ruleId?: string;
  ruleOrigin?: "generic-builtin" | "reviewed-compatibility" | "project";
  packageId?: string;
  packageVersion?: string;
}

export function createBehaviorGraphFromJava(
  report: JavaEndpointAnalysisReport,
  projectRules: BehaviorClassificationRule[] = [],
  semanticPackageIds?: string[]
): BehaviorGraph {
  if (!report.selectedRoute) throw new Error("A selected Java route is required to create a behavior graph.");
  const entryId = report.callGraph.nodes.find((node) => node.route?.path === report.endpoint.path)?.id
    ?? report.callGraph.nodes[0]?.id;
  const nodes = report.callGraph.nodes.map((node) =>
    classifyNode(node, node.id === entryId, projectRules, semanticPackageIds)
  );
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
  const classificationCoverage = createBehaviorClassificationCoverage(nodes);
  const findings = [
    ...(truncation.edgeCapHit ? ["RP-GRAPH-EDGE-CAP"] : []),
    ...(truncation.depthCapHit ? ["RP-GRAPH-DEPTH-CAP"] : []),
    ...(truncation.perMethodCallCapHit ? ["RP-GRAPH-PER-METHOD-CALL-CAP"] : []),
    ...(truncation.unexpandedBoundaryNodes.length ? ["RP-GRAPH-UNEXPANDED-NODES"] : []),
    ...(unresolvedCalls ? ["RP-GRAPH-UNRESOLVED-EDGES"] : []),
    ...(ambiguousEdges ? ["RP-GRAPH-AMBIGUOUS-CALLS"] : []),
    ...(findRiskyTransactionSelfInvocations(report).length ? ["RP-GRAPH-TRANSACTION-SELF-INVOCATION"] : []),
    ...(sqlSources.some(dynamicSqlNeedsReplayContract) ? ["RP-SQL-DYNAMIC-SOURCE"] : []),
    ...(sqlSources.some((source) => sqlTableResolution(source) === "unresolved") ? ["RP-SQL-TABLE-UNRESOLVED"] : []),
    ...(missingSqlContracts.has("table-expansion") ? ["RP-SQL-MISSING-TABLE-EXPANSION"] : []),
    ...(missingSqlContracts.has("branch-fixture") ? ["RP-SQL-MISSING-BRANCH-FIXTURE"] : []),
    ...(missingSqlContracts.has("provider-fragment") ? ["RP-SQL-MISSING-PROVIDER-FRAGMENT"] : []),
    ...(missingSqlContracts.has("routing-contract") ? ["RP-SQL-MISSING-ROUTING-CONTRACT"] : []),
    ...(sqlSources.some((source) => source.source === "base-mapper" && !source.generatedContract) ? ["RP-SQL-BASE-MAPPER-GENERATED"] : []),
    ...(!truncation.edgeCapHit && !truncation.depthCapHit && truncation.unexpandedBoundaryNodes.length === 0
      && report.callGraph.nodes.some((node) => node.role === "mapper" && node.signature?.includes("[abstract-declaration]") && !sqlSources.some((source) => source.ownerClassName === node.className && source.ownerMethodName === node.methodName))
      ? ["RP-REPOSITORY-GENERATED-IMPLEMENTATION"]
      : []),
    ...(sqlSources.some((source) => source.source === "provider") ? ["RP-SQL-PROVIDER-SOURCE"] : []),
    ...(classificationCoverage.highRiskUnknownNodeIds.length > 0 ? ["RP-GRAPH-HIGH-RISK-UNCLASSIFIED"] : [])
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
    },
    classificationCoverage
  };
  return { ...base, graphHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export interface TransactionSelfInvocationEvidence {
  edge: string;
  source: string;
  target: string;
  sourceTransaction: string;
  targetTransaction: string;
  reason: "requires-new-boundary-bypassed" | "transaction-attributes-bypassed" | "transaction-boundary-bypassed";
}

const REVIEWED_EQUIVALENT_TRANSACTION_SELF_CALLS = new Set([
  "ViewDynamicFieldCountIndexDataServiceImpl.ensureIndexRecord -> ViewDynamicFieldCountIndexDataServiceImpl.createViewDynamicFieldCountIndexData",
  "AiEmpowerConfigBizServiceImpl.saveAiEmpowerConfig -> AiEmpowerConfigBizServiceImpl.deleteByFieldId"
]);

export function findRiskyTransactionSelfInvocations(
  report: JavaEndpointAnalysisReport,
  options: { equivalentTransactions?: "all" | "reviewed-only" } = {}
): TransactionSelfInvocationEvidence[] {
  const nodesById = new Map(report.callGraph.nodes.map((node) => [node.id, node]));
  const findings: TransactionSelfInvocationEvidence[] = [];
  for (const edge of report.callGraph.edges) {
    if (edge.resolution !== "same-class" || !edge.to) continue;
    const target = nodesById.get(edge.to);
    const targetTransaction = transactionAnnotation(target);
    if (!target || !targetTransaction) continue;
    const source = nodesById.get(edge.from);
    const sourceTransaction = transactionAnnotation(source);
    const requiresNew = /REQUIRES_NEW/.test(targetTransaction);
    const sourceSymbol = source ? `${source.className}.${source.methodName}` : edge.from;
    const targetSymbol = `${target.className}.${target.methodName}`;
    const sameTransactionAttributes = sourceTransaction === targetTransaction;
    const equivalent = !requiresNew && sameTransactionAttributes;
    const reviewedEquivalent = sameTransactionAttributes
      && REVIEWED_EQUIVALENT_TRANSACTION_SELF_CALLS.has(`${sourceSymbol} -> ${targetSymbol}`);
    if (reviewedEquivalent
      || (equivalent && options.equivalentTransactions !== "reviewed-only")) continue;
    const reason = requiresNew
      ? "requires-new-boundary-bypassed" as const
      : sourceTransaction
        ? "transaction-attributes-bypassed" as const
        : "transaction-boundary-bypassed" as const;
    findings.push({
      edge: `${sourceSymbol} -> ${targetSymbol}`,
      source: sourceSymbol,
      target: targetSymbol,
      sourceTransaction: sourceTransaction ?? "none",
      targetTransaction,
      reason
    });
  }
  return findings.sort((a, b) => a.edge.localeCompare(b.edge) || a.reason.localeCompare(b.reason));
}

function transactionAnnotation(node: JavaEndpointCallGraphNode | undefined): string | undefined {
  if (!node?.signature) return undefined;
  const methodStart = node.signature.lastIndexOf(`${node.methodName}(`);
  if (methodStart < 0) return undefined;
  const annotationPrefix = node.signature.slice(node.signature.lastIndexOf("}", methodStart) + 1, methodStart);
  return annotationPrefix.match(/@Transactional(?:\([^)]*\))?/)?.[0].replace(/\s+/g, " ");
}

function dynamicSqlNeedsReplayContract(source: JavaSqlSourceInfo): boolean {
  return source.dynamic && (source.operation === "unknown" || sqlTableResolution(source) === "unresolved" || (source.ownershipEvidence?.missingContracts.length ?? 0) > 0);
}

function sqlTableResolution(source: JavaSqlSourceInfo): "resolved" | "tableless" | "statement-expansion" | "unresolved" {
  if (source.tables.length > 0) return "resolved";
  if ((source.ownershipEvidence?.statementExpansionCases.length ?? 0) > 0) return "statement-expansion";
  if (/\bselect\s+(?:(?:last_insert_id|database|current_schema|current_database|version)\s*\(|@@)/i.test(source.statement ?? "")) return "tableless";
  return "unresolved";
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

function classifyNode(
  node: JavaEndpointCallGraphNode,
  entry: boolean,
  projectRules: BehaviorClassificationRule[],
  semanticPackageIds?: string[]
): BehaviorNode {
  const text = `${node.className}.${node.methodName} ${node.file} ${node.signature ?? ""}`;
  const result = entry
    ? {
      kind: "entrypoint" as const,
      reasons: ["selected endpoint entry"],
      source: "entrypoint" as const,
      strength: "authoritative" as const,
      ruleId: "selected-endpoint"
    }
    : classifyBehavior(text, node.role ?? node.kind, projectRules, semanticPackageIds);
  const { kind, reasons } = result;
  const highRisk = isHighRiskBehavior(kind) || isPotentialHighRiskSource(node);
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
    reasons,
    classification: {
      source: result.source,
      strength: result.strength,
      explainable: result.source !== "unresolved",
      highRisk,
      ruleId: result.ruleId,
      ruleOrigin: result.ruleOrigin,
      packageId: result.packageId,
      packageVersion: result.packageVersion
    }
  };
}

function classifyBehavior(
  text: string,
  sourceKind: string,
  projectRules: BehaviorClassificationRule[],
  semanticPackageIds?: string[]
): BehaviorClassificationResult {
  for (const rule of projectRules) {
    if (new RegExp(rule.symbolPattern).test(text)) {
      return {
        kind: rule.behavior,
        reasons: [rule.reason, `project semantic rule ${rule.id}`],
        source: "project-rule",
        strength: "authoritative",
        ruleId: rule.id,
        ruleOrigin: "project",
        packageId: "migration-project-semantic-rules",
        packageVersion: "1"
      };
    }
  }
  const semantic = classifyJavaSemanticPackagesWithTrace(text, semanticPackageIds);
  if (semantic) {
    return {
      kind: semantic.rule.kind,
      reasons: [semantic.rule.reason, `registry ${semantic.rule.id}`],
      source: "semantic-package",
      strength: "authoritative",
      ruleId: semantic.ruleId,
      ruleOrigin: semantic.origin,
      packageId: semantic.packageId,
      packageVersion: semantic.packageVersion
    };
  }
  const rules: Array<[string, BehaviorKind, RegExp, string]> = [
    ["decision-keyword", "decision", /(^|\.)(?:is|has|should|can|allow|resolve|filter|match)[A-Z_]|filterConditions|predicate/i, "branch decision"],
    ["calculation-keyword", "calculation", /calculate|compute|derive|convert|assemble|build|map|normalize|fill|evaluate|copyProperties|BeanUtils|CommonResult|success|(^|\.)to[A-Z]|\.init[A-Z].*(?:DO|VO|BO|DTO|Req|Resp)/i, "deterministic transformation"]
  ];
  for (const [ruleId, kind, pattern, reason] of rules) {
    if (pattern.test(text)) {
      return {
        kind,
        reasons: [reason, `source kind ${sourceKind}`],
        source: "generic-heuristic",
        strength: "heuristic",
        ruleId
      };
    }
  }
  if (sourceKind === "assembler" || sourceKind === "mapper" || sourceKind === "support") {
    return roleClassification("calculation", sourceKind, `${sourceKind} role`);
  }
  if (sourceKind === "policy") return roleClassification("decision", sourceKind, "policy role");
  if (sourceKind === "coordinator") return roleClassification("coordination", sourceKind, "coordination role");
  if (sourceKind === "adapter" || sourceKind === "infrastructure-client") {
    return roleClassification("external-call", sourceKind, `${sourceKind} role`);
  }
  return {
    kind: "unknown",
    reasons: [`unclassified source kind ${sourceKind}`],
    source: "unresolved",
    strength: "unresolved"
  };
}

function roleClassification(kind: BehaviorKind, sourceKind: string, reason: string): BehaviorClassificationResult {
  return {
    kind,
    reasons: [reason, "role inference"],
    source: "role-inference",
    strength: "inferred",
    ruleId: `role-${sourceKind}`
  };
}

export function createBehaviorClassificationCoverage(nodes: BehaviorNode[]): BehaviorClassificationCoverage {
  const highRisk = nodes.filter((node) => node.classification?.highRisk);
  const explainable = nodes.filter((node) => node.classification?.explainable);
  const authoritative = nodes.filter((node) => node.classification?.strength === "authoritative");
  const highRiskExplainable = highRisk.filter((node) => node.classification?.explainable);
  const highRiskAuthoritative = highRisk.filter((node) => node.classification?.strength === "authoritative");
  return {
    version: 1,
    totalNodes: nodes.length,
    explainableNodes: explainable.length,
    explainablePercent: coveragePercent(explainable.length, nodes.length),
    authoritativeNodes: authoritative.length,
    authoritativePercent: coveragePercent(authoritative.length, nodes.length),
    highRiskNodes: highRisk.length,
    highRiskExplainableNodes: highRiskExplainable.length,
    highRiskExplainablePercent: coveragePercent(highRiskExplainable.length, highRisk.length),
    highRiskAuthoritativeNodes: highRiskAuthoritative.length,
    highRiskAuthoritativePercent: coveragePercent(highRiskAuthoritative.length, highRisk.length),
    unknownNodeIds: nodes.filter((node) => node.kind === "unknown").map((node) => node.id).sort(),
    highRiskUnknownNodeIds: highRisk
      .filter((node) => !node.classification?.explainable)
      .map((node) => node.id)
      .sort(),
    bySource: summarizeClassification(nodes, (node) => node.classification?.source ?? "unresolved")
      .map(([source, values]) => ({ source: source as BehaviorClassificationSource, ...values })),
    byStrength: summarizeClassification(nodes, (node) => node.classification?.strength ?? "unresolved")
      .map(([strength, values]) => ({
        strength: strength as "authoritative" | "heuristic" | "inferred" | "unresolved",
        ...values
      })),
    byBehavior: summarizeClassification(nodes, (node) => node.kind)
      .map(([behavior, values]) => ({ behavior: behavior as BehaviorKind, ...values })),
    byPackage: summarizePackages(nodes),
    bySourceKind: summarizeSourceKinds(nodes)
  };
}

function summarizeClassification(
  nodes: BehaviorNode[],
  keyOf: (node: BehaviorNode) => string
): Array<[string, { nodes: number; highRiskNodes: number }]> {
  const values = new Map<string, { nodes: number; highRiskNodes: number }>();
  for (const node of nodes) {
    const key = keyOf(node);
    const current = values.get(key) ?? { nodes: 0, highRiskNodes: 0 };
    current.nodes += 1;
    if (node.classification?.highRisk) current.highRiskNodes += 1;
    values.set(key, current);
  }
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function summarizeSourceKinds(nodes: BehaviorNode[]): BehaviorClassificationCoverage["bySourceKind"] {
  const values = new Map<string, { nodes: number; highRiskNodes: number; unknownNodes: number }>();
  for (const node of nodes) {
    const current = values.get(node.sourceKind) ?? { nodes: 0, highRiskNodes: 0, unknownNodes: 0 };
    current.nodes += 1;
    if (node.classification?.highRisk) current.highRiskNodes += 1;
    if (node.kind === "unknown") current.unknownNodes += 1;
    values.set(node.sourceKind, current);
  }
  return [...values.entries()]
    .map(([sourceKind, counts]) => ({ sourceKind, ...counts }))
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind));
}

function summarizePackages(nodes: BehaviorNode[]): BehaviorClassificationCoverage["byPackage"] {
  const packages = new Map<string, BehaviorNode[]>();
  for (const node of nodes) {
    const classification = node.classification;
    if (classification?.source !== "semantic-package" || !classification.packageId) continue;
    const values = packages.get(classification.packageId) ?? [];
    values.push(node);
    packages.set(classification.packageId, values);
  }
  return [...packages.entries()]
    .map(([packageId, packageNodes]) => ({
      packageId,
      packageVersion: packageNodes[0]?.classification?.packageVersion ?? "unknown",
      nodes: packageNodes.length,
      highRiskNodes: packageNodes.filter((node) => node.classification?.highRisk).length,
      ruleHits: summarizeClassification(packageNodes, (node) => node.classification?.ruleId ?? "unknown")
        .map(([ruleId, values]) => ({ ruleId, ...values }))
    }))
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
}

function isHighRiskBehavior(kind: BehaviorKind): boolean {
  return [
    "context-resolution",
    "state-write",
    "external-call",
    "transaction",
    "event-publish",
    "compensation",
    "clock-read",
    "coordination",
    "async-boundary"
  ].includes(kind);
}

function isPotentialHighRiskSource(node: JavaEndpointCallGraphNode): boolean {
  if (node.kind === "repository" || node.kind === "mapper") return true;
  if (["adapter", "infrastructure-client", "coordinator"].includes(node.role ?? "")) return true;
  return /(?:Client|Gateway|Repository|Mapper|Publisher|Producer|Consumer|Scheduler|Executor|Cache|Lock|Transaction)/i
    .test(`${node.className}.${node.methodName}`);
}

function coveragePercent(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : Number((numerator * 100 / denominator).toFixed(2));
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
  if (report.goldenCasePlan.model === "mutation-command") return "command";
  if (report.goldenCasePlan.model === "page-query") {
    const mutations = nodes.filter((node) => node.kind === "state-write" || node.kind === "transaction").length;
    const queryEntrypoint = `${report.endpoint.path} ${entry}`;
    if (mutations > 0 && /(?:^|[\/._\s-])(?:page|list|search|query|find|select|get)(?:$|[\/._\sA-Z-])/i.test(queryEntrypoint)) {
      return "query-with-effects";
    }
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
  if (node.kind === "compensation") return "undo";
  if (node.kind === "clock-read") return "clock";
  if (node.kind === "observability") return "audit";
  if (node.kind === "coordination") return /cache|redis/i.test(text) ? "cache" : "lock";
  if (node.kind === "async-boundary") return "event";
  if (node.kind === "event-publish") return "event";
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
