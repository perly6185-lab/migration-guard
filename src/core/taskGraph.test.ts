import test from "node:test";
import assert from "node:assert/strict";
import { createTaskGraph, getReadyTasks, validateTaskGraph } from "./taskGraph.js";
import type { ScanSummary } from "../types.js";

test("createTaskGraph builds a valid JS/Vite migration graph", () => {
  const graph = createTaskGraph("run-1", makeScan(), "Webpack to Vite", "js-vite");

  assert.deepEqual(validateTaskGraph(graph), []);
  assert.ok(graph.tasks.some((task) => task.id === "task-js-vite-package"));
  assert.deepEqual(getReadyTasks(graph).map((task) => task.id), ["task-analyze"]);
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
