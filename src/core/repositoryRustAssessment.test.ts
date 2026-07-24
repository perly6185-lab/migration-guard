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
      "mapper/Task.java": ["package demo.mapper;", "@TableName(\"task\")", "public class Task {}"],
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
    assert.equal(report.methods.find((x) => x.method === "selectFromXml")?.findings.includes("RP-SQL-DYNAMIC-SOURCE"), false);
    assert.equal(report.methods.find((x) => x.method === "selectViaProvider")?.sqlSourceKinds[0], "provider");
    assert.ok(report.methods.find((x) => x.method === "selectViaProvider")?.findings.includes("RP-SQL-PROVIDER-SOURCE"));
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.implementation, "generated-boundary");
    assert.equal(report.methods.find((x) => x.method === "selectDynamic")?.status, "blocked");
    assert.equal(report.methods.find((x) => x.method === "fallback")?.implementation, "default");
    assert.equal(report.methods.find((x) => x.method === "delete")?.operation, "delete");
    assert.equal(report.summary.sqlBackedMethods, 3);
    assert.equal(report.summary.sqlSources, 3);
    assert.equal(report.summary.dynamicSqlSources, 2);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.missingSqlContracts, []);
    assert.deepEqual(report.methods.find((x) => x.method === "selectViaProvider")?.missingSqlContracts, ["provider-fragment", "table-expansion"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.sqlOwnershipEvidence[0]?.evidence.dynamicTags, ["if", "where"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectViaProvider")?.sqlOwnershipEvidence[0]?.evidence.providerFragments, ["tableName"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.sqlContracts[0]?.branchCases, ["test:tenantId != null=false", "test:tenantId != null=true", "where:content-empty", "where:content-present"]);
    assert.deepEqual(report.methods.find((x) => x.method === "selectFromXml")?.sqlContracts[0]?.routingCases, ["tenant:active", "tenant:mismatch", "tenant:missing-context"]);
    assert.ok(report.methods.find((x) => x.method === "selectViaProvider")?.findings.includes("RP-SQL-MISSING-PROVIDER-FRAGMENT"));
    assert.doesNotMatch(renderRepositoryRustAssessment(report), /## Missing SQL contracts[\s\S]*routing-contract: 1/);
    assert.equal(report.sqlMetrics.records, 3);
    assert.equal(report.sqlMetrics.reviewableRecords, 2);
    assert.equal(report.sqlMetrics.replayContractRequiredRecords, 1);
    assert.deepEqual(report.sqlMetrics.sourceKinds, { annotation: 1, "mapper-xml": 1, provider: 1 });
    assert.deepEqual(report.sqlMetrics.operations, { read: 3 });
    assert.deepEqual(report.sqlMetrics.dynamicTags, { if: 1, where: 1 });
    assert.deepEqual(report.sqlMetrics.branchCases, { "test:tenantId != null=false": 1, "test:tenantId != null=true": 1, "where:content-empty": 1, "where:content-present": 1 });
    assert.equal(report.sqlMetrics.tables.task, 2);
    assert.equal(report.sqlMetrics.contexts.tenant, 1);
    assert.deepEqual(report.sqlMetrics.transactionParticipation, { "not-transactional": 3 });
    assert.equal(report.sqlMetrics.unresolvedReasons["missing-routing-contract"] ?? 0, 0);
    assert.equal(report.sqlMetrics.unresolvedReasons["table-not-resolved"], 1);
    assert.match(renderRepositoryRustAssessment(report), /## SQL contract metrics[\s\S]*Reviewable SQL records: 2[\s\S]*### Unresolved SQL reasons/);
    assert.match(renderRepositoryRustAssessment(report), /### Reviewable SQL records[\s\S]*annotation:demo\.mapper\.TaskMapper\.selectAnnotated/);
    assert.match(renderRepositoryRustAssessment(report), /### Replay contract required[\s\S]*missing-provider-fragment/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("BaseMapper inherited overloads remain SQL boundaries instead of unresolved self recursion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-base-mapper-overload-"));
  try {
    const file = path.join(dir, "demo", "TaskMapper.java");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, ["package demo;", "public interface TaskMapper extends BaseMapperX<Task> {", " default Object selectPage(TaskPageReq req) {", "  return selectPage(req, new QueryWrapper<Task>());", " }", " default void clearExternalRef(Long id) { updateById(id); }", " default void replaceAll(List<Task> rows) {", "  deleteByIds(rows);", "  insertBatch(rows);", "  updateBatch(rows);", "  selectByIds(rows);", " }", " default void logOnly() { String message = \"replaceAll(rows)\"; }", " default void invalidateAll(List<Task> rows) { rows.forEach(this::invalidate); rows.forEach(row -> invalidate(row)); }", " default void invalidate(Task row) {}", " default void invalidate(List<Task> rows) {}", " Object selectDeletedDataByTenantId(Long tenantId);", " int recoverDataByTenantId(Long tenantId);", " @org.apache.ibatis.annotations.Update(\"<script>\" +", "   \"UPDATE task SET deleted = 0 WHERE id IN \" +", "   \"<foreach collection='ids' item='id'>#{id}</foreach>\" +", "   \"</script>\")", " int restoreDeletedByIds(List<Long> ids);", "}", "@TableName(\"task\")", "class Task {}"].join("\n"));
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    const method = report.methods.find((item) => item.method === "selectPage");
    assert.equal(method?.sqlSources, 1);
    assert.equal(method?.findings.includes("RP-GRAPH-UNRESOLVED-EDGES"), false);
    assert.equal(method?.findings.includes("RP-SQL-BASE-MAPPER-GENERATED"), false);
    assert.equal(method?.sqlContracts[0]?.generatedContract?.table, "task");
    assert.equal(report.methods.find((item) => item.method === "clearExternalRef")?.operation, "write");
    assert.equal(report.methods.find((item) => item.method === "restoreDeletedByIds")?.implementation, "sql-source");
    assert.equal(report.methods.find((item) => item.method === "replaceAll")?.findings.includes("RP-GRAPH-UNRESOLVED-EDGES"), false);
    assert.equal(report.methods.find((item) => item.method === "invalidateAll")?.findings.includes("RP-GRAPH-AMBIGUOUS-CALLS"), false);
    assert.equal(report.methods.find((item) => item.method === "selectDeletedDataByTenantId")?.implementation, "sql-source");
    assert.equal(report.methods.find((item) => item.method === "selectDeletedDataByTenantId")?.sqlContracts[0]?.generatedContract?.predicate, "method-convention");
    assert.equal(report.methods.find((item) => item.method === "recoverDataByTenantId")?.sqlContracts[0]?.generatedContract?.evidence, "table-annotation+method-convention");
    assert.equal(report.methods.find((item) => item.method === "logOnly")?.findings.includes("RP-GRAPH-UNRESOLVED-EDGES"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("large persistence wrapper property chains remain complete SQL contracts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-wrapper-property-chain-"));
  try {
    const file = path.join(dir, "demo", "WideTaskMapper.java");
    await mkdir(path.dirname(file), { recursive: true });
    const predicates = Array.from({ length: 45 }, (_, index) =>
      `   .eqIfPresent(WideTask::getField${index}, req.getField${index}())`
    );
    await writeFile(file, [
      "package demo;",
      "public interface WideTaskMapper extends BaseMapperX<WideTask> {",
      " default Object selectPage(WideTaskPageReq req) {",
      "  return selectPage(req, new LambdaQueryWrapperX<WideTask>()",
      ...predicates,
      "   .orderByDesc(WideTask::getId));",
      " }",
      "}",
      "@TableName(\"wide_task\")",
      "class WideTask {}",
      "class WideTaskPageReq {}"
    ].join("\n"));
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100, adaptive: true });
    const method = report.methods.find((item) => item.method === "selectPage");
    assert.equal(method?.status, "ready");
    assert.equal(method?.findings.includes("RP-GRAPH-PER-METHOD-CALL-CAP"), false);
    assert.equal(method?.sqlContracts[0]?.generatedContract?.predicate, "wrapper");
    assert.equal(method?.sqlContracts[0]?.reviewStatus, "reviewable");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dynamic table and statement expansions synthesize replay cases while tableless SQL stays reviewable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-sql-expansion-"));
  try {
    const mapper = path.join(dir, "demo", "mapper", "DynamicMapper.java");
    await mkdir(path.dirname(mapper), { recursive: true });
    await writeFile(mapper, [
      "package demo.mapper;", "@Mapper", "public interface DynamicMapper {",
      " Object selectBySql(String sql);",
      " Long lastInsertId();",
      " Object selectDynamicTable(String tableName);", "}"
    ].join("\n"));
    const xml = path.join(dir, "resources", "DynamicMapper.xml");
    await mkdir(path.dirname(xml), { recursive: true });
    await writeFile(xml, ["<mapper namespace=\"demo.mapper.DynamicMapper\">", "<select id=\"selectBySql\">${sql}</select>", "<select id=\"lastInsertId\">select last_insert_id()</select>", "<select id=\"selectDynamicTable\">select * from ${tableName}</select>", "</mapper>"].join("\n"));
    const report = await assessJavaRepositoriesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    assert.deepEqual(report.methods.map((item) => item.method).sort(), ["lastInsertId", "selectBySql", "selectDynamicTable"]);
    const statement = report.methods.find((item) => item.method === "selectBySql")!;
    const tableless = report.methods.find((item) => item.method === "lastInsertId")!;
    const table = report.methods.find((item) => item.method === "selectDynamicTable")!;
    assert.equal(statement.sqlContracts[0].tableResolution, "statement-expansion");
    assert.deepEqual(statement.sqlContracts[0].statementExpansionCases, ["${sql}:invalid-statement", "${sql}:multi-statement-rejected", "${sql}:valid-statement"]);
    assert.equal(tableless.sqlContracts[0].tableResolution, "tableless");
    assert.equal(table.sqlContracts[0].tableResolution, "resolved");
    assert.deepEqual(table.sqlContracts[0].tableExpansionCases, ["${tableName}:invalid-identifier", "${tableName}:known-identifier", "${tableName}:unknown-identifier"]);
    assert.equal(report.summary.findings["RP-SQL-DYNAMIC-SOURCE"] ?? 0, 0);
    assert.equal(report.summary.findings["RP-SQL-TABLE-UNRESOLVED"] ?? 0, 0);
    assert.equal(report.summary.missingSqlContracts["table-expansion"] ?? 0, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
