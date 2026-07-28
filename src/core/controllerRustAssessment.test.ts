import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaControllersForRust } from "./controllerRustAssessment.js";
import { createJavaEndpointAnalyzer } from "./javaEndpointAnalysis.js";
import { createJavaFieldConfigSnapshot } from "./javaFieldConfigSnapshot.js";

test("route symbolic shadow applies field projections only to the evidenced tranObjList call", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-projection-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const files: Record<string, string[]> = {
      "ProjectionController.java": [
        "package demo;", "@RestController", "public class ProjectionController {",
        " private ProjectionService projectionService;", " @GetMapping(\"/projection\")",
        " public Object run() { return projectionService.run(); }", "}"
      ],
      "ProjectionService.java": [
        "package demo;", "public class ProjectionService {",
        " private EngineTranObjectValueServiceImpl engineTranObjectValueService;",
        " public Object run() { return engineTranObjectValueService.tranObjList(null, null, null, null, null); }", "}"
      ],
      "EngineTranObjectValueServiceImpl.java": [
        "package demo;", "public class EngineTranObjectValueServiceImpl {",
        " private FieldPercentageValueDataService fieldPercentageValueDataService;",
        " private FieldDateFormatValueDataService fieldDateFormatValueDataService;",
        " public Object tranObjList(Object fields, Object rows, Object selected, Object fun, Object total) {",
        "  fieldPercentageValueDataService.handleShowFieldValue(fields, rows);",
        "  fieldDateFormatValueDataService.handleFieldDateFormat(fields, rows);",
        "  return rows;", " }", "}"
      ],
      "FieldPercentageValueDataService.java": [
        "package demo;", "public class FieldPercentageValueDataService {",
        " public void handleShowFieldValue(Object fields, Object rows) {}", "}"
      ],
      "FieldDateFormatValueDataService.java": [
        "package demo;", "public class FieldDateFormatValueDataService {",
        " public void handleFieldDateFormat(Object fields, Object rows) {}", "}"
      ]
    };
    for (const [name, lines] of Object.entries(files)) {
      await writeFile(path.join(dir, "demo", name), lines.join("\n"));
    }
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const service = analyzer.serviceMethods.find((item) =>
      item.className === "ProjectionService" && item.methodName === "run")!;
    const callId = analyzer.summarizeMethod(service).calls
      .find((call) => call.method === "tranObjList")!.id;
    const snapshot = createJavaFieldConfigSnapshot({
      source: analyzer.sourceIdentity,
      tenantId: "7",
      panelIds: ["10"],
      fields: [{ fieldId: "1", panelId: "10", alias: "name", formatterKinds: [] }]
    });
    const report = analyzer.analyzeRouteSymbolicShadow({
      endpoint: "/projection",
      method: "GET",
      maxDepth: 8,
      maxEdges: 100,
      fieldConfigSnapshot: snapshot,
      fieldProjectionSites: [{
        callId,
        tenantId: "7",
        panelId: "10",
        selectedAliases: ["name"]
      }]
    });
    assert.equal(report.fieldProjectionEvidence?.trustedSnapshot, true);
    assert.deepEqual(report.fieldProjectionEvidence?.appliedCallIds, [callId]);
    assert.equal(report.symbolic.methodIds.some((id) => id.includes("handleShowFieldValue")), false);
    assert.equal(report.symbolic.methodIds.some((id) => id.includes("handleFieldDateFormat")), false);

    const unknown = analyzer.analyzeRouteSymbolicShadow({
      endpoint: "/projection",
      method: "GET",
      maxDepth: 8,
      maxEdges: 100,
      fieldConfigSnapshot: snapshot,
      fieldProjectionSites: [{
        callId,
        tenantId: "7",
        panelId: "10",
        selectedAliases: ["missing"]
      }]
    });
    assert.deepEqual(unknown.fieldProjectionEvidence?.rejectedCallIds, [callId]);
    assert.equal(unknown.symbolic.methodIds.some((id) => id.includes("handleShowFieldValue")), true);
    assert.equal(unknown.symbolic.methodIds.some((id) => id.includes("handleFieldDateFormat")), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("route symbolic shadow derives only proven entry facts and compares shared graphs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-symbolic-shadow-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "ShadowController.java"), [
      "package demo;", "@RestController", "public class ShadowController {",
      " @GetMapping(\"/shadow/{id}\")",
      " public Object run(@PathVariable Long id, @RequestParam(required = false) String query, boolean dryRun) {",
      "  return handle(id, query, dryRun);",
      " }",
      " private Object handle(Long id, String query, boolean dryRun) { return null; }",
      "}"
    ].join("\n"));
    const analyzer = await createJavaEndpointAnalyzer(dir);
    const first = analyzer.analyzeRouteSymbolicShadow({
      endpoint: "/shadow/{id}",
      method: "GET",
      maxDepth: 8,
      maxEdges: 100
    });
    assert.deepEqual(first.initialFacts.nonNullParams, ["dryRun", "id"]);
    assert.equal(first.initialFacts.nonNullParams.includes("query"), false);
    assert.equal(first.verdict, "aligned");
    assert.equal(first.symbolic.stateCount, 2);
    assert.deepEqual(first.symbolic.stateVariantHotspots, []);
    assert.deepEqual(first.symbolic.budgetRejectionSources, []);
    assert.deepEqual(first.differences.methodsMissingFromSymbolic, []);
    assert.deepEqual(first.differences.edgesMissingFromSymbolic, []);
    assert.equal(first.reportHash, analyzer.analyzeRouteSymbolicShadow({
      endpoint: "/shadow/{id}",
      method: "GET",
      maxDepth: 8,
      maxEdges: 100
    }).reportHash);
    const truncated = analyzer.analyzeRouteSymbolicShadow({
      endpoint: "/shadow/{id}",
      method: "GET",
      maxDepth: 1,
      maxEdges: 100
    });
    assert.equal(truncated.legacy.truncated, true);
    assert.equal(truncated.verdict, "inconclusive");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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

test("controller assessment binds interface and locally implemented Feign routes while excluding outbound-only clients", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-interface-route-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "OrderAdminApi.java"), [
      "package demo;",
      "@RestController",
      "@RequestMapping(\"/api/orders\")",
      "public interface OrderAdminApi {",
      " @GetMapping(\"/get\")",
      " Object getOrder(Long id);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "OrderController.java"), [
      "package demo;",
      "@RestController",
      "@RequestMapping(\"/api/orders\")",
      "public class OrderController implements OrderAdminApi {",
      " @Resource",
      " private OrderService orderService;",
      " @Override",
      " @GetMapping(\"/get\")",
      " public Object getOrder(Long id) { return orderService.getOrder(id); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "OrderService.java"), [
      "package demo;",
      "public class OrderService {",
      " @Resource",
      " private OrderRepository orderRepository;",
      " public Object getOrder(Long id) { return orderRepository.findById(id); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "OrderRepository.java"), [
      "package demo;",
      "public class OrderRepository {",
      " public Object findById(Long id) { return null; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "RemoteOrderClient.java"), [
      "package demo;",
      "@FeignClient(name = \"remote-orders\")",
      "public interface RemoteOrderClient {",
      " @GetMapping(\"/remote/orders/get\")",
      " Object getOrder(Long id);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "LocalAuditApi.java"), [
      "package demo;",
      "@FeignClient(name = \"local-audit\")",
      "public interface LocalAuditApi {",
      " @PostMapping(\"/rpc-api/audit/create\")",
      " Object createAudit(String value);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "LocalAuditApiImpl.java"), [
      "package demo;",
      "@RestController",
      "public class LocalAuditApiImpl implements LocalAuditApi {",
      " @Override",
      " public Object createAudit(String value) { return value; }",
      "}"
    ].join("\n"));

    const analyzer = await createJavaEndpointAnalyzer(dir);
    assert.equal(analyzer.routes.length, 2);
    const orderRoute = analyzer.routes.find((route) => route.className === "OrderController");
    assert.equal(orderRoute?.implementationResolution, "bound");
    assert.equal(orderRoute?.declaration?.className, "OrderAdminApi");
    const rpcRoute = analyzer.routes.find((route) => route.className === "LocalAuditApiImpl");
    assert.equal(rpcRoute?.path, "/rpc-api/audit/create");
    assert.equal(rpcRoute?.implementationResolution, "bound");
    assert.equal(rpcRoute?.declaration?.className, "LocalAuditApi");
    assert.equal(analyzer.routes.some((route) => route.className === "RemoteOrderClient"), false);

    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 100 });
    assert.equal(report.routeCount, 2);
    const orderAssessment = report.methods.find((method) => method.handler === "OrderController.getOrder");
    assert.ok((orderAssessment?.nodes ?? 0) >= 3);
    assert.equal(orderAssessment?.findings.includes("RP-ENTRYPOINT-IMPLEMENTATION-UNRESOLVED"), false);
    assert.equal(report.methods.some((method) => method.handler === "LocalAuditApiImpl.createAudit"), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment fails closed for unresolved or ambiguous interface route implementations", async () => {
  const unresolvedDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-interface-unresolved-"));
  const ambiguousDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-interface-ambiguous-"));
  try {
    await mkdir(path.join(unresolvedDir, "demo"), { recursive: true });
    await writeFile(path.join(unresolvedDir, "demo", "MissingApi.java"), [
      "package demo;",
      "@RestController",
      "public interface MissingApi {",
      " @GetMapping(\"/missing\")",
      " Object get();",
      "}"
    ].join("\n"));
    const unresolved = await assessJavaControllersForRust({ root: unresolvedDir, maxDepth: 4, maxEdges: 20 });
    assert.equal(unresolved.methods[0]?.status, "blocked");
    assert.ok(unresolved.methods[0]?.findings.includes("RP-ENTRYPOINT-IMPLEMENTATION-UNRESOLVED"));

    await mkdir(path.join(ambiguousDir, "demo"), { recursive: true });
    await writeFile(path.join(ambiguousDir, "demo", "SharedApi.java"), [
      "package demo;",
      "@RestController",
      "public interface SharedApi {",
      " @GetMapping(\"/shared\")",
      " Object get();",
      "}"
    ].join("\n"));
    for (const name of ["FirstController", "SecondController"]) {
      await writeFile(path.join(ambiguousDir, "demo", `${name}.java`), [
        "package demo;",
        "@RestController",
        `public class ${name} implements SharedApi {`,
        " public Object get() { return null; }",
        "}"
      ].join("\n"));
    }
    const ambiguous = await assessJavaControllersForRust({ root: ambiguousDir, maxDepth: 4, maxEdges: 20 });
    assert.equal(ambiguous.methods[0]?.status, "blocked");
    assert.ok(ambiguous.methods[0]?.findings.includes("RP-ENTRYPOINT-IMPLEMENTATION-AMBIGUOUS"));
  } finally {
    await rm(unresolvedDir, { recursive: true, force: true });
    await rm(ambiguousDir, { recursive: true, force: true });
  }
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
    await writeFile(path.join(dir, "demo", "ViewDynamicFieldCountIndexDataServiceImpl.java"), [
      "package demo;", "public class ViewDynamicFieldCountIndexDataServiceImpl {",
      " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object ensureIndexRecord() { return createViewDynamicFieldCountIndexData(); }",
      " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object createViewDynamicFieldCountIndexData() { return null; }", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "RequiresNewReviewedController.java"), [
      "package demo;", "@RestController", "public class RequiresNewReviewedController {", " @Resource",
      " private ViewDynamicFieldCountIndexDataServiceImpl service;",
      " @GetMapping(\"/reviewed-requires-new\")", " public Object run() { return service.ensureIndexRecord(); }", "}"
    ].join("\n"));
    const reviewed = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 20 });
    assert.equal(reviewed.summary.findings["RP-GRAPH-TRANSACTION-SELF-INVOCATION"] ?? 0, 0);

    await writeFile(path.join(dir, "demo", "OtherService.java"), [
      "package demo;", "public class OtherService {",
      " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object saveAiEmpowerConfig() { return deleteByFieldId(); }",
      " @Transactional(propagation = Propagation.REQUIRES_NEW)", " public Object deleteByFieldId() { return null; }", "}"
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
    assert.equal(fixed.summary.truncationInventory.routes, 1);
    assert.equal(fixed.truncationInventory[0]?.edgeCapHit, true);
    assert.equal(fixed.truncationInventory[0]?.route, "GET /chain");
    const progress: Array<{ completed: number; total: number; cacheHits: number }> = [];
    const adaptive = await assessJavaControllersForRust({
      root: dir,
      maxDepth: 2,
      maxEdges: 2,
      adaptive: true,
      maxExpansionDepth: 8,
      maxExpansionEdges: 20,
      maxExpansionRounds: 3,
      onProgress: (item) => item.phase === "completed" && progress.push({
        completed: item.completed,
        total: item.total,
        cacheHits: item.cache.methodCallHits
      })
    });
    assert.equal(adaptive.summary.findings["RP-GRAPH-EDGE-CAP"] ?? 0, 0);
    assert.equal(adaptive.summary.adaptivelyExpanded, 1);
    assert.equal(adaptive.methods[0]?.expansionStatus, "complete");
    assert.equal(adaptive.truncationInventory.length, 0);
    assert.deepEqual(adaptive.highFanoutInventory, []);
    assert.deepEqual(progress.map((item) => [item.completed, item.total]), [[1, 1]]);
    assert.ok((progress[0]?.cacheHits ?? 0) > 0);
    assert.equal("onProgress" in adaptive.assessmentScope, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment attributes exclusive and repeated fanout edges and clusters truncated routes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-fanout-attribution-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    const calls = Array.from({ length: 25 }, (_, index) => `  branch${index}();`);
    const branches = Array.from({ length: 25 }, (_, index) => ` private void branch${index}() { }`);
    await writeFile(path.join(dir, "demo", "FanoutController.java"), [
      "package demo;", "@RestController", "public class FanoutController {",
      " @GetMapping(\"/fanout\")", " public void run() {", ...calls, " }", ...branches, "}"
    ].join("\n"));
    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 20 });
    assert.equal(report.summary.truncationInventory.edgeCapRoutes, 1);
    assert.equal(report.methods[0]?.truncation.minimumEdgeReductionToUncap, 1);
    assert.equal(report.methods[0]?.truncation.edgeReductionCertainty, "lower-bound");
    assert.equal(report.methods[0]?.truncation.fanoutContributions[0]?.directEdges, 20);
    assert.equal(report.methods[0]?.truncation.fanoutContributions[0]?.exclusiveDownstreamEdges, 20);
    assert.equal(report.methods[0]?.truncation.fanoutContributions[0]?.repeatedDownstreamEdges, 0);
    assert.equal(report.highFanoutInventory[0]?.priorityScore, 20);
    assert.equal(report.truncationRouteClusters[0]?.routes[0], "GET /fanout");
    assert.equal(report.truncationRouteClusters[0]?.edgeReductionCertainty, "lower-bound");
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
    assert.deepEqual(shared?.sourceLocations, [{ file: "demo/SharedService.java", line: 4 }]);
    assert.equal(nested?.minDepth, 2);
    assert.equal(report.unclassifiedBoundaryInventory[0]?.symbol, "SharedService.innerOpaque");
    assert.match(report.reportHash, /^[a-f0-9]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller assessment inventories ambiguous calls and candidate evidence without resolving them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-controller-ambiguity-inventory-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "AmbiguousController.java"), [
      "package demo;", "@RestController", "public class AmbiguousController {",
      " @GetMapping(\"/ambiguous\")", " public Object run() { return choose(null); }",
      " private Object choose(Long value) { return null; }",
      " private Object choose(String value) { return null; }", "}"
    ].join("\n"));

    const report = await assessJavaControllersForRust({ root: dir, maxDepth: 8, maxEdges: 40 });
    const call = report.ambiguousCallInventory[0];

    assert.equal(report.summary.ready, 0);
    assert.equal(report.summary.blocked, 1);
    assert.equal(report.summary.ambiguousCallInventory.affectedRoutes, 1);
    assert.equal(call?.expression, "choose(");
    assert.equal(call?.candidates.length, 2);
    assert.equal(call?.affectedRoutes[0], "GET /ambiguous");
    assert.ok(call?.candidates.some((candidate) => /Long value/.test(candidate.signature)));
    assert.ok(call?.candidates.some((candidate) => /String value/.test(candidate.signature)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
