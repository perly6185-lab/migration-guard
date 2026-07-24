import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaServicesForRust, renderServiceRustAssessment } from "./serviceRustAssessment.js";
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

test("service assessment reports unclassified boundary review categories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-service-categories-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "CategoryService.java"), [
      "package demo;", "public class CategoryService {",
      " public Object run() {", "  handle();", "  ResultFactory.extract();", "  OrderContext.unknown();", "  mystery.handle();", "  return null;", " }",
      " private void handle() { }", "}"
    ].join("\n"));
    const report = await assessJavaServicesForRust({ root: dir, maxDepth: 4, maxEdges: 100 });
    const run = report.methods.find((item) => item.method === "run")!;
    assert.deepEqual(run.unclassifiedCategories, ["business-helper", "context-coordination", "residual", "value-object-factory"]);
    assert.deepEqual(run.unclassifiedSymbols, ["CategoryService.handle", "OrderContext.unknown", "ResultFactory.extract", "mystery.handle"]);
    assert.ok(run.unknownNodes > 0);
    assert.equal(run.status, "blocked", "unknown Service boundaries must remain fail-closed");
    assert.equal(report.summary.unclassifiedCategories["business-helper"], 1);
    assert.equal(report.summary.unclassifiedSymbols["OrderContext.unknown"], 1);
    assert.match(renderServiceRustAssessment(report), /## Unclassified symbols[\s\S]*OrderContext\.unknown: 1/);
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
      "Worker.java": ["package demo;", "public class Worker {", " public Object execute(long value) { return null; }", " public Object process(Long value, String state) { return null; }", " public Payload payload() { return null; }", "}"],
      "Factory.java": ["package demo;", "public interface Factory<T> {", " T create();", "}"],
      "StaticTools.java": ["package demo;", "public class StaticTools {", " public static Object normalize(long value) { return null; }", " public static Object normalize(String value) { return null; }", "}"],
      "ResolutionService.java": [
        "package demo;", "import static demo.StaticTools.normalize;", "import static external.Results.success;", "import static external.Constants.*;", "public class ResolutionService {", " @Resource", " private Worker worker;", " private Worker sourceTypedWorker;", " @Resource", " private Factory<Worker> factory;", " @Resource", " private GeneratedConfig config;", " @Resource", " private OverloadWorker overloadWorker;",
        " public Object run() {", "  Payload payload = worker.payload();", "  sourceTypedWorker.execute(1);", "  PayloadHolder holder = new PayloadHolder(payload);", "  List<Payload> payloads = new ArrayList<>();", "  for (var item : payloads) { accept(item); }", "  worker.process(", "    1L,", "    \"ready\"", "  );", "  runBatch(payloads, item -> { worker.process(1L, \"batch\"); });", "  resolveLazy(1L, () -> worker.payload());", "  factory.create().execute(1);", "  worker.payload().getName();", "  overloadWorker.choose(Long.parseLong(\"1\"));", "  overloadWorker.choose(payload.getId());", "  overloadWorker.choose(holder.getPayload().getId());", "  payloads.stream().map(item -> overloadWorker.choose(item.getId()));", "  payloads.stream().map(item -> new PayloadHolder(item)).distinct().forEach(this::accept);", "  overloadWorker.chooseList(new ArrayList<Long>());", "  config.getTimeout();", "  normalize(1);", "  success(new Payload());", "  collect(\"batch\", 1L, 2L);", "  return null;", " }",
        " protected void runBatch(List<Payload> values, Consumer<Payload> handler) { }", " protected void resolveLazy(Long id, Supplier<Payload> supplier) { }", " protected void resolveLazy(Long id, Long value) { }", " protected void accept(PayloadHolder holder) { }", " protected void accept(Payload payload) { }", " protected Object collect(String name, Long... values) { return null; }", "}"
      ],
      "Payload.java": ["package demo;", "@Data", "public class Payload {", " private String name;", " private Long id;", "}"],
      "PayloadHolder.java": ["package demo;", "@Value", "public class PayloadHolder {", " Payload payload;", "}"],
      "GeneratedConfig.java": ["package demo;", "@Getter", "public class GeneratedConfig {", " private long timeout;", "}"],
      "OverloadWorker.java": ["package demo;", "public class OverloadWorker {", " public Object choose(Long value) { return null; }", " public Object choose(List<Long> value) { return null; }", " public Object chooseList(Long value) { return null; }", " public Object chooseList(List<Long> value) { return null; }", " public Object getViewDynamicUsePageDataByPageId(Long value) { return null; }", " public Object getViewDynamicUsePageDataByPageId(List<Long> values) { return null; }", " public Object selectListByPanelId(Long value) { return null; }", " public Object selectListByPanelId(List<Long> values) { return null; }", " public String toString(Long value) { return String.valueOf(value); }", "}"],
      "ExternalAccessorService.java": [
        "package demo;", "public class ExternalAccessorService {", " @Resource", " private OverloadWorker overloadWorker;",
        " public Object page(List<ExternalRow> rows) { return overloadWorker.getViewDynamicUsePageDataByPageId(rows.get(0).getPageId()); }",
        " public Object rightPage(List<ExternalRow> rows) { return overloadWorker.getViewDynamicUsePageDataByPageId(rows.get(0).getRightPageId()); }",
        " public Object panel(List<ExternalRow> rows) { return overloadWorker.selectListByPanelId(rows.get(0).getId()); }",
        " public Object unionPanel(List<ExternalRow> rows) { return overloadWorker.selectListByPanelId(rows.get(0).getUnionPanelId()); }",
        " public Object pages(List<ExternalRow> rows) { return overloadWorker.getViewDynamicUsePageDataByPageId(rows.get(0).getPageIds()); }",
        " public Object unrelated(List<ExternalRow> rows) { return overloadWorker.choose(rows.get(0).getPageId()); }",
        " public Object prototypeName(List<ExternalRow> rows) { return overloadWorker.toString(rows.get(0).getId()); }", "}"
      ],
      "InitializerService.java": [
        "package demo;", "public class InitializerService {", " private Worker worker;",
        " private final Object listener = Builder.create()", "  .listen(() -> {", "   try { worker.execute(1L); } catch (Exception error) {", "    error.printStackTrace();", "   }", "  })", "  .build();",
        " public Object before() {", "  // match status/*_rule_id without opening a block comment", "  return worker.execute(1L);", " }",
        " public Object run() { return worker.execute(1L); }", "}"
      ],
      "one/DuplicateWorker.java": ["package demo.one;", "public class DuplicateWorker {", " public Object execute() { return null; }", "}"],
      "two/DuplicateWorker.java": ["package demo.two;", "public class DuplicateWorker {", " public Object execute() { return null; }", "}"],
      "ImportedService.java": ["package demo;", "import demo.one.DuplicateWorker;", "public class ImportedService {", " @Resource", " private DuplicateWorker duplicateWorker;", " public Object run() { return duplicateWorker.execute(); }", "}"]
    };
    for (const [name, lines] of Object.entries(files)) { const file = path.join(dir, "demo", name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, lines.join("\n")); }
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const report = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ResolutionService" && item.methodName === "run")!, { maxDepth: 5, maxEdges: 100 });
    assert.ok(report.callGraph.nodes.some((item) => item.className === "Worker" && item.methodName === "process"));
    assert.ok(report.callGraph.nodes.some((item) => item.className === "Worker" && item.methodName === "execute"));
    assert.equal(report.callGraph.edges.find((edge) => edge.call.receiver === "sourceTypedWorker")?.resolution, "field-injection");
    assert.ok(report.callGraph.nodes.some((item) => item.className === "StaticTools" && item.methodName === "normalize" && /long value/.test(item.signature ?? "")));
    assert.ok(report.callGraph.nodes.some((item) => item.className === "ResolutionService" && item.methodName === "collect"));
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "success")?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.some((edge) => edge.call.method === "Payload"), false);
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "getName")?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "getTimeout")?.resolution, "static-or-external");
    assert.match(report.callGraph.nodes.find((item) => item.className === "OverloadWorker" && item.methodName === "choose")?.signature ?? "", /Long value/);
    const imported = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ImportedService" && item.methodName === "run")!, { maxDepth: 5, maxEdges: 100 });
    assert.ok(imported.callGraph.nodes.some((item) => item.file === "demo/one/DuplicateWorker.java"));
    assert.equal(imported.callGraph.nodes.some((item) => item.file === "demo/two/DuplicateWorker.java"), false);
    assert.equal(report.callGraph.edges.some((edge) => edge.resolution === "ambiguous"), false, JSON.stringify(report.callGraph.edges.filter((edge) => edge.resolution === "ambiguous"), null, 2));
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "process")?.call.argumentCount, 2);
    assert.equal(report.callGraph.edges.find((edge) => edge.call.method === "runBatch")?.call.argumentCount, 2);
    assert.match(report.callGraph.nodes.find((item) => item.methodName === "resolveLazy")?.signature ?? "", /Supplier<Payload>/);
    assert.match(report.callGraph.nodes.find((item) => item.methodName === "accept")?.signature ?? "", /PayloadHolder holder/);
    const initializerRun = analyzer.serviceMethods.find((item) => item.className === "InitializerService" && item.methodName === "run");
    assert.ok(initializerRun, "method after a multiline field initializer must remain visible");
    const initializer = analyzer.analyzeServiceMethod(initializerRun, { maxDepth: 5, maxEdges: 100 });
    assert.equal(initializer.callGraph.edges.find((edge) => edge.call.receiver === "worker")?.resolution, "field-injection");
    const pageAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "page")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(pageAccessor.callGraph.edges.find((edge) => edge.call.method === "getViewDynamicUsePageDataByPageId")?.call.argumentTypes?.[0], "Long");
    assert.equal(pageAccessor.callGraph.edges.find((edge) => edge.call.method === "getViewDynamicUsePageDataByPageId")?.resolution, "field-injection");
    const rightPageAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "rightPage")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(rightPageAccessor.callGraph.edges.find((edge) => edge.call.method === "getViewDynamicUsePageDataByPageId")?.call.argumentTypes?.[0], "Long");
    assert.equal(rightPageAccessor.callGraph.edges.find((edge) => edge.call.method === "getViewDynamicUsePageDataByPageId")?.resolution, "field-injection");
    const panelAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "panel")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(panelAccessor.callGraph.edges.find((edge) => edge.call.method === "selectListByPanelId")?.call.argumentTypes?.[0], "Long");
    assert.equal(panelAccessor.callGraph.edges.find((edge) => edge.call.method === "selectListByPanelId")?.resolution, "field-injection");
    const unionPanelAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "unionPanel")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(unionPanelAccessor.callGraph.edges.find((edge) => edge.call.method === "selectListByPanelId")?.call.argumentTypes?.[0], "Long");
    assert.equal(unionPanelAccessor.callGraph.edges.find((edge) => edge.call.method === "selectListByPanelId")?.resolution, "field-injection");
    const unknownAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "pages")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(unknownAccessor.callGraph.edges.find((edge) => edge.call.method === "getViewDynamicUsePageDataByPageId")?.resolution, "ambiguous");
    const unrelatedAccessor = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "unrelated")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(unrelatedAccessor.callGraph.edges.find((edge) => edge.call.method === "choose")?.resolution, "ambiguous");
    const prototypeName = analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === "ExternalAccessorService" && item.methodName === "prototypeName")!, { maxDepth: 4, maxEdges: 100 });
    assert.equal(prototypeName.callGraph.edges.find((edge) => edge.call.method === "toString")?.resolution, "field-injection");
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
    await writeFile(path.join(dir, "demo", "WideService.java"), [
      "package demo;", "public class WideService {",
      " public void start() {", ...Array.from({ length: 40 }, (_, index) => `  branch${index}();`), " }",
      ...Array.from({ length: 40 }, (_, index) => ` private void branch${index}() { shared(); }`),
      " private void shared() { start();", ...Array.from({ length: 40 }, (_, index) => `  tail${index}();`), " }",
      ...Array.from({ length: 40 }, (_, index) => ` private void tail${index}() { }`), "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "SelectorService.java"), [
      "package demo;", "public class SelectorService {",
      " public Object select(List<Item> items) { return items.stream().map(Item::getId).filter(item -> item != null).toList(); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "Item.java"), [
      "package demo;", "import lombok.Data;", "@Data", "public class Item {", " private Long id;", "}"
    ].join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const start = analyzer.serviceMethods.find((item) => item.methodName === "start")!;
    const expanded = analyzer.analyzeServiceMethodAdaptive(start, { initialDepth: 1, initialEdges: 10, maxDepth: 8, maxEdges: 100, maxRounds: 4 });
    assert.equal(expanded.status, "complete");
    assert.equal(expanded.topology, "complete");
    assert.ok(expanded.rounds.length > 1);
    assert.equal(expanded.rounds.at(-1)?.complete, true);
    assert.equal(expanded.rounds.at(-1)?.depthCapHit, false);
    const exhausted = analyzer.analyzeServiceMethodAdaptive(start, { initialDepth: 1, initialEdges: 10, maxDepth: 1, maxEdges: 10, maxRounds: 2 });
    assert.equal(exhausted.status, "budget-exhausted");
    assert.equal(exhausted.topology, "depth-growth");
    assert.equal(exhausted.rounds.length, 1);
    assert.equal(createEndpointReplacementPlanFromJava(exhausted.report).plan.status, "blocked", "depth exhaustion must remain fail-closed");
    const wide = analyzer.serviceMethods.find((item) => item.className === "WideService" && item.methodName === "start")!;
    const highFanout = analyzer.analyzeServiceMethodAdaptive(wide, { initialDepth: 2, initialEdges: 32, maxDepth: 2, maxEdges: 32, maxRounds: 1 });
    assert.equal(highFanout.status, "budget-exhausted");
    assert.equal(highFanout.topology, "high-fanout");
    assert.equal(highFanout.rounds[0].maxOutDegree, 32);
    assert.equal(createEndpointReplacementPlanFromJava(highFanout.report).plan.status, "blocked", "high-fanout exhaustion must remain fail-closed");
    const finalBudget = analyzer.analyzeServiceMethodAdaptive(wide, { initialDepth: 2, initialEdges: 32, maxDepth: 4, maxEdges: 200, maxRounds: 2 });
    assert.equal(finalBudget.rounds.at(-1)?.maxEdges, 200, "the last adaptive round must exercise the configured edge ceiling");
    assert.equal(finalBudget.rounds.at(-1)?.maxDepth, 4, "the last adaptive round must also exercise the depth ceiling hidden by an edge cap");
    const finalDepthBudget = analyzer.analyzeServiceMethodAdaptive(start, { initialDepth: 1, initialEdges: 100, maxDepth: 4, maxEdges: 100, maxRounds: 2 });
    assert.equal(finalDepthBudget.rounds.at(-1)?.maxDepth, 4, "the last adaptive round must exercise the configured depth ceiling");
    const continued = analyzer.analyzeServiceMethodAdaptive(wide, { initialDepth: 4, initialEdges: 200, maxDepth: 4, maxEdges: 200, maxRounds: 1 });
    assert.equal(continued.status, "complete", "wide methods must continue after each local call batch");
    assert.equal(continued.report.callGraph.truncation.perMethodCallCapHit, false);
    assert.equal(continued.report.callGraph.truncation.perMethodCallCapNodes?.length, 0);
    assert.ok(continued.report.callGraph.edges.some((edge) => edge.call.method === "tail39"), "calls after the first batch must be retained");
    const selector = analyzer.serviceMethods.find((item) => item.className === "SelectorService" && item.methodName === "select")!;
    const summarized = analyzer.analyzeServiceMethod(selector, { maxDepth: 4, maxEdges: 20 });
    assert.equal(summarized.callGraph.summarizedCalls?.find((item) => item.kind === "generated-accessor-reference")?.count, 1);
    assert.equal(summarized.callGraph.edges.some((edge) => edge.call.method === "getId"), false);
    assert.equal(summarized.callGraph.edges.some((edge) => edge.call.receiver === "$lambda"), true);
    const serviceReport = await assessJavaServicesForRust({ root: dir, maxDepth: 4, maxEdges: 32, adaptive: true, maxExpansionDepth: 8, maxExpansionEdges: 90, maxExpansionRounds: 3 });
    const diagnosed = serviceReport.methods.find((item) => item.service.endsWith("WideService") && item.method === "start")!;
    assert.equal(diagnosed.status, "blocked");
    assert.equal(diagnosed.expansionTopology, "high-fanout");
    assert.ok((diagnosed.highFanoutDiagnostics?.maxOutDegree ?? 0) >= 32);
    assert.equal(diagnosed.highFanoutDiagnostics?.callCapNodes, 0);
    assert.equal(diagnosed.highFanoutDiagnostics?.omittedCalls, 0);
    assert.ok((diagnosed.highFanoutDiagnostics?.repeatedSubgraphGroups ?? 0) > 0);
    assert.ok((diagnosed.highFanoutDiagnostics?.cyclicStronglyConnectedComponents ?? 0) > 0);
    assert.ok(diagnosed.highFanoutDiagnostics?.amplificationSignals.includes("repeated-outgoing-shape"));
    assert.ok(diagnosed.highFanoutDiagnostics?.amplificationSignals.includes("cyclic-scc"));
    assert.equal(diagnosed.highFanoutDiagnostics?.amplificationSignals.includes("per-method-call-cap-saturated"), false);
    assert.ok(serviceReport.summary.highFanoutDiagnostics.methods > 0);
    assert.equal(serviceReport.summary.highFanoutDiagnostics.withPerMethodCallCapSaturation, 0);
    assert.equal(serviceReport.summary.highFanoutDiagnostics.totalCallCapNodes, 0);
    assert.equal(serviceReport.summary.highFanoutDiagnostics.totalOmittedCalls, 0);
    assert.ok(Object.keys(serviceReport.summary.highFanoutDiagnostics.maxOutDegrees).length > 0);
    assert.ok(Object.keys(serviceReport.summary.highFanoutDiagnostics.repeatedSubgraphGroups).length > 0);
    assert.ok(Object.keys(serviceReport.summary.highFanoutDiagnostics.cyclicSccs).length > 0);
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
      "PrimaryWorker.java": ["package demo;", "public interface PrimaryWorker {", " Object execute();", "}"],
      "PrimaryWorkerImpl.java": ["package demo;", "@Primary", "public class PrimaryWorkerImpl implements PrimaryWorker {", " public Object execute() { return null; }", "}"],
      "BackupPrimaryWorkerImpl.java": ["package demo;", "public class BackupPrimaryWorkerImpl implements PrimaryWorker {", " public Object execute() { return null; }", "}"],
      "PrimaryService.java": ["package demo;", "public class PrimaryService {", " @Resource", " private PrimaryWorker primaryWorker;", " public Object run() { return primaryWorker.execute(); }", "}"],
      "RegisteredWorker.java": ["package demo;", "public interface RegisteredWorker {", " Object execute();", "}"],
      "RegisteredWorkerImpl.java": ["package demo;", "@Component", "public class RegisteredWorkerImpl implements RegisteredWorker {", " public Object execute() { return null; }", "}"],
      "LegacyRegisteredWorker.java": ["package demo;", "public class LegacyRegisteredWorker implements RegisteredWorker {", " public Object execute() { return null; }", "}"],
      "RegisteredService.java": ["package demo;", "public class RegisteredService {", " @Resource", " private RegisteredWorker worker;", " public Object run() { return worker.execute(); }", "}"],
      "DefaultWorker.java": ["package demo;", "public interface DefaultWorker {", " default Object execute() {", "  return execute(\"default\");", " }", " Object execute(String mode);", "}"],
      "DefaultWorkerImpl.java": ["package demo;", "public class DefaultWorkerImpl implements DefaultWorker {", " public Object execute(String mode) { return null; }", "}"],
      "DefaultService.java": ["package demo;", "public class DefaultService {", " @Resource", " private DefaultWorker defaultWorker;", " public Object run() {", "  return defaultWorker.execute();", " }", "}"],
      "IJobRepository.java": ["package demo;", "public interface IJobRepository {", " Object selectById(Long id);", "}"],
      "JobRepositoryImpl.java": ["package demo;", "public class JobRepositoryImpl", " implements IJobRepository {", " public Object selectById(Long id) { return null; }", "}"],
      "RepositoryService.java": ["package demo;", "public class RepositoryService {", " @Resource", " private IJobRepository jobRepository;", " public Object run() { return jobRepository.selectById(1L); }", "}"],
      "PackageSupport.java": ["package demo;", "public class PackageSupport {", " String braceText() { return \"${value}\"; }", " Object execute(", "  Long one,", "  Long two,", "  Long three,", "  Long four,", "  Long five,", "  Long six,", "  Long seven,", "  Long eight,", "  Long nine", ") { return null; }", "}"],
      "PackageSupportService.java": ["package demo;", "public class PackageSupportService {", " @Resource", " private PackageSupport packageSupport;", " public Object run() { return packageSupport.execute(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L); }", "}"],
      "TransactionService.java": ["package demo;", "public class TransactionService {", " @Transactional", " public Object save() {", "  return null;", " }", " public Object run() {", "  return save();", " }", "}"],
      "EquivalentTransactionService.java": ["package demo;", "public class EquivalentTransactionService {", " @Transactional", " public Object save() { return null; }", " @Transactional", " public Object run() { return save(); }", "}"],
      "RequiresNewTransactionService.java": ["package demo;", "public class RequiresNewTransactionService {", " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object save() { return null; }", " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object run() { return save(); }", "}"],
      "LambdaService.java": ["package demo;", "public class LambdaService {", " public Object run() {", "  items.forEach(item -> process(item));", "  return items.stream().map(this::convert);", " }", " protected void process(Object item) {", " }", " protected Object convert(Object item) {", "  return item;", " }", "}"]
    };
    for (const [name, lines] of Object.entries(files)) await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const analyze = (className: string) => analyzer.analyzeServiceMethod(analyzer.serviceMethods.find((item) => item.className === className && item.methodName === "run")!, { maxDepth: 5, maxEdges: 200 });
    assert.ok(analyze("ChildService").callGraph.nodes.some((item) => item.className === "BaseService" && item.methodName === "inherited"));
    assert.ok(analyze("QualifiedService").callGraph.nodes.some((item) => item.className === "FastWorkerImpl"));
    assert.equal(analyze("QualifiedService").callGraph.nodes.some((item) => item.className === "SlowWorkerImpl"), false);
    assert.ok(analyze("AmbiguousService").callGraph.edges.some((item) => item.resolution === "ambiguous"));
    const primary = analyze("PrimaryService");
    assert.ok(primary.callGraph.nodes.some((item) => item.className === "PrimaryWorkerImpl"), JSON.stringify(primary.callGraph, null, 2));
    assert.equal(primary.callGraph.nodes.some((item) => item.className === "BackupPrimaryWorkerImpl"), false);
    assert.ok(analyze("RegisteredService").callGraph.nodes.some((item) => item.className === "RegisteredWorkerImpl"));
    assert.equal(analyze("RegisteredService").callGraph.nodes.some((item) => item.className === "LegacyRegisteredWorker"), false);
    assert.ok(analyze("DefaultService").callGraph.nodes.some((item) => item.className === "DefaultWorker"));
    const repository = analyze("RepositoryService");
    assert.ok(repository.callGraph.nodes.some((item) => item.className === "JobRepositoryImpl"));
    assert.equal(repository.callGraph.edges.some((item) => item.resolution === "ambiguous"), false);
    assert.ok(analyze("PackageSupportService").callGraph.nodes.some((item) => item.className === "PackageSupport" && item.methodName === "execute"));
    const transaction = analyze("TransactionService");
    assert.ok(createEndpointReplacementPlanFromJava(transaction).plan.findings.includes("RP-GRAPH-TRANSACTION-SELF-INVOCATION"), JSON.stringify(transaction.callGraph, null, 2));
    assert.equal(createEndpointReplacementPlanFromJava(analyze("EquivalentTransactionService")).plan.findings.includes("RP-GRAPH-TRANSACTION-SELF-INVOCATION"), false);
    assert.ok(createEndpointReplacementPlanFromJava(analyze("RequiresNewTransactionService")).plan.findings.includes("RP-GRAPH-TRANSACTION-SELF-INVOCATION"));
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
