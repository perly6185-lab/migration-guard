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
  assert.equal(report.conflicts[0]?.reviewed, false);
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
    text: "Service.run Service.java void run()",
    kind: "java-method",
    applicable: true
  }]);
});

test("reviewed ordered precedence resolves known conflicts and policy gates regressions", () => {
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
  value.conflictPolicy = {
    strategy: "ordered-first-match",
    reviewedPrecedence: [{
      id: "save-before-save-clock",
      winnerRuleId: "save",
      loserRuleId: "save-clock",
      reason: "The narrow compatibility ordering is intentionally retained."
    }]
  };
  const passed = evaluateSemanticRulePackage(value, [{
    id: "save",
    text: "ClockService.save",
    expectedBehavior: "state-write",
    expectedRuleId: "save"
  }], {
    minimumCoveragePercent: 100,
    maximumUnreviewedConflicts: 0,
    maximumExpectedMismatches: 0
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.conflicts[0]?.reviewed, true);
  assert.deepEqual(passed.conflicts[0]?.reviewIds, ["save-before-save-clock"]);
  assert.equal(passed.policy.passed, true);

  const blocked = evaluateSemanticRulePackage(value, [
    { id: "save", text: "ClockService.save" },
    { id: "unknown", text: "Nothing.matches" }
  ], { minimumCoveragePercent: 100 });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.policy.findings[0] ?? "", /COVERAGE-BELOW-MINIMUM/);
});

test("Java analysis samples separate applicable methods from SQL and generated declarations", () => {
  const samples = semanticSamplesFromJavaAnalysis({
    callGraph: {
      nodes: [
        { id: "demo.Service.run", className: "Service", methodName: "run" },
        { id: "external:http.call", className: "HttpClient", methodName: "call" },
        { id: "sql:mapper:find", className: "Mapper", methodName: "find" },
        {
          id: "demo.Mapper.find",
          className: "Mapper",
          methodName: "find",
          signature: "Object find() [abstract-declaration]"
        }
      ]
    }
  });
  assert.deepEqual(samples.map((sample) => [sample.kind, sample.applicable]), [
    ["java-method", true],
    ["external-boundary", true],
    ["sql-source", false],
    ["generated-declaration", false]
  ]);
});

test("malformed external rules and samples fail closed without runtime type errors", () => {
  const invalidPackage = pkg();
  invalidPackage.rules = [null] as unknown as SemanticRulePackage["rules"];
  const validation = validateSemanticRulePackage(invalidPackage);
  assert.equal(validation.valid, false);
  assert.ok(validation.findings.includes("SEMANTIC-RULE-INVALID:0"));

  const report = evaluateSemanticRulePackage(pkg(), [
    null,
    { id: "", text: "Instant.now" },
    { id: "missing-text" }
  ] as unknown as Parameters<typeof evaluateSemanticRulePackage>[1]);
  assert.equal(report.status, "blocked");
  assert.ok(report.findings.includes("SEMANTIC-SAMPLE-INVALID:0"));
  assert.ok(report.findings.includes("SEMANTIC-SAMPLE-ID-MISSING:1"));
  assert.ok(report.findings.includes("SEMANTIC-SAMPLE-TEXT-MISSING:missing-text"));

  const invalidPolicy = evaluateSemanticRulePackage(pkg(), [
    { id: "clock", text: "Instant.now" }
  ], { minimumCoveragePercent: 101 });
  assert.equal(invalidPolicy.status, "blocked");
  assert.ok(invalidPolicy.findings.includes("SEMANTIC-POLICY-MINIMUM-COVERAGE-INVALID"));

  const invalidScope = pkg();
  invalidScope.scope = null as unknown as SemanticRulePackage["scope"];
  assert.equal(validateSemanticRulePackage(invalidScope).valid, false);
});
