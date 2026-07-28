import assert from "node:assert/strict";
import test from "node:test";
import {
  createSemanticRulePackageLock,
  diffSemanticRulePackageLocks,
  evaluateSemanticRulePackage,
  semanticSamplesFromJavaAnalysis,
  validateSemanticRulePackage,
  type SemanticRulePackage
} from "./semanticRulePackage.js";

function pkg(version = "1.0.0"): SemanticRulePackage {
  return {
    schemaVersion: 1,
    id: "test-java",
    version,
    language: "java",
    description: "Test rules",
    compatibility: {
      engineSchemaVersion: 1,
      mode: "portable"
    },
    scope: {
      frameworks: ["spring"],
      projects: ["*"]
    },
    rules: [
      {
        id: "clock",
        pattern: "Instant\\.now",
        flags: "",
        behavior: "clock-read",
        reason: "clock",
        defaultOwnership: "target-owned",
        origin: "generic-builtin"
      },
      {
        id: "save",
        pattern: "\\.save",
        flags: "i",
        behavior: "state-write",
        reason: "save",
        defaultOwnership: "infrastructure-port",
        origin: "reviewed-compatibility"
      }
    ]
  };
}

test("semantic packages validate and produce deterministic locks", () => {
  const value = pkg();
  const validation = validateSemanticRulePackage(value);
  assert.equal(validation.valid, true);
  const first = createSemanticRulePackageLock(value);
  const second = createSemanticRulePackageLock(value);
  assert.deepEqual(first, second);
  assert.equal(first.ruleCount, 2);
});

test("semantic package diffs report added, removed and modified rules", () => {
  const before = createSemanticRulePackageLock(pkg());
  const next = pkg("1.1.0");
  next.rules[0] = { ...next.rules[0], behavior: "external-call" };
  next.rules.splice(1, 1);
  next.rules.push({
    id: "query",
    pattern: "\\.query",
    flags: "",
    behavior: "state-read",
    reason: "query",
    defaultOwnership: "infrastructure-port",
    origin: "generic-builtin"
  });
  const diff = diffSemanticRulePackageLocks(before, createSemanticRulePackageLock(next));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.added, ["query"]);
  assert.deepEqual(diff.removed, ["save"]);
  assert.deepEqual(diff.modified, ["clock"]);
});

test("semantic package evaluation records coverage, conflicts and expected drift", () => {
  const value = pkg();
  value.rules.push({
    id: "save-clock",
    pattern: "ClockService\\.save",
    flags: "",
    behavior: "external-call",
    reason: "conflicting sample",
    defaultOwnership: "infrastructure-port",
    origin: "project"
  });
  const report = evaluateSemanticRulePackage(value, [
    { id: "clock", text: "ClockService Instant.now", expectedBehavior: "clock-read" },
    { id: "save", text: "ClockService.save", expectedBehavior: "state-read" },
    { id: "unknown", text: "Nothing.matches" }
  ]);
  assert.equal(report.status, "needs-review");
  assert.equal(report.classifiedCount, 2);
  assert.deepEqual(report.unclassified, ["unknown"]);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.expectedMismatches.length, 1);
  assert.equal(report.coverage.genericBuiltinHits, 1);
  assert.equal(report.coverage.reviewedCompatibilityHits, 1);
});

test("Java analysis samples preserve classifier input text", () => {
  const samples = semanticSamplesFromJavaAnalysis({
    callGraph: {
      nodes: [{
        id: "demo.Service.run",
        className: "Service",
        methodName: "run",
        file: "Service.java",
        signature: "void run()"
      }]
    }
  });
  assert.deepEqual(samples, [{
    id: "demo.Service.run",
    text: "Service.run Service.java void run()"
  }]);
});
