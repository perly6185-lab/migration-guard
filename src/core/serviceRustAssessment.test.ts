import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaServicesForRust } from "./serviceRustAssessment.js";
import { createJavaEndpointAnalyzer } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";

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

test("Java call resolution selects overloads by arity and type and blocks ambiguity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-overloads-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "OverloadService.java"), [
      "package demo;", "public class OverloadService {", "",
      " public Object run(Long id) {", "  select(id);", "  return select(id, \"active\");", " }", "",
      " protected Object select(Long id) {", "  return null;", " }", "",
      " protected Object select(Long id, String state) {", "  return null;", " }", "",
      " public Object typed() {", "  return choose(1L);", " }", "",
      " public Object ambiguous() {", "  return choose(null);", " }", "",
      " protected Object choose(Long value) {", "  return null;", " }", "",
      " protected Object choose(String value) {", "  return null;", " }", "}"
    ].join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const run = analyzer.serviceMethods.find((item) => item.methodName === "run")!;
    const runReport = analyzer.analyzeServiceMethod(run, { maxDepth: 4, maxEdges: 100 });
    assert.equal(runReport.callGraph.nodes.filter((item) => item.methodName === "select").length, 2);
    assert.equal(runReport.callGraph.edges.some((edge) => edge.resolution === "ambiguous"), false);
    const typed = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.methodName === "typed")!, { maxDepth: 4, maxEdges: 100 });
    assert.match(typed.callGraph.nodes.find((item) => item.methodName === "choose")?.signature ?? "", /Long value/);
    const ambiguous = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.methodName === "ambiguous")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(ambiguous.callGraph.edges.some((edge) => edge.resolution === "ambiguous"), true);
    assert.equal(ambiguous.callGraph.edges.find((edge) => edge.resolution === "ambiguous")?.resolutionCandidates?.length, 2);
    const planned = createEndpointReplacementPlanFromJava(ambiguous);
    assert.equal(planned.plan.status, "blocked");
    assert.ok(planned.plan.findings.includes("RP-GRAPH-AMBIGUOUS-CALLS"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Java call resolution covers multiline arguments, static imports, generic factories, widening, boxing, and varargs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-receiver-types-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const files: Record<string, string[]> = {
      "Worker.java": ["package demo;", "public class Worker {", " public Object execute(long value) { return null; }", " public Object process(Long value, String state) { return null; }", "}"],
      "Factory.java": ["package demo;", "public interface Factory<T> {", " T create();", "}"],
      "StaticTools.java": ["package demo;", "public class StaticTools {", " public static Object normalize(long value) { return null; }", " public static Object normalize(String value) { return null; }", "}"],
      "ResolutionService.java": [
        "package demo;", "import static demo.StaticTools.normalize;", "import static external.Results.success;", "import static external.Constants.*;", "public class ResolutionService {", " @Resource", " private Worker worker;", " @Resource", " private Factory<Worker> factory;",
        " public Object run() {", "  worker.process(", "    1L,", "    \"ready\"", "  );", "  factory.create().execute(1);", "  normalize(1);", "  success(new Payload());", "  collect(\"batch\", 1L, 2L);", "  return null;", " }",
        " protected Object collect(String name, Long... values) { return null; }", "}"
      ],
      "Payload.java": ["package demo;", "public class Payload {}"]
    };
    for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const report = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ResolutionService" && item.methodName === "run")!, { maxDepth: 5, maxEdges: 100 });
    assert.ok(report.callGraph.nodes.some((item) => item.className === "Worker" && item.methodName === "process"));
    assert.ok(report.callGraph.nodes.some((item) => item.className === "Worker" && item.methodName === "execute"));
    assert.ok(report.callGraph.nodes.some((item) => item.className === "StaticTools" && item.methodName === "normalize" && /long value/.test(item.signature ?? "")));
    assert.ok(report.callGraph.nodes.some((item) => item.className === "ResolutionService" && item.methodName === "collect"));
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "success")?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.some((edge) => edge.call.method === "Payload"), false);
    assert.equal(report.callGraph.edges.some((edge) => edge.resolution === "ambiguous"), false, JSON.stringify(report.callGraph.edges.filter((edge) => edge.resolution === "ambiguous"), null, 2));
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "process")?.call.argumentCount, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adaptive Service analysis expands only while graph budgets can progress", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-adaptive-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "ChainService.java"), [
      "package demo;", "public class ChainService {", "",
      " public Object start() {", "  return stepOne();", " }", "",
      " protected Object stepOne() {", "  return stepTwo();", " }", "",
      " protected Object stepTwo() {", "  return stepThree();", " }", "",
      " protected Object stepThree() {", "  return null;", " }", "}"
    ].join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const start = analyzer.serviceMethods.find((item) => item.methodName === "start")!;
    const expanded = analyzer.analyzeServiceMethodAdaptive(start, { initialDepth: 1, initialEdges: 10, maxDepth: 8, maxEdges: 100, maxRounds: 4 });
    assert.equal(expanded.status, "complete");
    assert.ok(expanded.rounds.length > 1);
    assert.equal(expanded.rounds.at(-1)?.complete, true);
    const exhausted = analyzer.analyzeServiceMethodAdaptive(start, { initialDepth: 1, initialEdges: 10, maxDepth: 1, maxEdges: 10, maxRounds: 2 });
    assert.equal(exhausted.status, "budget-exhausted");
    assert.equal(exhausted.rounds.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("advanced Java semantics cover inheritance, qualifiers, defaults, transactions, and language features", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-semantics-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const files: Record<string, string[]> = {
      "BaseService.java": ["package demo;", "public class BaseService {", " protected Object inherited() {", "  return null;", " }", "}"],
      "ChildService.java": ["package demo;", "public class ChildService extends BaseService {", " public Object run() {", "  return inherited();", " }", "}"],
      "Worker.java": ["package demo;", "public interface Worker {", " Object execute();", "}"],
      "FastWorkerImpl.java": ["package demo;", "public class FastWorkerImpl implements Worker {", " public Object execute() {", "  return null;", " }", "}"],
      "SlowWorkerImpl.java": ["package demo;", "public class SlowWorkerImpl implements Worker {", " public Object execute() {", "  return null;", " }", "}"],
      "QualifiedService.java": ["package demo;", "public class QualifiedService {", " @Resource", " @Qualifier(\"fastWorker\")", " private Worker worker;", " public Object run() {", "  return worker.execute();", " }", "}"],
      "AmbiguousService.java": ["package demo;", "public class AmbiguousService {", " @Resource", " private Worker worker;", " public Object run() {", "  return worker.execute();", " }", "}"],
      "DefaultWorker.java": ["package demo;", "public interface DefaultWorker {", " default Object execute() {", "  return null;", " }", "}"],
      "DefaultService.java": ["package demo;", "public class DefaultService {", " @Resource", " private DefaultWorker worker;", " public Object run() {", "  return worker.execute();", " }", "}"],
      "TransactionService.java": ["package demo;", "public class TransactionService {", " @Transactional", " public Object save() {", "  return null;", " }", " public Object run() {", "  return save();", " }", "}"],
      "LambdaService.java": ["package demo;", "public class LambdaService {", " public Object run() {", "  items.forEach(item -> process(item));", "  return items.stream().map(this::convert);", " }", " protected void process(Object item) {", " }", " protected Object convert(Object item) {", "  return item;", " }", "}"]
    };
    for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const analyze = (className: string) => analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === className && item.methodName === "run")!, { maxDepth: 5, maxEdges: 200 });
    assert.ok(analyze("ChildService").callGraph.nodes.some((item) => item.className === "BaseService" && item.methodName === "inherited"));
    assert.ok(analyze("QualifiedService").callGraph.nodes.some((item) => item.className === "FastWorkerImpl"));
    assert.equal(analyze("QualifiedService").callGraph.nodes.some((item) => item.className === "SlowWorkerImpl"), false);
    assert.ok(analyze("AmbiguousService").callGraph.edges.some((item) => item.resolution === "ambiguous"));
    assert.ok(analyze("DefaultService").callGraph.nodes.some((item) => item.className === "DefaultWorker"));
    assert.ok(createEndpointReplacementPlanFromJava(analyze("TransactionService")).plan.findings.includes("RP-GRAPH-TRANSACTION-SELF-INVOCATION"));
    const lambda = createEndpointReplacementPlanFromJava(analyze("LambdaService"));
    assert.ok(lambda.graph.nodes.some((item) => item.evidence.detail?.includes("lambda")));
    assert.ok(lambda.graph.nodes.some((item) => item.evidence.symbol.includes("convert")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SQL source modeling covers inherited BaseMapper calls with transaction and routing context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-sql-source-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const files: Record<string, string[]> = {
      "TaskService.java": ["package demo;", "import jakarta.annotation.Resource;", "public class TaskService {", " @Resource", " private TaskMapper taskMapper;", " @Transactional", " public Object run(Long id) {", "  TenantContextHolder.getTenantId();", "  DynamicDataSourceContextHolder.peek();", "  return taskMapper.selectById(id);", " }", "}"],
      "TaskMapper.java": ["package demo;", "public interface TaskMapper extends BaseMapper<Task> {", "}"],
      "Task.java": ["package demo;", "public class Task {", "}"]
    };
    for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const report = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "TaskService" && item.methodName === "run")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(report.sqlSources.length, 1);
    assert.equal(report.sqlSources[0]?.source, "base-mapper");
    assert.equal(report.sqlSources[0]?.operation, "read");
    assert.equal(report.sqlSources[0]?.transactional, true);
    assert.deepEqual(report.sqlSources[0]?.contextSignals, ["datasource", "tenant", "transaction"]);
    const planned = createEndpointReplacementPlanFromJava(report);
    assert.ok(planned.graph.nodes.some((item) => item.id.startsWith("sql:base-mapper")));
    assert.ok(planned.plan.findings.includes("RP-SQL-BASE-MAPPER-GENERATED"));
    assert.equal(planned.plan.contracts.states.find((item) => item.resource === "database")?.transactional, true);
    assert.deepEqual(planned.plan.contracts.contexts.map((item) => item.name), ["datasource", "tenant"]);
    assert.ok(planned.plan.contracts.framework.some((item) => item.kind === "transaction"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
