import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer, type AdaptiveExpansionTopology, type JavaEndpointHttpMethod } from "./javaEndpointAnalysis.js";
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
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
  transactionSelfInvocations: string[];
  transactionSelfInvocationReasons: string[];
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
  category: UnclassifiedBoundaryCategory;
  reason: string;
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
  };
  methods: ControllerMethodAssessment[];
  unclassifiedBoundaryInventory: ControllerUnclassifiedBoundaryInventoryItem[];
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
      findings: [...plan.findings, ...(expansion?.status === "budget-exhausted" ? ["RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])],
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length,
      transactionSelfInvocations: [...new Set(transactionSelfInvocations.map((item) => `${item.edge} [${item.sourceTransaction} -> ${item.targetTransaction}]`))],
      transactionSelfInvocationReasons: [...new Set(transactionSelfInvocations.map((item) => item.reason))].sort()
    };
  });
  const unclassifiedBoundaryInventory = aggregateUnclassifiedBoundaries(methods);
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
        categories: countValues(unclassifiedBoundaryInventory.map((item) => item.category)),
        depths: countValues(methods.flatMap((item) => item.unclassifiedBoundaries).map((item) => item.depth === null ? "unreachable" : String(item.depth)))
      }
    },
    methods,
    unclassifiedBoundaryInventory
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
    ...report.unclassifiedBoundaryInventory.map((item) => `| ${escapeTable(item.symbol)} | ${item.category} | ${item.affectedRoutes.length} | ${item.occurrences} | ${formatDepthRange(item)} | ${escapeTable(`${item.file}:${item.line}`)} |`), "",
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
  }>();
  for (const method of methods) {
    const route = `${method.method} ${method.path}`;
    for (const boundary of method.unclassifiedBoundaries) {
      const key = `${boundary.symbol}\0${boundary.file}\0${boundary.line}\0${boundary.category}\0${boundary.reason}`;
      const current = values.get(key) ?? {
        item: {
          ...boundary,
          occurrences: 0,
          affectedRoutes: [],
          affectedHandlers: [],
          minDepth: boundary.depth,
          maxDepth: boundary.depth
        },
        routes: new Set<string>(),
        handlers: new Set<string>(),
        depths: []
      };
      current.item.occurrences += 1;
      current.routes.add(route);
      current.handlers.add(method.handler);
      if (boundary.depth !== null) current.depths.push(boundary.depth);
      values.set(key, current);
    }
  }
  return [...values.values()].map(({ item, routes, handlers, depths }) => ({
    ...item,
    affectedRoutes: [...routes].sort(),
    affectedHandlers: [...handlers].sort(),
    minDepth: depths.length ? Math.min(...depths) : null,
    maxDepth: depths.length ? Math.max(...depths) : null
  })).sort((a, b) =>
    b.affectedRoutes.length - a.affectedRoutes.length
    || b.occurrences - a.occurrences
    || a.symbol.localeCompare(b.symbol)
    || a.file.localeCompare(b.file)
    || a.line - b.line
  );
}

function compareBoundaryOccurrences(a: ControllerUnclassifiedBoundaryOccurrence, b: ControllerUnclassifiedBoundaryOccurrence): number {
  return a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file) || a.line - b.line;
}

function formatDepthRange(item: ControllerUnclassifiedBoundaryInventoryItem): string {
  if (item.minDepth === null || item.maxDepth === null) return "unreachable";
  return item.minDepth === item.maxDepth ? String(item.minDepth) : `${item.minDepth}-${item.maxDepth}`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|");
}
