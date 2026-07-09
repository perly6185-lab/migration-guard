import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectOneShotReport, renderOneShotReport } from "./oneShot.js";
import type { CheckResult, CommandProbeResult, CompareReport, LoadedConfig, ScanSummary, Snapshot } from "../types.js";

test("one-shot report goes green when latest evidence passes and source delta is budgeted", async () => {
  const { loaded, baseline, current, comparePath } = await makeFixture({ currentSourceFiles: 11 });

  const report = await collectOneShotReport(loaded, {
    maxSourceFileDelta: 1,
    checkTargetGit: false
  });

  assert.equal(report.status, "go");
  assert.equal(report.compareReportPath, comparePath);
  assert.equal(report.summary.sourceFileDelta, 1);
  assert.ok(report.criteria.some((criterion) => criterion.id === "source-file-budget" && criterion.status === "passed"));
  assert.match(renderOneShotReport(report), new RegExp(`Baseline: ${baseline.id}`));
  assert.match(renderOneShotReport(report), new RegExp(`Current: ${current.id}`));
});

test("one-shot report holds when source delta exceeds budget", async () => {
  const { loaded } = await makeFixture({ currentSourceFiles: 12 });

  const report = await collectOneShotReport(loaded, {
    maxSourceFileDelta: 1,
    checkTargetGit: false
  });

  assert.equal(report.status, "hold");
  assert.equal(report.summary.sourceFileDelta, 2);
  assert.ok(report.criteria.some((criterion) => criterion.id === "source-file-budget" && criterion.status === "blocked"));
  assert.match(renderOneShotReport(report), /Reduce the one-shot scope/);
});

async function makeFixture(options: { currentSourceFiles: number }): Promise<{
  loaded: LoadedConfig;
  baseline: Snapshot;
  current: Snapshot;
  comparePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-one-shot-"));
  const artifactsDir = path.join(root, "artifacts");
  const targetRoot = path.join(root, "target");
  await mkdir(path.join(artifactsDir, "compare"), { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  const loaded: LoadedConfig = {
    path: path.join(root, ".migration-guard.json"),
    baseDir: root,
    targetRoot,
    artifactsDir,
    config: {
      schemaVersion: 1,
      targetRoot,
      artifactsDir,
      ignore: [],
      checks: [],
      probes: [],
      output: {
        maxOutputBytes: 1024
      },
      compare: {
        failOnCheckRegression: true,
        failOnProbeDiff: true
      },
      proposalGate: {
        defaultPolicy: "collect-all",
        batchPolicy: "fail-fast"
      }
    }
  };
  const baseline = makeSnapshot("baseline-fixture", 10);
  const current = makeSnapshot("run-fixture", options.currentSourceFiles, "run");
  const compare: CompareReport = {
    passed: true,
    baselineId: baseline.id,
    currentId: current.id,
    createdAt: "2026-07-09T00:00:02.000Z",
    differences: options.currentSourceFiles === 10
      ? []
      : [
          {
            severity: "info",
            area: "scan",
            name: "source-files",
            message: "Source file count changed."
          }
        ]
  };
  const comparePath = path.join(artifactsDir, "compare", "one-shot-compare.json");

  await writeFile(path.join(artifactsDir, "latest-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactsDir, "latest-run.json"), `${JSON.stringify(current, null, 2)}\n`, "utf8");
  await writeFile(comparePath, `${JSON.stringify(compare, null, 2)}\n`, "utf8");

  return { loaded, baseline, current, comparePath };
}

function makeSnapshot(id: string, sourceFiles: number, kind: Snapshot["kind"] = "baseline"): Snapshot {
  return {
    version: 1,
    kind,
    id,
    createdAt: "2026-07-09T00:00:01.000Z",
    root: "/target",
    configHash: "hash",
    scan: makeScan(sourceFiles),
    checks: [
      makeCheck("core-test", true),
      makeCheck("web-build", true)
    ],
    probes: [
      makeProbe("md-renderer-behavior"),
      makeProbe("md-api-contract")
    ]
  };
}

function makeScan(sourceFiles: number): ScanSummary {
  return {
    root: "/target",
    scannedAt: "2026-07-09T00:00:00.000Z",
    totalFiles: sourceFiles + 5,
    sourceFiles,
    testFiles: 2,
    totalLines: 100,
    fileTypes: {
      ".ts": sourceFiles
    },
    packageManager: "pnpm",
    stackHints: ["typescript"],
    riskFiles: [],
    dependencyEdges: []
  };
}

function makeCheck(name: string, critical: boolean): CheckResult {
  return {
    name,
    command: `pnpm ${name}`,
    status: "passed",
    critical,
    exitCode: 0,
    durationMs: 1,
    stdoutHash: "stdout",
    stderrHash: "stderr",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function makeProbe(name: string): CommandProbeResult {
  return {
    name,
    type: "command",
    command: `node ${name}.mjs`,
    status: "passed",
    durationMs: 1,
    exitCode: 0,
    outputHash: "output",
    normalizedOutput: "{}",
    stdout: "{}",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}
