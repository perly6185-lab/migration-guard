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
