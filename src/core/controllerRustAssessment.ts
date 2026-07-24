import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import {
  createJavaEndpointAnalyzer,
  type AdaptiveExpansionTopology,
  type JavaEndpointAnalysisReport,
  type JavaEndpointHttpMethod
} from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import { findRiskyTransactionSelfInvocations } from "./behaviorGraph.js";
import type { BehaviorGraph, EndpointWorkloadKind } from "./endpointReplacementModel.js";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";
import { classifyUnclassifiedBoundary, type UnclassifiedBoundaryCategory } from "./serviceRustAssessment.js";

export interface ControllerRustAssessmentOptions {
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

export interface ControllerMethodAssessment {
  method: JavaEndpointHttpMethod;
  path: string;
  file: string;
  line: number;
  handler: string;
  workload: EndpointWorkloadKind;
  status: "ready" | "blocked";
  nodes: number;
  edges: number;
  externalBoundaries: number;
  unknownNodes: number;
  unclassifiedBoundaries: ControllerUnclassifiedBoundaryOccurrence[];
  ambiguousCalls: ControllerAmbiguousCallOccurrence[];
  truncation: ControllerTruncationDiagnostic;
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
  transactionSelfInvocations: string[];
  transactionSelfInvocationReasons: string[];
}

export interface ControllerAmbiguousCallOccurrence {
  expression: string;
  file: string;
  line: number;
  receiver?: string;
  method: string;
  argumentCount?: number;
  argumentTypes: string[];
  candidates: Array<{ methodId: string; signature: string; score: number }>;
}

export interface ControllerAmbiguousCallInventoryItem {
  expression: string;
  sourceLocations: Array<{ file: string; line: number }>;
  methods: string[];
  argumentCounts: number[];
  argumentTypes: string[][];
  candidates: Array<{ methodId: string; signature: string; score: number }>;
  occurrences: number;
  affectedRoutes: string[];
  affectedHandlers: string[];
}

export interface ControllerTruncationDiagnostic {
  edgeCapHit: boolean;
  depthCapHit: boolean;
  perMethodCallCapHit: boolean;
  maxObservedDepth: number;
  maxTotalEdges: number;
  unexpandedBoundaryNodes: string[];
  perMethodCallCapNodes: Array<{ nodeId: string; extractedCalls: number; retainedCalls: number; omittedCalls: number }>;
  omittedCalls: number;
}

export interface ControllerTruncationInventoryItem extends ControllerTruncationDiagnostic {
  route: string;
  handler: string;
  nodes: number;
  edges: number;
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
}

export interface ControllerUnclassifiedBoundaryOccurrence {
  symbol: string;
  file: string;
  line: number;
  category: UnclassifiedBoundaryCategory;
  reason: string;
  depth: number | null;
}

export interface ControllerUnclassifiedBoundaryInventoryItem {
  symbol: string;
  file: string;
  line: number;
  sourceLocations: Array<{ file: string; line: number }>;
  category: UnclassifiedBoundaryCategory;
  reason: string;
  categories: UnclassifiedBoundaryCategory[];
  reasons: string[];
  occurrences: number;
  affectedRoutes: string[];
  affectedHandlers: string[];
  minDepth: number | null;
  maxDepth: number | null;
}

export interface ControllerRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: ControllerRustAssessmentOptions;
  routeCount: number;
  assessedCount: number;
  summary: {
    ready: number;
    blocked: number;
    truncated: number;
    withUnknownNodes: number;
    workloads: Record<string, number>;
    findings: Record<string, number>;
    adaptivelyExpanded: number;
    expansionBudgetExhausted: number;
    expansionTopologies: Record<string, number>;
    transactionSelfInvocationEdges: number;
    transactionSelfInvocationReasons: Record<string, number>;
    unclassifiedBoundaryInventory: {
      occurrences: number;
      uniqueSymbols: number;
      affectedRoutes: number;
      categories: Record<string, number>;
      depths: Record<string, number>;
    };
    ambiguousCallInventory: {
      occurrences: number;
      uniqueExpressions: number;
      affectedRoutes: number;
      candidateCountDistribution: Record<string, number>;
    };
    truncationInventory: {
      routes: number;
      edgeCapRoutes: number;
      depthCapRoutes: number;
      perMethodCallCapRoutes: number;
      unexpandedBoundaryNodes: number;
      omittedCalls: number;
    };
  };
  methods: ControllerMethodAssessment[];
  unclassifiedBoundaryInventory: ControllerUnclassifiedBoundaryInventoryItem[];
  ambiguousCallInventory: ControllerAmbiguousCallInventoryItem[];
  truncationInventory: ControllerTruncationInventoryItem[];
  reportHash: string;
}

export async function assessJavaControllersForRust(options: ControllerRustAssessmentOptions): Promise<ControllerRustAssessmentReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const sourceIdentity = await captureAssessmentSourceIdentity(analyzer.root);
  const routes = analyzer.routes.slice(0, positiveLimit(options.limit, analyzer.routes.length));
  const methods = routes.map((route): ControllerMethodAssessment => {
    const expansion = options.adaptive ? analyzer.analyzeAdaptive({
      endpoint: route.path,
      method: route.method,
      initialDepth: options.maxDepth,
      initialEdges: options.maxEdges,
      maxDepth: options.maxExpansionDepth,
      maxEdges: options.maxExpansionEdges,
      maxRounds: options.maxExpansionRounds
    }) : undefined;
    const source = expansion?.report ?? analyzer.analyze({ endpoint: route.path, method: route.method, maxDepth: options.maxDepth, maxEdges: options.maxEdges });
    const { graph, plan } = createEndpointReplacementPlanFromJava(source);
    const depths = nodeDepths(graph);
    const unclassifiedBoundaries = graph.nodes.filter((node) => node.kind === "unknown").map((node): ControllerUnclassifiedBoundaryOccurrence => ({
      symbol: node.evidence.symbol,
      file: node.evidence.file,
      line: node.evidence.line,
      category: classifyUnclassifiedBoundary(node),
      reason: node.reasons.join("; "),
      depth: depths.get(node.id) ?? null
    })).sort(compareBoundaryOccurrences);
    const ambiguousCalls = source.callGraph.edges.filter((edge) => edge.resolution === "ambiguous").map((edge): ControllerAmbiguousCallOccurrence => ({
      expression: edge.call.expression,
      file: edge.call.file,
      line: edge.call.line,
      receiver: edge.call.receiver,
      method: edge.call.method,
      argumentCount: edge.call.argumentCount,
      argumentTypes: [...(edge.call.argumentTypes ?? [])],
      candidates: [...(edge.resolutionCandidates ?? [])].sort(compareCandidates)
    })).sort(compareAmbiguousOccurrences);
    const truncation = createTruncationDiagnostic(source);
    const transactionSelfInvocations = findRiskyTransactionSelfInvocations(source);
    return {
      method: route.method,
      path: route.path,
      file: route.file,
      line: route.line,
      handler: `${route.className}.${route.methodName}`,
      workload: graph.workload,
      status: plan.status,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externalBoundaries: graph.nodes.filter((node) => node.id.startsWith("external:")).length,
      unknownNodes: unclassifiedBoundaries.length,
      unclassifiedBoundaries,
      ambiguousCalls,
      truncation,
      findings: [...plan.findings, ...(expansion?.status === "budget-exhausted" ? ["RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])],
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length,
      transactionSelfInvocations: [...new Set(transactionSelfInvocations.map((item) => `${item.edge} [${item.sourceTransaction} -> ${item.targetTransaction}]`))],
      transactionSelfInvocationReasons: [...new Set(transactionSelfInvocations.map((item) => item.reason))].sort()
    };
  });
  const unclassifiedBoundaryInventory = aggregateUnclassifiedBoundaries(methods);
  const ambiguousCallInventory = aggregateAmbiguousCalls(methods);
  const truncationInventory = aggregateTruncations(methods);
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root: analyzer.root,
    sourceIdentity,
    assessmentScope: { ...options, root: analyzer.root },
    routeCount: analyzer.routes.length,
    assessedCount: methods.length,
    summary: {
      ready: methods.filter((item) => item.status === "ready").length,
      blocked: methods.filter((item) => item.status === "blocked").length,
      truncated: methods.filter((item) => item.findings.some((finding) => /GRAPH-(EDGE|DEPTH|UNEXPANDED)/.test(finding))).length,
      withUnknownNodes: methods.filter((item) => item.unknownNodes > 0).length,
      workloads: countValues(methods.map((item) => item.workload)),
      findings: countValues(methods.flatMap((item) => item.findings)),
      adaptivelyExpanded: methods.filter((item) => (item.expansionRounds ?? 0) > 1).length,
      expansionBudgetExhausted: methods.filter((item) => item.expansionStatus === "budget-exhausted").length,
      expansionTopologies: countValues(methods.map((item) => item.expansionTopology).filter((item): item is AdaptiveExpansionTopology => Boolean(item))),
      transactionSelfInvocationEdges: new Set(methods.flatMap((item) => item.transactionSelfInvocations)).size,
      transactionSelfInvocationReasons: countValues(methods.flatMap((item) => item.transactionSelfInvocationReasons)),
      unclassifiedBoundaryInventory: {
        occurrences: methods.reduce((total, item) => total + item.unclassifiedBoundaries.length, 0),
        uniqueSymbols: unclassifiedBoundaryInventory.length,
        affectedRoutes: methods.filter((item) => item.unclassifiedBoundaries.length > 0).length,
        categories: countValues(unclassifiedBoundaryInventory.flatMap((item) => item.categories)),
        depths: countValues(methods.flatMap((item) => item.unclassifiedBoundaries).map((item) => item.depth === null ? "unreachable" : String(item.depth)))
      },
      ambiguousCallInventory: {
        occurrences: methods.reduce((total, item) => total + item.ambiguousCalls.length, 0),
        uniqueExpressions: ambiguousCallInventory.length,
        affectedRoutes: methods.filter((item) => item.ambiguousCalls.length > 0).length,
        candidateCountDistribution: countValues(ambiguousCallInventory.map((item) => String(item.candidates.length)))
      },
      truncationInventory: {
        routes: truncationInventory.length,
        edgeCapRoutes: truncationInventory.filter((item) => item.edgeCapHit).length,
        depthCapRoutes: truncationInventory.filter((item) => item.depthCapHit).length,
        perMethodCallCapRoutes: truncationInventory.filter((item) => item.perMethodCallCapHit).length,
        unexpandedBoundaryNodes: truncationInventory.reduce((total, item) => total + item.unexpandedBoundaryNodes.length, 0),
        omittedCalls: truncationInventory.reduce((total, item) => total + item.omittedCalls, 0)
      }
    },
    methods,
    unclassifiedBoundaryInventory,
    ambiguousCallInventory,
    truncationInventory
  };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function renderControllerRustAssessment(report: ControllerRustAssessmentReport): string {
  return [
    "# Controller Rust Assessment", "",
    `- Root: ${report.root}`,
    `- Routes: ${report.routeCount}`,
    `- Assessed: ${report.assessedCount}`,
    `- Ready: ${report.summary.ready}`,
    `- Blocked: ${report.summary.blocked}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Expansion topologies", "",
    ...Object.entries(report.summary.expansionTopologies).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([topology, count]) => `- ${topology}: ${count}`), "",
    "## Transaction self-invocation evidence", "",
    `- Unique route-edge evidence: ${report.summary.transactionSelfInvocationEdges}`,
    ...Object.entries(report.summary.transactionSelfInvocationReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, count]) => `- ${reason}: ${count}`), "",
    "## Unclassified boundary inventory", "",
    `- Occurrences: ${report.summary.unclassifiedBoundaryInventory.occurrences}`,
    `- Unique symbols: ${report.summary.unclassifiedBoundaryInventory.uniqueSymbols}`,
    `- Affected routes: ${report.summary.unclassifiedBoundaryInventory.affectedRoutes}`,
    ...Object.entries(report.summary.unclassifiedBoundaryInventory.categories).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => `- ${category}: ${count}`),
    `- Depth distribution: ${JSON.stringify(report.summary.unclassifiedBoundaryInventory.depths)}`, "",
    "| Symbol | Category | Routes | Occurrences | Depth | Evidence |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...report.unclassifiedBoundaryInventory.map((item) => `| ${escapeTable(item.symbol)} | ${item.categories.join(", ")} | ${item.affectedRoutes.length} | ${item.occurrences} | ${formatDepthRange(item)} | ${escapeTable(item.sourceLocations.map((location) => `${location.file}:${location.line}`).join("<br>"))} |`), "",
    "## Ambiguous call inventory", "",
    `- Occurrences: ${report.summary.ambiguousCallInventory.occurrences}`,
    `- Unique expressions: ${report.summary.ambiguousCallInventory.uniqueExpressions}`,
    `- Affected routes: ${report.summary.ambiguousCallInventory.affectedRoutes}`,
    `- Candidate count distribution: ${JSON.stringify(report.summary.ambiguousCallInventory.candidateCountDistribution)}`, "",
    "| Expression | Routes | Occurrences | Candidates | Evidence |",
    "| --- | ---: | ---: | --- | --- |",
    ...report.ambiguousCallInventory.map((item) => `| ${escapeTable(item.expression)} | ${item.affectedRoutes.length} | ${item.occurrences} | ${escapeTable(item.candidates.map((candidate) => `${candidate.signature} [${candidate.score}]`).join("<br>"))} | ${escapeTable(item.sourceLocations.map((location) => `${location.file}:${location.line}`).join("<br>"))} |`), "",
    "## Truncation inventory", "",
    `- Routes: ${report.summary.truncationInventory.routes}`,
    `- Edge-cap routes: ${report.summary.truncationInventory.edgeCapRoutes}`,
    `- Depth-cap routes: ${report.summary.truncationInventory.depthCapRoutes}`,
    `- Per-method call-cap routes: ${report.summary.truncationInventory.perMethodCallCapRoutes}`,
    `- Unexpanded boundary nodes: ${report.summary.truncationInventory.unexpandedBoundaryNodes}`,
    `- Omitted calls: ${report.summary.truncationInventory.omittedCalls}`, "",
    "| Route | Handler | Topology | Nodes | Edges | Max depth | Unexpanded | Omitted calls |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.truncationInventory.map((item) => `| ${escapeTable(item.route)} | ${escapeTable(item.handler)} | ${item.expansionTopology ?? "fixed"} | ${item.nodes} | ${item.edges} | ${item.maxObservedDepth} | ${item.unexpandedBoundaryNodes.length} | ${item.omittedCalls} |`), "",
    "## Findings", "",
    ...Object.entries(report.summary.findings).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([finding, count]) => `- ${finding}: ${count}`), ""
  ].join("\n");
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function nodeDepths(graph: BehaviorGraph): Map<string, number> {
  const entry = graph.nodes.find((node) => node.kind === "entrypoint");
  if (!entry) return new Map();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.to) continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const depths = new Map([[entry.id, 0]]);
  const queue = [entry.id];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as string;
    const nextDepth = (depths.get(current) as number) + 1;
    for (const target of outgoing.get(current) ?? []) {
      if ((depths.get(target) ?? Number.POSITIVE_INFINITY) <= nextDepth) continue;
      depths.set(target, nextDepth);
      queue.push(target);
    }
  }
  return depths;
}

function aggregateUnclassifiedBoundaries(methods: ControllerMethodAssessment[]): ControllerUnclassifiedBoundaryInventoryItem[] {
  const values = new Map<string, {
    item: ControllerUnclassifiedBoundaryInventoryItem;
    routes: Set<string>;
    handlers: Set<string>;
    depths: number[];
    locations: Map<string, { file: string; line: number }>;
    categories: Set<UnclassifiedBoundaryCategory>;
    reasons: Set<string>;
  }>();
  for (const method of methods) {
    const route = `${method.method} ${method.path}`;
    for (const boundary of method.unclassifiedBoundaries) {
      const key = boundary.symbol;
      const current = values.get(key) ?? {
        item: {
          ...boundary,
          sourceLocations: [],
          categories: [],
          reasons: [],
          occurrences: 0,
          affectedRoutes: [],
          affectedHandlers: [],
          minDepth: boundary.depth,
          maxDepth: boundary.depth
        },
        routes: new Set<string>(),
        handlers: new Set<string>(),
        depths: [],
        locations: new Map<string, { file: string; line: number }>(),
        categories: new Set<UnclassifiedBoundaryCategory>(),
        reasons: new Set<string>()
      };
      current.item.occurrences += 1;
      current.routes.add(route);
      current.handlers.add(method.handler);
      current.locations.set(`${boundary.file}\0${boundary.line}`, { file: boundary.file, line: boundary.line });
      current.categories.add(boundary.category);
      current.reasons.add(boundary.reason);
      if (boundary.depth !== null) current.depths.push(boundary.depth);
      values.set(key, current);
    }
  }
  return [...values.values()].map(({ item, routes, handlers, depths, locations, categories, reasons }) => {
    const sourceLocations = [...locations.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const sortedCategories = [...categories].sort();
    const sortedReasons = [...reasons].sort();
    return {
      ...item,
      file: sourceLocations[0]?.file ?? item.file,
      line: sourceLocations[0]?.line ?? item.line,
      sourceLocations,
      category: sortedCategories[0] ?? item.category,
      reason: sortedReasons[0] ?? item.reason,
      categories: sortedCategories,
      reasons: sortedReasons,
      affectedRoutes: [...routes].sort(),
      affectedHandlers: [...handlers].sort(),
      minDepth: depths.length ? Math.min(...depths) : null,
      maxDepth: depths.length ? Math.max(...depths) : null
    };
  }).sort((a, b) =>
    b.affectedRoutes.length - a.affectedRoutes.length
    || b.occurrences - a.occurrences
    || a.symbol.localeCompare(b.symbol)
    || a.file.localeCompare(b.file)
    || a.line - b.line
  );
}

function aggregateAmbiguousCalls(methods: ControllerMethodAssessment[]): ControllerAmbiguousCallInventoryItem[] {
  const values = new Map<string, {
    item: ControllerAmbiguousCallInventoryItem;
    locations: Map<string, { file: string; line: number }>;
    methods: Set<string>;
    argumentCounts: Set<number>;
    argumentTypes: Map<string, string[]>;
    candidates: Map<string, { methodId: string; signature: string; score: number }>;
    routes: Set<string>;
    handlers: Set<string>;
  }>();
  for (const assessment of methods) {
    const route = `${assessment.method} ${assessment.path}`;
    for (const call of assessment.ambiguousCalls) {
      const current = values.get(call.expression) ?? {
        item: {
          expression: call.expression,
          sourceLocations: [],
          methods: [],
          argumentCounts: [],
          argumentTypes: [],
          candidates: [],
          occurrences: 0,
          affectedRoutes: [],
          affectedHandlers: []
        },
        locations: new Map(),
        methods: new Set(),
        argumentCounts: new Set(),
        argumentTypes: new Map(),
        candidates: new Map(),
        routes: new Set(),
        handlers: new Set()
      };
      current.item.occurrences += 1;
      current.locations.set(`${call.file}\0${call.line}`, { file: call.file, line: call.line });
      current.methods.add(call.method);
      if (call.argumentCount !== undefined) current.argumentCounts.add(call.argumentCount);
      current.argumentTypes.set(call.argumentTypes.join("\0"), call.argumentTypes);
      for (const candidate of call.candidates) {
        current.candidates.set(`${candidate.methodId}\0${candidate.signature}\0${candidate.score}`, candidate);
      }
      current.routes.add(route);
      current.handlers.add(assessment.handler);
      values.set(call.expression, current);
    }
  }
  return [...values.values()].map(({ item, locations, methods: callMethods, argumentCounts, argumentTypes, candidates, routes, handlers }) => ({
    ...item,
    sourceLocations: [...locations.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    methods: [...callMethods].sort(),
    argumentCounts: [...argumentCounts].sort((a, b) => a - b),
    argumentTypes: [...argumentTypes.values()].sort((a, b) => a.join(",").localeCompare(b.join(","))),
    candidates: [...candidates.values()].sort(compareCandidates),
    affectedRoutes: [...routes].sort(),
    affectedHandlers: [...handlers].sort()
  })).sort((a, b) =>
    b.affectedRoutes.length - a.affectedRoutes.length
    || b.occurrences - a.occurrences
    || b.candidates.length - a.candidates.length
    || a.expression.localeCompare(b.expression)
  );
}

function aggregateTruncations(methods: ControllerMethodAssessment[]): ControllerTruncationInventoryItem[] {
  return methods.filter((item) =>
    item.truncation.edgeCapHit
    || item.truncation.depthCapHit
    || item.truncation.perMethodCallCapHit
    || item.truncation.unexpandedBoundaryNodes.length > 0
    || item.expansionStatus === "budget-exhausted"
  ).map((item) => ({
    route: `${item.method} ${item.path}`,
    handler: item.handler,
    nodes: item.nodes,
    edges: item.edges,
    expansionStatus: item.expansionStatus,
    expansionTopology: item.expansionTopology,
    expansionRounds: item.expansionRounds,
    ...item.truncation
  })).sort((a, b) =>
    b.omittedCalls - a.omittedCalls
    || b.unexpandedBoundaryNodes.length - a.unexpandedBoundaryNodes.length
    || b.edges - a.edges
    || a.route.localeCompare(b.route)
  );
}

function createTruncationDiagnostic(report: JavaEndpointAnalysisReport): ControllerTruncationDiagnostic {
  const truncation = report.callGraph.truncation;
  const perMethodCallCapNodes = [...(truncation.perMethodCallCapNodes ?? [])].sort((a, b) =>
    b.omittedCalls - a.omittedCalls || a.nodeId.localeCompare(b.nodeId)
  );
  return {
    edgeCapHit: truncation.edgeCapHit,
    depthCapHit: truncation.depthCapHit,
    perMethodCallCapHit: Boolean(truncation.perMethodCallCapHit),
    maxObservedDepth: truncation.maxObservedDepth,
    maxTotalEdges: truncation.maxTotalEdges,
    unexpandedBoundaryNodes: [...truncation.unexpandedBoundaryNodes].sort(),
    perMethodCallCapNodes,
    omittedCalls: perMethodCallCapNodes.reduce((total, item) => total + item.omittedCalls, 0)
  };
}

function compareBoundaryOccurrences(a: ControllerUnclassifiedBoundaryOccurrence, b: ControllerUnclassifiedBoundaryOccurrence): number {
  return a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file) || a.line - b.line;
}

function compareAmbiguousOccurrences(a: ControllerAmbiguousCallOccurrence, b: ControllerAmbiguousCallOccurrence): number {
  return a.expression.localeCompare(b.expression) || a.file.localeCompare(b.file) || a.line - b.line;
}

function compareCandidates(
  a: { methodId: string; signature: string; score: number },
  b: { methodId: string; signature: string; score: number }
): number {
  return b.score - a.score || a.methodId.localeCompare(b.methodId) || a.signature.localeCompare(b.signature);
}

function formatDepthRange(item: ControllerUnclassifiedBoundaryInventoryItem): string {
  if (item.minDepth === null || item.maxDepth === null) return "unreachable";
  return item.minDepth === item.maxDepth ? String(item.minDepth) : `${item.minDepth}-${item.maxDepth}`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|");
}
