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
      "batch-insert-header-defaults",
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
