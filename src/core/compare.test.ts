import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots } from "./compare.js";
import type { Snapshot } from "../types.js";

test("compareSnapshots fails when a behavior probe output changes", () => {
  const baseline = makeSnapshot("baseline-1", "aaa");
  const current = makeSnapshot("run-1", "bbb");

  const report = compareSnapshots(baseline, current);

  assert.equal(report.passed, false);
  assert.equal(report.differences.some((difference) => difference.area === "probe" && difference.severity === "error"), true);
});

function makeSnapshot(id: string, probeHash: string): Snapshot {
  return {
    version: 1,
    kind: id.startsWith("baseline") ? "baseline" : "run",
    id,
    createdAt: "2026-07-04T00:00:00.000Z",
    root: "/project",
    configHash: "config",
    scan: {
      root: "/project",
      scannedAt: "2026-07-04T00:00:00.000Z",
      totalFiles: 1,
      sourceFiles: 1,
      testFiles: 0,
      totalLines: 1,
      fileTypes: {
        ".ts": 1
      },
      packageManager: "npm",
      stackHints: ["typescript"],
      riskFiles: [],
      dependencyEdges: []
    },
    checks: [],
    probes: [
      {
        name: "critical-output",
        type: "command",
        command: "node probe.js",
        status: "passed",
        durationMs: 10,
        exitCode: 0,
        outputHash: probeHash,
        normalizedOutput: probeHash,
        stdout: probeHash,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false
      }
    ]
  };
}
