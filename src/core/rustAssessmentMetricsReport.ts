import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { ControllerRustAssessmentReport } from "./controllerRustAssessment.js";
import type { CrossLayerEvidenceLineageReport } from "./crossLayerEvidenceLineage.js";
import type { RepositoryRustAssessmentReport } from "./repositoryRustAssessment.js";
import type { ServiceRustAssessmentReport } from "./serviceRustAssessment.js";

export interface RustAssessmentMetricsReport {
  version: 1;
  kind: "migration-guard.rust-assessment-metrics";
  createdAt: string;
  sourceRevision: string;
  assessmentScope: { root: string; maxDepth?: number; maxEdges?: number; includeTests: boolean };
  layers: {
    controller: LayerMetrics;
    service: LayerMetrics & { withUnknownNodes: number; expansionBudgetExhausted: number };
    repository: LayerMetrics & { generatedBoundaries: number; sqlBackedMethods: number; sqlCoverage: number; dynamicSqlBlockers: number; unknownOperations: number; unresolvedEdgeFindings: number };
  };
  lineage: { routes: number; routesWithSql: number; completeRoutes: number; completeRouteRate: number; evidenceHash: string };
  reportHashes: { controller: string; service: string; repository: string; lineage: string };
  reportHash: string;
}

interface LayerMetrics {
  total: number;
  ready: number;
  blocked: number;
  readyRate: number;
  blockedCauseShare: Record<string, number>;
}

export function createRustAssessmentMetricsReport(inputs: { controller: ControllerRustAssessmentReport; service: ServiceRustAssessmentReport; repository: RepositoryRustAssessmentReport; lineage: CrossLayerEvidenceLineageReport }, createdAt = new Date().toISOString()): RustAssessmentMetricsReport {
  const { controller, service, repository, lineage } = inputs;
  const identities = [controller.sourceIdentity.identity, service.sourceIdentity.identity, repository.sourceIdentity.identity, lineage.sourceIdentity.identity];
  if (new Set(identities).size !== 1) throw new Error(`Assessment source identity mismatch: ${identities.join(", ")}`);
  const scopes = [controller.assessmentScope, service.assessmentScope, repository.assessmentScope, lineage.assessmentScope];
  const sharedScope = { root: controller.root, maxDepth: controller.assessmentScope.maxDepth, maxEdges: controller.assessmentScope.maxEdges, includeTests: Boolean(controller.assessmentScope.includeTests) };
  for (const scope of scopes) {
    if (scope.root !== sharedScope.root || scope.maxDepth !== sharedScope.maxDepth || scope.maxEdges !== sharedScope.maxEdges || Boolean(scope.includeTests) !== sharedScope.includeTests) throw new Error("Assessment scope mismatch across layer reports.");
  }
  const completeRoutes = lineage.routes.filter((route) => route.controllerNodeId && route.serviceNodeIds.length && route.repositoryNodeIds.length && route.sqlSourceIds.length).length;
  const base = {
    version: 1 as const,
    kind: "migration-guard.rust-assessment-metrics" as const,
    createdAt,
    sourceRevision: identities[0] as string,
    assessmentScope: sharedScope,
    layers: {
      controller: layer(controller.assessedCount, controller.summary.ready, controller.summary.blocked, controller.summary.findings),
      service: { ...layer(service.assessedCount, service.summary.ready, service.summary.blocked, service.summary.findings), withUnknownNodes: service.summary.withUnknownNodes, expansionBudgetExhausted: service.summary.expansionBudgetExhausted },
      repository: { ...layer(repository.assessedCount, repository.summary.ready, repository.summary.blocked, repository.summary.findings), generatedBoundaries: repository.summary.generatedBoundaries, sqlBackedMethods: repository.summary.sqlBackedMethods, sqlCoverage: ratio(repository.summary.sqlBackedMethods, repository.assessedCount), dynamicSqlBlockers: repository.summary.findings["RP-SQL-DYNAMIC-SOURCE"] ?? 0, unknownOperations: repository.summary.operations.unknown ?? 0, unresolvedEdgeFindings: repository.summary.findings["RP-GRAPH-UNRESOLVED-EDGES"] ?? 0 }
    },
    lineage: { routes: lineage.assessedCount, routesWithSql: lineage.summary.routesWithSql, completeRoutes, completeRouteRate: ratio(completeRoutes, lineage.assessedCount), evidenceHash: lineage.evidenceHash },
    reportHashes: { controller: controller.reportHash, service: service.reportHash, repository: repository.reportHash, lineage: lineage.reportHash }
  };
  return { ...base, reportHash: sha256(stableStringify(base)) };
}

export function renderRustAssessmentMetricsReport(report: RustAssessmentMetricsReport): string {
  return ["# Rust Assessment Metrics", "", `- Source revision: ${report.sourceRevision}`, `- Scope: depth=${report.assessmentScope.maxDepth ?? "default"}, edges=${report.assessmentScope.maxEdges ?? "default"}, includeTests=${report.assessmentScope.includeTests}`, `- Report hash: ${report.reportHash}`, "", "| Layer | Total | Ready | Blocked | Ready rate |", "| --- | ---: | ---: | ---: | ---: |", ...Object.entries(report.layers).map(([name, value]) => `| ${name} | ${value.total} | ${value.ready} | ${value.blocked} | ${percent(value.readyRate)} |`), "", "## Repository evidence", "", `- Generated boundaries: ${report.layers.repository.generatedBoundaries}`, `- SQL-backed methods: ${report.layers.repository.sqlBackedMethods} (${percent(report.layers.repository.sqlCoverage)})`, `- Dynamic SQL blockers: ${report.layers.repository.dynamicSqlBlockers}`, `- Unknown operations: ${report.layers.repository.unknownOperations}`, `- Unresolved-edge findings: ${report.layers.repository.unresolvedEdgeFindings}`, "", "## Cross-layer lineage", "", `- Routes with SQL: ${report.lineage.routesWithSql}/${report.lineage.routes}`, `- Complete Controller -> Service -> Repository -> SQL routes: ${report.lineage.completeRoutes}/${report.lineage.routes} (${percent(report.lineage.completeRouteRate)})`, `- Evidence hash: ${report.lineage.evidenceHash}`, "", "## Top blocked causes", "", ...Object.entries(report.layers).flatMap(([name, value]) => Object.entries(value.blockedCauseShare).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cause, share]) => `- ${name}: ${cause} = ${percent(share)}`)), "", "> Assessment readiness is evidence coverage only; it does not prove Rust implementation, runtime replay, performance parity, or source-off readiness.", ""].join("\n");
}

function layer(total: number, ready: number, blocked: number, findings: Record<string, number>): LayerMetrics {
  return { total, ready, blocked, readyRate: ratio(ready, total), blockedCauseShare: Object.fromEntries(Object.entries(findings).map(([key, value]) => [key, ratio(value, blocked)])) };
}
function ratio(value: number, total: number): number { return total > 0 ? Number((value / total).toFixed(6)) : 0; }
function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
