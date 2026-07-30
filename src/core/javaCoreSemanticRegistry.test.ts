import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyJavaCoreSemanticWithTrace,
  JAVA_CORE_SEMANTIC_RULE_PACKAGE,
  JAVA_CORE_SEMANTIC_RULES,
  PROMOTED_JAVA_CORE_SEMANTIC_RULES
} from "./javaCoreSemanticRegistry.js";
import {
  createSemanticRulePackageLock,
  evaluateSemanticRulePackage,
  validateSemanticRulePackage
} from "./semanticRulePackage.js";
import type { BehaviorKind } from "./endpointReplacementModel.js";

test("java-core is a valid portable package with stable ordered rules", () => {
  const validation = validateSemanticRulePackage(JAVA_CORE_SEMANTIC_RULE_PACKAGE);
  assert.equal(validation.valid, true);
  assert.equal(JAVA_CORE_SEMANTIC_RULE_PACKAGE.compatibility.mode, "portable");
  assert.deepEqual(
    JAVA_CORE_SEMANTIC_RULE_PACKAGE.rules.map((rule) => rule.id),
    JAVA_CORE_SEMANTIC_RULES.map((rule) => rule.id)
  );
  assert.equal(PROMOTED_JAVA_CORE_SEMANTIC_RULES.length, 10);
  assert.ok(createSemanticRulePackageLock(JAVA_CORE_SEMANTIC_RULE_PACKAGE).ruleCount > 10);
});

test("java-core promotes high-risk generic families without promoting calculation fallbacks", () => {
  const cases = [
    ["OrderService.rollbackFailedOrder", "compensation-keyword", "compensation"],
    ["transactionManager.commit", "transaction-keyword", "transaction"],
    ["orderEvents.publishCreated", "event-publication-keyword", "event-publish"],
    ["OrderPolicy.validatePermission", "validation-keyword", "validation"],
    ["RequestContext.resolveTenant", "context-keyword", "context-resolution"],
    ["PaymentGateway.charge", "external-boundary-keyword", "external-call"],
    ["DDL ALTER TABLE orders", "ddl-mutation-keyword", "state-write"],
    ["OrderRepository.save", "state-mutation-keyword", "state-write"],
    ["OrderMapper.findById", "state-lookup-keyword", "state-read"],
    ["BlobCache.copy", "infrastructure-keyword", "external-call"]
  ] as const;
  for (const [text, ruleId, behavior] of cases) {
    const trace = classifyJavaCoreSemanticWithTrace(text);
    assert.equal(trace?.packageId, "builtin-java-core", text);
    assert.equal(trace?.packageVersion, "1.2.0", text);
    assert.equal(trace?.ruleId, ruleId, text);
    assert.equal(trace?.rule.kind, behavior, text);
  }
  assert.equal(classifyJavaCoreSemanticWithTrace("Instant.now")?.ruleId, "clock");
  assert.equal(classifyJavaCoreSemanticWithTrace("OrderCalculator.calculateTotal"), undefined);
});

test("java-core golden semantics have full coverage without unreviewed conflicts or drift", () => {
  const tuples: Array<readonly [string, string, BehaviorKind, string]> = [
    ["rollback", "OrderService.rollbackFailedOrder", "compensation", "compensation-keyword"],
    ["transaction", "transactionManager.commit", "transaction", "transaction-keyword"],
    ["event", "orderEvents.publishCreated", "event-publish", "event-publication-keyword"],
    ["validation", "OrderPolicy.validatePermission", "validation", "validation-keyword"],
    ["context", "RequestContext.resolveTenant", "context-resolution", "context-keyword"],
    ["external", "PaymentGateway.charge", "external-call", "external-boundary-keyword"],
    ["ddl", "DDL ALTER TABLE orders", "state-write", "ddl-mutation-keyword"],
    ["write", "OrderRepository.save", "state-write", "state-mutation-keyword"],
    ["read", "OrderMapper.findById", "state-read", "state-lookup-keyword"],
    ["infrastructure", "BlobCache.copy", "external-call", "infrastructure-keyword"]
  ];
  const samples = tuples.map(([id, text, expectedBehavior, expectedRuleId]) => ({
    id,
    text,
    expectedBehavior,
    expectedRuleId
  }));
  const report = evaluateSemanticRulePackage(JAVA_CORE_SEMANTIC_RULE_PACKAGE, samples, {
    minimumCoveragePercent: 100,
    maximumUnreviewedConflicts: 0,
    maximumExpectedMismatches: 0
  });
  assert.equal(report.status, "passed");
  assert.equal(report.coverage.classifiedPercent, 100);
  assert.equal(report.conflicts.length, 3);
  assert.ok(report.conflicts.every((conflict) => conflict.reviewed));
  assert.equal(report.expectedMismatches.length, 0);
});
