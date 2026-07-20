import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { captureMethodAdvancedGateBaseline, createMethodExtractionQualityReport, renderMethodExtractionQualityReport } from "./methodExtractionQuality.js";

const before = [
  "export function calculate(input: number): number {",
  "  let result = input;",
  "  if (input > 0) {",
  "    result = input * 2;",
  "  }",
  "  return result;",
  "}"
].join("\n");

const after = [
  "export function calculate(input: number): number {",
  "  return calculateCore(input);",
  "}",
  "function calculateCore(input: number): number {",
  "  let result = input;",
  "  if (input > 0) result = input * 2;",
  "  return result;",
  "}"
].join("\n");

test("method extraction quality separates behavior confidence from structural improvement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-quality-"));
  try {
    const report = await createMethodExtractionQualityReport({ root, symbol: "calculate", beforeSource: before, afterSource: after, behaviorPassed: true });
    assert.equal(report.behaviorConfidence, "passed");
    assert.equal(report.structuralImprovement, "improved");
    assert.equal(report.operationalRisk, "low");
    assert.equal(report.passed, true);
    assert.equal(report.advancedGates.length, 6);
    assert.ok(report.advancedGates.every((gate) => gate.status === "not-evaluated"));
    assert.match(renderMethodExtractionQualityReport(report), /Behavior confidence: passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advanced quality gates compare current numeric evidence against baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-quality-comparison-"));
  const metric = path.join(root, "metric.txt");
  const command = "node -e \"process.stdout.write(require('fs').readFileSync('metric.txt','utf8'))\"";
  try {
    await writeFile(metric, "90");
    const config = [{ kind: "coverage" as const, command, required: true }];
    const baseline = await captureMethodAdvancedGateBaseline(root, config);
    await writeFile(metric, "85");
    const report = await createMethodExtractionQualityReport({
      root,
      symbol: "calculate",
      beforeSource: before,
      afterSource: after,
      behaviorPassed: true,
      advancedGates: config,
      advancedGateBaseline: baseline
    });
    const coverage = report.advancedGates.find((gate) => gate.kind === "coverage");
    assert.equal(coverage?.status, "failed");
    assert.equal(coverage?.baselineValue, 90);
    assert.equal(coverage?.currentValue, 85);
    assert.equal(coverage?.changePercent, -5.556);
    assert.equal(report.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required advanced quality gates fail closed while optional missing gates remain not evaluated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mg-quality-gates-"));
  try {
    const report = await createMethodExtractionQualityReport({
      root,
      symbol: "calculate",
      beforeSource: before,
      afterSource: after,
      behaviorPassed: true,
      advancedGates: [
        { kind: "coverage", command: "node -e \"process.exit(0)\"", required: true },
        { kind: "mutation", required: true }
      ]
    });
    assert.equal(report.advancedGates.find((gate) => gate.kind === "coverage")?.status, "passed");
    assert.equal(report.advancedGates.find((gate) => gate.kind === "mutation")?.status, "not-evaluated");
    assert.equal(report.passed, false);
    assert.equal(report.operationalRisk, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
