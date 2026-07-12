import test from "node:test";
import assert from "node:assert/strict";
import { selectRepairStrategy, summarizeRepairStrategy } from "./repairStrategy.js";

test("repair strategy selection marks deterministic and proposal repairs as auto-fixable", () => {
  const missingBaseline = summarizeRepairStrategy(selectRepairStrategy({ category: "missing-baseline" }));
  const installRequired = summarizeRepairStrategy(selectRepairStrategy({ category: "install-required" }));
  const proposalRepair = summarizeRepairStrategy(selectRepairStrategy({ category: "proposal-repair-needed" }));
  const probeDiff = summarizeRepairStrategy(selectRepairStrategy({ category: "probe-diff" }));

  assert.equal(missingBaseline.id, "capture-missing-baseline");
  assert.equal(missingBaseline.kind, "deterministic");
  assert.equal(missingBaseline.autoFixable, true);
  assert.equal(installRequired.id, "install-dependencies");
  assert.equal(installRequired.autoFixable, true);
  assert.equal(proposalRepair.id, "repair-failed-proposal");
  assert.equal(proposalRepair.behaviorDiffRequired, true);
  assert.equal(probeDiff.id, "manual-review");
  assert.equal(probeDiff.autoFixable, false);
});
