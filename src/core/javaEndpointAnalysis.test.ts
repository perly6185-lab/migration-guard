import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  analyzeJavaEndpoint,
  renderJavaEndpointAnalysisReport,
  writeJavaEndpointAnalysisReport
} from "./javaEndpointAnalysis.js";

test("java endpoint analysis traces Spring route through injected services and drafts golden cases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-"));

  try {
    await mkdir(path.join(dir, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageController.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "",
      "@RestController",
      "@RequestMapping(\"/api/books\")",
      "public class BookPageController {",
      "  @Resource",
      "  private BookPageRouteApplicationService pageRouteApplicationService;",
      "  @Resource",
      "  private BookPageAssembler bookPageAssembler;",
      "",
      "  @PostMapping(\"/page\")",
      "  public EngineInterRespVO pageByView(EngineUsePageInterReqVO reqVO) {",
      "    return bookPageAssembler.toRespVO(pageRouteApplicationService.pageByView(bookPageAssembler.toRequestDTO(reqVO)));",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageRouteApplicationService.java"), [
      "package demo;",
      "public interface BookPageRouteApplicationService {",
      "  ViewMetaEngineInterResponseDTO pageByView(ViewMetaEngineUsePageRequestDTO requestDTO);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageRouteApplicationServiceImpl.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.web.context.request.RequestContextHolder;",
      "",
      "@Service",
      "public class BookPageRouteApplicationServiceImpl implements BookPageRouteApplicationService {",
      "  @Resource",
      "  private BookPageUseCaseApplicationService useCaseApplicationService;",
      "",
      "  public ViewMetaEngineInterResponseDTO pageByView(ViewMetaEngineUsePageRequestDTO requestDTO) {",
      "    RequestContextHolder.setRequestAttributes(RequestContextHolder.getRequestAttributes(), true);",
      "    return useCaseApplicationService.page(requestDTO);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageUseCaseApplicationService.java"), [
      "package demo;",
      "public interface BookPageUseCaseApplicationService {",
      "  ViewMetaEngineInterResponseDTO page(ViewMetaEngineUsePageRequestDTO requestDTO);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageUseCaseApplicationServiceImpl.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class BookPageUseCaseApplicationServiceImpl implements BookPageUseCaseApplicationService {",
      "  @Resource",
      "  private BookPageApplicationService bookPageApplicationService;",
      "",
      "  public ViewMetaEngineInterResponseDTO page(ViewMetaEngineUsePageRequestDTO requestDTO) {",
      "    return bookPageApplicationService.page(requestDTO);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageApplicationService.java"), [
      "package demo;",
      "public interface BookPageApplicationService {",
      "  ViewMetaEngineInterResponseDTO page(ViewMetaEngineUsePageRequestDTO requestDTO);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageApplicationServiceImpl.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class BookPageApplicationServiceImpl implements BookPageApplicationService {",
      "  @Resource",
      "  private BookQueryPort bookQueryPort;",
      "",
      "  public ViewMetaEngineInterResponseDTO page(ViewMetaEngineUsePageRequestDTO requestDTO) {",
      "    Long tenantId = TenantContextHolder.getTenantId();",
      "    bookQueryPort.audit(\"page(requestDTO)\", 1);",
      "    bookQueryPort.loadIds().stream();",
      "    normalizeForQuery(requestDTO);",
      "    return bookQueryPort.selectPage(requestDTO);",
      "  }",
      "",
      "  private void normalizeForQuery(ViewMetaEngineUsePageRequestDTO requestDTO) {",
      "    requestDTO.setPageSize(100);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookQueryPort.java"), [
      "package demo;",
      "public interface BookQueryPort {",
      "  ViewMetaEngineInterResponseDTO selectPage(ViewMetaEngineUsePageRequestDTO requestDTO);",
      "  void audit(String message, int count);",
      "  java.util.List<Long> loadIds();",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookQueryPortAdapter.java"), [
      "package demo;",
      "import org.springframework.stereotype.Component;",
      "",
      "@Component",
      "public class BookQueryPortAdapter implements BookQueryPort {",
      "  public ViewMetaEngineInterResponseDTO selectPage(ViewMetaEngineUsePageRequestDTO requestDTO) {",
      "    dynamicTableQueryRepository.selectCount(null);",
      "    return new ViewMetaEngineInterResponseDTO();",
      "  }",
      "  public void audit(String message, int count) {}",
      "  public java.util.List<Long> loadIds() { return java.util.List.of(); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageAssembler.java"), [
      "package demo;",
      "import org.springframework.stereotype.Component;",
      "",
      "@Component",
      "public class BookPageAssembler {",
      "  public ViewMetaEngineUsePageRequestDTO toRequestDTO(EngineUsePageInterReqVO reqVO) { return new ViewMetaEngineUsePageRequestDTO(); }",
      "  public EngineInterRespVO toRespVO(ViewMetaEngineInterResponseDTO responseDTO) { return new EngineInterRespVO(); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EngineUsePageInterReqVO.java"), [
      "package demo;",
      "public class EngineUsePageInterReqVO {",
      "  private String operator;",
      "  private Long dataId;",
      "  private Long childFormFieldId;",
      "  private Object horizontalValues;",
      "  private Object horizontalKeyValues;",
      "  private Object horizontalDataPageTreeReqVOs;",
      "  private Object qualityValues;",
      "  private Object textFilterValue;",
      "  private String uploadTmpTableName;",
      "  private Integer uploadTmpFlag;",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "ViewMetaEngineUsePageRequestDTO.java"), [
      "package demo;",
      "public class ViewMetaEngineUsePageRequestDTO {",
      "  private Integer pageSize;",
      "  public void setPageSize(Integer pageSize) { this.pageSize = pageSize; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "ViewMetaEngineInterResponseDTO.java"), "package demo; public class ViewMetaEngineInterResponseDTO {}\n");
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EngineInterRespVO.java"), "package demo; public class EngineInterRespVO {}\n");

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "POST",
      endpoint: "/api/books/page",
      maxDepth: 6
    });

    assert.equal(report.selectedRoute?.className, "BookPageController");
    assert.equal(report.selectedRoute?.methodName, "pageByView");
    assert.ok(report.callGraph.nodes.some((node) => node.id.includes("BookPageRouteApplicationServiceImpl.pageByView")));
    assert.ok(report.callGraph.nodes.some((node) => node.id.includes("BookPageApplicationServiceImpl.page")));
    assert.ok(report.callGraph.nodes.some((node) => node.id.includes("BookQueryPortAdapter.selectPage")));
    assert.ok(report.callGraph.nodes.some((node) => node.id.includes("BookQueryPortAdapter.audit")));
    assert.equal(report.callGraph.edges.some((edge) => edge.call.method === "stream" && edge.resolution === "unresolved"), false);
    assert.equal(report.callGraph.truncation.maxTotalEdges, 600);
    assert.equal(report.callGraph.edges.some((edge) => edge.call.method === "setPageSize"), false);
    assert.deepEqual(report.requestModel?.fields, [
      "childFormFieldId",
      "dataId",
      "horizontalDataPageTreeReqVOs",
      "horizontalKeyValues",
      "horizontalValues",
      "operator",
      "qualityValues",
      "textFilterValue",
      "uploadTmpFlag",
      "uploadTmpTableName"
    ]);
    assert.ok(report.riskSignals.some((signal) => signal.id === "implicit-runtime-context"));
    assert.ok(report.riskSignals.some((signal) => signal.id === "refresh-operator-unresolved"));
    assert.ok(report.riskSignals.some((signal) => signal.id === "legacy-request-fields"));
    assert.ok(report.riskSignals.some((signal) => signal.id === "dynamic-query-execution"));
    assert.equal(report.goldenCasePlan.model, "page-query");
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "refresh-operator"));
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "child-form-page"));
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "horizontal-page"));
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "quality-text-filter"));
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "upload-preview-page"));
    assert.match(renderJavaEndpointAnalysisReport(report), /Java Endpoint Analysis/);
    assert.match(renderJavaEndpointAnalysisReport(report), /Call graph limits/);

    const written = await writeJavaEndpointAnalysisReport(report, path.join(dir, ".migration-guard"));
    assert.match(written.outputPath ?? "", /post-api-books-page\.json$/);
    assert.match(written.markdownPath ?? "", /post-api-books-page\.md$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis uses batch-command golden cases for batch update endpoints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-batch-"));

  try {
    await mkdir(path.join(dir, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookBatchController.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "import org.springframework.web.context.request.RequestContextHolder;",
      "",
      "@RestController",
      "@RequestMapping(\"/api/books\")",
      "public class BookBatchController {",
      "  @Resource",
      "  private BookBatchService bookBatchService;",
      "",
      "  @PostMapping(\"/batchUpdateWithProgress\")",
      "  public EngineInterRespVO batchUpdateWithProgress(EngineInterBatchReqVO reqVO) {",
      "    RequestContextHolder.setRequestAttributes(RequestContextHolder.getRequestAttributes(), true);",
      "    assertBatchSizeUnderLimit(reqVO);",
      "    reqVO.setEnableProgress(true);",
      "    EngineInterRespVO response = bookBatchService.batchUpdateByView(reqVO);",
      "    recordUndoWithoutFailedRows(reqVO, response);",
      "    return response;",
      "  }",
      "",
      "  private void assertBatchSizeUnderLimit(EngineInterBatchReqVO reqVO) {",
      "    if (reqVO.getBatchPostValueList().size() > 10000) { throw new IllegalArgumentException(); }",
      "  }",
      "",
      "  private void recordUndoWithoutFailedRows(EngineInterBatchReqVO reqVO, EngineInterRespVO response) {",
      "    recordData(reqVO);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookBatchService.java"), [
      "package demo;",
      "public interface BookBatchService {",
      "  EngineInterRespVO batchUpdateByView(EngineInterBatchReqVO reqVO);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookBatchServiceImpl.java"), [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class BookBatchServiceImpl implements BookBatchService {",
      "  public EngineInterRespVO batchUpdateByView(EngineInterBatchReqVO reqVO) {",
      "    progressPublisher.push(reqVO.getClientSessionId());",
      "    return new EngineInterRespVO();",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EngineInterBatchReqVO.java"), [
      "package demo;",
      "import java.util.List;",
      "import java.util.Map;",
      "public class EngineInterBatchReqVO {",
      "  private List<Object> batchHeaderValueList;",
      "  private String batchPkFieldValue;",
      "  private List<Object> batchPostValueList;",
      "  private String clientSessionId;",
      "  private Long dataId;",
      "  private String domain;",
      "  private Boolean enableProgress;",
      "  private Integer expectedTotalRows;",
      "  private Map<String, Object> headerValues;",
      "  private Long horizontalId;",
      "  private Long interId;",
      "  private Boolean isLastChunk;",
      "  private String operationKind;",
      "  private String operationLabel;",
      "  private Boolean undo;",
      "  private Long usePageId;",
      "  public List<Object> getBatchPostValueList() { return batchPostValueList; }",
      "  public void setEnableProgress(Boolean enableProgress) { this.enableProgress = enableProgress; }",
      "  public String getClientSessionId() { return clientSessionId; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EngineInterRespVO.java"), "package demo; public class EngineInterRespVO {}\n");

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "POST",
      endpoint: "/api/books/batchUpdateWithProgress",
      maxDepth: 4
    });

    assert.equal(report.selectedRoute?.methodName, "batchUpdateWithProgress");
    assert.equal(report.goldenCasePlan.model, "batch-command");
    assert.deepEqual(report.goldenCasePlan.cases.map((item) => item.id), [
      "batch-update-success",
      "batch-partial-failure",
      "batch-row-limit-rejected",
      "horizontal-batch-upsert",
      "chunked-paste-progress",
      "web-rpc-entrypoint-parity",
      "undo-excludes-failed-rows",
      "progress-event-shape"
    ]);
    assert.equal(report.goldenCasePlan.fixtureTemplate.body.enableProgress, true);
    assert.ok(report.goldenCasePlan.comparisonDimensions.some((dimension) => dimension.includes("progress events")));
    assert.ok(report.recommendedNextActions.some((action) => action.includes("batch-command golden fixtures")));
    assert.match(renderJavaEndpointAnalysisReport(report), /Golden case model: batch-command/);
    assert.doesNotMatch(renderJavaEndpointAnalysisReport(report), /Standard first-page query/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis uses sync-command golden cases for refresh sync endpoints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-sync-"));

  try {
    await mkdir(path.join(dir, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookPageController.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "import org.springframework.web.context.request.RequestContextHolder;",
      "",
      "@RestController",
      "@RequestMapping(\"/api/books\")",
      "public class BookPageController {",
      "  @Resource",
      "  private BookRefreshSyncApplicationService refreshSyncApplicationService;",
      "",
      "  @PostMapping(\"/refreshSync\")",
      "  public CommonResult<Boolean> refreshSync(EngineRefreshSyncReqVO reqVO) {",
      "    RequestContextHolder.setRequestAttributes(RequestContextHolder.getRequestAttributes(), true);",
      "    return CommonResult.success(refreshSyncApplicationService.refreshSync(reqVO));",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookRefreshSyncApplicationService.java"), [
      "package demo;",
      "public interface BookRefreshSyncApplicationService {",
      "  Boolean refreshSync(EngineRefreshSyncReqVO reqVO);",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "BookRefreshSyncApplicationServiceImpl.java"), [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class BookRefreshSyncApplicationServiceImpl implements BookRefreshSyncApplicationService {",
      "  public Boolean refreshSync(EngineRefreshSyncReqVO reqVO) {",
      "    if (OperatorEnum.REFRESH.getValue().equals(reqVO.getOperator())) {",
      "      return doManualRefresh(reqVO);",
      "    }",
      "    return doAutoRefresh(reqVO);",
      "  }",
      "",
      "  private Boolean doManualRefresh(EngineRefreshSyncReqVO reqVO) {",
      "    LocalDateTime syncBoundaryTs = LocalDateTime.now();",
      "    if (batchUpdateInFlightRegistry.isActive(reqVO.getPanelId())) { return true; }",
      "    boolean ok = progressService.syncWithProgress(reqVO.getUsePageId(), reqVO.getPanelId(), true);",
      "    updateDataAndSyncTimeByPanelId(reqVO.getPanelId(), syncBoundaryTs);",
      "    clearUndoOperation(reqVO.getPanelId());",
      "    reconcileBillOnlyUnarchived(reqVO.getPanelId());",
      "    return ok;",
      "  }",
      "",
      "  private Boolean doAutoRefresh(EngineRefreshSyncReqVO reqVO) {",
      "    if (batchUpdateInFlightRegistry.isActive(reqVO.getPanelId())) { return true; }",
      "    return progressService.syncWithProgressNoReload(reqVO.getUsePageId(), reqVO.getPanelId(), false);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EngineRefreshSyncReqVO.java"), [
      "package demo;",
      "import java.util.List;",
      "import java.util.Map;",
      "public class EngineRefreshSyncReqVO {",
      "  private String operator;",
      "  private Long panelId;",
      "  private Long pageId;",
      "  private Long targetFieldId;",
      "  private Long usePageId;",
      "  private Long pageNo;",
      "  private Integer pageSize;",
      "  private Map<String, Object> headerValues;",
      "  private Map<String, Object> postValues;",
      "  private Map<String, Object> selectValues;",
      "  private List<Object> orderValues;",
      "  private Long dataId;",
      "  private Long childFormFieldId;",
      "  private String uploadTmpTableName;",
      "  private Integer uploadTmpFlag;",
      "  public String getOperator() { return operator; }",
      "  public Long getPanelId() { return panelId; }",
      "  public Long getUsePageId() { return usePageId; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(dir, "src", "main", "java", "demo", "CommonResult.java"), "package demo; public class CommonResult<T> { public static <T> CommonResult<T> success(T value) { return new CommonResult<T>(); } }\n");

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "POST",
      endpoint: "/api/books/refreshSync",
      maxDepth: 4
    });

    assert.equal(report.selectedRoute?.methodName, "refreshSync");
    assert.equal(report.goldenCasePlan.model, "sync-command");
    assert.deepEqual(report.goldenCasePlan.cases.map((item) => item.id), [
      "manual-refresh-success",
      "auto-refresh-incremental",
      "missing-id-resolution",
      "batch-inflight-skip",
      "duplicate-refresh-dedup",
      "progress-event-shape",
      "snapshot-context-only",
      "sync-boundary-timestamp",
      "manual-post-side-effects",
      "column-field-ignored"
    ]);
    assert.equal(report.goldenCasePlan.fixtureTemplate.body.operator, "REFRESH");
    assert.ok(report.goldenCasePlan.comparisonDimensions.some((dimension) => dimension.includes("manual versus automatic")));
    assert.ok(report.recommendedNextActions.some((action) => action.includes("sync-command golden fixtures")));
    assert.match(renderJavaEndpointAnalysisReport(report), /Golden case model: sync-command/);
    assert.doesNotMatch(renderJavaEndpointAnalysisReport(report), /Standard first-page query/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis models update routes as mutation commands and applies command risks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-mutation-"));
  try {
    const sourceDir = path.join(dir, "src", "main", "java", "demo");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "FieldController.java"), [
      "package demo;",
      "@RestController",
      "@RequestMapping(\"/api/fields\")",
      "public class FieldController {",
      "  private FieldService fieldService;",
      "  // @PreAuthorize(\"hasAuthority('field:update')\")",
      "",
      "  @PutMapping(\"/update\")",
      "  public Object update(FieldUpdateReqVO reqVO) {",
      "    return fieldService.update(reqVO);",
      "  }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "FieldService.java"), [
      "package demo;",
      "public class FieldService {",
      "  @Transactional",
      "  public Object update(FieldUpdateReqVO reqVO) {",
      "    reqVO.setName(generateUniqueName(reqVO.getName()));",
      "    repository.findByName(reqVO.getName());",
      "    repository.updateById(reqVO);",
      "    return reqVO;",
      "  }",
      "  private String generateUniqueName(String value) { return value; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "FieldUpdateReqVO.java"), [
      "package demo;",
      "public class FieldUpdateReqVO {",
      "  private Long id;",
      "  private Long panelId;",
      "  private String name;",
      "  private String type;",
      "  public String getName() { return name; }",
      "  public void setName(String value) { name = value; }",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "PUT",
      endpoint: "/api/fields/update",
      maxDepth: 5
    });
    const riskIds = new Set(report.riskSignals.map((signal) => signal.id));

    assert.equal(report.goldenCasePlan.model, "mutation-command");
    assert.ok(report.goldenCasePlan.cases.some((item) => item.id === "concurrent-write"));
    assert.equal(report.goldenCasePlan.cases.some((item) => item.id === "standard-page"), false);
    assert.equal(riskIds.has("refresh-operator-unresolved"), false);
    assert.equal(riskIds.has("query-side-effects"), false);
    const detectedRisks = [...riskIds].sort().join(",");
    assert.equal(riskIds.has("disabled-authorization-guard"), true, detectedRisks);
    assert.equal(riskIds.has("request-constraint-coverage-unresolved"), true, detectedRisks);
    assert.equal(riskIds.has("lost-update-guard-unresolved"), true, detectedRisks);
    assert.equal(riskIds.has("idempotency-ordering-risk"), true, detectedRisks);
    assert.match(renderJavaEndpointAnalysisReport(report), /Golden case model: mutation-command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis reports endpoint-not-found when no route matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-missing-"));

  try {
    await mkdir(path.join(dir, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(dir, "src", "main", "java", "demo", "HealthController.java"), [
      "package demo;",
      "import org.springframework.web.bind.annotation.GetMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "@RestController",
      "public class HealthController {",
      "  @GetMapping(\"/health\")",
      "  public String health() { return \"ok\"; }",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "POST",
      endpoint: "/missing"
    });

    assert.equal(report.selectedRoute, undefined);
    assert.equal(report.summary.exactMatchCount, 0);
    assert.ok(report.riskSignals.some((signal) => signal.id === "endpoint-not-found" && signal.severity === "high"));
    assert.deepEqual(report.recommendedNextActions, [
      "Add or fix Java route detection for the requested Spring endpoint before planning runtime extraction."
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis treats declared Feign clients as external boundaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-feign-"));
  try {
    const sourceDir = path.join(dir, "src", "main", "java", "demo");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "RemoteController.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "import org.springframework.web.bind.annotation.GetMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "@RestController",
      "public class RemoteController {",
      " @Resource",
      " private RemoteClient remoteClient;",
      " @GetMapping(\"/remote\")",
      " public Object remote() {",
      "  return remoteClient.fetch(\"tenant\");",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "RemoteClient.java"), [
      "package demo;",
      "import org.springframework.cloud.openfeign.FeignClient;",
      "@FeignClient(name=\"remote\")",
      "public interface RemoteClient {",
      " Object fetch(String tenant);",
      "}"
    ].join("\n"));
    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/remote" });
    const edge = report.callGraph.edges.find((candidate) => candidate.call.method === "fetch");
    assert.equal(edge?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.some((candidate) => candidate.resolution === "unresolved"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis parses multiline controller signatures and explicit external calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-multiline-"));
  try {
    await mkdir(path.join(dir, "demo"), { recursive: true });
    await writeFile(path.join(dir, "demo", "UploadController.java"), [
      "package demo;", "import jakarta.annotation.Resource;", "@RestController", "@RequestMapping(\"/api/files\")",
      "public class UploadController {", "  @Resource", "  private UploadService uploadService;", "",
      "  @GetMapping(\"/page\")", "  public CommonResult<PageResult<FileDO>> page(",
      "      @RequestParam Long ownerId,", "      @RequestParam Integer pageNo,", "      @RequestParam Integer pageSize) {",
      "    return success(uploadService.getPage(ownerId, pageNo, pageSize));", "  }", "",
      "  @PostMapping(\"/upload\")", "  public Object upload(FileReq req) {",
      "    fileClient.upload(req);", "    return uploadService.record(req);", "  }", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "UploadService.java"), [
      "package demo;", "public interface UploadService {", " Object getPage(Long ownerId, Integer pageNo, Integer pageSize);", " Object record(FileReq req);", "}"
    ].join("\n"));
    await writeFile(path.join(dir, "demo", "UploadServiceImpl.java"), [
      "package demo;", "public class UploadServiceImpl implements UploadService {", " public Object getPage(Long ownerId, Integer pageNo, Integer pageSize) { return null; }", " public Object record(FileReq req) { return null; }", "}"
    ].join("\n"));
    const page = await analyzeJavaEndpoint({ root: dir, endpoint: "/api/files/page", method: "GET" });
    assert.equal(page.selectedRoute?.methodName, "page");
    const upload = await analyzeJavaEndpoint({ root: dir, endpoint: "/api/files/upload", method: "POST" });
    assert.ok(upload.callGraph.nodes.some((item) => item.id.startsWith("external:") && item.methodName === "upload"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("java endpoint analysis resolves local value accessors and project static helpers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-local-types-"));
  try {
    const sourceDir = path.join(dir, "src", "main", "java", "demo");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "LocalTypeController.java"), [
      "package demo;",
      "@RestController",
      "public class LocalTypeController {",
      " @GetMapping(\"/local-types\")",
      " public String read() {",
      "  View view = new View(\" value \");",
      "  return Helpers.normalize(view.name());",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "View.java"), "package demo; public record View(String name) {}\n");
    await writeFile(path.join(sourceDir, "Helpers.java"), [
      "package demo;",
      "public final class Helpers {",
      " public static String normalize(String value) { return value.trim(); }",
      "}"
    ].join("\n"));
    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/local-types" });
    assert.ok(report.callGraph.nodes.some((node) => node.className === "Helpers" && node.methodName === "normalize"));
    assert.ok(report.callGraph.nodes.some((node) =>
      node.kind === "dto"
      && node.className === "View"
      && node.methodName === "name"
      && node.signature?.includes("[generated-value-accessor]")
    ));
    assert.equal(report.callGraph.edges.some((edge) => edge.unresolvedTarget === "view.name" && edge.resolution === "unresolved"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis honors explicit type imports over duplicate simple names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-imports-"));
  try {
    const appDir = path.join(dir, "src", "main", "java", "app");
    const preferredDir = path.join(dir, "src", "main", "java", "preferred");
    const legacyDir = path.join(dir, "src", "main", "java", "legacy");
    await mkdir(appDir, { recursive: true });
    await mkdir(preferredDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(appDir, "ImportController.java"), [
      "package app;",
      "import preferred.DateFormatUtils;",
      "import external.StrUtil;",
      "@RestController",
      "public class ImportController {",
      " @GetMapping(\"/imports\")",
      " public String read() {",
      "  Object raw = \"2026-07\";",
      "  return StrUtil.blankToDefault(DateFormatUtils.parseMonth(raw == null ? null : raw.toString()), \"\");",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(preferredDir, "DateFormatUtils.java"), [
      "package preferred;",
      "public final class DateFormatUtils {",
      " public static String parseMonth(String value) { return value; }",
      " public static String parseMonth(Object value) { return value.toString(); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(legacyDir, "DateFormatUtils.java"), [
      "package legacy;",
      "public final class DateFormatUtils {",
      " public static String parseMonth(String value) { return value; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(legacyDir, "StrUtil.java"), [
      "package legacy;",
      "public final class StrUtil {",
      " public static String blankToDefault(String value, String fallback) { return value; }",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/imports" });
    const dateEdge = report.callGraph.edges.find((edge) => edge.call.method === "parseMonth");
    const strEdge = report.callGraph.edges.find((edge) => edge.call.method === "blankToDefault");
    assert.equal(dateEdge?.resolution, "field-injection");
    assert.match(dateEdge?.to ?? "", /^preferred\.DateFormatUtils\.parseMonth:/);
    assert.equal(strEdge?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.some((edge) => edge.resolution === "ambiguous" || edge.resolution === "unresolved"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis prefers a duplicate qualified type from the caller module", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-module-local-"));
  try {
    const moduleA = path.join(dir, "module-a", "src", "main", "java", "shared");
    const moduleB = path.join(dir, "module-b", "src", "main", "java", "shared");
    await mkdir(moduleA, { recursive: true });
    await mkdir(moduleB, { recursive: true });
    await writeFile(path.join(moduleA, "DeepCopy.java"), [
      "package shared;",
      "public final class DeepCopy {",
      " public static Object copy(Object value) { return value; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(moduleB, "DeepCopy.java"), [
      "package shared;",
      "public final class DeepCopy {",
      "",
      " public static Object copy(Object value) { return value; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(moduleB, "CopyController.java"), [
      "package shared;",
      "@RestController",
      "public class CopyController {",
      " @GetMapping(\"/copy\")",
      " public Object read(Object value) { return DeepCopy.copy(value); }",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/copy" });
    const edge = report.callGraph.edges.find((candidate) => candidate.call.method === "copy");
    const target = report.callGraph.nodes.find((candidate) => candidate.id === edge?.to);
    assert.equal(edge?.resolution, "field-injection");
    assert.match(target?.file ?? "", /^module-b\//);
    assert.equal(report.callGraph.edges.some((candidate) => candidate.resolution === "ambiguous"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis recognizes commented multiline record accessors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-record-comments-"));
  try {
    const sourceDir = path.join(dir, "src", "main", "java", "demo");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "RecordController.java"), [
      "package demo;",
      "@RestController",
      "public class RecordController {",
      " @GetMapping(\"/record-comments\")",
      " public String read() {",
      "  Container.FieldMeta field = new Container.FieldMeta(\"name\", \"text\");",
      "  UpdatePlan plan = new UpdatePlan(\"name\");",
      "  plan.toBuilder();",
      "  return field.fieldFormatTag();",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "Container.java"), [
      "package demo;",
      "public final class Container {",
      " public record FieldMeta(",
      "   String field,",
      "   // The format controls downstream comparison semantics.",
      "   String fieldFormatTag",
      " ) {}",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "FieldMeta.java"), [
      "package demo;",
      "public class FieldMeta {",
      " private String unrelated;",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "UpdatePlan.java"), [
      "package demo;",
      "@lombok.Value",
      "@lombok.Builder(toBuilder = true)",
      "public class UpdatePlan {",
      " String name;",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/record-comments" });
    const edge = report.callGraph.edges.find((candidate) => candidate.call.method === "fieldFormatTag");
    const builderEdge = report.callGraph.edges.find((candidate) => candidate.call.method === "toBuilder");
    assert.equal(edge?.resolution, "static-or-external");
    assert.match(edge?.to ?? "", /^external:/);
    assert.equal(builderEdge?.resolution, "static-or-external");
    assert.equal(report.callGraph.edges.some((candidate) => candidate.resolution === "unresolved"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis uses enum method return types to resolve overloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-enum-overload-"));
  try {
    const sourceDir = path.join(dir, "src", "main", "java", "demo");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "EnumController.java"), [
      "package demo;",
      "import jakarta.annotation.Resource;",
      "@RestController",
      "public class EnumController {",
      " @Resource",
      " private CatalogService catalogService;",
      " @GetMapping(\"/enum-overload\")",
      " public Object read() { return catalogService.find(Category.PRIMARY.getCode()); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "CatalogService.java"), [
      "package demo;",
      "public class CatalogService {",
      " public Object find(Integer code) { return code; }",
      " public Object find(java.util.List<String> names) { return names; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceDir, "Category.java"), [
      "package demo;",
      "public enum Category {",
      " PRIMARY;",
      " public Integer getCode() { return 1; }",
      "}"
    ].join("\n"));
    const report = await analyzeJavaEndpoint({ root: dir, method: "GET", endpoint: "/enum-overload" });
    const edge = report.callGraph.edges.find((candidate) => candidate.call.receiver === "catalogService" && candidate.call.method === "find");
    assert.equal(edge?.resolution, "field-injection");
    assert.deepEqual(edge?.call.argumentTypes, ["Integer"]);
    assert.ok(edge?.to?.includes("CatalogService.find"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("java endpoint analysis reports edge-cap truncation and honors max-edges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-endpoint-edge-cap-"));

  try {
    await mkdir(path.join(dir, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(dir, "src", "main", "java", "demo", "EdgeCapController.java"), [
      "package demo;",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "@RestController",
      "public class EdgeCapController {",
      "  @PostMapping(\"/edge-cap\")",
      "  public String probe() {",
      "    ExternalHooks.one();",
      "    ExternalHooks.two();",
      "    ExternalHooks.three();",
      "    return \"ok\";",
      "  }",
      "}"
    ].join("\n"));

    const report = await analyzeJavaEndpoint({
      root: dir,
      method: "POST",
      endpoint: "/edge-cap",
      maxDepth: 6,
      maxEdges: 2
    });

    assert.equal(report.callGraph.edges.length, 2);
    assert.equal(report.callGraph.truncation.maxTotalEdges, 2);
    assert.equal(report.callGraph.truncation.edgeCapHit, true);
    assert.equal(report.callGraph.truncation.depthCapHit, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
