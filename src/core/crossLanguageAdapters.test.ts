import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createContractPlan,
  createContractCorpusDraft,
  createCrossLanguageActionPlan,
  createCrossLanguageHttpInventory,
  createMigrationSlicePlan,
  createProjectInventory,
  createReadinessReport,
  createRecipePlan
} from "./crossLanguageAdapters.js";
import { createTaskGraph, validateTaskGraph } from "./taskGraph.js";
import type { ScanSummary } from "../types.js";

test("cross-language inventory aligns FastAPI source routes with Express target routes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-cross-language-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await mkdir(path.join(target, "src"), { recursive: true });
    await writeFile(path.join(source, "requirements.txt"), "fastapi\npytest\n");
    await writeFile(path.join(source, "main.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "",
      "@app.get('/users')",
      "def list_users():",
      "    return []",
      "",
      "@app.post('/users')",
      "def create_user():",
      "    return {}"
    ].join("\n"));
    await writeFile(path.join(target, "package.json"), JSON.stringify({
      scripts: { test: "vitest", build: "tsc" },
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" }
    }));
    await writeFile(path.join(target, "src", "app.ts"), [
      "import express from 'express'",
      "const app = express()",
      "app.get('/users', listUsers)",
      "app.delete('/users/:id', deleteUser)"
    ].join("\n"));

    const inventory = await createCrossLanguageHttpInventory(source, target);
    assert.equal(inventory.source.primaryLanguage, "python");
    assert.equal(inventory.source.languageConfidence, "high");
    assert.equal(inventory.target.primaryLanguage, "typescript-node");
    assert.equal(inventory.target.languageConfidence, "high");
    assert.deepEqual(inventory.summary, {
      sourceRouteCount: 2,
      targetRouteCount: 2,
      matchedRouteCount: 1,
      missingTargetRouteCount: 1,
      targetExtraRouteCount: 1
    });
    assert.deepEqual(inventory.target.recommendedChecks, ["npm run test", "npm run build"]);

    const contractPlan = createContractPlan(inventory);
    assert.ok(contractPlan.exchanges.some((exchange) => exchange.status === "ready-for-dual-run" && exchange.path === "/users"));
    assert.ok(contractPlan.exchanges.some((exchange) => exchange.status === "source-only" && exchange.method === "POST"));

    const slicePlan = createMigrationSlicePlan(inventory);
    assert.ok(slicePlan.slices.some((slice) => slice.id === "cl-slice-port-missing-routes"));
    assert.ok(slicePlan.slices.some((slice) => slice.id === "cl-slice-replay-matched-routes"));
    assert.ok(slicePlan.slices.some((slice) => slice.id === "cl-slice-review-target-extra-routes"));

    const recipePlan = createRecipePlan(inventory);
    assert.equal(recipePlan.recipeId, "python-to-typescript-node");
    assert.equal(recipePlan.supported, true);
    assert.ok(recipePlan.routeMappings.some((mapping) => mapping.status === "port-required"));

    const corpusDraft = createContractCorpusDraft(inventory);
    assert.equal(corpusDraft.coverage.readyForDualRun, 1);
    assert.equal(corpusDraft.coverage.sourceOnly, 1);
    assert.equal(corpusDraft.requests.find((request) => request.method === "POST")?.bodyTemplate, "{}");

    const actionPlan = createCrossLanguageActionPlan("run-1", "Port API", inventory, recipePlan, corpusDraft);
    assert.ok(actionPlan.actions.some((action) => action.id === "action-cl5-verification-issue-loop"));
    assert.ok(actionPlan.actions.every((action) => action.patchTemplate === "cross-language-contract-probe"));

    const readiness = createReadinessReport(inventory, recipePlan, corpusDraft, actionPlan);
    assert.equal(readiness.achievedLevel, "CL5");
    assert.ok(readiness.issuePlan.some((issue) => issue.actionId === "action-cl4-port-missing-http-routes"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readiness does not report CL5 when no HTTP contract corpus can be drafted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-cross-language-empty-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(source, "requirements.txt"), "fastapi\npytest\n");
    await writeFile(path.join(source, "main.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()"
    ].join("\n"));
    await writeFile(path.join(target, "package.json"), JSON.stringify({
      scripts: { test: "vitest" },
      dependencies: { express: "^5.0.0" }
    }));
    await writeFile(path.join(target, "app.ts"), [
      "import express from 'express'",
      "const app = express()"
    ].join("\n"));

    const inventory = await createCrossLanguageHttpInventory(source, target);
    const recipePlan = createRecipePlan(inventory);
    const corpusDraft = createContractCorpusDraft(inventory);
    const actionPlan = createCrossLanguageActionPlan("run-empty", "Port API", inventory, recipePlan, corpusDraft);
    const readiness = createReadinessReport(inventory, recipePlan, corpusDraft, actionPlan);
    const statuses = new Map(readiness.levels.map((level) => [level.level, level.status]));

    assert.equal(recipePlan.supported, true);
    assert.equal(corpusDraft.requests.length, 0);
    assert.equal(statuses.get("CL3"), "blocked");
    assert.equal(statuses.get("CL5"), "partial");
    assert.equal(readiness.achievedLevel, "CL2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recipe support is limited to explicit language-pair recipes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-cross-language-unsupported-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await mkdir(path.join(target, "src", "main", "java", "demo"), { recursive: true });
    await writeFile(path.join(source, "go.mod"), "module example.com/demo\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.0.0\n");
    await writeFile(path.join(source, "main.go"), [
      "package main",
      "import \"github.com/gin-gonic/gin\"",
      "func main() {",
      "  r := gin.Default()",
      "  r.GET(\"/health\", health)",
      "}"
    ].join("\n"));
    await writeFile(path.join(target, "pom.xml"), "<project></project>\n");
    await writeFile(path.join(target, "src", "main", "java", "demo", "HealthController.java"), [
      "import org.springframework.web.bind.annotation.GetMapping;",
      "@RestController",
      "class HealthController {",
      "  @GetMapping('/health')",
      "  String health() { return \"ok\"; }",
      "}"
    ].join("\n"));

    const inventory = await createCrossLanguageHttpInventory(source, target);
    const recipePlan = createRecipePlan(inventory);
    const corpusDraft = createContractCorpusDraft(inventory);
    const actionPlan = createCrossLanguageActionPlan("run-unsupported", "Port API", inventory, recipePlan, corpusDraft);
    const readiness = createReadinessReport(inventory, recipePlan, corpusDraft, actionPlan);
    const statuses = new Map(readiness.levels.map((level) => [level.level, level.status]));

    assert.equal(recipePlan.recipeId, "go-to-java");
    assert.equal(recipePlan.supported, false);
    assert.equal(recipePlan.confidence, "low");
    assert.equal(statuses.get("CL2"), "partial");
    assert.equal(readiness.achievedLevel, "CL1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project inventory extracts Spring and Go HTTP route candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-route-inventory-"));
  const spring = path.join(dir, "spring");
  const go = path.join(dir, "go");

  try {
    await mkdir(path.join(spring, "src", "main", "java", "demo"), { recursive: true });
    await mkdir(go, { recursive: true });
    await writeFile(path.join(spring, "pom.xml"), "<project></project>\n");
    await writeFile(path.join(spring, "src", "main", "java", "demo", "UsersController.java"), [
      "import org.springframework.web.bind.annotation.GetMapping;",
      "@RestController",
      "class UsersController {",
      "  @GetMapping('/users')",
      "  String list() { return \"ok\"; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(go, "go.mod"), "module example.com/demo\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.0.0\n");
    await writeFile(path.join(go, "main.go"), [
      "package main",
      "import \"github.com/gin-gonic/gin\"",
      "func main() {",
      "  r := gin.Default()",
      "  r.GET(\"/health\", health)",
      "}"
    ].join("\n"));

    const springInventory = await createProjectInventory(spring);
    const goInventory = await createProjectInventory(go);
    assert.equal(springInventory.primaryLanguage, "java");
    assert.ok(springInventory.routes.some((route) => route.method === "GET" && route.path === "/users"));
    assert.equal(goInventory.primaryLanguage, "go");
    assert.ok(goInventory.routes.some((route) => route.method === "GET" && route.path === "/health"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task graph creates cross-language HTTP CL1-CL5 tasks", () => {
  const graph = createTaskGraph("run-1", makeScan(), "Port legacy API into new service", "cross-language-http");

  assert.deepEqual(validateTaskGraph(graph), []);
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:inventory"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:recipes"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:contracts"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:corpus"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:slices"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:actions"));
  assert.ok(graph.tasks.some((task) => task.executor === "cross-language-http:readiness"));
  assert.deepEqual(graph.tasks.find((task) => task.id === "task-verify")?.dependsOn, ["task-cross-language-readiness"]);
});

function makeScan(): ScanSummary {
  return {
    root: "/repo",
    scannedAt: "2026-07-19T00:00:00.000Z",
    totalFiles: 4,
    sourceFiles: 2,
    testFiles: 1,
    totalLines: 50,
    fileTypes: {
      ".py": 1,
      ".ts": 1
    },
    packageManager: "unknown",
    stackHints: [],
    riskFiles: [],
    dependencyEdges: []
  };
}
