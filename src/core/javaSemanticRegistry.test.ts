import assert from "node:assert/strict";
import test from "node:test";
import { classifyJavaSemantic } from "./javaSemanticRegistry.js";

test("Java semantic registry classifies deterministic JDK value operations", () => {
  for (const symbol of [
    "items.stream().collect",
    "items.stream().filter",
    "value.indexOf",
    "part.chars().allMatch",
    "value.toPlainString",
    "result.append",
    "LocalDate.parse",
    "date.atStartOfDay",
    "formatter.format",
    "latest.sort",
    "items.values().stream",
    "result.retainAll",
    "date.plusDays",
    "parseDate.dayOfMonth",
    "ISO_DATE_TIME.parse",
    "rawObject.toString().equals",
    "DAYS.between",
    "out.toByteArray"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, "calculation", symbol);
  }
  assert.equal(classifyJavaSemantic("FieldDateFormatValueDataServiceImpl.handleFieldDateFormat")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("FieldPercentageValueDataServiceImpl.handleShowFieldValue")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("FieldPercentageValueDataServiceImpl.handleFormatFieldValue")?.kind, "calculation");
  for (const symbol of [
    "ColorEvaluatorPipeline.run",
    "EngineTablePageOperatorServiceImpl.processChildFormCondition",
    "EngineUsePageServiceImpl.applySuperImportShowIfNeeded",
    "ViewConfigServiceImpl.applyViewConfig",
    "ViewDynamicFieldEngineServiceImpl.mergeFieldConfig",
    "ViewMetaChildFormConditionApplicationServiceImpl.applyPageHeaderConditions"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, "calculation", symbol);
  }
  assert.equal(classifyJavaSemantic("ViewMetaFieldValueSyncStatusService.cleanupExpired")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("ViewMetaFieldValueSyncStatusService.enforceMaxEntries")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("DynamicAlterTableServiceImpl.alterAdd")?.kind, "state-write");
  for (const symbol of [
    "AutomationConditionBizServiceImpl.toDate",
    "LedgerImportHistoryService.defaultLong",
    "ViewDynamicHorizontalProcessDateServiceImpl.extractDatePart",
    "ViewMetaInitApplicationServiceImpl.toLong",
    "OperationLogDashboardServiceImpl.asInt",
    "ViewMetaExcelImportBatchExecuteApplicationServiceImpl.safeLong",
    "OrphanedDataCleanupServiceImpl.defaultZero",
    "SyncTaskServiceImpl.clampPercent",
    "AiExpressionCompileService.renderFormula",
    "AiEmpowerReportCustomAbilityServiceImpl.describeCoverage",
    "AiEmpowerReportRunnerImpl.truncate",
    "BillFieldDataServiceImpl.bizKeyOfHandleLog",
    "ViewRelationGraphServiceImpl.generateEdgeKey"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, "calculation", symbol);
  }
});

test("Java semantic registry preserves synchronization and diagnostic effects", () => {
  assert.equal(classifyJavaSemantic("openDataFuture.join")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("executor.awaitTermination")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("queue.offer")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("barrier.signalDone")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("signal.release")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("heartbeatScheduler.scheduleWithFixedDelay")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("sqlSessionTemplate.flushStatements")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("DateTime.now")?.kind, "clock-read");
  assert.equal(classifyJavaSemantic("JSON.toJSON")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("error.printStackTrace")?.kind, "observability");
  assert.equal(classifyJavaSemantic("UUID.randomUUID")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("ZoneId.systemDefault")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("dbConnection.prepareStatement")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("pstmt.executeBatch")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("logDir.mkdirs")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("zipOut.putNextEntry")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("pb.start")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("process.waitFor")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("request.addHeader")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("response.body")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("backupCompareExecutor.shutdownNow")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("bfsQueue.poll")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("service.handle")?.kind, undefined);
});

test("Java semantic registry narrows helpers, value factories, and application contexts", () => {
  assert.equal(classifyJavaSemantic("FieldValueService.formatToken file.java private String formatToken(String raw) {")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("DateService.parseDate file.java private static LocalDate parseDate(String raw) {")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("GroupRefMultiRuleContext.empty")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AiCallOutcome.failed")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AllocationOrderContext.current")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("BatchBillConfigContext.newScope")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("AiCallContext.runWithBizContext")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("CascadeContext.push")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("CascadePreSnapshotContext.exit")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("CascadeVisitedPanelsContext.snapshot")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("ruleContext.rulesOf")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ruleContext.nodesOf")?.kind, "calculation");
  for (const symbol of [
    "AiOutputTypeResolver.resolve",
    "BatchTypedFieldResolver.resolve",
    "Eligibility.no",
    "Eligibility.yes",
    "ImportFailureMessageResolver.resolve",
    "IntegerExtractor.extract",
    "NoMenuUsePageCleanupStats.empty",
    "NumberExtractor.extract",
    "NumberPercentageExtractor.extract",
    "ViewMetaExcelHeadSnapshot.from",
    "ViewMetaRespKeyResolver.resolve"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, "calculation", symbol);
  }
  assert.equal(classifyJavaSemantic("FieldValueService.handle file.java private String handle(Object value) {")?.kind, undefined);
  assert.equal(classifyJavaSemantic("PublicParser.parse file.java public Object parse(String value) {")?.kind, undefined);
  assert.equal(classifyJavaSemantic("BusinessContext.process")?.kind, undefined);
  assert.equal(classifyJavaSemantic("BusinessResolver.resolve")?.kind, undefined);
  assert.equal(classifyJavaSemantic("PayloadFactory.create")?.kind, undefined);
  assert.equal(classifyJavaSemantic("FieldValueDataServiceImpl.handleFieldValue")?.kind, undefined);
  assert.equal(classifyJavaSemantic("DynamicAlterTableServiceImpl.alterDrop")?.kind, undefined);
  assert.equal(classifyJavaSemantic("SyncTaskServiceImpl.finalizeTask")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("RobustComparisonParser.parseChainedComparison")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("SafeExpressionEvaluator.evalToOutput")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ExprJsonCodec.fromJson")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("entry.expiresAtMillis")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ctx.currentRow")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldDataServiceImpl.handleUnionConditionData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicQuickBizDataServiceImpl.refFieldQuick")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicQuickBizDataServiceImpl.refRelateFieldQuick")?.kind, "state-read");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldDataServiceImpl.handleAllFieldSort")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("OperationLogSyncServiceImpl.syncDetailLogToCloudTable")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldDataServiceImpl.processShowFieldLogicRelation")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportBatchExecuteApplicationServiceImpl.collectSheetWarnings")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("EngineUseChangeServiceImpl.handleChildFormDefaultValues")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("AiEmpowerBizServiceImpl.empowerNewFieldData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("SpeechFieldProcessServiceImpl.processNewSpeechFieldRows")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldSynOldDataServiceImpl.handleUnionRefData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportAnalyzeApplicationServiceImpl.toFieldDraftResult")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportBatchExecuteApplicationServiceImpl.joinPathSegments")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportHistoryApplicationServiceImpl.invalidParam")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AutomationConfigDataBizServiceImpl.geAutomationReportRespVO")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewDynamicOldDataHandleServiceImpl.escapeSql")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ctx.horizontalId")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("plan.splitValues().size")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("sql.Timestamp")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("BackupServiceImpl.generateBackupId")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("DynamicDataSyncBizServiceImpl.refreshData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("DynamicDataSyncDataBizFinalServiceImpl.refreshData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicUseGroupDataBizServiceImpl.refreshData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("viewLayoutActivateExecutionPort.activate")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("viewLayoutTransferCopyHomeExecutionPort.transferToHome")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldDataServiceImpl.handleSyncData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewMetaPageRefValueSyncExecutor.toLongValue")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("EngineUsePageServiceImpl.applyChildFormFieldConfig")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("LedgerAnalysisCore.jsSurprise")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("pathSegments.addFirst")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("NlsUsageController.toDTO")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("OcrUsageController.toDTO")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("NlsUsageController.toEpochMillis")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("OcrUsageController.toEpochMillis")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("ViewDynamicUsePageNewCopyServiceImpl.quickCopyKey")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("webSocketACL.sendToAdmin")?.kind, "event-publish");
  assert.equal(classifyJavaSemantic("aiFieldClassifyACL.classifyFieldOption")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("aiFieldClassifyACL.matchFieldTags")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("aiFieldClassifyACL.summaryFields")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("aiImageAnalyzeACL.imageAnalyze")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("aiInfoExtractACL.extractInfo")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("AnomalyRuleServiceImpl.toggleStatus")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("SensitiveTableServiceImpl.toggleStatus")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("AutomationConfigDataBizServiceImpl.renameAutomationConfig")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("BatchExportAsyncServiceImpl.reexport")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("BatchExportAsyncServiceImpl.resumeTask")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ctx.validRulesByLeftFieldId")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.leftField")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.operator")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.cellFontColor")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.cellBgColor")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.joinLeftAliases")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rule.joinKeyToRightValues")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("OtherUsageController.toDTO")?.kind, undefined);
  assert.equal(classifyJavaSemantic("OtherCopyServiceImpl.quickCopyKey")?.kind, undefined);
  assert.equal(classifyJavaSemantic("otherWebSocket.sendToAdmin")?.kind, undefined);
  assert.equal(classifyJavaSemantic("OtherRuleServiceImpl.toggleStatus")?.kind, undefined);
  assert.equal(classifyJavaSemantic("am.max")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("cmp.thenComparing")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("c.reversed")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ctx.creator")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("creator.userId")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("f1.lastModified")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("plan.splitValues")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AutomationTriggerSuppressor.suppress")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("AutomationTriggerSuppressor.isSuppressed")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("ColorAttributeDefaultFilter.stripDefaultColors")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaPageRefValueSyncExecutor.quoteSqlIdentifier")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewDynamicLayoutEngineServiceImpl.reverseDirection")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("SqlFieldExtractor.extractFieldFromAggregateFunction")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("delta.abs")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("threshold.negate")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("endDate.before")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("dateTime.hour")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AiEmpowerRefreshTaskServiceImpl.touchHeartbeat")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("OcrACL.recognizeInvoice")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("NlsSpeechACL.tts")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("EngineInitOperatorServiceImpl.ayncInit")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("AiEmpowerConfigBizServiceImpl.triggerReportCustomAbilityIfNeeded")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportBatchWebSocketNotifier.pushResult")?.kind, "event-publish");
  assert.equal(classifyJavaSemantic("webSocketMessageSender.sendObject")?.kind, "event-publish");
  assert.equal(classifyJavaSemantic("LedgerCommonFieldServiceImpl.currentUserId")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("EngineInitOperatorServiceImpl.applyBatchHeaderValuesAsDefaultValues")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportDomainServiceImpl.applyColumnOverride")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportAnalyzeSession.requireSheet")?.kind, "decision");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportAnalyzeSession.requireColumn")?.kind, "decision");
  assert.equal(classifyJavaSemantic("AiEmpowerFieldCustomAbilityServiceImpl.enterRefreshScope")?.kind, "context-resolution");
  assert.equal(classifyJavaSemantic("ViewDynamicHorizontalConditionDataServiceImpl.judgeIsSyncColData")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("DynamicTreeHeaderExcelExporter.exportToExcel")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("hit.compiledJson")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("hit.expired")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("out.putBackground")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("AiCustomAbilityReqDTO.FieldItem")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("FieldRelationGraphRespVO.CanvasConfig")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("crj.joins")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("cmd.startDate")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("baseDir.relativize")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("BillApprovalFieldResultEnum.valueOf")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("PartitionTypeEnum.fromCode")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("SELECT_REF.getTagKey().equals")?.defaultOwnership, "reviewed-exclusion");
  assert.equal(classifyJavaSemantic("ScanOptions.scanOptions().match")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("wrapper.orderByAsc")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("rowHandler.accept")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("nlsSpeechACL.tts")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("systemServerDirectInvoker.callPreferDirect")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("phaseObserver.accept")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewDynamicBillBizDataServiceImpl.billApproval")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewMetaExcelQuickImportApplicationServiceImpl.quickPreviewImportV2")?.kind, "state-read");
  assert.equal(classifyJavaSemantic("ViewDynamicHorizontalCalcFieldDataServiceImpl.processCalcFieldData")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewDynamicPictureRecognitionBizServiceImpl.recognizePicture")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("nlsUsageACL.summary")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("ocrUsageACL.summary")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("viewLayoutActivateApplicationService.activate")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("vo.PartitionRuleExcelVO")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("attrs.lastModifiedTime")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("OperationLogSyncServiceImpl.sliceDetailField")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportFieldDraft.applyBasic")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("SpeechFieldProcessServiceImpl.synthesizeSpeech")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("g2d.drawString")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("heartbeatScheduler.shutdownNow")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("signal.drainPermits")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("wrapper.last")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("YearMonth.from")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("source.copy")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("batch.assignIdentity")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("ViewMetaExcelImportAnalyzeApplicationServiceImpl.generateAnalyzeToken")?.kind, "external-call");
  assert.equal(classifyJavaSemantic("ViewDynamicFieldRelationServiceImpl.expandGraphWithLayoutFieldData")?.kind, "state-read");
  assert.equal(classifyJavaSemantic("OcrACL.process")?.kind, undefined);
  for (const symbol of [
    "CrossModuleRefreshServiceImpl.refreshAcrossModules",
    "DynamicPortServiceImpl.resolveRuntimePort",
    "ComplexSynchronizationServiceImpl.synchronizeDependencies"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, undefined, `${symbol} must remain fail-closed`);
  }
  assert.equal(classifyJavaSemantic("SyncDynamicDataServiceImpl.syncParentPageDataByLocalPage")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("EngineUseExcelBackServiceImpl.cleanupBackupDirectory")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("SqlDynamicOperationalDataServiceImpl.exitsSqlDynamicOperationalDataDOByTableName")?.kind, "decision");
  assert.equal(classifyJavaSemantic("LedgerAnalysisCore.toBigDecimal")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ToCodeFieldDataServiceImpl.generateQrCodeImage")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("ParentPanelRefreshServiceImpl.consumeLoop")?.kind, "coordination");
});

test("remaining callbacks and unreviewed dynamic boundaries stay fail-closed", () => {
  for (const symbol of [
    "unreviewedPhaseObserver.accept",
    "unreviewedHandler.accept",
    "CrossModuleRefreshServiceImpl.refreshAcrossModules",
    "DynamicPortServiceImpl.resolveRuntimePort",
    "ComplexSynchronizationServiceImpl.synchronizeDependencies"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, undefined, `${symbol} must remain fail-closed`);
  }
});
