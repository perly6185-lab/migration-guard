import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionsForCompareReport,
  loadDiffDecisionLedger,
  recordDiffDecision,
  summarizeDiffDecisionCoverage
} from "./diffDecision.js";
import type { CompareReport, LoadedConfig } from "../types.js";

test("recordDiffDecision classifies a compare difference and refreshes markdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-diff-decision-"));
  try {
    const loaded = makeLoadedConfig(dir);
    const comparePath = path.join(dir, ".migration-guard", "compare", "report.json");
    const markdownPath = comparePath.replace(/\.json$/, ".md");
    const report: CompareReport = {
      passed: false,
      baselineId: "baseline-1",
      currentId: "run-1",
      createdAt: "2026-07-07T00:00:00.000Z",
      differences: [
        {
          severity: "error",
          area: "probe",
          name: "renderer",
          message: "Probe output changed.",
          before: "aaa",
          after: "bbb"
        },
        {
          severity: "warn",
          area: "check",
          name: "test",
          message: "Check stdout changed while still passing.",
          before: "111",
          after: "222"
        }
      ]
    };
    await mkdir(path.dirname(comparePath), { recursive: true });
    await writeFile(comparePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const result = await recordDiffDecision(loaded, {
      runId: "run-1",
      compareReportPath: comparePath,
      area: "probe",
      name: "renderer",
      classification: "intentional",
      reason: "renderer output changed by design",
      approvedBy: "test"
    });

    assert.match(result.ledgerPath, /diff-decisions[\\/]decisions\.json$/);
    assert.equal(result.decision.classification, "intentional");
    const ledger = await loadDiffDecisionLedger(loaded, "run-1");
    assert.equal(ledger.decisions.length, 1);

    const decisions = await decisionsForCompareReport(loaded, report, "run-1");
    const coverage = summarizeDiffDecisionCoverage(report, decisions);
    assert.deepEqual(coverage, {
      total: 2,
      decided: 1,
      pending: 1,
      pendingRisk: 1,
      intentional: 1,
      accidental: 0,
      unknown: 0
    });
    const markdown = await readFile(markdownPath, "utf8");
    assert.match(markdown, /Decision/);
    assert.match(markdown, /intentional/);
    assert.match(markdown, /renderer output changed by design/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeLoadedConfig(root: string): LoadedConfig {
  return {
    path: path.join(root, ".migration-guard.json"),
    baseDir: root,
    targetRoot: root,
    artifactsDir: path.join(root, ".migration-guard"),
    config: {
      schemaVersion: 1,
      targetRoot: root,
      artifactsDir: path.join(root, ".migration-guard"),
      ignore: [],
      checks: [],
      probes: [],
      output: {
        maxOutputBytes: 262144
      },
      compare: {
        failOnCheckRegression: true,
        failOnProbeDiff: true
      },
      proposalGate: {
        defaultPolicy: "collect-all",
        batchPolicy: "fail-fast"
      },
      variables: {}
    }
  };
}
