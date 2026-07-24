import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaControllersForRust } from "./controllerRustAssessment.js";

test("controller Rust assessment analyzes normalized routes and aggregates strict blockers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-rust-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "TaskController.java"), [
      "package demo;", "@RestController", "@RequestMapping(\"/api/tasks\")", "public class TaskController {", "",
      " @PostMapping(\"/cancel\")", " public Object cancel() {", "  taskClient.cancel();", "  return null;", " }", "",
      " @GetMapping(\"/get\")", " public Object get() {", "  return null;", " }", "}"
    ].join("\n"));
    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    assert.equal(report.routeCount, 2);
    assert.equal(report.assessedCount, 2);
    assert.equal(report.methods.find((item) => item.path === "/api/tasks/cancel")?.workload, "idempotent-command");
    assert.equal(report.methods.find((item) => item.path === "/api/tasks/cancel")?.externalBoundaries, 1);
    assert.equal(report.summary.ready + report.summary.blocked, 2);
    assert.equal(report.summary.transactionSelfInvocationEdges, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment reports deduplicated transaction self-invocation evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-transaction-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "TransactionController.java"), [
      "package demo;", "@RestController", "public class TransactionController {",
      " @GetMapping(\"/tx\")", " public Object run() { return outer(); }",
      " @Transactional(rollbackFor = Exception.class)", " public Object outer() { return inner(); }",
      " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object inner() { return null; }", "}"
    ].join("\n"));
    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 20 });
    assert.equal(report.summary.transactionSelfInvocationEdges, 2);
    assert.deepEqual(report.methods[0]?.transactionSelfInvocationReasons, ["requires-new-boundary-bypassed", "transaction-boundary-bypassed"]);
    assert.ok(report.methods[0]?.transactionSelfInvocations.some((item) => /outer -> TransactionController\.inner/.test(item)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment accepts only exact reviewed equivalent transaction self-calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-reviewed-transaction-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "AiEmpowerConfigBizServiceImpl.java"), [
      "package demo;", "public class AiEmpowerConfigBizServiceImpl {",
      " @Transactional(rollbackFor = Exception.class)", " public Object saveAiEmpowerConfig() { return deleteByFieldId(); }",
      " @Transactional(rollbackFor = Exception.class)", " public Object deleteByFieldId() { return null; }", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "ReviewedController.java"), [
      "package demo;", "@RestController", "public class ReviewedController {", " @Resource", " private AiEmpowerConfigBizServiceImpl service;",
      " @GetMapping(\"/reviewed\")", " public Object run() { return service.saveAiEmpowerConfig(); }", "}"
    ].join("\n"));
    const reviewed = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 20 });
    assert.equal(reviewed.summary.findings["RP-GRAPH-TRANSACTION-SELF-INVOCATION"] ?? 0, 0);

    await writeFile(path.join(dir, "demo", "OtherService.java"), [
      "package demo;", "public class OtherService {",
      " @Transactional(rollbackFor = Exception.class)", " public Object saveAiEmpowerConfig() { return deleteByFieldId(); }",
      " @Transactional(rollbackFor = Exception.class)", " public Object deleteByFieldId() { return null; }", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "OtherController.java"), [
      "package demo;", "@RestController", "public class OtherController {", " @Resource", " private OtherService service;",
      " @GetMapping(\"/other\")", " public Object run() { return service.saveAiEmpowerConfig(); }", "}"
    ].join("\n"));
    const exactOnly = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 20 });
    assert.ok(exactOnly.methods.find((item) => item.path === "/other")?.findings.includes("RP-GRAPH-TRANSACTION-SELF-INVOCATION"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller Rust assessment adaptively expands truncated call graphs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-adaptive-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "ChainController.java"), [
      "package demo;", "@RestController", "public class ChainController {",
      " @GetMapping(\"/chain\")", " public Object run() { return one(); }",
      " private Object one() { return two(); }",
      " private Object two() { return three(); }",
      " private Object three() { return null; }", "}"
    ].join("\n"));
    const fixed = await assessJavaControllersForRust({ root: dir, maxDepth: 2, maxEdges: 2 });
    assert.ok((fixed.summary.findings["RP-GRAPH-EDGE-CAP"] ?? 0) > 0);
    const adaptive = await assessJavaControllersForRust({ root: dir, maxDepth: 2, maxEdges: 2, adaptive: true, maxExpansionDepth: 8, maxExpansionEdges: 20, maxExpansionRounds: 3 });
    assert.equal(adaptive.summary.findings["RP-GRAPH-EDGE-CAP"] ?? 0, 0);
    assert.equal(adaptive.summary.adaptivelyExpanded, 1);
    assert.equal(adaptive.methods[0]?.expansionStatus, "complete");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment inventories and ranks shared unclassified boundaries without changing readiness", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-boundary-inventory-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "SharedService.java"), [
      "package demo;", "@Service", "public class SharedService {",
      " public Object opaqueTransform() { return innerOpaque(); }",
      " private Object innerOpaque() { return null; }", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "InventoryController.java"), [
      "package demo;", "@RestController", "public class InventoryController {", " @Resource", " private SharedService service;",
      " @GetMapping(\"/inventory/one\")", " public Object one() { return service.opaqueTransform(); }",
      " @GetMapping(\"/inventory/two\")", " public Object two() { return service.opaqueTransform(); }", "}"
    ].join("\n"));

    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 40 });
    const shared = report.unclassifiedBoundaryInventory.find((item) => item.symbol === "SharedService.opaqueTransform");
    const nested = report.unclassifiedBoundaryInventory.find((item) => item.symbol === "SharedService.innerOpaque");

    assert.equal(report.summary.ready, 0);
    assert.equal(report.summary.blocked, 2);
    assert.equal(report.summary.unclassifiedBoundaryInventory.affectedRoutes, 2);
    assert.equal(shared?.affectedRoutes.length, 2);
    assert.equal(shared?.occurrences, 2);
    assert.equal(shared?.minDepth, 1);
    assert.equal(nested?.minDepth, 2);
    assert.equal(report.unclassifiedBoundaryInventory[0]?.symbol, "SharedService.innerOpaque");
    assert.match(report.reportHash, /^[a-f0-9]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
