import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { selectRepairStrategy, summarizeRepairStrategy } from "./repairStrategy.js";
import { loadConfig } from "./config.js";
import { pathExists, readJsonFile } from "./files.js";
import type {
  IssueControlRecoveryPlan,
  IssueControlSuperviseIteration,
  IssueControlSuperviseOptions,
  IssueControlSuperviseReport,
  SupervisorFailureCategory
} from "./issueControl.js";

test("repair strategy selection marks deterministic and proposal repairs as auto-fixable", () => {
  const missingBaseline = summarizeRepairStrategy(selectRepairStrategy({ category: "missing-baseline" }));
  const installRequired = summarizeRepairStrategy(selectRepairStrategy({ category: "install-required" }));
  const missingScript = summarizeRepairStrategy(selectRepairStrategy({ category: "missing-script" }));
  const probePathDrift = summarizeRepairStrategy(selectRepairStrategy({ category: "probe-path-drift" }));
  const formattingNoop = summarizeRepairStrategy(selectRepairStrategy({ category: "formatting-noop" }));
  const proposalRepair = summarizeRepairStrategy(selectRepairStrategy({ category: "proposal-repair-needed" }));
  const probeDiff = summarizeRepairStrategy(selectRepairStrategy({ category: "probe-diff" }));

  assert.equal(missingBaseline.id, "capture-missing-baseline");
  assert.equal(missingBaseline.kind, "deterministic");
  assert.equal(missingBaseline.autoFixable, true);
  assert.equal(installRequired.id, "install-dependencies");
  assert.equal(installRequired.autoFixable, true);
  assert.equal(missingScript.id, "patch-missing-package-script");
  assert.equal(missingScript.autoFixable, true);
  assert.equal(probePathDrift.id, "rewrite-drifted-probe-path");
  assert.equal(probePathDrift.behaviorDiffRequired, true);
  assert.equal(formattingNoop.id, "confirm-formatting-noop");
  assert.equal(formattingNoop.autoFixable, true);
  assert.equal(proposalRepair.id, "repair-failed-proposal");
  assert.equal(proposalRepair.behaviorDiffRequired, true);
  assert.equal(probeDiff.id, "manual-review");
  assert.equal(probeDiff.autoFixable, false);
});

test("missing script strategy adds a conservative package script alias", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-repair-script-"));
  try {
    const loaded = await loadRepairConfig(dir);
    await writeFile(path.join(loaded.targetRoot, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run"
      }
    }), "utf8");
    const strategy = selectRepairStrategy({ category: "missing-script" });
    const result = await strategy.apply({
      loaded,
      report: {} as IssueControlSuperviseReport,
      plan: createPlan("missing-script", "Missing script: test:ci"),
      options: {} as IssueControlSuperviseOptions
    });

    assert.equal(result.status, "executed");
    assert.equal(result.action, "patch-package-script");
    const packageJson = await readJsonFile<{ scripts: Record<string, string> }>(path.join(loaded.targetRoot, "package.json"));
    assert.equal(packageJson.scripts["test:ci"], "npm run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probe path drift strategy rewrites a stale probe path when replacement is unique", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-repair-probe-"));
  try {
    const targetRoot = path.join(dir, "target");
    await mkdir(path.join(targetRoot, "new"), { recursive: true });
    await writeFile(path.join(targetRoot, "new", "state.json"), "{}", "utf8");
    const loaded = await loadRepairConfig(dir, {
      probes: [{
        name: "state",
        type: "command",
        command: "node -e \"require('fs').readFileSync('old/state.json','utf8')\""
      }]
    });
    const strategy = selectRepairStrategy({ category: "probe-path-drift" });
    const result = await strategy.apply({
      loaded,
      report: {} as IssueControlSuperviseReport,
      plan: createPlan("probe-path-drift", "ENOENT: no such file or directory, open 'old/state.json'"),
      options: {} as IssueControlSuperviseOptions
    });

    assert.equal(result.status, "executed");
    assert.equal(result.action, "rewrite-probe-path");
    const config = await readJsonFile<{ probes: Array<{ command: string }> }>(loaded.path);
    assert.match(config.probes[0]?.command ?? "", /new\/state\.json/);
    assert.match(loaded.config.probes[0]?.type === "command" ? loaded.config.probes[0].command : "", /new\/state\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatting no-op strategy writes a recovery artifact for behavior guard", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-repair-format-"));
  try {
    const loaded = await loadRepairConfig(dir);
    const strategy = selectRepairStrategy({ category: "formatting-noop" });
    const result = await strategy.apply({
      loaded,
      report: {} as IssueControlSuperviseReport,
      plan: createPlan("formatting-noop", "format completed as no-op with no changes"),
      options: {} as IssueControlSuperviseOptions
    });

    assert.equal(result.status, "executed");
    assert.equal(result.action, "confirm-formatting-noop");
    assert.equal(await pathExists(result.artifactPath ?? ""), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function loadRepairConfig(dir: string, extra: Record<string, unknown> = {}) {
  const targetRoot = path.join(dir, "target");
  await mkdir(targetRoot, { recursive: true });
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    targetRoot: "target",
    artifactsDir: ".migration-guard",
    ...extra
  }), "utf8");
  return loadConfig(configPath);
}

function createPlan(category: SupervisorFailureCategory, reason: string): IssueControlRecoveryPlan {
  const repairStrategy = summarizeRepairStrategy(selectRepairStrategy({ category }));
  return {
    version: 1,
    id: `recovery-${category}`,
    createdAt: "2026-07-12T00:00:00.000Z",
    provider: "github",
    repo: "perly6185-lab/migration-guard",
    sourceSuperviseId: "supervise-test",
    status: "planned",
    failureCategory: category,
    failedIteration: {
      reason,
      error: reason,
      verification: {
        status: "failed",
        reason
      }
    } as IssueControlSuperviseIteration,
    evidencePaths: [],
    autoFixable: repairStrategy.autoFixable,
    autoFixableReason: repairStrategy.reason,
    autoRepairEligible: repairStrategy.autoFixable,
    humanActionRequired: !repairStrategy.autoFixable,
    repairStrategy,
    behaviorDiffRequired: repairStrategy.behaviorDiffRequired,
    recommendedNextCommand: repairStrategy.recommendedNextCommand,
    recommendedActions: []
  };
}
