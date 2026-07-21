import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createBehaviorGraphFromJava } from "./behaviorGraph.js";
import {
  createEndpointPilotPlan,
  createEndpointReplacementPlanFromJava,
  evaluateEndpointReplacementReadiness
} from "./endpointReplacementPlanner.js";
import type { JavaEndpointAnalysisReport, JavaEndpointGoldenCasePlan } from "./javaEndpointAnalysis.js";

const execFileAsync = promisify(execFile);

test("generic planner creates stable behavior contracts, boundaries, scenarios and waves", () => {
  const report = endpointReport("POST", "/records", "createRecord", "page-query", [
    node("Controller.createRecord", "controller", "Controller", "createRecord"),
    node("Service.validateInput", "service", "Service", "validateInput"),
    node("Service.calculateDefaults", "service", "Service", "calculateDefaults"),
    node("Repository.insert", "repository", "Repository", "insert")
  ]);
  const first = createEndpointReplacementPlanFromJava(report);
  const second = createEndpointReplacementPlanFromJava(report);
  assert.equal(first.graph.workload, "command");
  assert.equal(first.graph.graphHash, second.graph.graphHash);
  assert.equal(first.plan.planHash, second.plan.planHash);
  assert.equal(first.plan.status, "ready");
  assert.ok(first.plan.boundaries.some((item) => item.id === "pure-logic"));
  assert.ok(first.plan.boundaries.some((item) => item.id === "infrastructure"));
  assert.ok(first.plan.scenarios.some((item) => item.id === "validation-failure"));
  assert.ok(first.plan.scenarios.some((item) => item.id === "concurrent-write"));
  assert.equal(first.plan.waves.length, 5);
});

test("behavior graph and replacement plan fail closed on truncation and unresolved calls", () => {
  const report = endpointReport("POST", "/jobs", "runJob", "batch-command", [node("Controller.runJob", "controller", "Controller", "runJob")]);
  report.callGraph.truncation.edgeCapHit = true;
  report.callGraph.edges.push({
    from: "Controller.runJob",
    unresolvedTarget: "dynamicTarget",
    call: { method: "invoke", expression: "target.invoke()", file: "Controller.java", line: 12 },
    resolution: "unresolved"
  });
  const { graph, plan } = createEndpointReplacementPlanFromJava(report);
  assert.equal(graph.completeness.complete, false);
  assert.deepEqual(graph.completeness.findings, ["RP-GRAPH-EDGE-CAP", "RP-GRAPH-UNRESOLVED-EDGES"]);
  assert.equal(plan.status, "blocked");
  assert.match(plan.nextAction ?? "", /RP-GRAPH-EDGE-CAP/);
});

test("scenario synthesis is data driven across query, query-with-effects, command and sync workloads", () => {
  const query = createEndpointReplacementPlanFromJava(endpointReport("GET", "/search", "search", "page-query", [
    node("Controller.search", "controller", "Controller", "search"),
    node("Repository.query", "repository", "Repository", "query")
  ])).plan;
  const command = createEndpointReplacementPlanFromJava(endpointReport("POST", "/records", "create", "page-query", [
    node("Controller.create", "controller", "Controller", "create"),
    node("Repository.save", "repository", "Repository", "save")
  ])).plan;
  const mixedQuery = createEndpointReplacementPlanFromJava(endpointReport("POST", "/reports/page", "page", "page-query", [
    node("Controller.page", "controller", "Controller", "page"),
    node("Repository.query", "repository", "Repository", "query"),
    node("Repository.count", "repository", "Repository", "count"),
    node("Service.loadColumns", "service", "Service", "loadColumns"),
    node("Service.loadPermissions", "service", "Service", "loadPermissions"),
    node("Repository.updateLastAccess", "repository", "Repository", "updateLastAccess")
  ])).plan;
  const sync = createEndpointReplacementPlanFromJava(endpointReport("POST", "/sync", "synchronize", "sync-command", [
    node("Controller.synchronize", "controller", "Controller", "synchronize"),
    node("Publisher.publishProgress", "service", "Publisher", "publishProgress")
  ])).plan;
  assert.equal(query.workload, "query");
  assert.equal(mixedQuery.workload, "query-with-effects");
  assert.equal(command.workload, "command");
  assert.equal(sync.workload, "sync");
  assert.equal(query.scenarios.some((item) => item.id === "concurrent-write"), false);
  assert.equal(command.scenarios.some((item) => item.id === "transaction-failure"), true);
  assert.equal(sync.scenarios.some((item) => item.id === "dependency-failure"), true);
});

test("RP1 through RP6 readiness is sequential and produces local issue actions", () => {
  const base = {
    graphComplete: true,
    contractsComplete: true,
    ownershipComplete: true,
    replayPassed: true,
    concurrencyPassed: true,
    faultPassed: true,
    performancePassed: true,
    sourceOffPassed: false,
    rollbackPassed: true,
    evidenceCreatedAt: "2026-07-21T00:00:00.000Z",
    maxEvidenceAgeMs: 86_400_000
  };
  const blocked = evaluateEndpointReplacementReadiness(base, Date.parse("2026-07-21T01:00:00.000Z"));
  assert.equal(blocked.achievedLevel, "RP5");
  assert.equal(blocked.nextAction, "Resolve RP6-SOURCE-OFF-BLOCKED before RP6.");
  const ready = evaluateEndpointReplacementReadiness({ ...base, sourceOffPassed: true }, Date.parse("2026-07-21T01:00:00.000Z"));
  assert.equal(ready.status, "ready");
  assert.equal(ready.achievedLevel, "RP6");
});

test("generic pilot plan binds generated scenarios and fails closed without roots", () => {
  const plan = createEndpointReplacementPlanFromJava(endpointReport("GET", "/items", "listItems", "page-query", [
    node("Controller.listItems", "controller", "Controller", "listItems")
  ])).plan;
  const blocked = createEndpointPilotPlan(plan, { sourceRoot: "/source" });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers, ["RP-PILOT-TARGET-ROOT-MISSING"]);
  assert.equal(createEndpointPilotPlan(plan, { sourceRoot: "/source", targetRoot: "/target" }).status, "ready-to-run");
});

test("generic planner source contains no endpoint-specific route branching", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../src/core/endpointReplacementPlanner.ts"), "utf8");
  assert.doesNotMatch(source, /refreshSync|engine-use-page|\/init\b/);
});

test("full-replacement CLI plans an endpoint and pilot fails closed without a target root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-endpoint-planner-cli-"));
  try {
    const analysisPath = path.join(dir, "analysis.json");
    await writeFile(analysisPath, JSON.stringify(endpointReport("GET", "/items", "listItems", "page-query", [
      node("Controller.listItems", "controller", "Controller", "listItems")
    ])));
    const cli = path.resolve(import.meta.dirname, "../cli.js");
    const planned = await execFileAsync(process.execPath, [cli, "full-replacement", "plan", "--java-analysis", analysisPath, "--json"]);
    const value = JSON.parse(planned.stdout) as { plan: { status: string; endpoint: { path: string } } };
    assert.equal(value.plan.status, "ready");
    assert.equal(value.plan.endpoint.path, "/items");
    const planPath = path.join(dir, "plan.json");
    await writeFile(planPath, planned.stdout);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "full-replacement", "endpoint-pilot", "--plan", planPath, "--source-root", dir, "--json"]),
      (error: unknown) => {
        const failure = error as { code?: number; stdout?: string };
        assert.equal(failure.code, 1);
        const report = JSON.parse(failure.stdout ?? "{}") as { blockers?: string[] };
        assert.deepEqual(report.blockers, ["RP-PILOT-TARGET-ROOT-MISSING"]);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function endpointReport(
  method: "GET" | "POST",
  routePath: string,
  methodName: string,
  model: JavaEndpointGoldenCasePlan["model"],
  nodes: JavaEndpointAnalysisReport["callGraph"]["nodes"]
): JavaEndpointAnalysisReport {
  const selectedRoute = {
    method,
    path: routePath,
    file: "Controller.java",
    line: 10,
    className: "Controller",
    methodName,
    signature: `public Object ${methodName}()`,
    framework: "Spring" as const,
    confidence: "high" as const
  };
  nodes[0]!.route = { method, path: routePath };
  return {
    version: 1,
    createdAt: "2026-07-21T00:00:00.000Z",
    root: "/source",
    endpoint: { method, path: routePath },
    summary: { javaFileCount: 1, routeCount: 1, exactMatchCount: 1, callGraphNodeCount: nodes.length, callGraphEdgeCount: Math.max(0, nodes.length - 1), highRiskCount: 0, goldenCaseCount: 1 },
    matches: [selectedRoute],
    selectedRoute,
    callGraph: {
      nodes,
      edges: nodes.slice(1).map((item, index) => ({
        from: nodes[index]!.id,
        to: item.id,
        call: { method: item.methodName, expression: `${item.className}.${item.methodName}()`, file: nodes[index]!.file, line: 11 + index },
        resolution: "field-injection" as const
      })),
      truncation: { maxDepth: 12, maxTotalEdges: 1000, edgeCapHit: false, depthCapHit: false, maxObservedDepth: nodes.length - 1, nodeDepthCounts: {}, edgeSourceDepthCounts: {}, unexpandedBoundaryNodes: [] }
    },
    riskSignals: [],
    recommendedNextActions: [],
    goldenCasePlan: {
      version: 1,
      model,
      endpoint: { method, path: routePath },
      cases: [{ id: "standard-success", title: "Standard success", requestFocus: [], expectedComparison: ["status"], reason: "baseline", status: "draft" }],
      fixtureTemplate: { headers: {}, body: {} },
      comparisonDimensions: ["status"]
    }
  };
}

function node(id: string, kind: JavaEndpointAnalysisReport["callGraph"]["nodes"][number]["kind"], className: string, methodName: string) {
  return { id, kind, className, methodName, file: `${className}.java`, line: 10, signature: `Object ${methodName}()` };
}
