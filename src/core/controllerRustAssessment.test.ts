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
