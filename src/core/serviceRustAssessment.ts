import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer, type AdaptiveExpansionTopology } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import type { EndpointWorkloadKind } from "./endpointReplacementModel.js";
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
  contexts: number;
  frameworkContracts: number;
  dataContracts: number;
  effects: number;
  roles: string[];
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
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
    workloads: Record<string, number>;
    findings: Record<string, number>;
    roles: Record<string, number>;
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
      unknownNodes: graph.nodes.filter((node) => node.kind === "unknown").length,
      contexts: plan.contracts.contexts.length,
      frameworkContracts: plan.contracts.framework.length,
      dataContracts: plan.contracts.data.length,
      effects: plan.contracts.effects.length,
      roles: [...new Set(graph.nodes.map((node) => node.sourceRole ?? "unknown"))].sort(),
      findings: [...plan.findings, ...(expansion?.status === "budget-exhausted" ? ["RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])],
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length
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
      workloads: countValues(methods.map((item) => item.workload)),
      findings: countValues(methods.flatMap((item) => item.findings)),
      roles: countValues(methods.flatMap((item) => item.roles))
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
    ...Object.entries(report.summary.expansionTopologies).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([topology, count]) => `- ${topology}: ${count}`), ""
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
