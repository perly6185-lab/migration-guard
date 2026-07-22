import test from "node:test";
import assert from "node:assert/strict";
import { createRustAssessmentMetricsReport, renderRustAssessmentMetricsReport } from "./rustAssessmentMetricsReport.js";

test("aggregate Rust metrics require matching source identity and scope", () => {
  const common = { root: "demo", sourceIdentity: { identity: "rev-1" }, assessmentScope: { root: "demo", maxDepth: 12, maxEdges: 500 }, reportHash: "hash" };
  const controller = { ...common, assessedCount: 10, summary: { ready: 4, blocked: 6, findings: { incomplete: 3 } } };
  const service = { ...common, assessedCount: 20, summary: { ready: 10, blocked: 10, findings: { unknown: 5 }, withUnknownNodes: 7, expansionBudgetExhausted: 2 } };
  const repository = { ...common, assessedCount: 8, summary: { ready: 6, blocked: 2, findings: { "RP-SQL-DYNAMIC-SOURCE": 2, "RP-GRAPH-UNRESOLVED-EDGES": 1 }, generatedBoundaries: 1, sqlBackedMethods: 4, operations: { unknown: 1 } } };
  const lineage = { ...common, assessedCount: 2, summary: { routesWithSql: 2 }, evidenceHash: "evidence", routes: [{ controllerNodeId: "c", serviceNodeIds: ["s"], repositoryNodeIds: ["r"], sqlSourceIds: ["q"] }, { controllerNodeId: "c", serviceNodeIds: [], repositoryNodeIds: [], sqlSourceIds: [] }] };
  const report = createRustAssessmentMetricsReport({ controller, service, repository, lineage } as never, "2026-07-22T00:00:00.000Z");
  assert.equal(report.layers.controller.readyRate, 0.4);
  assert.equal(report.layers.repository.sqlCoverage, 0.5);
  assert.equal(report.layers.service.blockedCauseShare.unknown, 0.5);
  assert.equal(report.lineage.completeRouteRate, 0.5);
  assert.match(renderRustAssessmentMetricsReport(report), /does not prove Rust implementation/);
  assert.throws(() => createRustAssessmentMetricsReport({ controller: { ...controller, sourceIdentity: { identity: "other" } }, service, repository, lineage } as never), /source identity mismatch/);
});
