import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  compareContextEnvelopes,
  compareStatefulReplay,
  createFullReplacementClosure,
  createRefreshSyncPilotPlan,
  DeterministicRefreshCoordinator,
  evaluateFullReplacementReadiness,
  replayConcurrencySchedule,
  replayRefreshFault,
  runRuntimeDriver,
  upgradeGoldenPlan,
  validateContextEnvelope,
  validateEffectTrace,
  type EffectTrace,
  type ReplayObservation,
  type RuntimeContextEnvelope
} from "./fullReplacement.js";
import type { JavaEndpointAnalysisReport } from "./javaEndpointAnalysis.js";
import type { CrossLanguageProjectInventory } from "./crossLanguageAdapters.js";

const execFileAsync = promisify(execFile);

function javaReport(overrides: Partial<JavaEndpointAnalysisReport["callGraph"]["truncation"]> = {}): JavaEndpointAnalysisReport {
  return {
    version: 1, createdAt: "2026-07-20T00:00:00.000Z", root: "/java", endpoint: { method: "POST", path: "/refreshSync" },
    summary: { javaFileCount: 2, routeCount: 1, exactMatchCount: 1, callGraphNodeCount: 2, callGraphEdgeCount: 1, highRiskCount: 0, goldenCaseCount: 1 },
    matches: [], callGraph: {
      nodes: [
        { id: "Controller.refreshSync", kind: "controller", className: "Controller", methodName: "refreshSync", file: "Controller.java", line: 10 },
        { id: "Service.sync", kind: "service", className: "Service", methodName: "sync", file: "Service.java", line: 20 }
      ],
      edges: [{ from: "Controller.refreshSync", to: "Service.sync", call: { receiver: "service", method: "sync", expression: "service.sync()", file: "Controller.java", line: 11 }, resolution: "field-injection" }],
      truncation: { maxDepth: 5, maxTotalEdges: 100, edgeCapHit: false, depthCapHit: false, maxObservedDepth: 1, nodeDepthCounts: { "0": 1, "1": 1 }, edgeSourceDepthCounts: { "0": 1 }, unexpandedBoundaryNodes: [], ...overrides }
    }, sqlSources: [], riskSignals: [], recommendedNextActions: [],
    goldenCasePlan: {
      version: 1, model: "sync-command", endpoint: { method: "POST", path: "/refreshSync" },
      cases: [{ id: "manual-refresh-success", title: "manual", requestFocus: [], expectedComparison: ["status"], reason: "fixture", status: "draft" }],
      fixtureTemplate: { headers: { authorization: "Bearer secret-token" }, body: {} }, comparisonDimensions: []
    }
  };
}

function rustInventory(unresolved = false): CrossLanguageProjectInventory {
  return {
    root: "/rust", detectedAt: "2026-07-20T00:00:00.000Z", primaryLanguage: "rust", languageConfidence: "high",
    languages: [{ id: "rust", sourceFiles: 1, testFiles: 0, frameworks: ["Axum"], buildFiles: ["Cargo.toml"], reasons: [] }],
    routes: [{ method: "POST", path: "/refreshSync", file: "src/main.rs", line: 5, framework: "Axum", confidence: "high" }],
    unresolvedRoutes: unresolved ? [{ code: "unsupported-rust-route-syntax", file: "src/main.rs", line: 9, framework: "Axum", syntax: ".route(path(), post(x))", reason: "dynamic" }] : [],
    recommendedChecks: ["cargo check --all-targets", "cargo test --all-targets"]
  };
}

test("replacement closure fails closed and produces stable hashes", () => {
  const blocked = createFullReplacementClosure({ java: javaReport({ depthCapHit: true, unexpandedBoundaryNodes: ["Service.sync"] }), rust: rustInventory(true) });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.findings.some((item) => item.code === "FR-CLOSURE-JAVA-TAIL"));
  assert.ok(blocked.findings.some((item) => item.code === "FR-CLOSURE-DEPTH-CAP"));
  const evidence = {
    "Controller.refreshSync": [{ kind: "handler" as const, file: "src/main.rs", symbol: "refresh_sync" }],
    "Service.sync": [{ kind: "branch" as const, file: "src/sync.rs", symbol: "sync" }]
  };
  const first = createFullReplacementClosure({ java: javaReport(), rust: rustInventory(), targetEvidence: evidence });
  const second = createFullReplacementClosure({ java: javaReport(), rust: rustInventory(), targetEvidence: evidence });
  assert.equal(first.status, "passed");
  assert.equal(first.manifestHash, second.manifestHash);
});

test("context envelope blocks missing isolation fields and redacts secrets", () => {
  const source: RuntimeContextEnvelope = { version: 1, fields: {
    tenant: { value: "tenant-a", provenance: "header", required: true, defaultBehavior: "reject", consumedBy: ["refresh_sync"] },
    user: { provenance: "security", required: true, defaultBehavior: "reject", consumedBy: ["refresh_sync"] },
    datasource: { provenance: "routing", required: true, defaultBehavior: "reject", consumedBy: ["database_port"] },
    request: { value: { authorization: "Bearer top-secret", requestId: "r1" }, provenance: "gateway", required: true, defaultBehavior: "reject", consumedBy: ["request_middleware"] }
  } };
  const validation = validateContextEnvelope(source);
  assert.equal(validation.passed, false);
  assert.ok(validation.findings.some((item) => item.code === "FR-CONTEXT-REQUIRED-MISSING"));
  assert.doesNotMatch(JSON.stringify(validation), /top-secret/);
  const target = structuredClone(source); target.fields.tenant!.value = "tenant-b";
  assert.deepEqual(compareContextEnvelopes(source, target).map((item) => item.field), ["tenant"]);
});

function effectTrace(): EffectTrace {
  return { version: 1, fixtureHash: "fixture", bounded: true, redacted: true, complete: true, effects: [
    { kind: "database", phase: "sync", sequence: 1, resourceKey: "panel:1", operation: "sync", outcome: "applied", errorPolicy: "result-affecting", transactionGroup: "tx1", logicalTimestamp: "t1" },
    { kind: "database", phase: "timestamp", sequence: 2, resourceKey: "panel:1", operation: "update", outcome: "applied", errorPolicy: "result-affecting", transactionGroup: "tx2", logicalTimestamp: "t2" },
    { kind: "undo", phase: "post", sequence: 3, resourceKey: "panel:1", operation: "clear", outcome: "applied", errorPolicy: "result-affecting", logicalTimestamp: "t3" },
    { kind: "reconcile", phase: "post", sequence: 4, resourceKey: "panel:1", operation: "reconcile", outcome: "ignored-failure", errorPolicy: "ignored", logicalTimestamp: "t4" }
  ] };
}

test("ordered effect validation accepts refresh order and rejects unknown effects", () => {
  assert.equal(validateEffectTrace(effectTrace()).passed, true);
  const unknown = effectTrace(); unknown.effects[0].kind = "mystery";
  assert.ok(validateEffectTrace(unknown).findings.some((item) => item.code === "FR-EFFECT-KIND-UNKNOWN"));
});

test("golden v2 keeps case ids, adds failure cases, and removes secret fixture values", () => {
  const upgraded = upgradeGoldenPlan(javaReport().goldenCasePlan);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.cases[0].id, "manual-refresh-success");
  assert.ok(upgraded.cases.some((item) => item.id === "undo-clear-failure"));
  assert.ok(upgraded.cases.some((item) => item.id === "tenant-context"));
  assert.ok(upgraded.cases.some((item) => item.id === "user-context"));
  assert.ok(upgraded.cases.some((item) => item.id === "datasource-context"));
  assert.equal(upgraded.cases.every((item) => item.ownership === "target-owned"), true);
  assert.doesNotMatch(JSON.stringify(upgraded), /secret-token/);
});

function observation(effects = effectTrace()): ReplayObservation {
  return {
    caseId: "manual-refresh-success", fixtureHash: "fixture", http: { status: 200, body: true },
    context: { version: 1, fields: { tenant: { value: "t1", provenance: "header", required: true, defaultBehavior: "reject", consumedBy: ["refresh_sync"] } } },
    decisions: ["manual"], effects, state: { "panel:1": "after-hash" }, events: [{ name: "started", sequence: 1 }, { name: "completed", sequence: 2, terminal: true }],
    concurrency: { deduplicated: true }, failures: { outcome: "none" }, cleanup: { passed: true }
  };
}

test("stateful replay fails when HTTP matches but undo or progress differs", () => {
  const source = observation(); const target = observation(); target.effects = effectTrace(); target.effects.effects.splice(2, 1); target.events.splice(0, 1);
  const comparison = compareStatefulReplay(source, target);
  assert.equal(comparison.status, "failed");
  assert.ok(comparison.differences.some((item) => item.dimension === "effects"));
  assert.ok(comparison.differences.some((item) => item.dimension === "events"));
});

test("deterministic schedules cover dedup, batch skip, and lease expiry", () => {
  const duplicate = replayConcurrencySchedule({ kind: "manual-manual", steps: [
    { actor: "a", barrier: "start", action: "acquire" }, { actor: "b", barrier: "start", action: "acquire" },
    { actor: "a", barrier: "run", action: "invoke" }, { actor: "a", barrier: "done", action: "release" }
  ] });
  assert.equal(duplicate.passed, true); assert.equal(duplicate.executions, 1); assert.deepEqual(duplicate.blockedActors, ["b"]);
  const batch = replayConcurrencySchedule({ kind: "batch-inflight", steps: [{ actor: "a", barrier: "start", action: "acquire" }] });
  assert.equal(batch.passed, true); assert.deepEqual(batch.effects, []);
  const crash = replayConcurrencySchedule({ kind: "auto-auto", steps: [{ actor: "a", barrier: "x", action: "acquire" }, { actor: "a", barrier: "x", action: "crash" }, { actor: "clock", barrier: "expiry", action: "expire" }] });
  assert.equal(crash.leaseReleased, true);
});

test("coordinator preserves manual priority, fencing, heartbeat, and crash expiry", () => {
  const coordinator = new DeterministicRefreshCoordinator();
  const auto = coordinator.acquire("auto-1", "auto", 2).lease!;
  assert.equal(coordinator.heartbeat("auto-1", auto.fencingToken, 3), true);
  const manual = coordinator.acquire("manual-1", "manual", 2);
  assert.equal(manual.acquired, true); assert.equal(manual.preempted, "auto-1");
  assert.equal(coordinator.heartbeat("auto-1", auto.fencingToken, 3), false);
  assert.equal(coordinator.acquire("auto-2", "auto", 2).acquired, false);
  coordinator.crash("manual-1"); coordinator.advance(2);
  assert.equal(coordinator.current(), undefined);
  assert.ok(coordinator.acquire("auto-2", "auto", 2).lease!.fencingToken > manual.lease!.fencingToken);
});

test("fault replay distinguishes result-affecting undo from ignored reconcile", () => {
  const undo = replayRefreshFault("undo-clear");
  assert.equal(undo.result, "failed");
  assert.ok(undo.committedPhases.includes("timestamp-update"));
  const reconcile = replayRefreshFault("reconcile");
  assert.equal(reconcile.result, "success");
  assert.equal(reconcile.effects.at(-1)?.outcome, "ignored-failure");
  assert.equal(reconcile.terminalEvents, 1);
});

test("FR readiness remains blocked until source-off, performance, freshness, and rollback pass", () => {
  const closure = createFullReplacementClosure({ java: javaReport(), rust: rustInventory(), targetEvidence: {
    "Controller.refreshSync": [{ kind: "handler", file: "src/main.rs", symbol: "refresh_sync" }],
    "Service.sync": [{ kind: "branch", file: "src/sync.rs", symbol: "sync" }]
  } });
  const comparison = compareStatefulReplay(observation(), observation());
  const base = {
    routeMatched: true, closure, contextsPassed: true, statefulComparisons: [comparison], concurrencyPassed: true, faultReplayPassed: true,
    sourceOff: { sourceUnavailable: false, targetHealthy: true, callbacksToJava: 0 }, evidenceCreatedAt: "2026-07-20T00:00:00.000Z", maxEvidenceAgeMs: 86_400_000,
    performance: { throughput: 100, p95Ms: 20, p99Ms: 30, memoryMb: 100, errorRate: 0 }, performanceBudget: { minThroughput: 50, maxP95Ms: 50, maxP99Ms: 80, maxMemoryMb: 200, maxErrorRate: 0.01 },
    rollback: { target: "java-route", triggers: ["error-rate"], reviewedAt: "2026-07-20T00:00:00.000Z" }
  };
  assert.equal(evaluateFullReplacementReadiness(base, Date.parse("2026-07-20T01:00:00.000Z")).achievedLevel, "FR4");
  assert.ok(evaluateFullReplacementReadiness(base, Date.parse("2026-07-20T01:00:00.000Z")).issuePlan.some((item) => item.finding === "FR5-SOURCE-STILL-AVAILABLE"));
  base.sourceOff.sourceUnavailable = true;
  assert.equal(evaluateFullReplacementReadiness(base, Date.parse("2026-07-20T01:00:00.000Z")).achievedLevel, "FR5");
});

test("refreshSync pilot is executable only with both real project roots", () => {
  const blocked = createRefreshSyncPilotPlan({});
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.endpoint.path, "/zboss/data/view/dynamic/engine/use/engine-use-page/refreshSync");
  assert.equal(blocked.requiredSchedules.length, 5);
  assert.equal(createRefreshSyncPilotPlan({ javaRoot: "/java", rustRoot: "/rust" }).status, "ready-to-run");
});

test("full-replacement CLI pilot fails closed when real roots are missing", async () => {
  const cli = path.resolve(import.meta.dirname, "../cli.js");
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "full-replacement", "pilot", "--json"]),
    (error: unknown) => {
      const result = error as { code?: number; stdout?: string };
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout ?? "{}") as { status?: string; blockers?: string[] };
      assert.equal(report.status, "blocked");
      assert.deepEqual(report.blockers, ["MG201-JAVA-ROOT-MISSING", "MG201-RUST-ROOT-MISSING"]);
      return true;
    }
  );
});

test("command runtime driver validates output and always executes stop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-runtime-driver-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "driver.mjs"), [
      "import { appendFileSync } from 'node:fs';",
      "const [op, caseId] = process.argv.slice(2);",
      "appendFileSync('operations.log', op + '\\n');",
      "if (op === 'collect') console.log(JSON.stringify({",
      "  caseId, fixtureHash: 'fixture', http: { status: 200 },",
      "  context: { version: 1, fields: { tenant: { value: 't1', provenance: 'header', required: true, defaultBehavior: 'reject', consumedBy: ['refresh_sync'] } } },",
      "  decisions: ['manual'], effects: { version: 1, fixtureHash: 'fixture', bounded: true, redacted: true, complete: true, effects: [] },",
      "  state: {}, events: [{ name: 'done', sequence: 1, terminal: true }], concurrency: {}, failures: {}, cleanup: { passed: true }",
      "}));"
    ].join("\n"));
    const operations = Object.fromEntries(["start", "health", "reset", "invoke", "snapshot", "collect", "injectFault", "stop"].map((op) => [op, `node driver.mjs ${op} {caseId}`])) as Record<"start" | "health" | "reset" | "invoke" | "snapshot" | "collect" | "injectFault" | "stop", string>;
    const result = await runRuntimeDriver({ id: "fixture", root: dir, timeoutMs: 5_000, operations }, "case-1");
    assert.equal(result.status, "passed");
    assert.equal(result.observations?.caseId, "case-1");
    const log = await import("node:fs/promises").then((fs) => fs.readFile(path.join(dir, "operations.log"), "utf8"));
    assert.match(log, /start[\s\S]*collect[\s\S]*stop/);

    await writeFile(path.join(dir, "bad.mjs"), "console.log('{}');\n");
    const bad = await runRuntimeDriver({ id: "bad", root: dir, timeoutMs: 5_000, operations: { ...operations, collect: "node bad.mjs", stop: "node driver.mjs stop case-1" } }, "case-1");
    assert.equal(bad.status, "blocked");
    assert.ok(bad.findings.includes("FR-DRIVER-CASE-LINEAGE-INVALID"));

    const unsafe = await runRuntimeDriver({ id: "unsafe", root: dir, timeoutMs: 5_000, operations }, "case-1 && echo injected");
    assert.equal(unsafe.status, "blocked");
    assert.deepEqual(unsafe.findings, ["FR-DRIVER-CASE-ID-UNSAFE"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
