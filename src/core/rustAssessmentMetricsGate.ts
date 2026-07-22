import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { RepositoryRustAssessmentReport } from "./repositoryRustAssessment.js";

export type RepositoryRegressionMetric = "generatedBoundaries" | "unknownOperations" | "unresolvedEdgeFindings" | "dynamicSqlBlockers";

export interface RepositoryMetricsSnapshot {
  version: 1;
  kind: "migration-guard.repository-metrics";
  capturedAt: string;
  project: string;
  sourceRevision: string;
  assessmentReportHash: string;
  metrics: Record<RepositoryRegressionMetric, number>;
  snapshotHash: string;
}

export interface MetricsRegressionExplanation {
  metric: RepositoryRegressionMetric;
  baseline: number;
  current: number;
  reason: string;
  reviewedBy: string;
}

export interface MetricsRegressionGateReport {
  version: 1;
  status: "passed" | "blocked";
  baselineHash: string;
  currentHash: string;
  comparisons: Array<{ metric: RepositoryRegressionMetric; baseline: number; current: number; delta: number; status: "passed" | "explained" | "regressed"; explanation?: MetricsRegressionExplanation }>;
  blockers: string[];
  gateHash: string;
}

export function createRepositoryMetricsSnapshot(report: RepositoryRustAssessmentReport, identity?: { project?: string; sourceRevision?: string; capturedAt?: string }): RepositoryMetricsSnapshot {
  const base = {
    version: 1 as const,
    kind: "migration-guard.repository-metrics" as const,
    capturedAt: identity?.capturedAt ?? report.createdAt,
    project: identity?.project ?? report.root,
    sourceRevision: identity?.sourceRevision ?? report.sourceIdentity.identity,
    assessmentReportHash: report.reportHash,
    metrics: {
      generatedBoundaries: report.summary.generatedBoundaries,
      unknownOperations: report.summary.operations.unknown ?? 0,
      unresolvedEdgeFindings: report.summary.findings["RP-GRAPH-UNRESOLVED-EDGES"] ?? 0,
      dynamicSqlBlockers: report.summary.findings["RP-SQL-DYNAMIC-SOURCE"] ?? 0
    }
  };
  return { ...base, snapshotHash: sha256(stableStringify(base)) };
}

export function evaluateMetricsRegressionGate(baseline: RepositoryMetricsSnapshot, current: RepositoryMetricsSnapshot, explanations: MetricsRegressionExplanation[] = []): MetricsRegressionGateReport {
  validateSnapshot(baseline);
  validateSnapshot(current);
  const metrics: RepositoryRegressionMetric[] = ["generatedBoundaries", "unknownOperations", "unresolvedEdgeFindings", "dynamicSqlBlockers"];
  const comparisons = metrics.map((metric) => {
    const baselineValue = baseline.metrics[metric];
    const currentValue = current.metrics[metric];
    const explanation = explanations.find((item) => item.metric === metric && item.baseline === baselineValue && item.current === currentValue && item.reason.trim() && item.reviewedBy.trim());
    const status = currentValue <= baselineValue ? "passed" as const : explanation ? "explained" as const : "regressed" as const;
    return { metric, baseline: baselineValue, current: currentValue, delta: currentValue - baselineValue, status, explanation };
  });
  const blockers = comparisons.filter((item) => item.status === "regressed").map((item) => `${item.metric} increased from ${item.baseline} to ${item.current} without a matching reviewed explanation.`);
  const base = { version: 1 as const, status: blockers.length ? "blocked" as const : "passed" as const, baselineHash: baseline.snapshotHash, currentHash: current.snapshotHash, comparisons, blockers };
  return { ...base, gateHash: sha256(stableStringify(base)) };
}

export function renderMetricsRegressionGate(report: MetricsRegressionGateReport): string {
  return ["# Rust Assessment Metrics Regression Gate", "", `- Status: ${report.status}`, `- Baseline: ${report.baselineHash}`, `- Current: ${report.currentHash}`, `- Gate hash: ${report.gateHash}`, "", "| Metric | Baseline | Current | Delta | Status |", "| --- | ---: | ---: | ---: | --- |", ...report.comparisons.map((item) => `| ${item.metric} | ${item.baseline} | ${item.current} | ${item.delta} | ${item.status} |`), "", "## Blockers", "", ...(report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`) : ["- none"]), ""].join("\n");
}

function validateSnapshot(snapshot: RepositoryMetricsSnapshot): void {
  if (snapshot.version !== 1 || snapshot.kind !== "migration-guard.repository-metrics") throw new Error("Unsupported repository metrics snapshot.");
  const expected = sha256(stableStringify({ ...snapshot, snapshotHash: undefined }));
  if (snapshot.snapshotHash !== expected) throw new Error("Repository metrics snapshot hash mismatch.");
  const required: RepositoryRegressionMetric[] = ["generatedBoundaries", "unknownOperations", "unresolvedEdgeFindings", "dynamicSqlBlockers"];
  for (const metric of required) {
    const value = snapshot.metrics?.[metric];
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid repository metric ${metric}: ${value}`);
  }
}
