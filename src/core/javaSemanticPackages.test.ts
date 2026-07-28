import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyJavaSemanticPackagesWithTrace,
  resolveJavaSemanticRulePackages
} from "./javaSemanticPackages.js";

test("semantic package routing isolates compatibility rules by project scope", () => {
  const neutral = resolveJavaSemanticRulePackages({
    projectId: "orders-service",
    language: "java",
    framework: "spring"
  });
  assert.equal(neutral.mode, "auto");
  assert.deepEqual(neutral.selected.map((item) => item.packageId), ["builtin-java-core"]);
  assert.deepEqual(neutral.excluded.map((item) => item.packageId), ["builtin-java-zboss-compatibility"]);
  assert.equal(neutral.excluded[0]?.reason, "project-scope-mismatch");

  const zboss = resolveJavaSemanticRulePackages({
    projectId: "zboss-query",
    language: "java",
    framework: "spring"
  });
  assert.deepEqual(
    zboss.selected.map((item) => item.packageId),
    ["builtin-java-zboss-compatibility", "builtin-java-core"]
  );
  assert.equal(zboss.selected[0]?.reason, "project-scope-match");

  const legacy = resolveJavaSemanticRulePackages();
  assert.equal(legacy.mode, "legacy");
  assert.equal(legacy.selected.length, 2);
});

test("explicit package routing is fail-closed and keeps the portable core", () => {
  const explicit = resolveJavaSemanticRulePackages({
    projectId: "zboss-query",
    explicitPackageIds: ["builtin-java-core"]
  });
  assert.equal(explicit.mode, "explicit");
  assert.deepEqual(explicit.selected.map((item) => item.packageId), ["builtin-java-core"]);
  assert.throws(
    () => resolveJavaSemanticRulePackages({ explicitPackageIds: ["builtin-java-zboss-compatibility"] }),
    /must include builtin-java-core/
  );
  assert.throws(
    () => resolveJavaSemanticRulePackages({ explicitPackageIds: ["builtin-java-core", "unknown-package"] }),
    /Unknown built-in semantic package/
  );
});

test("portable routing retains generic Java semantics without compatibility leakage", () => {
  const portable = ["builtin-java-core"];
  const clock = classifyJavaSemanticPackagesWithTrace("Instant.now", portable);
  assert.equal(clock?.packageId, "builtin-java-core");
  assert.equal(clock?.ruleId, "clock");

  const reviewed = "ViewDynamicFieldDataServiceImpl.handleUnionConditionData";
  assert.equal(classifyJavaSemanticPackagesWithTrace(reviewed, portable), undefined);
  assert.equal(
    classifyJavaSemanticPackagesWithTrace(reviewed)?.packageId,
    "builtin-java-zboss-compatibility"
  );
  assert.throws(
    () => classifyJavaSemanticPackagesWithTrace("Instant.now", ["unknown-package"]),
    /Unknown built-in semantic package/
  );
});
