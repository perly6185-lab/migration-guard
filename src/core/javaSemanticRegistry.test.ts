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
    "formatter.format"
  ]) {
    assert.equal(classifyJavaSemantic(symbol)?.kind, "calculation", symbol);
  }
});

test("Java semantic registry preserves synchronization and diagnostic effects", () => {
  assert.equal(classifyJavaSemantic("openDataFuture.join")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("executor.awaitTermination")?.kind, "async-boundary");
  assert.equal(classifyJavaSemantic("queue.offer")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("barrier.signalDone")?.kind, "coordination");
  assert.equal(classifyJavaSemantic("sqlSessionTemplate.flushStatements")?.kind, "state-write");
  assert.equal(classifyJavaSemantic("DateTime.now")?.kind, "clock-read");
  assert.equal(classifyJavaSemantic("JSON.toJSON")?.kind, "calculation");
  assert.equal(classifyJavaSemantic("error.printStackTrace")?.kind, "observability");
  assert.equal(classifyJavaSemantic("UUID.randomUUID")?.kind, undefined);
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
  assert.equal(classifyJavaSemantic("FieldValueService.handle file.java private String handle(Object value) {")?.kind, undefined);
  assert.equal(classifyJavaSemantic("PublicParser.parse file.java public Object parse(String value) {")?.kind, undefined);
  assert.equal(classifyJavaSemantic("BusinessContext.process")?.kind, undefined);
});
