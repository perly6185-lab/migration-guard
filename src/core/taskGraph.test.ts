import test from "node:test";
import assert from "node:assert/strict";
import { createMdMonorepoRefactorTaskPlan, createPnpmViteVueActions, evaluateActionCheckReadiness, inferMdActionTemplate } from "./executor.js";
import { renderActionPlan } from "./actionPlan.js";
import { getProbeTemplateDefinition, selectProbeTemplate } from "./probeTemplateRegistry.js";
import { createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import type { MigrationRunPackage } from "./migrationRun.js";
import type { ScanSummary } from "../types.js";

test("createTaskGraph builds a valid JS/Vite migration graph", () => {
  const graph = createTaskGraph("run-1", makeScan(), "Webpack to Vite", "js-vite");

  assert.deepEqual(validateTaskGraph(graph), []);
  assert.ok(graph.tasks.some((task) => task.id === "task-js-vite-package"));
  assert.deepEqual(getReadyTasks(graph).map((task) => task.id), ["task-analyze"]);
});

test("createTaskGraph builds a non-mutating pnpm/Vite/Vue inventory graph", () => {
  const graph = createTaskGraph("run-1", makeScan(), "Vite/Vue monorepo safety validation", "pnpm-vite-vue");

  assert.deepEqual(validateTaskGraph(graph), []);
  assert.ok(graph.tasks.some((task) => task.executor === "pnpm-vite-vue:workspace"));
  assert.ok(graph.tasks.some((task) => task.executor === "pnpm-vite-vue:configs"));
  assert.ok(graph.tasks.some((task) => task.executor === "pnpm-vite-vue:risks"));
  assert.equal(graph.tasks.some((task) => task.executor === "js-vite:config"), false);
});

test("createTaskGraph builds an md monorepo task-planning graph", () => {
  const graph = createTaskGraph("run-1", makeScan(), "MD monorepo refactor task planning", "md-monorepo");

  assert.deepEqual(validateTaskGraph(graph), []);
  assert.ok(graph.tasks.some((task) => task.executor === "md-monorepo:plan"));
  assert.ok(graph.tasks.some((task) => task.executor === "md-monorepo:actions"));
  assert.equal(graph.tasks.some((task) => task.executor?.startsWith("pnpm-vite-vue:")), false);
  assert.deepEqual(graph.tasks.find((task) => task.id === "task-verify")?.dependsOn, ["task-md-monorepo-actions"]);
});

test("createPnpmViteVueActions includes low-risk proposal candidates", () => {
  const actions = createPnpmViteVueActions({
    ...makeScan(),
    packageManager: "pnpm",
    stackHints: ["vue", "vite", "typescript"],
    riskFiles: [
      {
        path: "packages/core/src/renderer/renderer-impl.ts",
        score: 45,
        reasons: ["large file"],
        lines: 400,
        importerCount: 3
      }
    ]
  });

  assert.ok(actions.some((action) => action.id === "action-adapter-fixture-inventory" && action.risk === "low"));
  assert.ok(actions.some((action) => action.id === "action-normalize-check-noise" && action.patchTemplate === "normalization-probe"));
  assert.ok(actions.some((action) => action.id === "action-renderer-probes"));
});

test("createMdMonorepoRefactorTaskPlan covers md refactor domains and probes", () => {
  const plan = createMdMonorepoRefactorTaskPlan(makeRunPackage(), {
    ...makeScan(),
    riskFiles: [
      {
        path: "packages/core/src/renderer/MarkdownRenderer.ts",
        score: 45,
        reasons: ["large renderer file"],
        lines: 500,
        importerCount: 6
      },
      {
        path: "apps/api/src/upload.ts",
        score: 42,
        reasons: ["api boundary"],
        lines: 250,
        importerCount: 2
      }
    ]
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.tasks.length >= 10, true);
  assert.ok(plan.tasks.some((task) => task.id === "md-task-core-renderer" && task.risk === "high"));
  assert.ok(plan.tasks.some((task) => task.id === "md-task-api-contracts" && task.requiredProbes.includes("md-api-contract")));
  assert.ok(plan.tasks.some((task) => task.id === "md-task-web-editor-shell" && task.requiredProbes.includes("md-web-static-contract")));
  assert.ok(plan.tasks.some((task) => task.id === "md-task-mcp-render" && task.recommendedChecks.some((check) => check.includes("buildRenderedOutput"))));
  assert.ok(plan.tasks.some((task) => task.id === "md-task-mcp-render" && task.recommendedChecks.some((check) => check.includes("codeBlockTheme: ''"))));
  assert.equal(inferMdActionTemplate(plan.tasks.find((task) => task.id === "md-task-shared-contracts")!), "ts-structural-probe");
  assert.ok(plan.tasks.some((task) => task.id === "md-task-cross-package-verification" && task.recommendedChecks.includes("pnpm test")));
});

test("probe template registry selects shared TS before UI smoke and renders reasons", () => {
  const shared = selectProbeTemplate({
    id: "action-md-shared-contracts",
    domain: "packages/shared",
    affectedFiles: ["packages/shared/src/types"],
    requiredProbes: ["md-renderer-behavior", "md-web-static-contract"]
  });
  const web = selectProbeTemplate({
    id: "action-md-web-editor-shell",
    domain: "apps/web",
    affectedFiles: ["apps/web/src/components/editor"],
    requiredProbes: ["md-web-static-contract", "md-renderer-behavior"]
  });

  assert.equal(shared.template, "ts-structural-probe");
  assert.match(shared.reason, /packages\/shared/);
  assert.equal(web.template, "ui-smoke-probe");
  assert.equal(getProbeTemplateDefinition("ui-smoke-probe").needsPreview, true);
  const crossLanguage = selectProbeTemplate({
    id: "action-cl4-port-missing-http-routes",
    affectedFiles: ["src/main.py"]
  });
  assert.equal(crossLanguage.template, "cross-language-contract-probe");
  assert.equal(getProbeTemplateDefinition("cross-language-contract-probe").defaultCheckKind, "contract-probe");

  const text = renderActionPlan({
    version: 1,
    runId: "run-1",
    createdAt: "2026-07-08T00:00:00.000Z",
    goal: "registry output",
    actions: [
      {
        id: "action-md-shared-contracts",
        title: "Guard shared contracts",
        summary: "Shared package action.",
        risk: "medium",
        affectedFiles: ["packages/shared/src/types"],
        recommendedChecks: [],
        patchMode: "dry-run-only",
        patchTemplate: shared.template,
        templateSelection: shared
      }
    ]
  });
  assert.match(text, /template: ts-structural-probe \(packages\/shared actions use TS structural probes/);
});

test("evaluateActionCheckReadiness flags missing pnpm scripts before gates run", () => {
  const index = {
    rootScripts: new Set(["type-check", "build:cli"]),
    packageScriptsByName: new Map([
      ["@md/core", new Set(["test", "type-check"])],
      ["@md/mcp-server", new Set(["start", "dev"])]
    ])
  };

  assert.deepEqual(
    evaluateActionCheckReadiness("pnpm --filter @md/core test", index),
    {
      command: "pnpm --filter @md/core test",
      status: "ready",
      reason: "package script exists: @md/core#test"
    }
  );
  assert.deepEqual(
    evaluateActionCheckReadiness("pnpm --filter @md/mcp-server type-check", index),
    {
      command: "pnpm --filter @md/mcp-server type-check",
      status: "no-op-risk",
      reason: "package @md/mcp-server has no script type-check"
    }
  );
  assert.equal(
    evaluateActionCheckReadiness("pnpm --filter @md/mcp-server exec tsx -e \"console.log(1)\"", index).status,
    "ready"
  );
});

function makeScan(): ScanSummary {
  return {
    root: "/repo",
    scannedAt: "2026-07-04T00:00:00.000Z",
    totalFiles: 10,
    sourceFiles: 4,
    testFiles: 1,
    totalLines: 100,
    fileTypes: {
      ".ts": 4
    },
    packageManager: "npm",
    stackHints: ["typescript", "webpack"],
    riskFiles: [],
    dependencyEdges: []
  };
}

function makeRunPackage(): MigrationRunPackage {
  const createdAt = "2026-07-04T00:00:00.000Z";
  const estimate = {
    sourceFiles: 4,
    testFiles: 1,
    taskCount: 0,
    riskLevel: "medium" as const,
    confidence: "medium" as const,
    estimatedVerificationRounds: 1,
    notes: [],
    updatedAt: createdAt
  };
  return {
    run: {
      version: 1 as const,
      id: "run-1",
      goal: "MD monorepo refactor task planning",
      sourceRoot: "/repo",
      targetRoot: "/repo",
      artifactsDir: "/repo/.migration-guard/migration-runs/run-1",
      createdAt,
      updatedAt: createdAt,
      status: "planned" as const,
      mode: "dry-run" as const,
      adapter: "md-monorepo",
      issueProvider: "local" as const,
      estimate
    },
    graph: {
      version: 1 as const,
      runId: "run-1",
      createdAt,
      updatedAt: createdAt,
      tasks: []
    },
    issues: []
  };
}
