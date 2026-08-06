import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTAKE_PROTOCOL =
  "migration-guard.batch-update-l4c-remaining-wave-approval-intake/v1";
const RECORD_PROTOCOL =
  "migration-guard.batch-update-l4c-remaining-wave-approval-record/v1";
const REVIEW_PROTOCOL =
  "migration-guard.batch-update-l4c-remaining-wave-human-review/v1";
const MATRIX_PROTOCOL =
  "migration-guard.batch-update-l4c-fault-mechanism-matrix/v1";
const MAX_APPROVAL_MS = 24 * 60 * 60 * 1000;
const COLLECTORS = ["events", "mysql", "redis"];
const FAULT_SCENARIOS = new Set([
  "post-commit-effect-failure",
  "schema-transition-failure",
  "transaction-failure",
  "undo-excludes-failed-rows",
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(
  scriptDirectory,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);
const caseDirectory = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const outputRoot = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "scenario-preparation",
  "remaining-wave",
);
const reviewRoot = path.join(outputRoot, "human-review");
const reviewPath = path.join(reviewRoot, "remaining-wave-review.json");
const matrixPath = path.join(outputRoot, "fault-mechanism-matrix.json");
const templatePath = path.join(reviewRoot, "approval-intake.template.json");
const defaultIntakePath = path.join(reviewRoot, "approval-intake.json");
const defaultRecordPath = path.join(reviewRoot, "approval-record.json");

const args = parseArgs(process.argv.slice(2));
const built = await buildTemplate();

if (args.mode === "write-template") {
  await mkdir(reviewRoot, { recursive: true });
  await writeJson(templatePath, built);
  console.log(JSON.stringify(summary(built, "template-written"), null, 2));
} else if (args.mode === "write-draft") {
  const draftFindings = await writeDraftIntake(built);
  console.log(JSON.stringify({
    ...summary(
      built,
      draftFindings.length === 0 ? "draft-written" : "draft-blocked",
    ),
    intakePath: path.relative(repositoryRoot, defaultIntakePath),
    findings: draftFindings,
  }, null, 2));
  if (draftFindings.length > 0) process.exitCode = 1;
} else if (args.mode === "check-template") {
  const findings = await checkPersistedTemplate(built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "template-passed" : "template-blocked"),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else if (args.mode === "check-intake") {
  const intakePath = approvalPath(args.intake, defaultIntakePath);
  const findings = await checkIntakeFile(intakePath, built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "intake-passed" : "intake-blocked"),
    intakePath: path.relative(repositoryRoot, intakePath),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else if (args.mode === "write-record") {
  const intakePath = approvalPath(args.intake, defaultIntakePath);
  const recordPath = approvalPath(args.record, defaultRecordPath);
  const intake = await readJson(intakePath);
  const findings = validateApprovalIntake(intake, built);
  if (findings.length > 0) {
    console.log(JSON.stringify({
      ...summary(built, "record-blocked"),
      intakePath: path.relative(repositoryRoot, intakePath),
      recordPath: path.relative(repositoryRoot, recordPath),
      findings,
    }, null, 2));
    process.exitCode = 1;
  } else {
    const record = buildApprovalRecord(intake, built);
    const recordFindings = validateApprovalRecord(record, built);
    if (recordFindings.length > 0) throw new Error(recordFindings.join(", "));
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeJson(recordPath, record);
    console.log(JSON.stringify({
      ...summary(built, "record-written"),
      intakePath: path.relative(repositoryRoot, intakePath),
      recordPath: path.relative(repositoryRoot, recordPath),
      approvalRecordHash: record.approvalRecordHash,
    }, null, 2));
  }
} else {
  const findings = selfTestApprovalIntake(built);
  if (findings.length > 0) throw new Error(findings.join(", "));
  console.log(JSON.stringify({
    status: "pass",
    checks: 7,
    coverage: [
      "template-contains-all-fourteen-scenarios",
      "template-keeps-all-decisions-pending",
      "complete-intake-validates",
      "approval-record-hash-validates",
      "hash-tamper-rejected",
      "expired-authorization-rejected",
      "missing-fault-endpoint-rejected",
    ],
  }, null, 2));
}

async function buildTemplate() {
  const review = await readJson(reviewPath);
  const matrix = await readJson(matrixPath);
  const sourceFindings = [
    ...validateSourceReview(review),
    ...validateFaultMatrix(matrix, review),
  ];
  if (sourceFindings.length > 0) {
    throw new Error(sourceFindings.join(", "));
  }
  const faultControls = Object.fromEntries(matrix.scenarios
    .filter((item) => item.mechanism.id !== "none")
    .map((item) => [item.scenarioId, faultControlTemplate(item)]));
  const scenarios = review.scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    decision: "pending",
    semanticConfirmation: {
      javaSeed: "pending",
      rustSeed: "pending",
      collectors: Object.fromEntries(COLLECTORS.map((collector) => [
        collector,
        "pending",
      ])),
      binding: "pending",
      resourceScope: "pending",
      faultEndpoint: FAULT_SCENARIOS.has(scenario.scenarioId)
        ? "pending"
        : "not-applicable",
    },
    hashes: scenarioHashes(scenario),
    paths: {
      sourceDraft: scenario.sourceDraft.path,
      javaSeed: scenario.seed.javaPath,
      rustSeed: scenario.seed.rustPath,
      binding: scenario.binding.path,
      collectors: Object.fromEntries(Object.entries(scenario.collectors).map(
        ([collector, value]) => [collector, value.path],
      )),
    },
    resourceScopeRefs: {
      database: "resourceScopes.database",
      redis: "resourceScopes.redis",
      websocket: "resourceScopes.websocket",
    },
    faultControlRef: FAULT_SCENARIOS.has(scenario.scenarioId)
      ? `faultControls.${scenario.scenarioId}`
      : "not-applicable",
  }));
  const value = {
    schemaVersion: 1,
    protocol: INTAKE_PROTOCOL,
    status: "draft-pending-human-input",
    realEvidenceEligible: false,
    projectId: review.projectId,
    projectHash: review.projectHash,
    runtimeContractHash: review.runtimeContractHash,
    promotionWave: review.promotionWave,
    sourceReview: {
      path: relativeCasePath(reviewPath),
      reportHash: review.reportHash,
      status: review.status,
    },
    reviewer: {
      identity: "<reviewer>",
      confirmedAt: "<iso-8601>",
      reviewTicket: "<approval-ticket>",
      confirmationBasis: [
        "seed-semantics",
        "collector-semantics",
        "binding-resource-scope",
        "fault-control-endpoints",
      ],
      notes: "<human-review-notes>",
    },
    authorization: {
      mode: "disposable-test-write",
      approvedBy: "<write-approver>",
      ticket: "<approval-ticket>",
      approvedAt: "<iso-8601>",
      expiresAt: "<iso-8601-no-more-than-24-hours-later>",
      scope: {
        projectId: review.projectId,
        promotionWave: review.promotionWave,
        scenarioIds: review.scenarioOrder,
        targets: ["source", "target"],
        operations: [
          "seed",
          "replay",
          "collect",
          "fault-control",
          "cleanup",
        ],
      },
    },
    resourceScopes: {
      database: {
        status: "review-required",
        host: "<database-host>",
        database: "<database-name>",
        tables: ["<marker-scoped-table>"],
        markerField: "<marker-column>",
        markerPrefix: "<l4c-marker-prefix>",
        rowLimitPerScenario: "<max-rows>",
        cleanupMethod: "marker-bound-delete-and-verify-zero",
        cleanupEvidence: "before-after-count-zero",
      },
      redis: {
        status: "review-required",
        endpoint: "<redis-endpoint-or-not-applicable>",
        keyPrefixes: ["<marker-scoped-key-prefix>"],
        keyTypes: ["<approved-key-type>"],
        cleanupMethod: "marker-bound-delete-and-verify-zero",
        cleanupEvidence: "before-after-count-zero",
        notApplicableReason: "<required-when-status-is-not-applicable>",
      },
      websocket: {
        status: "review-required",
        endpoint: "<websocket-url>",
        subscription: "<panel-subscription-scope>",
        terminalStatuses: ["<terminal-status>"],
        noEventWindowMs: "<required-for-no-event-scenarios>",
        cleanupMethod: "subscription-close-and-marker-window-drain",
      },
    },
    faultControls,
    scenarioOrder: review.scenarioOrder,
    scenarios,
    summary: {
      scenarioCount: scenarios.length,
      faultScenarioCount: Object.keys(faultControls).length,
      pendingDecisionCount: scenarios.length,
      approvedDecisionCount: 0,
    },
    templateHash: "",
  };
  value.templateHash = templateHash(value);
  return value;
}

async function checkPersistedTemplate(expected) {
  const findings = validateTemplate(expected);
  try {
    const persisted = await readJson(templatePath);
    findings.push(...validateTemplate(persisted));
    if (stableStringify(persisted) !== stableStringify(expected)) {
      findings.push("MG-SH3C-APPROVAL-INTAKE-TEMPLATE-STALE");
    }
  } catch {
    findings.push("MG-SH3C-APPROVAL-INTAKE-TEMPLATE-MISSING");
  }
  return uniqueFindings(findings);
}

async function writeDraftIntake(expected) {
  await mkdir(reviewRoot, { recursive: true });
  const existing = await readJsonIfPresent(defaultIntakePath);
  if (existing && stableStringify(existing) !== stableStringify(expected)) {
    return ["MG-SH3C-APPROVAL-INTAKE-DRAFT-EXISTS"];
  }
  await writeJson(defaultIntakePath, expected);
  return [];
}

async function checkIntakeFile(intakePath, expectedTemplate) {
  try {
    const intake = await readJson(intakePath);
    return validateApprovalIntake(intake, expectedTemplate);
  } catch {
    return ["MG-SH3C-APPROVAL-INTAKE-MISSING"];
  }
}

function validateTemplate(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== INTAKE_PROTOCOL
    || value?.status !== "draft-pending-human-input"
    || value?.realEvidenceEligible !== false
    || value?.promotionWave !== "sh3c-remaining-wave"
    || !Array.isArray(value?.scenarios)
    || value.scenarios.length !== 14
    || value.summary?.approvedDecisionCount !== 0
  ) {
    findings.push("MG-SH3C-APPROVAL-INTAKE-TEMPLATE-PROTOCOL-INVALID");
  }
  for (const scenario of value?.scenarios ?? []) {
    if (scenario.decision !== "pending") {
      findings.push(`MG-SH3C-APPROVAL-INTAKE-TEMPLATE-APPROVES:${scenario.scenarioId}`);
    }
  }
  for (const item of Object.values(value?.faultControls ?? {})) {
    if (item.status !== "review-required") {
      findings.push(`MG-SH3C-APPROVAL-INTAKE-FAULT-TEMPLATE-INVALID:${item.scenarioId}`);
    }
  }
  if (value?.templateHash !== templateHash(value)) {
    findings.push("MG-SH3C-APPROVAL-INTAKE-TEMPLATE-HASH-MISMATCH");
  }
  return uniqueFindings(findings);
}

function validateApprovalIntake(value, expectedTemplate) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== INTAKE_PROTOCOL
    || value?.status !== "approved"
    || value?.realEvidenceEligible !== false
    || value?.projectId !== expectedTemplate.projectId
    || value?.projectHash !== expectedTemplate.projectHash
    || value?.runtimeContractHash !== expectedTemplate.runtimeContractHash
    || value?.promotionWave !== expectedTemplate.promotionWave
  ) {
    findings.push("MG-SH3C-APPROVAL-INTAKE-PROTOCOL-INVALID");
  }
  if (value?.templateHash !== expectedTemplate.templateHash) {
    findings.push("MG-SH3C-APPROVAL-INTAKE-TEMPLATE-HASH-MISMATCH");
  }
  if (
    value?.sourceReview?.path !== expectedTemplate.sourceReview.path
    || value?.sourceReview?.reportHash !== expectedTemplate.sourceReview.reportHash
  ) {
    findings.push("MG-SH3C-APPROVAL-INTAKE-SOURCE-REVIEW-MISMATCH");
  }
  findings.push(...validateReviewer(value?.reviewer));
  findings.push(...validateAuthorization(value?.authorization, expectedTemplate));
  findings.push(...validateResourceScopes(value?.resourceScopes));
  findings.push(...validateFaultControls(value?.faultControls, expectedTemplate));
  findings.push(...validateScenarioDecisions(value, expectedTemplate));
  findings.push(...placeholderFindings(value));
  return uniqueFindings(findings);
}

function validateReviewer(value) {
  const findings = [];
  if (!filledString(value?.identity)) {
    findings.push("MG-SH3C-APPROVAL-REVIEWER-MISSING");
  }
  if (!validTime(value?.confirmedAt)) {
    findings.push("MG-SH3C-APPROVAL-REVIEWER-TIME-INVALID");
  }
  if (!filledString(value?.reviewTicket)) {
    findings.push("MG-SH3C-APPROVAL-REVIEW-TICKET-MISSING");
  }
  const basis = value?.confirmationBasis;
  for (const required of [
    "seed-semantics",
    "collector-semantics",
    "binding-resource-scope",
    "fault-control-endpoints",
  ]) {
    if (!Array.isArray(basis) || !basis.includes(required)) {
      findings.push(`MG-SH3C-APPROVAL-REVIEW-BASIS-MISSING:${required}`);
    }
  }
  return findings;
}

function validateAuthorization(value, expectedTemplate) {
  const findings = [];
  const approvedAt = parseTime(value?.approvedAt);
  const expiresAt = parseTime(value?.expiresAt);
  if (value?.mode !== "disposable-test-write") {
    findings.push("MG-SH3C-APPROVAL-MODE-INVALID");
  }
  if (!filledString(value?.approvedBy)) {
    findings.push("MG-SH3C-APPROVAL-APPROVER-MISSING");
  }
  if (!filledString(value?.ticket)) {
    findings.push("MG-SH3C-APPROVAL-TICKET-MISSING");
  }
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    findings.push("MG-SH3C-APPROVAL-WINDOW-INVALID");
  } else {
    if (expiresAt <= approvedAt) {
      findings.push("MG-SH3C-APPROVAL-WINDOW-NONPOSITIVE");
    }
    if (expiresAt - approvedAt > MAX_APPROVAL_MS) {
      findings.push("MG-SH3C-APPROVAL-WINDOW-TOO-LONG");
    }
    if (expiresAt <= Date.now()) {
      findings.push("MG-SH3C-APPROVAL-WINDOW-EXPIRED");
    }
  }
  const scope = value?.scope;
  if (
    scope?.projectId !== expectedTemplate.projectId
    || scope?.promotionWave !== expectedTemplate.promotionWave
    || !sameArray(scope?.scenarioIds, expectedTemplate.scenarioOrder)
    || !sameArray(scope?.targets, ["source", "target"])
  ) {
    findings.push("MG-SH3C-APPROVAL-SCOPE-MISMATCH");
  }
  for (const operation of ["seed", "replay", "collect", "fault-control", "cleanup"]) {
    if (!Array.isArray(scope?.operations) || !scope.operations.includes(operation)) {
      findings.push(`MG-SH3C-APPROVAL-OPERATION-MISSING:${operation}`);
    }
  }
  return findings;
}

function validateResourceScopes(value) {
  return [
    ...validateDatabaseScope(value?.database),
    ...validateRedisScope(value?.redis),
    ...validateWebsocketScope(value?.websocket),
  ];
}

function validateDatabaseScope(value) {
  const findings = [];
  if (value?.status !== "approved") {
    findings.push("MG-SH3C-APPROVAL-DATABASE-SCOPE-NOT-APPROVED");
  }
  for (const key of ["host", "database", "markerField", "markerPrefix"]) {
    if (!filledString(value?.[key])) {
      findings.push(`MG-SH3C-APPROVAL-DATABASE-SCOPE-MISSING:${key}`);
    }
  }
  if (!Array.isArray(value?.tables) || value.tables.length === 0) {
    findings.push("MG-SH3C-APPROVAL-DATABASE-TABLES-MISSING");
  } else {
    for (const table of value.tables) {
      if (!safeScopeString(table)) {
        findings.push("MG-SH3C-APPROVAL-DATABASE-TABLE-UNSAFE");
      }
    }
  }
  if (!Number.isInteger(value?.rowLimitPerScenario) || value.rowLimitPerScenario <= 0) {
    findings.push("MG-SH3C-APPROVAL-DATABASE-ROW-LIMIT-INVALID");
  }
  if (value?.cleanupMethod !== "marker-bound-delete-and-verify-zero") {
    findings.push("MG-SH3C-APPROVAL-DATABASE-CLEANUP-INVALID");
  }
  if (!filledString(value?.cleanupEvidence)) {
    findings.push("MG-SH3C-APPROVAL-DATABASE-CLEANUP-EVIDENCE-MISSING");
  }
  return findings;
}

function validateRedisScope(value) {
  const findings = [];
  if (value?.status === "not-applicable") {
    if (!filledString(value?.notApplicableReason)) {
      findings.push("MG-SH3C-APPROVAL-REDIS-NOT-APPLICABLE-REASON-MISSING");
    }
    return findings;
  }
  if (value?.status !== "approved") {
    findings.push("MG-SH3C-APPROVAL-REDIS-SCOPE-NOT-APPROVED");
  }
  if (!filledString(value?.endpoint)) {
    findings.push("MG-SH3C-APPROVAL-REDIS-ENDPOINT-MISSING");
  }
  if (!Array.isArray(value?.keyPrefixes) || value.keyPrefixes.length === 0) {
    findings.push("MG-SH3C-APPROVAL-REDIS-KEY-PREFIXES-MISSING");
  } else {
    for (const prefix of value.keyPrefixes) {
      if (!safeScopeString(prefix)) {
        findings.push("MG-SH3C-APPROVAL-REDIS-KEY-PREFIX-UNSAFE");
      }
    }
  }
  if (!Array.isArray(value?.keyTypes) || value.keyTypes.length === 0) {
    findings.push("MG-SH3C-APPROVAL-REDIS-KEY-TYPES-MISSING");
  }
  if (value?.cleanupMethod !== "marker-bound-delete-and-verify-zero") {
    findings.push("MG-SH3C-APPROVAL-REDIS-CLEANUP-INVALID");
  }
  if (!filledString(value?.cleanupEvidence)) {
    findings.push("MG-SH3C-APPROVAL-REDIS-CLEANUP-EVIDENCE-MISSING");
  }
  return findings;
}

function validateWebsocketScope(value) {
  const findings = [];
  if (value?.status !== "approved") {
    findings.push("MG-SH3C-APPROVAL-WEBSOCKET-SCOPE-NOT-APPROVED");
  }
  if (!validUrl(value?.endpoint, ["ws:", "wss:", "http:", "https:"])) {
    findings.push("MG-SH3C-APPROVAL-WEBSOCKET-ENDPOINT-INVALID");
  }
  if (!filledString(value?.subscription)) {
    findings.push("MG-SH3C-APPROVAL-WEBSOCKET-SUBSCRIPTION-MISSING");
  }
  if (!Array.isArray(value?.terminalStatuses) || value.terminalStatuses.length === 0) {
    findings.push("MG-SH3C-APPROVAL-WEBSOCKET-TERMINAL-STATUS-MISSING");
  }
  if (value?.cleanupMethod !== "subscription-close-and-marker-window-drain") {
    findings.push("MG-SH3C-APPROVAL-WEBSOCKET-CLEANUP-INVALID");
  }
  return findings;
}

function validateFaultControls(value, expectedTemplate) {
  const findings = [];
  for (const scenarioId of Object.keys(expectedTemplate.faultControls)) {
    const expected = expectedTemplate.faultControls[scenarioId];
    const actual = value?.[scenarioId];
    if (
      actual?.status !== "approved"
      || actual?.scenarioId !== scenarioId
      || actual?.mechanismId !== expected.mechanismId
      || actual?.controller !== expected.controller
    ) {
      findings.push(`MG-SH3C-APPROVAL-FAULT-CONTROL-MISMATCH:${scenarioId}`);
      continue;
    }
    for (const target of ["source", "target"]) {
      findings.push(...validateFaultEndpoint(
        scenarioId,
        target,
        actual[target],
      ));
    }
    if (actual.cleanupMethod !== "fault-apply-active-revert-inactive") {
      findings.push(`MG-SH3C-APPROVAL-FAULT-CLEANUP-INVALID:${scenarioId}`);
    }
    if (actual.cleanupEvidence !== "fault-artifacts-zero-after-cleanup") {
      findings.push(`MG-SH3C-APPROVAL-FAULT-CLEANUP-EVIDENCE-INVALID:${scenarioId}`);
    }
  }
  return findings;
}

function validateFaultEndpoint(scenarioId, target, value) {
  const findings = [];
  const parsed = parseUrl(value?.controlUrl, ["http:", "https:"]);
  if (!parsed) {
    findings.push(`MG-SH3C-APPROVAL-FAULT-ENDPOINT-INVALID:${scenarioId}:${target}`);
  }
  if (!Array.isArray(value?.approvedHosts) || value.approvedHosts.length === 0) {
    findings.push(`MG-SH3C-APPROVAL-FAULT-HOSTS-MISSING:${scenarioId}:${target}`);
  } else {
    for (const host of value.approvedHosts) {
      if (!safeScopeString(host)) {
        findings.push(`MG-SH3C-APPROVAL-FAULT-HOST-UNSAFE:${scenarioId}:${target}`);
      }
    }
    if (parsed && !value.approvedHosts.includes(parsed.hostname)) {
      findings.push(`MG-SH3C-APPROVAL-FAULT-HOST-NOT-ALLOWLISTED:${scenarioId}:${target}`);
    }
  }
  if (value?.restoreRequired !== true) {
    findings.push(`MG-SH3C-APPROVAL-FAULT-RESTORE-NOT-REQUIRED:${scenarioId}:${target}`);
  }
  if (value?.cleanupMethod !== "fault-apply-active-revert-inactive") {
    findings.push(`MG-SH3C-APPROVAL-FAULT-ENDPOINT-CLEANUP-INVALID:${scenarioId}:${target}`);
  }
  if (value?.cleanupEvidence !== "fault-artifacts-zero-after-cleanup") {
    findings.push(`MG-SH3C-APPROVAL-FAULT-ENDPOINT-EVIDENCE-INVALID:${scenarioId}:${target}`);
  }
  return findings;
}

function validateScenarioDecisions(value, expectedTemplate) {
  const findings = [];
  if (!sameArray(value?.scenarioOrder, expectedTemplate.scenarioOrder)) {
    findings.push("MG-SH3C-APPROVAL-SCENARIO-ORDER-MISMATCH");
  }
  if (!Array.isArray(value?.scenarios) || value.scenarios.length !== 14) {
    findings.push("MG-SH3C-APPROVAL-SCENARIOS-MISSING");
    return findings;
  }
  for (const scenarioId of expectedTemplate.scenarioOrder) {
    const expected = expectedTemplate.scenarios.find((item) =>
      item.scenarioId === scenarioId);
    const actual = value.scenarios.find((item) => item.scenarioId === scenarioId);
    if (!actual) {
      findings.push(`MG-SH3C-APPROVAL-SCENARIO-MISSING:${scenarioId}`);
      continue;
    }
    if (actual.decision !== "approved") {
      findings.push(`MG-SH3C-APPROVAL-SCENARIO-NOT-APPROVED:${scenarioId}`);
    }
    findings.push(...validateSemanticConfirmation(actual, scenarioId));
    findings.push(...validateScenarioHashes(actual, expected));
  }
  return findings;
}

function validateSemanticConfirmation(value, scenarioId) {
  const findings = [];
  const confirmation = value.semanticConfirmation;
  for (const key of ["javaSeed", "rustSeed", "binding", "resourceScope"]) {
    if (confirmation?.[key] !== "approved") {
      findings.push(`MG-SH3C-APPROVAL-SEMANTIC-CONFIRMATION-MISSING:${scenarioId}:${key}`);
    }
  }
  for (const collector of COLLECTORS) {
    if (confirmation?.collectors?.[collector] !== "approved") {
      findings.push(`MG-SH3C-APPROVAL-COLLECTOR-CONFIRMATION-MISSING:${scenarioId}:${collector}`);
    }
  }
  const expectedFault = FAULT_SCENARIOS.has(scenarioId) ? "approved" : "not-applicable";
  if (confirmation?.faultEndpoint !== expectedFault) {
    findings.push(`MG-SH3C-APPROVAL-FAULT-CONFIRMATION-MISMATCH:${scenarioId}`);
  }
  return findings;
}

function validateScenarioHashes(actual, expected) {
  const findings = [];
  for (const key of ["sourceDraft", "component", "package", "binding"]) {
    if (actual.hashes?.[key] !== expected.hashes[key]) {
      findings.push(`MG-SH3C-APPROVAL-HASH-MISMATCH:${actual.scenarioId}:${key}`);
    }
  }
  for (const key of ["java", "rust"]) {
    if (actual.hashes?.seed?.[key] !== expected.hashes.seed[key]) {
      findings.push(`MG-SH3C-APPROVAL-HASH-MISMATCH:${actual.scenarioId}:seed:${key}`);
    }
  }
  for (const collector of COLLECTORS) {
    if (actual.hashes?.collectors?.[collector] !== expected.hashes.collectors[collector]) {
      findings.push(`MG-SH3C-APPROVAL-HASH-MISMATCH:${actual.scenarioId}:collector:${collector}`);
    }
  }
  return findings;
}

function buildApprovalRecord(intake, expectedTemplate) {
  const value = {
    schemaVersion: 1,
    protocol: RECORD_PROTOCOL,
    status: "approved-pending-static-promotion",
    realEvidenceEligible: false,
    projectId: intake.projectId,
    projectHash: intake.projectHash,
    runtimeContractHash: intake.runtimeContractHash,
    promotionWave: intake.promotionWave,
    sourceReview: intake.sourceReview,
    reviewer: intake.reviewer,
    authorization: intake.authorization,
    resourceScopes: intake.resourceScopes,
    faultControls: intake.faultControls,
    approvedScenarios: intake.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      decision: scenario.decision,
      semanticConfirmation: scenario.semanticConfirmation,
      hashes: scenario.hashes,
      paths: scenario.paths,
      resourceScopeRefs: scenario.resourceScopeRefs,
      faultControlRef: scenario.faultControlRef,
    })),
    summary: {
      scenarioCount: expectedTemplate.scenarioOrder.length,
      approvedScenarioCount: intake.scenarios.filter((item) =>
        item.decision === "approved").length,
      faultScenarioCount: Object.keys(expectedTemplate.faultControls).length,
      expiresAt: intake.authorization.expiresAt,
    },
    intakeHash: stableHash(intake),
    approvalRecordHash: "",
  };
  value.approvalRecordHash = recordHash(value);
  return value;
}

function validateApprovalRecord(value, expectedTemplate) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== RECORD_PROTOCOL
    || value?.status !== "approved-pending-static-promotion"
    || value?.realEvidenceEligible !== false
    || value?.promotionWave !== expectedTemplate.promotionWave
    || value.summary?.approvedScenarioCount !== expectedTemplate.scenarioOrder.length
  ) {
    findings.push("MG-SH3C-APPROVAL-RECORD-PROTOCOL-INVALID");
  }
  if (value?.approvalRecordHash !== recordHash(value)) {
    findings.push("MG-SH3C-APPROVAL-RECORD-HASH-MISMATCH");
  }
  return findings;
}

function selfTestApprovalIntake(template) {
  const findings = validateTemplate(template);
  const complete = completeSelfTestIntake(template);
  findings.push(...validateApprovalIntake(complete, template));
  const record = buildApprovalRecord(complete, template);
  findings.push(...validateApprovalRecord(record, template));

  const tamperedHash = structuredClone(complete);
  tamperedHash.scenarios[0].hashes.seed.java =
    "0000000000000000000000000000000000000000000000000000000000000000";
  if (!validateApprovalIntake(tamperedHash, template).some((finding) =>
    finding.includes("HASH-MISMATCH"))) {
    findings.push("MG-SH3C-APPROVAL-SELF-TEST-HASH-TAMPER-NOT-REJECTED");
  }

  const expired = structuredClone(complete);
  expired.authorization.approvedAt = "2026-01-01T00:00:00.000Z";
  expired.authorization.expiresAt = "2026-01-01T01:00:00.000Z";
  if (!validateApprovalIntake(expired, template).includes(
    "MG-SH3C-APPROVAL-WINDOW-EXPIRED"
  )) {
    findings.push("MG-SH3C-APPROVAL-SELF-TEST-EXPIRED-NOT-REJECTED");
  }

  const missingFault = structuredClone(complete);
  delete missingFault.faultControls["transaction-failure"].target.controlUrl;
  if (!validateApprovalIntake(missingFault, template).some((finding) =>
    finding.includes("FAULT-ENDPOINT-INVALID:transaction-failure:target"))) {
    findings.push("MG-SH3C-APPROVAL-SELF-TEST-FAULT-ENDPOINT-NOT-REJECTED");
  }

  return uniqueFindings(findings);
}

function completeSelfTestIntake(template) {
  const now = Date.now();
  const approvedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const value = structuredClone(template);
  value.status = "approved";
  value.reviewer = {
    identity: "l4c-self-test-reviewer",
    confirmedAt: approvedAt,
    reviewTicket: "L4C-SH3C-SELF-TEST",
    confirmationBasis: [
      "seed-semantics",
      "collector-semantics",
      "binding-resource-scope",
      "fault-control-endpoints",
    ],
    notes: "self-test completed intake",
  };
  value.authorization = {
    mode: "disposable-test-write",
    approvedBy: "l4c-self-test-reviewer",
    ticket: "L4C-SH3C-SELF-TEST",
    approvedAt,
    expiresAt,
    scope: {
      projectId: template.projectId,
      promotionWave: template.promotionWave,
      scenarioIds: template.scenarioOrder,
      targets: ["source", "target"],
      operations: ["seed", "replay", "collect", "fault-control", "cleanup"],
    },
  };
  value.resourceScopes = {
    database: {
      status: "approved",
      host: "127.0.0.1",
      database: "l4c_disposable",
      tables: ["cust_table7001"],
      markerField: "mg_l4c_marker",
      markerPrefix: "mg-l4c-self-test-",
      rowLimitPerScenario: 20,
      cleanupMethod: "marker-bound-delete-and-verify-zero",
      cleanupEvidence: "before-after-count-zero",
    },
    redis: {
      status: "approved",
      endpoint: "127.0.0.1:6379",
      keyPrefixes: ["mg:l4c:self-test:"],
      keyTypes: ["string", "hash"],
      cleanupMethod: "marker-bound-delete-and-verify-zero",
      cleanupEvidence: "before-after-count-zero",
      notApplicableReason: "not-applicable-only-when-status-is-not-applicable",
    },
    websocket: {
      status: "approved",
      endpoint: "ws://127.0.0.1:8080/ws/zboss",
      subscription: "panel-data-update marker scoped subscription",
      terminalStatuses: ["success", "failed", "partial-failed"],
      noEventWindowMs: 1000,
      cleanupMethod: "subscription-close-and-marker-window-drain",
    },
  };
  for (const [scenarioId, control] of Object.entries(value.faultControls)) {
    control.status = "approved";
    control.source = approvedFaultEndpoint(
      `http://127.0.0.1:18080/l4c/source/fault/${scenarioId}`,
    );
    control.target = approvedFaultEndpoint(
      `http://127.0.0.1:18081/l4c/target/fault/${scenarioId}`,
    );
    control.cleanupMethod = "fault-apply-active-revert-inactive";
    control.cleanupEvidence = "fault-artifacts-zero-after-cleanup";
  }
  value.scenarios = value.scenarios.map((scenario) => ({
    ...scenario,
    decision: "approved",
    semanticConfirmation: {
      javaSeed: "approved",
      rustSeed: "approved",
      collectors: Object.fromEntries(COLLECTORS.map((collector) => [
        collector,
        "approved",
      ])),
      binding: "approved",
      resourceScope: "approved",
      faultEndpoint: FAULT_SCENARIOS.has(scenario.scenarioId)
        ? "approved"
        : "not-applicable",
    },
  }));
  value.summary = {
    scenarioCount: value.scenarios.length,
    faultScenarioCount: Object.keys(value.faultControls).length,
    pendingDecisionCount: 0,
    approvedDecisionCount: value.scenarios.length,
  };
  return value;
}

function approvedFaultEndpoint(controlUrl) {
  return {
    controlUrl,
    approvedHosts: ["127.0.0.1"],
    restoreRequired: true,
    cleanupMethod: "fault-apply-active-revert-inactive",
    cleanupEvidence: "fault-artifacts-zero-after-cleanup",
  };
}

function validateSourceReview(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== REVIEW_PROTOCOL
    || value?.status !== "pending-human-review"
    || value?.realEvidenceEligible !== false
    || value?.promotionWave !== "sh3c-remaining-wave"
    || value?.summary?.scenarioCount !== 14
    || value?.summary?.hashVerifiedScenarioCount !== 14
    || value?.summary?.approvedCount !== 0
    || !Array.isArray(value?.scenarios)
    || value.scenarios.length !== 14
  ) {
    findings.push("MG-SH3C-APPROVAL-SOURCE-REVIEW-INVALID");
  }
  for (const scenario of value?.scenarios ?? []) {
    if (scenario.hashStatus !== "pass" || scenario.humanDecision !== "pending") {
      findings.push(`MG-SH3C-APPROVAL-SOURCE-REVIEW-SCENARIO-INVALID:${scenario.scenarioId}`);
    }
  }
  if (value?.reportHash !== reportHash(value)) {
    findings.push("MG-SH3C-APPROVAL-SOURCE-REVIEW-HASH-MISMATCH");
  }
  return uniqueFindings(findings);
}

function validateFaultMatrix(value, review) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== MATRIX_PROTOCOL
    || value?.status !== "review-required"
    || value?.promotionWave !== review.promotionWave
    || value?.summary?.scenarioCount !== review.scenarioOrder.length
    || value?.summary?.faultScenarioCount !== FAULT_SCENARIOS.size
    || value?.summary?.boundFaultMechanismCount !== 0
  ) {
    findings.push("MG-SH3C-APPROVAL-FAULT-MATRIX-INVALID");
  }
  if (!sameArray(value?.scenarios?.map((item) => item.scenarioId), review.scenarioOrder)) {
    findings.push("MG-SH3C-APPROVAL-FAULT-MATRIX-SCENARIO-MISMATCH");
  }
  for (const item of value?.scenarios ?? []) {
    const fault = FAULT_SCENARIOS.has(item.scenarioId);
    if (fault && (
      item.mechanism?.id === "none"
      || item.mechanism?.status !== "not-bound"
      || item.mechanism?.implementation?.status !== "implemented-unbound"
    )) {
      findings.push(`MG-SH3C-APPROVAL-FAULT-MATRIX-FAULT-INVALID:${item.scenarioId}`);
    }
    if (!fault && item.mechanism?.id !== "none") {
      findings.push(`MG-SH3C-APPROVAL-FAULT-MATRIX-NONFAULT-INVALID:${item.scenarioId}`);
    }
  }
  if (value?.matrixHash !== matrixHash(value)) {
    findings.push("MG-SH3C-APPROVAL-FAULT-MATRIX-HASH-MISMATCH");
  }
  return uniqueFindings(findings);
}

function faultControlTemplate(matrixScenario) {
  return {
    status: "review-required",
    scenarioId: matrixScenario.scenarioId,
    mechanismId: matrixScenario.mechanism.id,
    controller: matrixScenario.mechanism.implementation.controller,
    source: {
      controlUrl: "<source-fault-control-url>",
      approvedHosts: ["<source-fault-host>"],
      restoreRequired: true,
      cleanupMethod: "fault-apply-active-revert-inactive",
      cleanupEvidence: "fault-artifacts-zero-after-cleanup",
    },
    target: {
      controlUrl: "<target-fault-control-url>",
      approvedHosts: ["<target-fault-host>"],
      restoreRequired: true,
      cleanupMethod: "fault-apply-active-revert-inactive",
      cleanupEvidence: "fault-artifacts-zero-after-cleanup",
    },
    cleanupMethod: "fault-apply-active-revert-inactive",
    cleanupEvidence: "fault-artifacts-zero-after-cleanup",
  };
}

function scenarioHashes(scenario) {
  return {
    sourceDraft: scenario.hashChecks.sourceDraft.actual,
    component: scenario.hashChecks.component.actual,
    package: scenario.hashChecks.package.actual,
    binding: scenario.hashChecks.binding.actual,
    seed: {
      java: scenario.hashChecks.javaSeed.actual,
      rust: scenario.hashChecks.rustSeed.actual,
    },
    collectors: Object.fromEntries(COLLECTORS.map((collector) => [
      collector,
      scenario.hashChecks[`collector:${collector}`].actual,
    ])),
  };
}

function placeholderFindings(value, current = "$") {
  if (value && typeof value === "object" && value.status === "not-applicable") {
    return [];
  }
  if (typeof value === "string") {
    return /<[^>]+>/.test(value)
      ? [`MG-SH3C-APPROVAL-PLACEHOLDER-UNRESOLVED:${current}`]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      placeholderFindings(item, `${current}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      placeholderFindings(item, `${current}.${key}`));
  }
  return [];
}

function filledString(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && !/<[^>]+>/.test(value)
    && value !== "pending"
    && value !== "review-required";
}

function safeScopeString(value) {
  return filledString(value)
    && !/[\\*;]/.test(value)
    && !/\.\./.test(value);
}

function validTime(value) {
  return Number.isFinite(parseTime(value));
}

function parseTime(value) {
  if (typeof value !== "string" || /<[^>]+>/.test(value)) return NaN;
  return Date.parse(value);
}

function validUrl(value, protocols) {
  return Boolean(parseUrl(value, protocols));
}

function parseUrl(value, protocols) {
  if (!filledString(value)) return undefined;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function parseArgs(argv) {
  const value = { mode: "check-template" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-template") value.mode = "write-template";
    else if (arg === "--write-draft") value.mode = "write-draft";
    else if (arg === "--check-template") value.mode = "check-template";
    else if (arg === "--check") value.mode = "check-intake";
    else if (arg === "--write-record") value.mode = "write-record";
    else if (arg === "--self-test") value.mode = "self-test";
    else if (arg === "--intake") {
      index += 1;
      value.intake = requiredArg(argv[index], arg);
    } else if (arg === "--record") {
      index += 1;
      value.record = requiredArg(argv[index], arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return value;
}

function requiredArg(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function approvalPath(candidate, fallback) {
  if (!candidate) return fallback;
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(repositoryRoot, candidate);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("approval intake path escapes repository root");
  }
  return resolved;
}

function templateHash(value) {
  return stableHash({ ...value, templateHash: undefined });
}

function reportHash(value) {
  return stableHash({ ...value, reportHash: undefined });
}

function matrixHash(value) {
  return stableHash({ ...value, matrixHash: undefined });
}

function recordHash(value) {
  return stableHash({ ...value, approvalRecordHash: undefined });
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function uniqueFindings(findings) {
  return [...new Set(findings)].sort();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfPresent(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relativeCasePath(file) {
  const relative = path.relative(caseDirectory, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("approval intake source path escapes case directory");
  }
  return relative.replaceAll("\\", "/");
}

function summary(value, status) {
  return {
    status,
    stage: "SH-3C-remaining-wave-approval-intake",
    scenarioCount: value.summary.scenarioCount,
    faultScenarioCount: value.summary.faultScenarioCount,
    approvedDecisionCount: value.summary.approvedDecisionCount,
    templatePath: path.relative(repositoryRoot, templatePath),
  };
}
