import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessCrossLayerEvidenceLineage, renderCrossLayerEvidenceLineage } from "./crossLayerEvidenceLineage.js";

test("cross-layer evidence lineage links controller, service, repository, and SQL in one run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-cross-layer-lineage-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const files: Record<string, string[]> = {
      "TaskController.java": ["package demo;", "@RestController", "@RequestMapping(\"/tasks\")", "public class TaskController {", " @Resource", " private TaskService service;", " @GetMapping(\"/find\")", " public Object find(String table) { return service.find(table); }", "}"],
      "TaskService.java": ["package demo;", "@Service", "public class TaskService {", " @Resource", " private TaskRepository repository;", " public Object find(String table) { return repository.find(table); }", "}"],
      "TaskRepository.java": ["package demo;", "public class TaskRepository {", " @Resource", " private TaskMapper mapper;", " public Object find(String table) { return mapper.find(table); }", "}"],
      "TaskMapper.java": ["package demo;", "@Mapper", "public interface TaskMapper {", " @Select(\"select * from ${table}\")", " Object find(String table);", "}"]
    };
    for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    const report = await assessCrossLayerEvidenceLineage({ root: dir, maxDepth: 6, maxEdges: 100 });
    assert.equal(report.assessedCount, 1);
    assert.match(report.runId, /^lineage-/);
    assert.equal(report.sourceRevision, "unversioned");
    assert.equal(report.routes[0]?.status, "blocked");
    assert.equal(report.routes[0]?.serviceNodeIds.length, 1);
    assert.ok((report.routes[0]?.repositoryNodeIds.length ?? 0) >= 1);
    assert.equal(report.routes[0]?.sqlSourceIds.length, 1);
    assert.ok(report.routes[0]?.links.some((link) => link.kind === "sql-source" && link.to.startsWith("annotation:")));
    assert.ok(report.routes[0]?.rootCauses.includes("SQL:table-expansion"));
    assert.equal(report.summary.routesWithSql, 1);
    assert.equal(report.topBlockedRoutes[0]?.downstreamSqlSources, 1);
    assert.match(renderCrossLayerEvidenceLineage(report), /Controller\.find[\s\S]*sql=1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
