import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { runShellCommand } from "./exec.js";
import { createJavaEndpointAnalyzer, type JavaEndpointHttpMethod } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";

export interface CrossLayerEvidenceLineageOptions {
  root: string;
  maxDepth?: number;
  maxEdges?: number;
  limit?: number;
  includeTests?: boolean;
}

export interface CrossLayerRouteLineage {
  routeId: string;
  method: JavaEndpointHttpMethod;
  path: string;
  handler: string;
  status: "ready" | "blocked";
  controllerNodeId?: string;
  serviceNodeIds: string[];
  repositoryNodeIds: string[];
  sqlSourceIds: string[];
  links: Array<{ from: string; to: string; kind: "call" | "sql-source" }>;
  findings: string[];
  rootCauses: string[];
  lineageHash: string;
}

export interface CrossLayerEvidenceLineageReport {
  version: 1;
  createdAt: string;
  runId: string;
  root: string;
  sourceRevision: string;
  routeCount: number;
  assessedCount: number;
  summary: {
    ready: number;
    blocked: number;
    routesWithSql: number;
    layers: Record<string, number>;
    rootCauses: Record<string, number>;
  };
  routes: CrossLayerRouteLineage[];
  topBlockedRoutes: Array<{ routeId: string; handler: string; downstreamSqlSources: number; rootCauses: string[] }>;
  evidenceHash: string;
  reportHash: string;
}

export async function assessCrossLayerEvidenceLineage(options: CrossLayerEvidenceLineageOptions): Promise<CrossLayerEvidenceLineageReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const selected = analyzer.routes.slice(0, positiveLimit(options.limit, analyzer.routes.length));
  const routes = selected.map((route): CrossLayerRouteLineage => {
    const analysis = analyzer.analyze({ endpoint: route.path, method: route.method, maxDepth: options.maxDepth, maxEdges: options.maxEdges });
    const { graph, plan } = createEndpointReplacementPlanFromJava(analysis);
    const controllerNodeId = analysis.callGraph.nodes.find((node) => node.kind === "controller")?.id;
    const serviceNodeIds = ids(analysis.callGraph.nodes.filter((node) => node.kind === "service").map((node) => node.id));
    const repositoryNodeIds = ids(analysis.callGraph.nodes.filter((node) => node.kind === "repository" || node.kind === "mapper").map((node) => node.id));
    const sqlSourceIds = ids(analysis.sqlSources.map((source) => source.id));
    const nodeIds = new Set(analysis.callGraph.nodes.map((node) => node.id));
    const links = [
      ...analysis.callGraph.edges.filter((edge) => edge.to).map((edge) => ({ from: edge.from, to: edge.to as string, kind: "call" as const })),
      ...analysis.sqlSources.map((source) => ({ from: nodeIds.has(source.ownerId) ? source.ownerId : repositoryNodeIds.at(-1) ?? controllerNodeId ?? "unknown", to: source.id, kind: "sql-source" as const }))
    ].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const rootCauses = ids([...plan.findings, ...analysis.sqlSources.flatMap((source) => (source.ownershipEvidence?.missingContracts ?? []).map((contract) => `SQL:${contract}`))]);
    const routeBase = { routeId: `${route.method} ${route.path}#${route.className}.${route.methodName}`, method: route.method, path: route.path, handler: `${route.className}.${route.methodName}`, status: plan.status, controllerNodeId, serviceNodeIds, repositoryNodeIds, sqlSourceIds, links, findings: ids(plan.findings), rootCauses };
    return { ...routeBase, lineageHash: sha256(stableStringify(routeBase)) };
  });
  const createdAt = new Date().toISOString();
  const sourceRevision = await readSourceRevision(analyzer.root);
  const evidenceHash = sha256(stableStringify({ sourceRevision, routes }));
  const runId = `lineage-${createdAt.replace(/[:.]/g, "-")}-${evidenceHash.slice(0, 8)}`;
  const base = {
    version: 1 as const, createdAt, runId, root: analyzer.root, sourceRevision, routeCount: analyzer.routes.length, assessedCount: routes.length,
    summary: { ready: routes.filter((route) => route.status === "ready").length, blocked: routes.filter((route) => route.status === "blocked").length, routesWithSql: routes.filter((route) => route.sqlSourceIds.length > 0).length, layers: { controller: routes.filter((route) => route.controllerNodeId).length, service: routes.reduce((total, route) => total + route.serviceNodeIds.length, 0), repository: routes.reduce((total, route) => total + route.repositoryNodeIds.length, 0), sql: routes.reduce((total, route) => total + route.sqlSourceIds.length, 0) }, rootCauses: count(routes.flatMap((route) => route.rootCauses)) },
    routes,
    topBlockedRoutes: routes.filter((route) => route.status === "blocked").sort((a, b) => b.sqlSourceIds.length - a.sqlSourceIds.length || b.rootCauses.length - a.rootCauses.length || a.routeId.localeCompare(b.routeId)).slice(0, 20).map((route) => ({ routeId: route.routeId, handler: route.handler, downstreamSqlSources: route.sqlSourceIds.length, rootCauses: route.rootCauses }))
  };
  return { ...base, evidenceHash, reportHash: sha256(stableStringify({ ...base, createdAt: undefined, runId: undefined })) };
}

export function renderCrossLayerEvidenceLineage(report: CrossLayerEvidenceLineageReport): string {
  return ["# Cross-layer Evidence Lineage", "", `- Run: ${report.runId}`, `- Source revision: ${report.sourceRevision}`, `- Evidence hash: ${report.evidenceHash}`, `- Routes: ${report.assessedCount}/${report.routeCount}`, `- Ready: ${report.summary.ready}`, `- Blocked: ${report.summary.blocked}`, `- Routes with SQL: ${report.summary.routesWithSql}`, "", "## Layer coverage", "", ...renderCounts(report.summary.layers), "", "## Root-cause distribution", "", ...renderCounts(report.summary.rootCauses), "", "## Top blocked routes", "", ...(report.topBlockedRoutes.length ? report.topBlockedRoutes.map((route) => `- ${route.routeId}: sql=${route.downstreamSqlSources}; causes=${route.rootCauses.join(", ") || "none"}`) : ["- none"]), "", "## Route lineage", "", ...report.routes.map((route) => `- ${route.routeId}: controller=${route.controllerNodeId ?? "none"}; services=${route.serviceNodeIds.length}; repositories=${route.repositoryNodeIds.length}; sql=${route.sqlSourceIds.length}; hash=${route.lineageHash}`), "", `- Report hash: ${report.reportHash}`, ""].join("\n");
}

async function readSourceRevision(root: string): Promise<string> {
  const result = await runShellCommand("git rev-parse --verify HEAD", { cwd: root, timeoutMs: 5000, maxOutputBytes: 1024 });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : "unversioned";
}
function ids(values: string[]): string[] { return [...new Set(values)].sort(); }
function count(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))); }
function renderCounts(values: Record<string, number>): string[] { const entries = Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); return entries.length ? entries.map(([key, value]) => `- ${key}: ${value}`) : ["- none: 0"]; }
function positiveLimit(value: number | undefined, fallback: number): number { return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback; }
