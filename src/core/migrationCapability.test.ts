import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMigrationCapability,
  type MigrationCapabilitySignals
} from "./migrationCapability.js";

function signals(overrides: Partial<MigrationCapabilitySignals> = {}): MigrationCapabilitySignals {
  return {
    sourceReadOnlyGuardPassed: true,
    analysisComplete: true,
    offlineContractPassed: true,
    implementationChecksPassed: true,
    scenarioContractPassed: true,
    dependencyProtocolChecksPassed: true,
    concreteAdaptersAttested: false,
    deployableServiceAttested: false,
    realEvidencePassed: false,
    dualReplayPassed: false,
    unifiedRealGatePassed: false,
    ...overrides
  };
}

test("capability assessment distinguishes protocol readiness from deployable L4", () => {
  const result = assessMigrationCapability(signals());
  assert.equal(result.achieved, "L4-A");
  assert.equal(result.next, "L4-B");
  assert.deepEqual(
    result.claims.find((item) => item.level === "L4-B")?.blockers,
    [
      "MG-CAPABILITY-CONCRETE-ADAPTERS-MISSING",
      "MG-CAPABILITY-DEPLOYABLE-SERVICE-MISSING"
    ]
  );
});

test("capability levels are sequential and cannot skip blocked prerequisites", () => {
  const result = assessMigrationCapability(signals({
    implementationChecksPassed: false,
    concreteAdaptersAttested: true,
    deployableServiceAttested: true,
    realEvidencePassed: true,
    dualReplayPassed: true,
    unifiedRealGatePassed: true
  }));
  assert.equal(result.achieved, "L2");
  assert.equal(result.claims.find((item) => item.level === "L4")?.passed, false);
});

test("full L4 requires the unified real gate", () => {
  const almost = assessMigrationCapability(signals({
    concreteAdaptersAttested: true,
    deployableServiceAttested: true,
    realEvidencePassed: true,
    dualReplayPassed: true
  }));
  assert.equal(almost.achieved, "L4-C");
  const full = assessMigrationCapability(signals({
    concreteAdaptersAttested: true,
    deployableServiceAttested: true,
    realEvidencePassed: true,
    dualReplayPassed: true,
    unifiedRealGatePassed: true
  }));
  assert.equal(full.achieved, "L4");
});
