import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaServicesForRust } from "./serviceRustAssessment.js";

test("service Rust assessment includes implemented methods outside controller reachability", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-rust-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "TaskService.java"), [
      "package demo;", "public interface TaskService {", " Object query(Long id);", " void cancel(Long id);", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "TaskServiceImpl.java"), [
      "package demo;", "public class TaskServiceImpl implements TaskService {", "",
      " public Object query(Long id) {", "  return taskRepository.findById(id);", " }", "",
      " public void cancel(Long id) {", "  taskClient.cancel(id);", " }", "",
      " protected void rebuild() {", "  cacheClient.clear();", " }", "}"
    ].join("\n"));
    const report = await assessJavaServicesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    assert.equal(report.serviceMethodCount, 3);
    assert.equal(report.assessedCount, 3);
    assert.equal(report.methods.some((item) => item.method === "rebuild"), true);
    assert.equal(report.methods.find((item) => item.method === "cancel")?.workload, "idempotent-command");
    assert.equal(report.summary.ready + report.summary.blocked, 3);
    assert.ok(report.methods.every((item) => item.id.includes(":")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
