import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONCURRENCY_PROTOCOL,
  FAULT_PROTOCOL,
  OPERATION_PROTOCOL,
  PLAN_PROTOCOL,
  REPORT_PROTOCOL,
  REVIEW_PROTOCOL,
  WRITE_APPROVAL,
  cleanupReplayPlan,
  findLatestIncompleteRun,
  projectBatchUpdateContract,
  runReplayPlan,
  stableHash,
  validateReplayPlan,
  validateReplayReport,
  validateCanonicalObservation,
  validConcurrencyEvidence,
} from "./l4c-replay-core.mjs";

const now = Date.now();
const testRoot = await mkdtemp(path.join(os.tmpdir(), "mg-l4c-self-test-"));
const contract = {
  projectId: "zboss-batch-update-with-progress",
  projectHash: "a".repeat(64),
  contractHash: "b".repeat(64),
  sourceIdentity: {
    revision: "fixture",
    dirty: false,
    dirtyFingerprint: "0".repeat(64),
    identity: "fixture",
  },
  entries: [
    {
      id: "batch-update",
      scenarios: [
        {
          id: "primary-success",
          category: "success",
          requiredDimensions: [
            "http",
            "context",
            "decisions",
            "effects",
            "state",
            "events",
            "failures",
          ],
        },
        {
          id: "dependency-failure",
          category: "fault",
          requiredDimensions: [
            "http",
            "context",
            "decisions",
            "effects",
            "state",
            "events",
            "failures",
          ],
        },
      ],
    },
  ],
};
const operations = Object.fromEntries(
  [
    "setup",
    "start",
    "health",
    "seed",
    "snapshot",
    "injectFault",
    "invoke",
    "collect",
    "cleanup",
    "verifyCleanup",
    "stop",
  ].map((operation) => [
    operation,
    {
      program: "node",
      args: ["mock-driver.mjs", operation],
      timeoutMs: 10_000,
    },
  ]),
);
const plan = {
  schemaVersion: 1,
  protocol: PLAN_PROTOCOL,
  status: "approved",
  projectId: contract.projectId,
  projectHash: contract.projectHash,
  runtimeContractHash: contract.contractHash,
  approval: {
    mode: "disposable-test-write",
    approvedBy: "self-test-approver",
    ticket: "SELF-TEST",
    approvedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    executionNonceSha256: stableHash("self-test"),
  },
  scope: {
    environment: "test",
    allowedHosts: ["127.0.0.1"],
    database: "migration_guard_test",
    tenantId: "fixture-tenant",
    panelId: "fixture-panel",
    table: "cust_table9001",
    markerPrefix: "mg-l4c-test-",
    maxRowsPerScenario: 10,
    schemaChangesAllowed: false,
  },
  environmentValueBindings: [],
  requiredEnvironment: [],
  scenarios: ["primary-success", "dependency-failure"],
  targets: {
    source: {
      kind: "java",
      baseUrl: "http://127.0.0.1:18001",
      operations,
    },
    target: {
      kind: "rust",
      baseUrl: "http://127.0.0.1:18002",
      operations,
    },
  },
  normalization: {
    ignorePaths: ["observation.metadata.durationMs"],
  },
};

const preflight = validateReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  now,
});
assert.deepEqual(preflight.findings, []);
assert.equal(preflight.completeScenarioSet, true);

assert.deepEqual(
  validateCanonicalObservation(
    canonicalObservation("primary-success", plan.scope),
    contract.entries[0].scenarios[0],
    plan.scope,
    "source",
  ),
  [],
);
assert.ok(
  validateCanonicalObservation(
    { dimensions: { http: { verified: true } } },
    contract.entries[0].scenarios[0],
    plan.scope,
    "source",
  ).some((finding) => finding.endsWith(":http-collector")),
);
const websocketObservation = canonicalObservation(
  "primary-success",
  plan.scope,
);
websocketObservation.dimensions.events = {
  verified: true,
  collector: "websocket",
  terminalStatus: "SUCCESS",
  terminalPercentage: 100,
};
assert.deepEqual(
  validateCanonicalObservation(
    websocketObservation,
    contract.entries[0].scenarios[0],
    plan.scope,
    "source",
  ),
  [],
);
assert.deepEqual(
  projectBatchUpdateContract(contractSemantic("source")),
  projectBatchUpdateContract(contractSemantic("target")),
);
const identitySpoof = contractSemantic("target");
identitySpoof.after.mysql.projection[0].values.primaryKey = "spoofed";
assert.equal(
  projectBatchUpdateContract(identitySpoof)
    .after.projection[0].primaryKey,
  "mg-l4c-row-001",
);
const emptyRedisObservation = canonicalObservation(
  "primary-success",
  plan.scope,
);
emptyRedisObservation.dimensions.events = {
  verified: true,
  redis: {},
};
assert.ok(
  validateCanonicalObservation(
    emptyRedisObservation,
    contract.entries[0].scenarios[0],
    plan.scope,
    "target",
  ).some((finding) => finding.endsWith(":events")),
);
const validationScenario = {
  ...contract.entries[0].scenarios[0],
  id: "validation-failure",
  category: "validation",
};
const validationNoEventObservation = canonicalObservation(
  "validation-failure",
  plan.scope,
);
validationNoEventObservation.dimensions.events = {
  verified: true,
  collector: "websocket",
  completionMode: "no-event",
  eventCount: 0,
};
assert.deepEqual(
  validateCanonicalObservation(
    validationNoEventObservation,
    validationScenario,
    plan.scope,
    "source",
  ),
  [],
);
const validationTargetNoEventObservation = structuredClone(
  validationNoEventObservation,
);
validationTargetNoEventObservation.dimensions.events.collector =
  "state-profile";
assert.deepEqual(
  validateCanonicalObservation(
    validationTargetNoEventObservation,
    validationScenario,
    plan.scope,
    "target",
  ),
  [],
);
const nonEmptyNoEventObservation = structuredClone(
  validationNoEventObservation,
);
nonEmptyNoEventObservation.dimensions.events.eventCount = 1;
assert.ok(
  validateCanonicalObservation(
    nonEmptyNoEventObservation,
    validationScenario,
    plan.scope,
    "source",
  ).some((finding) => finding.endsWith(":events")),
);
const primaryNoEventObservation = canonicalObservation(
  "primary-success",
  plan.scope,
);
primaryNoEventObservation.dimensions.events = {
  verified: true,
  collector: "websocket",
  completionMode: "no-event",
  eventCount: 0,
};
const primaryScenario = contract.entries
  .flatMap((entry) => entry.scenarios)
  .find((scenario) => scenario.id === "primary-success");
assert.ok(
  validateCanonicalObservation(
    primaryNoEventObservation,
    primaryScenario,
    plan.scope,
    "source",
  ).some((finding) => finding.endsWith(":events")),
);

const profiledPlan = structuredClone(plan);
profiledPlan.normalization = {
  profile: "batch-update-contract-v1",
  supportedScenarios: ["primary-success"],
  ignorePaths: [],
};
assert.deepEqual(
  validateReplayPlan(profiledPlan, contract, {
    repositoryRoot: process.cwd(),
    now,
    scenarioFilter: ["primary-success"],
    allowPartialScenarios: true,
  }).findings,
  [],
);
assert.ok(
  validateReplayPlan(profiledPlan, contract, {
    repositoryRoot: process.cwd(),
    now,
  }).findings.includes(
    "MG-L4C-NORMALIZATION-SCENARIO-UNSUPPORTED:dependency-failure",
  ),
);

const unsafePlan = structuredClone(plan);
unsafePlan.scope.environment = "production";
unsafePlan.scope.database = "zboss_prod";
unsafePlan.targets.source.baseUrl = "https://api.production.example";
const unsafe = validateReplayPlan(unsafePlan, contract, {
  repositoryRoot: process.cwd(),
  now,
});
assert.ok(unsafe.findings.includes("MG-L4C-SCOPE-ENVIRONMENT-UNSAFE"));
assert.ok(unsafe.findings.includes("MG-L4C-SCOPE-DATABASE-UNSAFE"));
assert.ok(unsafe.findings.includes("MG-L4C-TARGET-URL-UNSAFE:source"));

const passed = await runReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now,
  runId: "self-test-pass",
  synthetic: true,
  operationExecutor: mockExecutor(),
});
assert.equal(passed.status, "pass");
assert.equal(passed.realEligible, false);
assert.equal(passed.dualReplayPassed, true);
assert.equal(passed.cleanupVerified, true);
assert.equal(passed.comparisons.length, 2);
const completedCheckpoint = JSON.parse(await readFile(
  path.join(testRoot, "self-test-pass", "checkpoint.json"),
  "utf8",
));
assert.equal(completedCheckpoint.status, "completed");
assert.ok(completedCheckpoint.operations.length > 0);

const mismatched = await runReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now,
  runId: "self-test-mismatch",
  synthetic: true,
  operationExecutor: mockExecutor({ mismatch: true }),
});
assert.equal(mismatched.status, "blocked");
assert.equal(mismatched.dualReplayPassed, false);
assert.ok(
  mismatched.comparisons.some((comparison) =>
    comparison.differences.some((difference) =>
      difference.path === "$.invoke.runtimeSpecific")),
);

const residue = await runReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now,
  runId: "self-test-residue",
  synthetic: true,
  operationExecutor: mockExecutor({ residue: true }),
});
assert.equal(residue.status, "blocked");
assert.equal(residue.cleanupVerified, false);

const syntheticReview = {
  schemaVersion: 1,
  protocol: REVIEW_PROTOCOL,
  decision: "approved",
  identity: "independent-self-test-reviewer",
  reviewedAt: new Date(now).toISOString(),
  evidenceReportHash: passed.reportHash,
};
const gateFindings = validateReplayReport(
  passed,
  contract,
  syntheticReview,
  now,
);
assert.ok(gateFindings.includes("MG-L4C-REPORT-NOT-REAL"));

const reviewedReport = structuredClone(passed);
reviewedReport.synthetic = false;
reviewedReport.realEligible = true;
reviewedReport.reportHash = stableHash({
  ...reviewedReport,
  reportHash: undefined,
});
const independentReview = {
  ...syntheticReview,
  evidenceReportHash: reviewedReport.reportHash,
};
assert.deepEqual(
  validateReplayReport(reviewedReport, contract, independentReview, now),
  [],
);

const changedProfileReport = structuredClone(reviewedReport);
changedProfileReport.targets.source.scenarios[0]
  .operations.collect.profileHash = "f".repeat(64);
changedProfileReport.reportHash = stableHash({
  ...changedProfileReport,
  reportHash: undefined,
});
const changedProfileReview = {
  ...independentReview,
  evidenceReportHash: changedProfileReport.reportHash,
};
assert.ok(
  validateReplayReport(
    changedProfileReport,
    contract,
    changedProfileReview,
    now,
  ).some((finding) =>
    finding.startsWith("MG-L4C-REPORT-STATE-PROFILE-INVALID")),
);

const missingSeedHashReport = structuredClone(reviewedReport);
delete missingSeedHashReport.targets.source.scenarios[0]
  .operations.seed.seedHash;
missingSeedHashReport.reportHash = stableHash({
  ...missingSeedHashReport,
  reportHash: undefined,
});
const missingSeedHashReview = {
  ...independentReview,
  evidenceReportHash: missingSeedHashReport.reportHash,
};
assert.ok(
  validateReplayReport(
    missingSeedHashReport,
    contract,
    missingSeedHashReview,
    now,
  ).some((finding) =>
    finding.startsWith("MG-L4C-REPORT-SEED-PROFILE-INVALID")),
);

const tampered = structuredClone(passed);
tampered.protocol = REPORT_PROTOCOL;
tampered.status = "pass";
tampered.synthetic = false;
tampered.realEligible = true;
assert.ok(
  validateReplayReport(tampered, contract, syntheticReview, now)
    .includes("MG-L4C-REPORT-HASH-MISMATCH"),
);

const priorWriteApproval = process.env.MG_L4C_REAL_WRITE_APPROVED;
const priorNonce = process.env.MG_L4C_APPROVAL_NONCE;
process.env.MG_L4C_REAL_WRITE_APPROVED = WRITE_APPROVAL;
process.env.MG_L4C_APPROVAL_NONCE = "incorrect";
await assert.rejects(
  cleanupReplayPlan(plan, contract, {
    repositoryRoot: process.cwd(),
    outputRoot: testRoot,
    now,
    runId: "self-test-cleanup",
    operationExecutor: mockExecutor(),
  }),
  /MG-L4C-EXECUTION-NONCE-MISMATCH/,
);
restoreEnvironment("MG_L4C_REAL_WRITE_APPROVED", priorWriteApproval);
restoreEnvironment("MG_L4C_APPROVAL_NONCE", priorNonce);

const redactionPlan = structuredClone(plan);
redactionPlan.environmentValueBindings = ["MG_L4C_SELF_TEST_VALUE"];
const priorSensitiveValue = process.env.MG_L4C_SELF_TEST_VALUE;
process.env.MG_L4C_SELF_TEST_VALUE = "fixture-sensitive-value";
const redactedFailure = await runReplayPlan(redactionPlan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now,
  runId: "self-test-redaction",
  synthetic: true,
  operationExecutor: async (definition, operationContext, context) => {
    if (
      operationContext.targetKind === "source"
      && operationContext.operation === "invoke"
    ) {
      throw new Error(`failure fixture-sensitive-value`);
    }
    return mockExecutor()(definition, operationContext, context);
  },
});
restoreEnvironment("MG_L4C_SELF_TEST_VALUE", priorSensitiveValue);
assert.equal(JSON.stringify(redactedFailure).includes("fixture-sensitive-value"), false);
assert.equal(JSON.stringify(redactedFailure).includes("<redacted>"), true);

const latestIncomplete = await findLatestIncompleteRun(testRoot);
assert.equal(latestIncomplete.checkpoint.runId, "self-test-residue");

const expiredApprovalCleanup = await cleanupReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now: now + 120_000,
  runId: "self-test-residue",
  synthetic: true,
  operationExecutor: mockExecutor(),
  requireCheckpoint: true,
});
assert.equal(expiredApprovalCleanup.status, "passed");
const recoveredCheckpoint = JSON.parse(await readFile(
  path.join(testRoot, "self-test-residue", "checkpoint.json"),
  "utf8",
));
assert.equal(recoveredCheckpoint.status, "recovered");

const changedCleanupPlan = structuredClone(plan);
changedCleanupPlan.normalization.ignorePaths.push("observation.metadata.traceId");
await assert.rejects(
  cleanupReplayPlan(changedCleanupPlan, contract, {
    repositoryRoot: process.cwd(),
    outputRoot: testRoot,
    now: now + 120_000,
    runId: "self-test-residue",
    synthetic: true,
    operationExecutor: mockExecutor(),
    requireCheckpoint: true,
  }),
  /MG-L4C-CLEANUP-CHECKPOINT-BINDING-MISMATCH/,
);
await assert.rejects(
  cleanupReplayPlan(plan, contract, {
    repositoryRoot: process.cwd(),
    outputRoot: testRoot,
    now: now + 120_000,
    runId: "self-test-missing-checkpoint",
    synthetic: true,
    operationExecutor: mockExecutor(),
    requireCheckpoint: true,
  }),
  /MG-L4C-CLEANUP-CHECKPOINT-MISSING/,
);

const slowRun = runReplayPlan(plan, contract, {
  repositoryRoot: process.cwd(),
  outputRoot: testRoot,
  now,
  runId: "self-test-lock-owner",
  synthetic: true,
  operationExecutor: async (...arguments_) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return mockExecutor()(...arguments_);
  },
});
await new Promise((resolve) => setTimeout(resolve, 10));
await assert.rejects(
  runReplayPlan(plan, contract, {
    repositoryRoot: process.cwd(),
    outputRoot: testRoot,
    now,
    runId: "self-test-lock-contender",
    synthetic: true,
    operationExecutor: mockExecutor(),
  }),
  /MG-L4C-SCOPE-LOCKED/,
);
await slowRun;

const concurrencyEvidence = {
  schemaVersion: 1,
  protocol: CONCURRENCY_PROTOCOL,
  status: "passed",
  scenarioId: "concurrent-write",
  marker: "mg-l4c-concurrent",
  driver: "built-in-barrier-v1",
  startMode: "barrier",
  barrier: {
    status: "released",
    participantCount: 2,
    arrivedWriterCount: 2,
    releaseCount: 1,
  },
  writerCount: 2,
  completedWriterCount: 2,
  writers: [
    {
      id: "writer-a",
      marker: "mg-l4c-concurrent:writer-a",
      httpStatus: 200,
      code: 0,
    },
    {
      id: "writer-b",
      marker: "mg-l4c-concurrent:writer-b",
      httpStatus: 200,
      code: 0,
    },
  ],
};
assert.equal(validConcurrencyEvidence(
  concurrencyEvidence,
  "mg-l4c-concurrent",
  "concurrent-write",
), true);
const duplicateWriter = structuredClone(concurrencyEvidence);
duplicateWriter.writers[1].marker = duplicateWriter.writers[0].marker;
assert.equal(validConcurrencyEvidence(
  duplicateWriter,
  "mg-l4c-concurrent",
  "concurrent-write",
), false);
const unreleasedBarrier = structuredClone(concurrencyEvidence);
unreleasedBarrier.barrier.status = "waiting";
assert.equal(validConcurrencyEvidence(
  unreleasedBarrier,
  "mg-l4c-concurrent",
  "concurrent-write",
), false);

console.log(JSON.stringify({
  status: "pass",
  checks: 48,
  coverage: [
    "safe-plan-preflight",
    "production-scope-rejected",
    "synthetic-dual-replay",
    "semantic-mismatch-fail-closed",
    "cleanup-residue-fail-closed",
    "synthetic-evidence-gate-rejected",
    "reviewed-report-contract-valid",
    "tampered-report-rejected",
    "cleanup-nonce-required",
    "failure-output-redacted",
    "checkpoint-persisted",
    "latest-incomplete-discovery",
    "expired-approval-cleanup-recovery",
    "cleanup-checkpoint-plan-scope-binding",
    "cleanup-checkpoint-required",
    "scope-concurrency-lock",
    "field-level-difference",
    "canonical-observation-valid",
    "canonical-websocket-observation-valid",
    "empty-redis-terminal-rejected",
    "validation-no-event-observation-valid",
    "validation-target-no-event-observation-valid",
    "non-empty-no-event-observation-rejected",
    "no-event-observation-scenario-bounded",
    "canonical-observation-fail-closed",
    "batch-update-contract-projection",
    "canonical-projection-identity-protected",
    "normalization-profile-scenario-bounded",
    "normalization-profile-unsupported-scenario-rejected",
    "state-profile-hash-drift-rejected",
    "seed-profile-hash-required",
    "concurrency-evidence-valid",
    "duplicate-concurrency-writer-rejected",
    "unreleased-concurrency-barrier-rejected",
  ],
}, null, 2));
await rm(testRoot, { recursive: true, force: true });

function mockExecutor(options = {}) {
  return async (_definition, operationContext, context) => {
    const scoped = operationContext.marker
      ? {
          scope: {
            marker: operationContext.marker,
            tenantId: context.plan.scope.tenantId,
            panelId: context.plan.scope.panelId,
            table: context.plan.scope.table,
            database: context.plan.scope.database,
            rowCount: 2,
          },
        }
      : {};
    const base = {
      schemaVersion: 1,
      protocol: OPERATION_PROTOCOL,
      status: "passed",
      ...scoped,
      bindingHash: "d".repeat(64),
      ...(operationContext.targetKind === "source"
        ? { profileHash: "e".repeat(64) }
        : {}),
      ...(operationContext.operation === "seed"
        ? {
            seedHash: "a".repeat(64),
            bindings: {
              "row-001": {
                generatedId: `${operationContext.targetKind}-row-001`,
                marker: `${operationContext.marker}-row-001`,
              },
              "row-002": {
                generatedId: `${operationContext.targetKind}-row-002`,
                marker: `${operationContext.marker}-row-002`,
              },
            },
          }
        : {}),
    };
    if (operationContext.operation === "snapshot") {
      return {
        ...base,
        snapshot: {
          phase: operationContext.phase,
          rows: [{ id: "row-1", value: operationContext.phase }],
        },
      };
    }
    if (operationContext.operation === "invoke") {
      return {
        ...base,
        response: {
          code: 0,
          committed: 2,
          runtimeSpecific:
            options.mismatch && operationContext.targetKind === "target"
              ? "different"
              : "same",
        },
      };
    }
    if (operationContext.operation === "collect") {
      return {
        ...base,
        observation: canonicalObservation(
          operationContext.scenarioId,
          context.plan.scope,
          operationContext.targetKind === "source" ? 10 : 20,
        ),
      };
    }
    if (operationContext.operation === "injectFault") {
      return {
        ...base,
        fault: {
          schemaVersion: 1,
          protocol: FAULT_PROTOCOL,
          status: "passed",
          action: "verify-active",
          state: "active",
          scenarioId: operationContext.scenarioId,
          marker: operationContext.marker,
          mechanismId: "self-test-fault",
          resourceId: `self-test:${operationContext.marker}`,
          restoreRequired: true,
          artifactCount: 1,
          applyHash: stableHash({
            scenarioId: operationContext.scenarioId,
            marker: operationContext.marker,
          }),
        },
      };
    }
    if (operationContext.operation === "verifyCleanup") {
      return {
        ...base,
        cleanup: {
          fixtureRows:
            options.residue && operationContext.targetKind === "target" ? 1 : 0,
          undoRows: 0,
          outboxRows: 0,
          commitRows: 0,
          redisKeys: 0,
          leaseKeys: 0,
          schemaArtifacts: 0,
          faultArtifacts: 0,
        },
      };
    }
    return base;
  };
}

function canonicalObservation(scenarioId, scope, durationMs = 10) {
  return {
    dimensions: {
      http: {
        verified: true,
        collector: "operation-driver",
      },
      context: {
        verified: true,
        tenantId: scope.tenantId,
        panelId: scope.panelId,
        database: scope.database,
        table: scope.table,
      },
      decisions: {
        verified: true,
        scenarioId,
      },
      effects: {
        verified: true,
        fixtureRows: 2,
        commitRows: 2,
        undoRows: 2,
        outboxRows: 4,
      },
      state: {
        verified: true,
        mysql: {},
      },
      events: {
        verified: true,
        redis: {
          progress: {
            state: "SUCCESS",
            terminal: "1",
            total: "2",
            committed: "2",
            failed: "0",
          },
        },
      },
      failures: {
        verified: true,
        markerScoped: true,
      },
      performance: {
        verified: true,
        rowCount: 2,
        withinBudget: true,
      },
    },
    metadata: { durationMs },
  };
}

function contractSemantic(targetKind) {
  const source = targetKind === "source";
  const projection = source
    ? [{
        primaryKey: "mg-l4c-row-001",
        value: "updated",
        quantity: 101,
      }]
    : [{
        primaryKey: "mg-l4c-row-001",
        values: { value: "updated", quantity: 101 },
      }];
  const mysql = {
    fixtureRows: 1,
    projection,
  };
  return {
    before: { mysql },
    invoke: { httpStatus: 200, body: { code: 0 } },
    after: { mysql },
    observation: {
      dimensions: {
        context: {
          tenantId: plan.scope.tenantId,
          panelId: plan.scope.panelId,
          database: plan.scope.database,
          table: plan.scope.table,
        },
        decisions: { scenarioId: "primary-success" },
        effects: {
          fixtureRows: 1,
          undoRows: source ? 1 : 2,
        },
        state: { mysql },
        events: source
          ? {
              terminalStatus: "SUCCESS",
              terminalPercentage: 100,
            }
          : {
              redis: {
                progress: {
                  state: "SUCCESS",
                  terminal: "1",
                  total: "1",
                  committed: "1",
                  failed: "0",
                },
              },
            },
        failures: { markerScoped: true },
      },
    },
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
