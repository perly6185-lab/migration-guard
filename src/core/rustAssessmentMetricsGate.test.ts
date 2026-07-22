import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRepositoryMetricsSnapshot, evaluateMetricsRegressionGate, renderMetricsRegressionGate } from "./rustAssessmentMetricsGate.js";
import type { RepositoryRustAssessmentReport } from "./repositoryRustAssessment.js";

function report(values: { generated: number; unknown: number; unresolved: number; dynamic: number; hash: string }): RepositoryRustAssessmentReport {
  return { version: 1, createdAt: "2026-07-21T00:00:00.000Z", root: "fixture", sourceIdentity: { revision: "fixture", dirty: false, dirtyFingerprint: "fixture", identity: "fixture" }, assessmentScope: { root: "fixture" }, repositoryMethodCount: 10, assessedCount: 10, summary: { ready: 0, blocked: 0, generatedBoundaries: values.generated, sqlBackedMethods: 0, sqlSources: 0, dynamicSqlSources: 0, transactionalSqlSources: 0, contextSqlSources: 0, withUnknownNodes: 0, adaptivelyExpanded: 0, expansionBudgetExhausted: 0, roles: {}, operations: { unknown: values.unknown }, sqlSourceKinds: {}, missingSqlContracts: {}, findings: { "RP-GRAPH-UNRESOLVED-EDGES": values.unresolved, "RP-SQL-DYNAMIC-SOURCE": values.dynamic } }, sqlMetrics: { records: 0, reviewableRecords: 0, replayContractRequiredRecords: 0, sourceKinds: {}, operations: {}, dynamicTags: {}, tables: {}, contexts: {}, transactionParticipation: {}, unresolvedReasons: {} }, methods: [], reportHash: values.hash };
}

test("metrics regression gate blocks unexplained increases and accepts exact reviewed explanations", () => {
  const baseline = createRepositoryMetricsSnapshot(report({ generated: 21, unknown: 32, unresolved: 1196, dynamic: 107, hash: "baseline" }), { project: "zboss-module-data", sourceRevision: "abc" });
  const improved = createRepositoryMetricsSnapshot(report({ generated: 20, unknown: 30, unresolved: 1100, dynamic: 100, hash: "improved" }));
  assert.equal(evaluateMetricsRegressionGate(baseline, improved).status, "passed");
  const regressed = createRepositoryMetricsSnapshot(report({ generated: 22, unknown: 32, unresolved: 1200, dynamic: 107, hash: "regressed" }));
  const blocked = evaluateMetricsRegressionGate(baseline, regressed);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers.map((item) => item.split(" ")[0]), ["generatedBoundaries", "unresolvedEdgeFindings"]);
  const explained = evaluateMetricsRegressionGate(baseline, regressed, [
    { metric: "generatedBoundaries", baseline: 21, current: 22, reason: "New generated mapper fixture is now modeled explicitly.", reviewedBy: "migration-team" },
    { metric: "unresolvedEdgeFindings", baseline: 1196, current: 1200, reason: "Expanded assessment scope by four methods.", reviewedBy: "migration-team" }
  ]);
  assert.equal(explained.status, "passed");
  assert.equal(explained.comparisons.filter((item) => item.status === "explained").length, 2);
  assert.match(renderMetricsRegressionGate(blocked), /generatedBoundaries[\s\S]*regressed/);
});

test("documented zboss repository metrics baseline is hash validated", () => {
  const baseline = JSON.parse(fs.readFileSync(path.resolve("fixtures/rust-assessment-metrics/zboss-module-data-baseline.json"), "utf8"));
  const gate = evaluateMetricsRegressionGate(baseline, baseline);
  assert.equal(gate.status, "passed");
  assert.equal(gate.comparisons.every((item) => item.delta === 0), true);
});
