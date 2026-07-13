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

test("compareSnapshots classifies inherited, changed, recovered, and regressed checks", () => {
  const baseline = makeSnapshot("baseline-1", "same");
  const current = makeSnapshot("run-1", "same");
  baseline.probes = [];
  current.probes = [];
  baseline.checks = [
    makeCheck("inherited", "failed", "failure-a"),
    makeCheck("changed", "failed", "failure-a"),
    makeCheck("recovered", "failed", "failure-a"),
    makeCheck("regressed", "passed", "ok")
  ];
  current.checks = [
    makeCheck("inherited", "failed", "failure-a"),
    makeCheck("changed", "failed", "failure-b"),
    makeCheck("recovered", "passed", "ok"),
    makeCheck("regressed", "failed", "failure-a")
  ];

  const report = compareSnapshots(baseline, current);

  assert.equal(report.checkHealth?.inheritedFailure, 1);
  assert.equal(report.checkHealth?.changedFailure, 1);
  assert.equal(report.checkHealth?.recovered, 1);
  assert.equal(report.checkHealth?.regression, 1);
  assert.equal(report.passed, false);
});

function makeCheck(name: string, status: "passed" | "failed", hash: string): Snapshot["checks"][number] {
  return {
    name,
    command: name,
    status,
    critical: true,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 1,
    stdoutHash: hash,
    stderrHash: hash,
    normalizedStdoutHash: hash,
    normalizedStderrHash: hash,
    stdout: hash,
    stderr: hash,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

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
