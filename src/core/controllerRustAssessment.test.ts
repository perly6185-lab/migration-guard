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
