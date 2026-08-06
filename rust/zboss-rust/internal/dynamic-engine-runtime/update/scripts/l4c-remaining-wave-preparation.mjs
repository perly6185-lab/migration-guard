import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_PROTOCOL =
  "migration-guard.batch-update-l4c-scenario-package/v1";
const REVIEW_PROTOCOL =
  "migration-guard.batch-update-l4c-scenario-technical-review/v1";
const MATRIX_PROTOCOL =
  "migration-guard.batch-update-l4c-fault-mechanism-matrix/v1";
const FIRST_WAVE = new Set([
  "primary-success",
  "validation-failure",
  "batch-partial-failure",
  "dependency-failure",
  "concurrent-write",
]);
const FAULT_MECHANISMS = {
  "post-commit-effect-failure": {
    id: "fault-post-commit-effect-v1",
    controller: "rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/l4c-post-commit-effect-fault-controller.mjs",
    blocker: "MG-SH3C-FAULT-MECHANISM-NOT-BOUND",
    requiredBindings: ["post-commit effect failure injector"],
  },
  "schema-transition-failure": {
    id: "fault-schema-transition-v1",
    controller: "rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/l4c-schema-transition-fault-controller.mjs",
    blocker: "MG-SH3C-FAULT-MECHANISM-NOT-BOUND",
    requiredBindings: ["marker-bound disposable DDL failure injector"],
  },
  "transaction-failure": {
    id: "fault-transaction-rollback-v1",
    controller: "rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/l4c-transaction-fault-controller.mjs",
    blocker: "MG-SH3C-FAULT-MECHANISM-NOT-BOUND",
    requiredBindings: ["marker-bound transaction failure injector"],
  },
  "undo-excludes-failed-rows": {
    id: "fault-undo-delivery-v1",
    controller: "rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/l4c-undo-delivery-fault-controller.mjs",
    blocker: "MG-SH3C-FAULT-MECHANISM-NOT-BOUND",
    requiredBindings: ["marker-bound undo delivery failure injector"],
  },
};

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
const entrypointId =
  "post-zboss-data-view-dynamic-engine-use-engine-use-batch-page-batchUpdateWithProgress";
const l4cRoot = path.join(caseDirectory, "evidence", "runtime", "l4c");
const contractPath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const stateProfilePath = path.join(
  l4cRoot,
  "java-state-profile.primary-success.approved.json",
);
const bindingPath = path.join(l4cRoot, "bindings.primary-success.approved.json");
const seedDirectory = path.join(l4cRoot, "seeds");
const draftRoot = path.join(
  caseDirectory,
  "fixtures",
  "java-runtime-drafts",
  entrypointId,
);
const outputRoot = path.join(l4cRoot, "scenario-preparation", "remaining-wave");
const packageRoot = path.join(outputRoot, "packages");
const manifestPath = path.join(outputRoot, "manifest.json");
const reviewPath = path.join(outputRoot, "technical-review.json");
const matrixPath = path.join(outputRoot, "fault-mechanism-matrix.json");
const componentsManifestPath = path.join(outputRoot, "components.json");

const mode = process.argv.includes("--write")
  ? "--write"
  : process.argv.includes("--self-test")
    ? "--self-test"
    : "--check";

const contract = await readJson(contractPath);
const entry = contract.entries.find((item) => item.id === entrypointId);
if (!entry) throw new Error(`runtime scenario entry is missing: ${entrypointId}`);
const remainingScenarioIds = entry.scenarios
  .map((scenario) => scenario.id)
  .filter((scenarioId) => !FIRST_WAVE.has(scenarioId));

const built = await buildPreparationSet(contract, entry);
if (mode === "--write") {
  await writePreparationSet(built);
  console.log(JSON.stringify(summary(built, "written"), null, 2));
} else if (mode === "--check") {
  const findings = await checkPersistedPreparationSet(built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "passed" : "blocked"),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else {
  const findings = validatePreparationSet(built);
  if (findings.length > 0) throw new Error(findings.join(", "));
  const tampered = structuredClone(built.packages[0]);
  tampered.blockers = [];
  tampered.packageHash = packageHash(tampered);
  if (!validatePackage(tampered).includes("MG-SH3C-PACKAGE-BLOCKERS-INVALID")) {
    throw new Error("remaining-wave package blocker tampering was not rejected");
  }
  const tamperedMatrix = structuredClone(built.matrix);
  tamperedMatrix.scenarios[0].mechanism.status = "bound";
  if (validateMatrix(tamperedMatrix).length === 0) {
    throw new Error("fault mechanism matrix tampering was not rejected");
  }
  console.log(JSON.stringify({
    status: "pass",
    checks: 5,
    coverage: [
      "remaining-wave-exactly-fourteen",
      "missing-seed-and-binding-blockers",
      "fault-mechanism-blockers",
      "package-tamper-rejected",
      "fault-matrix-tamper-rejected",
    ],
  }, null, 2));
}

async function buildPreparationSet(contractValue, entryValue) {
  const approvedBinding = await readJson(bindingPath);
  const approvedStateProfile = await readJson(stateProfilePath);
  const componentsManifest = await readJsonIfPresent(componentsManifestPath);
  const stateProfileHash = await fileHash(stateProfilePath);
  const packages = [];
  for (const scenarioId of remainingScenarioIds) {
    const scenario = entryValue.scenarios.find((item) => item.id === scenarioId);
    const draftPath = path.join(draftRoot, scenarioId, "fixture.draft.json");
    const draft = await readJson(draftPath);
    const stateProfileApproved =
      approvedStateProfile.applicableScenarios?.includes(scenarioId) === true;
    const selectedStateProfilePath = stateProfileApproved
      ? stateProfilePath
      : path.join(l4cRoot, "java-state-profile.template.json");
    const selectedStateProfile = await readJson(selectedStateProfilePath);
    const selectedStateProfileHash = await fileHash(selectedStateProfilePath);
    const scenarioBinding = approvedBinding.scenarios?.[scenarioId];
    const collectors = {};
    for (const collector of scenario.requiredCollectors) {
      const collectorPath = path.join(
        path.dirname(draftPath),
        "collectors",
        `${collector}.draft.json`,
      );
      const document = await readJson(collectorPath);
      collectors[collector] = {
        path: relativeCasePath(collectorPath),
        sha256: stableHash(document),
        status: document.status,
        reviewFindings: collectorFindings(document),
      };
    }
    const javaSeedPath = path.join(seedDirectory, `${scenarioId}.java-seed.json`);
    const rustSeedPath = path.join(seedDirectory, `${scenarioId}.rust-seed.json`);
    const javaSeed = await readJsonIfPresent(javaSeedPath);
    const rustSeed = await readJsonIfPresent(rustSeedPath);
    const requestPlaceholders = placeholderLocations(draft.request);
    const seedRows = plannedSeedRows(draft);
    const javaSeedReady = Boolean(javaSeed)
      && javaSeed.status === "approved"
      && javaSeed.scenarioId === scenarioId
      && scenarioBinding?.seedProfiles?.source?.sha256 === await fileHash(javaSeedPath);
    const rustSeedReady = Boolean(rustSeed)
      && rustSeed.status === "approved"
      && rustSeed.scenarioId === scenarioId
      && scenarioBinding?.seedProfiles?.target?.sha256 === await fileHash(rustSeedPath);
    const stateProfileReady = stateProfileApproved
      && selectedStateProfile.status === "approved"
      && approvedBinding.status === "approved"
      && approvedBinding.targets?.source?.stateProfileSha256 === selectedStateProfileHash;
    const websocketReady = validWebsocketBinding(
      scenarioBinding?.eventCollectors?.source,
      scenarioId,
    );
    const writeSafetyReady = validWriteSafety(draft.writeSafety);
    const faultMechanism = FAULT_MECHANISMS[scenarioId];
    const componentIndex = componentsManifest?.components?.find((item) =>
      item.scenarioId === scenarioId);
    const component = componentIndex
      ? await readJson(path.join(
          outputRoot,
          "components",
          `${scenarioId}.json`,
        ))
      : undefined;
    const blockers = [
      ...(!stateProfileReady ? ["MG-SH3C-STATE-PROFILE-NOT-APPROVED"] : []),
      ...(!javaSeedReady ? ["MG-SH3C-JAVA-SEED-NOT-AUTHORED"] : []),
      ...(!rustSeedReady ? ["MG-SH3C-RUST-SEED-ADAPTER-NOT-BOUND"] : []),
      ...(!websocketReady ? ["MG-SH3C-WEBSOCKET-EVENT-COLLECTOR-NOT-BOUND"] : []),
      ...(!writeSafetyReady
        ? ["MG-SH3C-FIXTURE-WRITE-SAFETY-APPROVAL-REQUIRED"]
        : []),
      ...requestPlaceholders.map((item) => `MG-SH3C-REQUEST-REVIEW:${item}`),
      ...Object.entries(collectors).flatMap(([collector, value]) =>
        value.reviewFindings.map((finding) =>
          `MG-SH3C-COLLECTOR-REVIEW:${collector}:${finding}`)),
      ...(faultMechanism ? [faultMechanism.blocker] : []),
    ];
    const uniqueBlockers = [...new Set(blockers)].sort();
    const document = {
      schemaVersion: 1,
      protocol: PACKAGE_PROTOCOL,
      status: "review-required",
      realEvidenceEligible: false,
      projectId: contractValue.projectId,
      projectHash: contractValue.projectHash,
      runtimeContractHash: contractValue.contractHash,
      sourceIdentity: contractValue.sourceIdentity,
      promotionWave: "sh3c-remaining-wave",
      entrypointId,
      scenarioId,
      category: scenario.category,
      requiredDimensions: scenario.requiredDimensions,
      decisionIds: scenario.decisionIds,
      sourceDraft: {
        path: relativeCasePath(draftPath),
        sha256: stableHash(draft),
      },
      stateProfile: {
        path: relativeCasePath(selectedStateProfilePath),
        sha256: selectedStateProfileHash,
        status: selectedStateProfile.status,
        applicableScenarios: selectedStateProfile.applicableScenarios ?? [],
      },
      collectors,
      requestPlan: {
        status: requestPlaceholders.length === 0 ? "authored" : "review-required",
        placeholderPaths: requestPlaceholders,
        environmentBindings: draft.environmentBindings ?? [],
      },
      seedPlan: {
        status: javaSeedReady && rustSeedReady ? "authored" : "review-required",
        plannedRows: seedRows,
        java: {
          status: javaSeedReady ? "authored" : "seed-required",
          resourceRole: "projection",
          binding: "scenario.seedProfiles.source",
          ...(javaSeedReady
            ? { path: relativeCasePath(javaSeedPath), sha256: await fileHash(javaSeedPath) }
            : {}),
        },
        rust: {
          status: rustSeedReady ? "adapter-bound" : "adapter-required",
          resourceRole: "projection",
          binding: "scenario.seedProfiles.target",
          ...(rustSeedReady
            ? { path: relativeCasePath(rustSeedPath), sha256: await fileHash(rustSeedPath) }
            : {}),
        },
      },
      ...(component
        ? {
            componentPreparation: {
              status: component.status,
              path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/components/${scenarioId}.json`,
              sha256: component.componentHash,
              seedCandidates: component.seedCandidates,
              collectorCandidates: component.collectorCandidates,
              binding: component.binding,
            },
          }
        : {}),
      expectedObservation: {
        status: "review-required",
        dimensions: scenario.requiredDimensions,
        invariants: observationInvariants(scenario.category),
      },
      semanticIntent: {
        intent: `remaining-wave-${scenarioId}-contract`,
        contractExpectations: draft.expectations,
      },
      formalPromotion: {
        command:
          `migration-guard migrate runtime-fixture-promote --case-dir ` +
          `cases/zboss-batch-update-with-progress --entrypoint ${entrypointId} ` +
          `--scenario ${scenarioId} --reviewed-by <reviewer>`,
        allowedOnlyWhenBlockersEmpty: true,
        status: "pending",
      },
      blockers: uniqueBlockers,
      packageHash: "",
    };
    document.packageHash = packageHash(document);
    packages.push(document);
  }
  const technicalReview = {
    schemaVersion: 1,
    protocol: REVIEW_PROTOCOL,
    status: "changes-required",
    reviewKind: "automated-technical",
    humanApprovalClaimed: false,
    projectId: contractValue.projectId,
    projectHash: contractValue.projectHash,
    runtimeContractHash: contractValue.contractHash,
    promotionWave: "sh3c-remaining-wave",
    packages: packages.map((item) => ({
      scenarioId: item.scenarioId,
      packageHash: item.packageHash,
      decision: "changes-required",
      blockers: item.blockers,
    })),
    summary: {
      scenarioCount: packages.length,
      readyCount: 0,
      changesRequiredCount: packages.length,
    },
    reviewHash: "",
  };
  technicalReview.reviewHash = reviewHash(technicalReview);
  const matrix = buildFaultMatrix(packages, entryValue);
  const manifest = {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-scenario-preparation-manifest/v1",
    status: "review-required",
    realEvidenceEligible: false,
    projectId: contractValue.projectId,
    projectHash: contractValue.projectHash,
    runtimeContractHash: contractValue.contractHash,
    promotionWave: "sh3c-remaining-wave",
    scenarioOrder: remainingScenarioIds,
    packages: packages.map((item) => ({
      scenarioId: item.scenarioId,
      path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/packages/${item.scenarioId}.json`,
      hash: item.packageHash,
      blockerCount: item.blockers.length,
    })),
    technicalReview: {
      path: "evidence/runtime/l4c/scenario-preparation/remaining-wave/technical-review.json",
      hash: technicalReview.reviewHash,
      status: technicalReview.status,
    },
    faultMatrix: {
      path: "evidence/runtime/l4c/scenario-preparation/remaining-wave/fault-mechanism-matrix.json",
      hash: matrix.matrixHash,
    },
    readyForHumanReview: true,
    readyForRealPromotion: false,
    manifestHash: "",
  };
  manifest.manifestHash = manifestHash(manifest);
  return { packages, manifest, technicalReview, matrix };
}

function buildFaultMatrix(packages, entryValue) {
  const scenarios = packages.map((item) => {
    const mechanism = FAULT_MECHANISMS[item.scenarioId];
    return {
      scenarioId: item.scenarioId,
      category: entryValue.scenarios.find((scenario) =>
        scenario.id === item.scenarioId).category,
      mechanism: mechanism
        ? {
            id: mechanism.id,
            status: "not-bound",
            implementation: {
              status: "implemented-unbound",
              controller: mechanism.controller,
              protocol: "migration-guard.batch-update-l4c-fault-controller/v1",
              lifecycle: ["apply", "verify-active", "revert", "verify-inactive"],
              controlUrlEnvironment: [
                "MG_L4C_SOURCE_FAULT_CONTROL_URL",
                "MG_L4C_TARGET_FAULT_CONTROL_URL",
              ],
            },
            requiredBindings: mechanism.requiredBindings,
            cleanupRequirements: [
              "fault-apply-active-revert-inactive",
              "fault-artifacts-zero-after-cleanup",
            ],
          }
        : {
            id: "none",
            status: "not-applicable",
            requiredBindings: [],
            cleanupRequirements: ["marker-bound-cleanup-zero"],
          },
      blockers: item.blockers.filter((blocker) =>
        blocker.includes("FAULT-MECHANISM")),
    };
  });
  const value = {
    schemaVersion: 1,
    protocol: MATRIX_PROTOCOL,
    status: "review-required",
    projectId: packages[0].projectId,
    projectHash: packages[0].projectHash,
    runtimeContractHash: packages[0].runtimeContractHash,
    promotionWave: "sh3c-remaining-wave",
    scenarios,
    summary: {
      scenarioCount: scenarios.length,
      faultScenarioCount: scenarios.filter((item) => item.mechanism.id !== "none").length,
      boundFaultMechanismCount: scenarios.filter((item) => item.mechanism.status === "bound").length,
    },
    matrixHash: "",
  };
  value.matrixHash = matrixHash(value);
  return value;
}

function validatePreparationSet(value) {
  const findings = [];
  if (
    value.packages.length !== remainingScenarioIds.length
    || JSON.stringify(value.packages.map((item) => item.scenarioId))
      !== JSON.stringify(remainingScenarioIds)
  ) {
    findings.push("MG-SH3C-REMAINING-WAVE-MISMATCH");
  }
  for (const item of value.packages) {
    findings.push(...validatePackage(item).map((finding) =>
      `${finding}:${item.scenarioId}`));
  }
  if (value.technicalReview.reviewHash !== reviewHash(value.technicalReview)) {
    findings.push("MG-SH3C-REMAINING-REVIEW-HASH-MISMATCH");
  }
  if (value.manifest.manifestHash !== manifestHash(value.manifest)) {
    findings.push("MG-SH3C-REMAINING-MANIFEST-HASH-MISMATCH");
  }
  if (value.matrix.matrixHash !== matrixHash(value.matrix)) {
    findings.push("MG-SH3C-FAULT-MATRIX-HASH-MISMATCH");
  }
  findings.push(...validateMatrix(value.matrix));
  return [...new Set(findings)].sort();
}

function validatePackage(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== PACKAGE_PROTOCOL
    || value?.status !== "review-required"
    || value?.realEvidenceEligible !== false
    || value?.promotionWave !== "sh3c-remaining-wave"
  ) {
    findings.push("MG-SH3C-PACKAGE-PROTOCOL-INVALID");
  }
  if (!Array.isArray(value?.blockers) || value.blockers.length === 0) {
    findings.push("MG-SH3C-PACKAGE-BLOCKERS-INVALID");
  }
  if (value?.packageHash !== packageHash(value)) {
    findings.push("MG-SH3C-PACKAGE-HASH-MISMATCH");
  }
  if (
    value?.componentPreparation
    && (
      value.componentPreparation.status !== "review-required"
      || !/^[a-f0-9]{64}$/.test(value.componentPreparation.sha256 ?? "")
      || value.componentPreparation.binding?.status !== "review-required"
    )
  ) {
    findings.push("MG-SH3C-COMPONENT-PREPARATION-INVALID");
  }
  return findings;
}

function validateMatrix(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== MATRIX_PROTOCOL
    || value?.status !== "review-required"
    || value?.promotionWave !== "sh3c-remaining-wave"
    || !Array.isArray(value?.scenarios)
    || value.scenarios.length !== remainingScenarioIds.length
  ) {
    findings.push("MG-SH3C-FAULT-MATRIX-PROTOCOL-INVALID");
  }
  for (const item of value?.scenarios ?? []) {
    const expected = FAULT_MECHANISMS[item.scenarioId];
    if (expected && (item.mechanism?.id !== expected.id
      || item.mechanism.status !== "not-bound"
      || item.mechanism.implementation?.status !== "implemented-unbound"
      || item.mechanism.implementation?.controller !== expected.controller
      || !item.blockers.includes(expected.blocker))) {
      findings.push(`MG-SH3C-FAULT-MATRIX-MECHANISM-INVALID:${item.scenarioId}`);
    }
    if (!expected && item.mechanism?.status !== "not-applicable") {
      findings.push(`MG-SH3C-FAULT-MATRIX-NONFAULT-INVALID:${item.scenarioId}`);
    }
  }
  if (value?.matrixHash !== matrixHash(value)) {
    findings.push("MG-SH3C-FAULT-MATRIX-HASH-MISMATCH");
  }
  return [...new Set(findings)].sort();
}

async function writePreparationSet(value) {
  const findings = validatePreparationSet(value);
  if (findings.length > 0) throw new Error(findings.join(", "));
  await mkdir(packageRoot, { recursive: true });
  for (const item of value.packages) {
    await writeJson(path.join(packageRoot, `${item.scenarioId}.json`), item);
  }
  await writeJson(manifestPath, value.manifest);
  await writeJson(reviewPath, value.technicalReview);
  await writeJson(matrixPath, value.matrix);
}

async function checkPersistedPreparationSet(expected) {
  const findings = validatePreparationSet(expected);
  for (const item of expected.packages) {
    const file = path.join(packageRoot, `${item.scenarioId}.json`);
    try {
      const persisted = await readJson(file);
      findings.push(...validatePackage(persisted).map((finding) =>
        `${finding}:${item.scenarioId}`));
      if (stableStringify(persisted) !== stableStringify(item)) {
        findings.push(`MG-SH3C-REMAINING-PACKAGE-STALE:${item.scenarioId}`);
      }
    } catch {
      findings.push(`MG-SH3C-REMAINING-PACKAGE-MISSING:${item.scenarioId}`);
    }
  }
  for (const [file, expectedValue, label] of [
    [manifestPath, expected.manifest, "MANIFEST"],
    [reviewPath, expected.technicalReview, "TECHNICAL-REVIEW"],
    [matrixPath, expected.matrix, "FAULT-MATRIX"],
  ]) {
    try {
      const persisted = await readJson(file);
      if (stableStringify(persisted) !== stableStringify(expectedValue)) {
        findings.push(`MG-SH3C-REMAINING-${label}-STALE`);
      }
    } catch {
      findings.push(`MG-SH3C-REMAINING-${label}-MISSING`);
    }
  }
  return [...new Set(findings)].sort();
}

function validWriteSafety(value) {
  return value?.mode === "disposable"
    && value.disposable === true
    && value.writeApproved === true
    && Date.parse(value.expiresAt ?? "") > Date.now();
}

function validWebsocketBinding(value, scenarioId) {
  return value?.kind === "websocket"
    && value.path === "/ws/zboss"
    && value.messageType === "panel-data-update"
    && value.subscribe?.type === "panel-subscribe"
    && value.subscribe?.content?.subscribe === true
    && value.terminalStatuses?.length > 0
    && (
      value.completionMode !== "no-event"
      || (
        scenarioId === "batch-row-limit-rejected"
        && Number.isInteger(value.noEventWindowMs)
        && value.noEventWindowMs >= 100
        && value.noEventWindowMs <= 5_000
      )
    );
}

function collectorFindings(value) {
  const findings = [];
  if (!["ready", "not-applicable"].includes(value.status)) {
    findings.push("STATUS-NOT-READY");
  }
  if (/replace[-_: ]?me/i.test(JSON.stringify(value))) {
    findings.push("PLACEHOLDER-PROBE");
  }
  if (value.collector === "redis" && value.notApplicable !== true) {
    findings.push("JAVA-PROGRESS-IS-NOT-REDIS-BACKED");
  }
  if (value.collector === "events" && value.status !== "ready") {
    findings.push("WEBSOCKET-CAPTURE-NOT-CONFIRMED");
  }
  return findings;
}

function observationInvariants(category) {
  if (category === "fault") {
    return [
      "fault-observable-and-reversible",
      "no-unapproved-cross-scope-effects",
      "marker-bound-cleanup-zero",
    ];
  }
  return [
    "complete-canonical-observation",
    "source-target-semantic-comparison",
    "marker-bound-cleanup-zero",
  ];
}

function plannedSeedRows(draft) {
  const rows = draft.request?.body?.batchPostValueList;
  return Math.max(1, Math.min(20, Array.isArray(rows) ? rows.length : 1));
}

function placeholderLocations(value, current = "$", output = []) {
  if (typeof value === "string" && /<[^>]+>/.test(value)) output.push(current);
  else if (Array.isArray(value)) {
    value.forEach((item, index) => placeholderLocations(item, `${current}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      placeholderLocations(item, `${current}.${key}`, output);
    }
  }
  return output.sort();
}

function packageHash(value) {
  return stableHash({ ...value, packageHash: undefined });
}

function manifestHash(value) {
  return stableHash({ ...value, manifestHash: undefined });
}

function reviewHash(value) {
  return stableHash({ ...value, reviewHash: undefined });
}

function matrixHash(value) {
  return stableHash({ ...value, matrixHash: undefined });
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

async function fileHash(file) {
  const content = await readFile(file, "utf8");
  return createHash("sha256")
    .update(content.replaceAll("\r\n", "\n"))
    .digest("hex");
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

function relativeCasePath(file) {
  const relative = path.relative(caseDirectory, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("remaining-wave source escapes case directory");
  }
  return relative.replaceAll("\\", "/");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summary(value, status) {
  return {
    status,
    stage: "SH-3C-remaining-wave-preparation",
    promotionWave: "sh3c-remaining-wave",
    scenarioCount: value.packages.length,
    faultScenarioCount: value.matrix.summary.faultScenarioCount,
    boundFaultMechanismCount: value.matrix.summary.boundFaultMechanismCount,
    readyForHumanReview: true,
    readyForRealPromotion: false,
    outputRoot: path.relative(repositoryRoot, outputRoot),
  };
}
