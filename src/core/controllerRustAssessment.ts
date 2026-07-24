import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer, type AdaptiveExpansionTopology, type JavaEndpointHttpMethod } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import { findRiskyTransactionSelfInvocations } from "./behaviorGraph.js";
import type { EndpointWorkloadKind } from "./endpointReplacementModel.js";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

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
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
  transactionSelfInvocations: string[];
  transactionSelfInvocationReasons: string[];
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
  };
  methods: ControllerMethodAssessment[];
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
      unknownNodes: graph.nodes.filter((node) => node.kind === "unknown").length,
      findings: [...plan.findings, ...(expansion?.status === "budget-exhausted" ? ["RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])],
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length,
      transactionSelfInvocations: [...new Set(transactionSelfInvocations.map((item) => `${item.edge} [${item.sourceTransaction} -> ${item.targetTransaction}]`))],
      transactionSelfInvocationReasons: [...new Set(transactionSelfInvocations.map((item) => item.reason))].sort()
    };
  });
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
      transactionSelfInvocationReasons: countValues(methods.flatMap((item) => item.transactionSelfInvocationReasons))
    },
    methods
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
