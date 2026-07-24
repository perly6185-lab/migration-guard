import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer, type AdaptiveExpansionTopology } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import type { BehaviorGraph, EndpointWorkloadKind } from "./endpointReplacementModel.js";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

export interface ServiceRustAssessmentOptions {
  root: string;
  maxDepth?: number;
  maxEdges?: number;
  limit?: number;
  includeTests?: boolean;
  adaptive?: boolean;
  maxExpansionDepth?: number;
  maxExpansionEdges?: number;
  maxExpansionRounds?: number;
}

export type UnclassifiedBoundaryCategory = "business-helper" | "value-object-factory" | "context-coordination" | "residual";

export interface HighFanoutDiagnostics {
  maxOutDegree: number;
  callCapNodes: number;
  omittedCalls: number;
  outDegreeDistribution: Record<string, number>;
  repeatedSubgraphGroups: number;
  repeatedSubgraphNodes: number;
  maxRepeatedSubgraphMultiplicity: number;
  stronglyConnectedComponents: number;
  cyclicStronglyConnectedComponents: number;
  cyclicNodes: number;
  largestStronglyConnectedComponent: number;
  amplificationSignals: Array<"per-method-call-cap-saturated" | "repeated-outgoing-shape" | "cyclic-scc">;
  assessment: "likely-genuine" | "mixed" | "likely-analyzer-amplified";
}

export interface ServiceMethodAssessment {
  id: string;
  file: string;
  line: number;
  service: string;
  method: string;
  signature: string;
  workload: EndpointWorkloadKind;
  status: "ready" | "blocked";
  nodes: number;
  edges: number;
  externalBoundaries: number;
  unknownNodes: number;
  unclassifiedCategories: UnclassifiedBoundaryCategory[];
  unclassifiedSymbols: string[];
  contexts: number;
  frameworkContracts: number;
  dataContracts: number;
  effects: number;
  roles: string[];
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
  highFanoutDiagnostics?: HighFanoutDiagnostics;
}

export interface ServiceRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: ServiceRustAssessmentOptions;
  serviceMethodCount: number;
  assessedCount: number;
  summary: {
    ready: number;
    blocked: number;
    truncated: number;
    withUnknownNodes: number;
    withExternalBoundaries: number;
    adaptivelyExpanded: number;
    expansionBudgetExhausted: number;
    expansionTopologies: Record<string, number>;
    unclassifiedCategories: Record<string, number>;
    unclassifiedSymbols: Record<string, number>;
    workloads: Record<string, number>;
    findings: Record<string, number>;
    roles: Record<string, number>;
    highFanoutDiagnostics: {
      methods: number;
      assessments: Record<string, number>;
      maxOutDegreeBuckets: Record<string, number>;
      maxOutDegrees: Record<string, number>;
      repeatedSubgraphGroups: Record<string, number>;
      cyclicSccs: Record<string, number>;
      largestSccs: Record<string, number>;
      withRepeatedSubgraphs: number;
      withCyclicSccs: number;
      withPerMethodCallCapSaturation: number;
      totalCallCapNodes: number;
      totalOmittedCalls: number;
    };
  };
  methods: ServiceMethodAssessment[];
  reportHash: string;
}

export async function assessJavaServicesForRust(options: ServiceRustAssessmentOptions): Promise<ServiceRustAssessmentReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const sourceIdentity = await captureAssessmentSourceIdentity(analyzer.root);
  const candidates = analyzer.serviceMethods.slice(0, positiveLimit(options.limit, analyzer.serviceMethods.length));
  const methods = candidates.map((candidate): ServiceMethodAssessment => {
    const expansion = options.adaptive ? analyzer.analyzeServiceMethodAdaptive(candidate, {
      initialDepth: options.maxDepth,
      initialEdges: options.maxEdges,
      maxDepth: options.maxExpansionDepth,
      maxEdges: options.maxExpansionEdges,
      maxRounds: options.maxExpansionRounds
    }) : undefined;
    const source = expansion?.report ?? analyzer.analyzeServiceMethod(candidate, { maxDepth: options.maxDepth, maxEdges: options.maxEdges });
    const { graph, plan } = createEndpointReplacementPlanFromJava(source);
    const highFanoutDiagnostics = expansion?.topology === "high-fanout" ? diagnoseHighFanout(graph, source.callGraph.truncation) : undefined;
    const unknownNodes = graph.nodes.filter((node) => node.kind === "unknown");
    const unclassifiedCategories = [...new Set(unknownNodes.map(classifyUnclassifiedBoundary))].sort();
    const unclassifiedSymbols = [...new Set(unknownNodes.map((node) => node.evidence.symbol).filter(Boolean))].sort();
    return {
      id: candidate.id,
      file: candidate.file,
      line: candidate.line,
      service: candidate.qualifiedClassName,
      method: candidate.methodName,
      signature: candidate.signature,
      workload: graph.workload,
      status: plan.status,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externalBoundaries: graph.nodes.filter((node) => node.id.startsWith("external:")).length,
      unknownNodes: unknownNodes.length,
      unclassifiedCategories,
      unclassifiedSymbols,
      contexts: plan.contracts.contexts.length,
      frameworkContracts: plan.contracts.framework.length,
      dataContracts: plan.contracts.data.length,
      effects: plan.contracts.effects.length,
      roles: [...new Set(graph.nodes.map((node) => node.sourceRole ?? "unknown"))].sort(),
      findings: [...plan.findings, ...(expansion?.status === "budget-exhausted" ? ["RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])],
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length,
      highFanoutDiagnostics
    };
  });
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root: analyzer.root,
    sourceIdentity,
    assessmentScope: { ...options, root: analyzer.root },
    serviceMethodCount: analyzer.serviceMethods.length,
    assessedCount: methods.length,
    summary: {
      ready: methods.filter((item) => item.status === "ready").length,
      blocked: methods.filter((item) => item.status === "blocked").length,
      truncated: methods.filter((item) => item.findings.some((finding) => /GRAPH-(EDGE|DEPTH|UNEXPANDED)/.test(finding))).length,
      withUnknownNodes: methods.filter((item) => item.unknownNodes > 0).length,
      withExternalBoundaries: methods.filter((item) => item.externalBoundaries > 0).length,
      adaptivelyExpanded: methods.filter((item) => (item.expansionRounds ?? 0) > 1).length,
      expansionBudgetExhausted: methods.filter((item) => item.expansionStatus === "budget-exhausted").length,
      expansionTopologies: countValues(methods.map((item) => item.expansionTopology).filter((item): item is AdaptiveExpansionTopology => Boolean(item))),
      unclassifiedCategories: countValues(methods.flatMap((item) => item.unclassifiedCategories)),
      unclassifiedSymbols: countValues(methods.flatMap((item) => item.unclassifiedSymbols)),
      workloads: countValues(methods.map((item) => item.workload)),
      findings: countValues(methods.flatMap((item) => item.findings)),
      roles: countValues(methods.flatMap((item) => item.roles)),
      highFanoutDiagnostics: summarizeHighFanout(methods)
    },
    methods
  };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function renderServiceRustAssessment(report: ServiceRustAssessmentReport): string {
  return [
    "# Service Rust Assessment", "",
    `- Root: ${report.root}`,
    `- Service methods: ${report.serviceMethodCount}`,
    `- Assessed: ${report.assessedCount}`,
    `- Ready: ${report.summary.ready}`,
    `- Blocked: ${report.summary.blocked}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Findings", "",
    ...Object.entries(report.summary.findings).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([finding, count]) => `- ${finding}: ${count}`), "",
    "## Expansion topologies", "",
    ...Object.entries(report.summary.expansionTopologies).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([topology, count]) => `- ${topology}: ${count}`), "",
    "## High-fanout diagnostics", "",
    `- Methods: ${report.summary.highFanoutDiagnostics.methods}`,
    `- With repeated subgraphs: ${report.summary.highFanoutDiagnostics.withRepeatedSubgraphs}`,
    `- With cyclic SCCs: ${report.summary.highFanoutDiagnostics.withCyclicSccs}`,
    `- With per-method call-cap saturation: ${report.summary.highFanoutDiagnostics.withPerMethodCallCapSaturation}`,
    `- Per-method call-cap nodes: ${report.summary.highFanoutDiagnostics.totalCallCapNodes}`,
    `- Omitted calls: ${report.summary.highFanoutDiagnostics.totalOmittedCalls}`,
    ...Object.entries(report.summary.highFanoutDiagnostics.assessments).map(([assessment, count]) => `- Assessment ${assessment}: ${count}`),
    ...Object.entries(report.summary.highFanoutDiagnostics.maxOutDegreeBuckets).map(([bucket, count]) => `- Max out-degree ${bucket}: ${count}`), "",
    `- Exact max out-degree distribution: ${JSON.stringify(report.summary.highFanoutDiagnostics.maxOutDegrees)}`,
    `- Repeated-subgraph group distribution: ${JSON.stringify(report.summary.highFanoutDiagnostics.repeatedSubgraphGroups)}`,
    `- Cyclic-SCC distribution: ${JSON.stringify(report.summary.highFanoutDiagnostics.cyclicSccs)}`,
    `- Largest-SCC distribution: ${JSON.stringify(report.summary.highFanoutDiagnostics.largestSccs)}`, "",
    "## Unclassified boundary categories", "",
    ...Object.entries(report.summary.unclassifiedCategories).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => `- ${category}: ${count}`), "",
    "## Unclassified symbols", "",
    ...Object.entries(report.summary.unclassifiedSymbols).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([symbol, count]) => `- ${symbol}: ${count}`), ""
  ].join("\n");
}

function classifyUnclassifiedBoundary(node: { evidence: { symbol: string; detail?: string }; id: string }): UnclassifiedBoundaryCategory {
  const text = `${node.evidence.symbol} ${node.evidence.detail ?? ""}`;
  if (/\b[A-Za-z0-9_]*Context\.|\b(?:scope|barrier|queue)\./i.test(text)) return "context-coordination";
  if (/\b[A-Z][A-Za-z0-9_]*\.(?:of|from|create|empty|ok|no|failed|skipped|resolve|extract)\b/.test(text)) return "value-object-factory";
  if (/\bprivate\s|\b(?:helper|util|support)\b/i.test(text) || !node.id.startsWith("external:")) return "business-helper";
  return "residual";
}

function diagnoseHighFanout(graph: BehaviorGraph, truncation: { perMethodCallCapNodes?: Array<{ omittedCalls: number }> }): HighFanoutDiagnostics {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, Array<{ to: string; kind: string }>>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to)) outgoing.get(edge.from)?.push({ to: edge.to, kind: edge.kind });
  }
  const degrees = [...outgoing.values()].map((edges) => edges.length);
  const outDegreeDistribution = countValues(degrees.map(String));
  const shapes = new Map<string, number>();
  for (const edges of outgoing.values()) {
    if (edges.length === 0) continue;
    const signature = edges.map((edge) => {
      const target = nodeById.get(edge.to);
      return `${edge.kind}:${target?.kind ?? "unknown"}:${target?.evidence.symbol ?? edge.to}`;
    }).sort().join("|");
    shapes.set(signature, (shapes.get(signature) ?? 0) + 1);
  }
  const repeated = [...shapes.values()].filter((count) => count > 1);
  const components = stronglyConnectedComponents([...nodeIds], outgoing);
  const cyclic = components.filter((component) => component.length > 1 || (outgoing.get(component[0] ?? "") ?? []).some((edge) => edge.to === component[0]));
  const maxRepeatedSubgraphMultiplicity = Math.max(0, ...repeated);
  const largestStronglyConnectedComponent = Math.max(0, ...components.map((component) => component.length));
  const amplificationSignals: HighFanoutDiagnostics["amplificationSignals"] = [
    (truncation.perMethodCallCapNodes?.length ?? 0) > 0 ? "per-method-call-cap-saturated" : undefined,
    repeated.length > 0 ? "repeated-outgoing-shape" : undefined,
    cyclic.length > 0 ? "cyclic-scc" : undefined
  ].filter((signal): signal is HighFanoutDiagnostics["amplificationSignals"][number] => Boolean(signal));
  const strongAmplification = maxRepeatedSubgraphMultiplicity >= 8 || largestStronglyConnectedComponent >= 8;
  return {
    maxOutDegree: Math.max(0, ...degrees),
    callCapNodes: truncation.perMethodCallCapNodes?.length ?? 0,
    omittedCalls: (truncation.perMethodCallCapNodes ?? []).reduce((total, item) => total + item.omittedCalls, 0),
    outDegreeDistribution,
    repeatedSubgraphGroups: repeated.length,
    repeatedSubgraphNodes: repeated.reduce((total, count) => total + count, 0),
    maxRepeatedSubgraphMultiplicity,
    stronglyConnectedComponents: components.length,
    cyclicStronglyConnectedComponents: cyclic.length,
    cyclicNodes: cyclic.reduce((total, component) => total + component.length, 0),
    largestStronglyConnectedComponent,
    amplificationSignals,
    assessment: strongAmplification ? "likely-analyzer-amplified" : amplificationSignals.length > 0 ? "mixed" : "likely-genuine"
  };
}

function stronglyConnectedComponents(nodes: string[], outgoing: Map<string, Array<{ to: string }>>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, nextIndex); lowLinks.set(node, nextIndex); nextIndex += 1; stack.push(node); onStack.add(node);
    for (const edge of outgoing.get(node) ?? []) {
      if (!indices.has(edge.to)) { visit(edge.to); lowLinks.set(node, Math.min(lowLinks.get(node) as number, lowLinks.get(edge.to) as number)); }
      else if (onStack.has(edge.to)) lowLinks.set(node, Math.min(lowLinks.get(node) as number, indices.get(edge.to) as number));
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do { member = stack.pop(); if (member) { onStack.delete(member); component.push(member); } } while (member && member !== node);
    components.push(component);
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components;
}

function summarizeHighFanout(methods: ServiceMethodAssessment[]): ServiceRustAssessmentReport["summary"]["highFanoutDiagnostics"] {
  const diagnostics = methods.map((method) => method.highFanoutDiagnostics).filter((item): item is HighFanoutDiagnostics => Boolean(item));
  return {
    methods: diagnostics.length,
    assessments: countValues(diagnostics.map((item) => item.assessment)),
    maxOutDegreeBuckets: countValues(diagnostics.map((item) => outDegreeBucket(item.maxOutDegree))),
    maxOutDegrees: numericCountValues(diagnostics.map((item) => item.maxOutDegree)),
    repeatedSubgraphGroups: numericCountValues(diagnostics.map((item) => item.repeatedSubgraphGroups)),
    cyclicSccs: numericCountValues(diagnostics.map((item) => item.cyclicStronglyConnectedComponents)),
    largestSccs: numericCountValues(diagnostics.map((item) => item.largestStronglyConnectedComponent)),
    withRepeatedSubgraphs: diagnostics.filter((item) => item.repeatedSubgraphGroups > 0).length,
    withCyclicSccs: diagnostics.filter((item) => item.cyclicStronglyConnectedComponents > 0).length,
    withPerMethodCallCapSaturation: diagnostics.filter((item) => item.amplificationSignals.includes("per-method-call-cap-saturated")).length,
    totalCallCapNodes: diagnostics.reduce((total, item) => total + item.callCapNodes, 0),
    totalOmittedCalls: diagnostics.reduce((total, item) => total + item.omittedCalls, 0)
  };
}

function outDegreeBucket(value: number): string {
  if (value < 32) return "0-31";
  if (value < 64) return "32-63";
  if (value < 128) return "64-127";
  return "128+";
}

function numericCountValues(values: number[]): Record<string, number> {
  return Object.fromEntries(Object.entries(countValues(values.map(String))).sort((a, b) => Number(a[0]) - Number(b[0])));
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}
