import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaRepositoriesForRust, renderRepositoryRustAssessment } from "./repositoryRustAssessment.js";

test("repository assessment covers contracts, implementations and persistence mappers only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-repository-rust-"));
  try {
    const files: Record<string, string[]> = {
      "repository/ITaskRepository.java": ["package demo.repository;", "public interface ITaskRepository {", " Object findById(Long id);", " default Object fallback(Long id) { return findById(id); }", "}"],
      "repository/TaskRepositoryImpl.java": ["package demo.repository;", "public class TaskRepositoryImpl implements ITaskRepository {", " public Object findById(Long id) { return mapper.selectById(id); }", " public void delete(Long id) { mapper.deleteById(id); }", "}"],
      "mapper/TaskMapper.java": ["package demo.mapper;", "@Mapper", "public interface TaskMapper extends BaseMapper<Task> {", " @Select(\"select * from task where id = #{id}\")", " Object selectAnnotated(Long id);", " Object selectFromXml(Long id);", " @SelectProvider(type = TaskSqlProvider.class, method = \"dynamicSelect\")", " Object selectViaProvider(String tableName);", " Object selectDynamic(String sql);", "}"],
      "mapper/TaskSqlProvider.java": ["package demo.mapper;", "public class TaskSqlProvider {", " public String dynamicSelect(String tableName) {", "  return \"select * from \" + tableName;", " }", "}"],
      "assembler/TaskMapper.java": ["package demo.assembler;", "@Mapper", "public interface TaskMapper {", " Object convert(Object source);", "}"]
    };
    for (const [name, lines] of Object.entries(files)) { const file = path.join(dir, "demo", name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, lines.join("\n")); }
    const xmlFile = path.join(dir, "resources", "mapper", "TaskMapper.xml");
    await mkdir(path.dirname(xmlFile), { recursive: true });
    await writeFile(xmlFile, [
      "<?xml version=\"1.0\" encoding=\"UTF-8\" ?>",
      "<mapper namespace=\"demo.mapper.TaskMapper\">",
      " <select id=\"selectFromXml\" resultType=\"object\">",
      "  select * from task",
      "  <where><if test=\"tenantId != null\">tenant_id = #{tenantId}</if></where>",
      " </select>",
      "</mapper>"
    ].join("\n"));
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    assert.equal(report.repositoryMethodCount, 7);
    assert.equal(report.methods.some((x) => x.repository.includes("assembler")), false);
    assert.equal(report.methods.find((x) => x.method === "selectAnnotated")?.implementation, "sql-source");
    assert.equal(report.methods.find((x) => x.method === "selectAnnotated")?.status, "ready");
    assert.equal(report.methods.find((x) => x.method === "selectFromXml")?.implementation, "sql-source");
    assert.equal(report.methods.find((x) => x.method === "selectFromXml")?.operation, "dynamic-sql");
    assert.ok(report.methods.find((x) => x.method === "selectFromXml")?.findings.includes("RP-SQL-DYNAMIC-SOURCE"));
    assert.equal(report.methods.find((x) => x.method === "selectViaProvider")?.sqlSourceKinds[0], "provider");
    assert.ok(report.methods.find((x) => x.method === "selectViaProvider")?.findings.includes("RP-SQL-PROVIDER-SOURCE"));
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.implementation, "generated-boundary");
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.status, "blocked");
    assert.equal(report.methods.find((x) => x.method === "fallback")?.implementation, "default");
    assert.equal(report.methods.find((x) => x.method === "delete")?.operation, "delete");
    assert.equal(report.summary.sqlBackedMethods, 3);
    assert.equal(report.summary.sqlSources, 3);
    assert.equal(report.summary.dynamicSqlSources, 2);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.missingSqlContracts, ["branch-fixture", "routing-contract"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectViaProvider")?.missingSqlContracts, ["provider-fragment", "table-expansion"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.sqlOwnershipEvidence[0]?.evidence.dynamicTags, ["if", "where"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectViaProvider")?.sqlOwnershipEvidence[0]?.evidence.providerFragments, ["tableName"]);
    assert.equal(report.summary.missingSqlContracts["branch-fixture"], 1);
    assert.ok(report.methods.find((x) => x.method === "selectFromXml")?.findings.includes("RP-SQL-MISSING-BRANCH-FIXTURE"));
    assert.ok(report.methods.find((x) => x.method === "selectViaProvider")?.findings.includes("RP-SQL-MISSING-PROVIDER-FRAGMENT"));
    assert.match(renderRepositoryRustAssessment(report), /## Missing SQL contracts[\s\S]*branch-fixture: 1/);
    assert.equal(report.sqlMetrics.records, 3);
    assert.equal(report.sqlMetrics.reviewableRecords, 1);
    assert.equal(report.sqlMetrics.replayContractRequiredRecords, 2);
    assert.deepEqual(report.sqlMetrics.sourceKinds, { annotation: 1, "mapper-xml": 1, provider: 1 });
    assert.deepEqual(report.sqlMetrics.operations, { read: 3 });
    assert.deepEqual(report.sqlMetrics.dynamicTags, { if: 1, where: 1 });
    assert.equal(report.sqlMetrics.tables.task, 2);
    assert.equal(report.sqlMetrics.contexts.tenant, 1);
    assert.deepEqual(report.sqlMetrics.transactionParticipation, { "not-transactional": 3 });
    assert.equal(report.sqlMetrics.unresolvedReasons["missing-branch-fixture"], 1);
    assert.equal(report.sqlMetrics.unresolvedReasons["table-not-resolved"], 1);
    assert.match(renderRepositoryRustAssessment(report), /## SQL contract metrics[\s\S]*Reviewable SQL records: 1[\s\S]*### Unresolved SQL reasons/);
    assert.match(renderRepositoryRustAssessment(report), /### Reviewable SQL records[\s\S]*annotation:demo\.mapper\.TaskMapper\.selectAnnotated/);
    assert.match(renderRepositoryRustAssessment(report), /### Replay contract required[\s\S]*missing-branch-fixture/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("BaseMapper inherited overloads remain SQL boundaries instead of unresolved self recursion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-base-mapper-overload-"));
  try {
    const file = path.join(dir, "demo", "TaskMapper.java");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, ["package demo;", "public interface TaskMapper extends BaseMapperX<Task> {", " default Object selectPage(TaskPageReq req) {", "  return selectPage(req, new QueryWrapper<Task>());", " }", " default void clearExternalRef(Long id) { updateById(id); }", " @org.apache.ibatis.annotations.Update(\"<script>\" +", "   \"UPDATE task SET deleted = 0 WHERE id IN \" +", "   \"<foreach collection='ids' item='id'>#{id}</foreach>\" +", "   \"</script>\")", " int restoreDeletedByIds(List<Long> ids);", "}"].join("\n"));
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    const method = report.methods.find((item) => item.method === "selectPage");
    assert.equal(method?.sqlSources, 1);
    assert.equal(method?.findings.includes("RP-GRAPH-UNRESOLVED-EDGES"), false);
    assert.equal(method?.findings.includes("RP-SQL-BASE-MAPPER-GENERATED"), true);
    assert.equal(report.methods.find((item) => item.method === "clearExternalRef")?.operation, "write");
    assert.equal(report.methods.find((item) => item.method === "restoreDeletedByIds")?.implementation, "sql-source");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
