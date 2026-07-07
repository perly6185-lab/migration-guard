import test from "node:test";
import assert from "node:assert/strict";
import { createPnpmViteVueActions } from "./executor.js";
import { createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
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
