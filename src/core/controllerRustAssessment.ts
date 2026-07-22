import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer, type JavaEndpointHttpMethod } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import type { EndpointWorkloadKind } from "./endpointReplacementModel.js";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

export interface ControllerRustAssessmentOptions {
  root: string;
  maxDepth?: number;
  maxEdges?: number;
  limit?: number;
  includeTests?: boolean;
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
  };
  methods: ControllerMethodAssessment[];
  reportHash: string;
}

export async function assessJavaControllersForRust(options: ControllerRustAssessmentOptions): Promise<ControllerRustAssessmentReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const sourceIdentity = await captureAssessmentSourceIdentity(analyzer.root);
  const routes = analyzer.routes.slice(0, positiveLimit(options.limit, analyzer.routes.length));
  const methods = routes.map((route): ControllerMethodAssessment => {
    const source = analyzer.analyze({ endpoint: route.path, method: route.method, maxDepth: options.maxDepth, maxEdges: options.maxEdges });
    const { graph, plan } = createEndpointReplacementPlanFromJava(source);
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
      findings: plan.findings
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
      findings: countValues(methods.flatMap((item) => item.findings))
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
