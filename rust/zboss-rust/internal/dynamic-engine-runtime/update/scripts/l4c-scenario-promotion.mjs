import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMOTION_PROTOCOL =
  "migration-guard.batch-update-l4c-scenario-package/v1";
export const TECHNICAL_REVIEW_PROTOCOL =
  "migration-guard.batch-update-l4c-scenario-technical-review/v1";
export const FIRST_WAVE = [
  "primary-success",
  "validation-failure",
  "batch-partial-failure",
  "dependency-failure",
  "concurrent-write",
];

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
const contractPath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const stateProfileTemplatePath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "java-state-profile.template.json",
);
const primaryStateProfilePath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "java-state-profile.primary-success.approved.json",
);
const approvedBindingPath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "bindings.primary-success.approved.json",
);
const seedDirectory = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "seeds",
);
const outputDirectory = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "l4c",
  "scenario-promotion",
);
const packageDirectory = path.join(outputDirectory, "packages");
const manifestPath = path.join(outputDirectory, "manifest.json");
const technicalReviewPath = path.join(outputDirectory, "technical-review.json");

const blueprints = {
  "primary-success": {
    plannedSeedRows: 2,
    intent: "all-requested-rows-commit",
    invariants: [
      "complete-row-classification",
      "terminal-progress-after-effects",
      "undo-only-for-successful-updates",
    ],
  },
  "validation-failure": {
    plannedSeedRows: 1,
    intent: "request-is-rejected-before-write",
    invariants: [
      "zero-projection-delta",
      "zero-undo-delta",
      "no-progress-created-for-all-precheck-failures",
    ],
  },
  "batch-partial-failure": {
    plannedSeedRows: 2,
    intent: "valid-row-commits-and-invalid-row-is-rejected",
    invariants: [
      "complete-row-classification",
      "failed-row-excluded-from-undo",
      "single-source-terminal-progress-identity",
    ],
  },
  "dependency-failure": {
    plannedSeedRows: 2,
    intent: "approved-dependency-fault-is-observable-and-reversible",
    invariants: [
      "fault-apply-active-revert-inactive",
      "no-unapproved-cross-scope-effects",
      "fault-artifacts-zero-after-cleanup",
    ],
  },
  "concurrent-write": {
    plannedSeedRows: 1,
    intent: "two-writers-have-a-reviewed-deterministic-outcome",
    invariants: [
      "two-invocations-share-one-seeded-row",
      "final-projection-is-deterministic",
      "no-stale-owner-release",
    ],
  },
};

const mode = process.argv[2] ?? "--check";
const built = await buildPromotionSet();
if (mode === "--write") {
  await writePromotionSet(built);
  console.log(JSON.stringify(summary(built, "written"), null, 2));
} else if (mode === "--check") {
  const findings = await checkPersistedPromotionSet(built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "passed" : "blocked"),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else if (mode === "--self-test") {
  const findings = validatePromotionSet(built);
  if (findings.length > 0) throw new Error(findings.join(", "));
  const incompleteFirstWaveBindings = built.packages.filter((item) =>
    item.seedPlan.status !== "authored"
    || item.seedPlan.rust.status !== "adapter-bound"
    || item.expectedObservation.status !== "authored"
    || item.blockers.some((blocker) =>
      blocker.startsWith("MG-SH3C-JAVA-SEED")
      || blocker.startsWith("MG-SH3C-RUST-SEED")
      || blocker.startsWith("MG-SH3C-WEBSOCKET")
      || blocker.startsWith("MG-SH3C-COLLECTOR-REVIEW"))
  );
  if (incompleteFirstWaveBindings.length > 0) {
    throw new Error(
      `first-wave seed/event bindings are incomplete: ${
        incompleteFirstWaveBindings.map((item) => item.scenarioId).join(",")
      }`,
    );
  }
  const requestAuthoredScenarios = built.packages.filter((item) =>
    ["validation-failure", "batch-partial-failure"].includes(item.scenarioId));
  if (requestAuthoredScenarios.some((item) =>
    item.requestPlan.status !== "authored"
    || item.blockers.some((blocker) => blocker.startsWith("MG-SH3C-REQUEST-REVIEW"))
    || item.blockers.includes("MG-SH3C-EVENT-SEMANTICS-DECISION-REQUIRED")
    || item.blockers.includes("MG-SH3C-NO-EVENT-COMPLETION-NOT-SUPPORTED"))) {
    throw new Error(
      "validation and partial-failure request and event semantics must be resolved",
    );
  }
  if (built.packages.some((item) =>
    item.status !== "promoted"
    && !item.blockers.includes(
      "MG-SH3C-FIXTURE-WRITE-SAFETY-APPROVAL-REQUIRED",
    ))) {
    throw new Error("every unpromoted first-wave package must require write safety");
  }
  const eligible = structuredClone(built.packages[1]);
  eligible.realEvidenceEligible = true;
  const eligibleFindings = validatePackage(eligible);
  if (!eligibleFindings.includes("MG-SH3C-PREMATURE-REAL-ELIGIBILITY")) {
    throw new Error("premature real eligibility was not rejected");
  }
  const tampered = structuredClone(built.packages[0]);
  tampered.semanticIntent.intent = "tampered";
  if (!validatePackage(tampered).includes("MG-SH3C-PACKAGE-HASH-MISMATCH")) {
    throw new Error("package hash tampering was not rejected");
  }
  const incompleteReady = structuredClone(built.packages[1]);
  incompleteReady.status = "ready-for-review";
  incompleteReady.blockers = [];
  incompleteReady.seedPlan.status = "review-required";
  incompleteReady.packageHash = packageHash(incompleteReady);
  if (!validatePackage(incompleteReady).includes("MG-SH3C-READY-STATE-INVALID")) {
    throw new Error("incomplete package cannot be marked ready for review");
  }
  const unapprovedScenario = structuredClone(built.packages[0]);
  unapprovedScenario.stateProfile.applicableScenarios = [];
  unapprovedScenario.packageHash = packageHash(unapprovedScenario);
  if (!validatePackage(unapprovedScenario).includes(
    "MG-SH3C-STATE-PROFILE-SCENARIO-NOT-APPROVED",
  )) {
    throw new Error("state profile scenario approval was not enforced");
  }
  const tamperedReview = structuredClone(built.technicalReview);
  tamperedReview.packages[0].decision = "ready-for-human-approval";
  if (!validateTechnicalReview(tamperedReview, built.packages).includes(
    "MG-SH3C-TECHNICAL-REVIEW-HASH-MISMATCH",
  )) {
    throw new Error("technical review tampering was not rejected");
  }
  console.log(JSON.stringify({
    status: "pass",
    checks: 17,
    coverage: [
      "first-wave-exactly-five",
      "contract-scenario-binding",
      "draft-fixture-hash-binding",
      "collector-hash-binding",
      "state-profile-hash-binding",
      "request-placeholder-inventory",
      "java-seed-review-plan",
      "rust-seed-adapter-blocker",
      "websocket-collector-blocker",
      "premature-real-eligibility-rejected",
      "package-tamper-rejected",
      "incomplete-ready-state-rejected",
      "state-profile-scenario-approval-enforced",
      "first-wave-seed-and-collector-bindings",
      "validation-and-partial-event-semantics-resolved",
      "first-wave-write-safety-enforced",
      "technical-review-tamper-rejected",
    ],
  }, null, 2));
} else {
  throw new Error("usage: l4c-scenario-promotion.mjs --write|--check|--self-test");
}

export async function buildPromotionSet() {
  const contract = await readJson(contractPath);
  const approvedBinding = await readJson(approvedBindingPath);
  const approvedStateProfile = await readJson(primaryStateProfilePath);
  const entry = contract.entries.find((item) => item.id === entrypointId);
  if (!entry) throw new Error(`runtime contract entry is missing: ${entrypointId}`);
  const packages = [];
  for (const scenarioId of FIRST_WAVE) {
    const stateProfileApprovedForScenario =
      approvedStateProfile.applicableScenarios?.includes(scenarioId) === true;
    const stateProfilePath = stateProfileApprovedForScenario
      ? primaryStateProfilePath
      : stateProfileTemplatePath;
    const stateProfile = await readJson(stateProfilePath);
    const scenario = entry.scenarios.find((item) => item.id === scenarioId);
    if (!scenario) throw new Error(`runtime scenario is missing: ${scenarioId}`);
    const javaSeedPath = path.join(seedDirectory, `${scenarioId}.java-seed.json`);
    const rustSeedPath = path.join(seedDirectory, `${scenarioId}.rust-seed.json`);
    const javaSeed = await readJson(javaSeedPath);
    const rustSeed = await readJson(rustSeedPath);
    const draftPath = path.join(
      caseDirectory,
      "fixtures",
      "java-runtime-drafts",
      entrypointId,
      scenarioId,
      "fixture.draft.json",
    );
    const draft = await readJson(draftPath);
    const promotedFixturePath = path.join(
      caseDirectory,
      "fixtures",
      "java-runtime",
      entrypointId,
      `${scenarioId}.json`,
    );
    const promotedFixture = await readJsonIfPresent(promotedFixturePath);
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
        sha256: documentHash(document),
        status: document.status,
        reviewFindings: collectorFindings(document),
      };
    }
    const placeholderPaths = placeholderLocations(draft.request);
    const stateProfileFileHash = await fileHash(stateProfilePath);
    const javaSeedFileHash = await fileHash(javaSeedPath);
    const rustSeedFileHash = await fileHash(rustSeedPath);
    const scenarioBinding = approvedBinding.scenarios?.[scenarioId];
    const stateProfileReady = stateProfileApprovedForScenario
      && stateProfile.status === "approved"
      && approvedBinding.status === "approved"
      && approvedBinding.targets?.source?.stateProfileSha256
        === stateProfileFileHash;
    const javaSeedReady = javaSeed.status === "approved"
      && javaSeed.scenarioId === scenarioId
      && javaSeed.stateProfileSha256 === stateProfileFileHash
      && javaSeed.resources?.reduce(
        (count, resource) => count + (resource.rows?.length ?? 0),
        0,
      ) === blueprints[scenarioId].plannedSeedRows
      && scenarioBinding?.seedProfiles?.source?.sha256 === javaSeedFileHash;
    const rustSeedReady = rustSeed.status === "approved"
      && rustSeed.scenarioId === scenarioId
      && rustSeed.rows?.length === blueprints[scenarioId].plannedSeedRows
      && scenarioBinding?.seedProfiles?.target?.sha256 === rustSeedFileHash
      && approvedBinding.targets?.target?.hooks?.seed
        ?.requiresSeedProfileHash === true;
    const websocketBinding = scenarioBinding?.eventCollectors?.source;
    const completionMode = websocketBinding?.completionMode ?? "terminal-event";
    const websocketReady = websocketBinding?.kind === "websocket"
      && websocketBinding.path === "/ws/zboss"
      && websocketBinding.messageType === "panel-data-update"
      && websocketBinding.subscribe?.type === "panel-subscribe"
      && websocketBinding.subscribe?.content?.subscribe === true
      && websocketBinding.terminalStatuses?.length > 0
      && (
        completionMode === "terminal-event"
        || (
          completionMode === "no-event"
          && scenarioId === "validation-failure"
          && Number.isInteger(websocketBinding.noEventWindowMs)
          && websocketBinding.noEventWindowMs >= 100
          && websocketBinding.noEventWindowMs <= 5_000
        )
      );
    const writeSafetyReady = draft.writeSafety?.mode === "disposable"
      && draft.writeSafety?.disposable === true
      && draft.writeSafety?.writeApproved === true
      && Date.parse(draft.writeSafety?.expiresAt ?? "") > Date.now();
    const formallyPromoted = promotedFixture?.fixtureKind === "real-runtime"
      && promotedFixture?.status === "ready"
      && promotedFixture?.realEvidenceEligible === true
      && promotedFixture?.authoring?.reviewed === true
      && promotedFixture?.authoring?.sourceDraftHash === documentHash(draft)
      && Object.entries(collectors).every(([collector, value]) =>
        promotedFixture?.collectorSpecs?.[collector]?.hash === value.sha256);
    const technicalBlockers = [
      ...(!stateProfileReady
        ? ["MG-SH3C-STATE-PROFILE-NOT-APPROVED"]
        : []),
      ...(!javaSeedReady
        ? ["MG-SH3C-JAVA-SEED-NOT-AUTHORED"]
        : []),
      ...(!rustSeedReady
        ? ["MG-SH3C-RUST-SEED-ADAPTER-NOT-BOUND"]
        : []),
      ...(!websocketReady
        ? ["MG-SH3C-WEBSOCKET-EVENT-COLLECTOR-NOT-BOUND"]
        : []),
      ...(!formallyPromoted && !writeSafetyReady
        ? ["MG-SH3C-FIXTURE-WRITE-SAFETY-APPROVAL-REQUIRED"]
        : []),
      ...placeholderPaths.map((item) => `MG-SH3C-REQUEST-REVIEW:${item}`),
      ...Object.entries(collectors).flatMap(([collector, value]) =>
        value.reviewFindings.map((finding) =>
          `MG-SH3C-COLLECTOR-REVIEW:${collector}:${finding}`)),
      ...(scenarioId === "dependency-failure"
        ? ["MG-SH3C-FAULT-CONTROLLER-NOT-BOUND"]
        : []),
      ...(scenarioId === "concurrent-write"
        ? ["MG-SH3C-CONCURRENCY-DRIVER-NOT-BOUND"]
        : []),
      ...(blueprints[scenarioId].compatibilityBlockers ?? []),
    ];
    const blockers = [...new Set(technicalBlockers)].sort();
    const readyForReview = blockers.length === 0;
    const document = {
      schemaVersion: 1,
      protocol: PROMOTION_PROTOCOL,
      status: formallyPromoted
        ? "promoted"
        : readyForReview
          ? "ready-for-review"
          : "review-required",
      realEvidenceEligible: formallyPromoted,
      projectId: contract.projectId,
      projectHash: contract.projectHash,
      runtimeContractHash: contract.contractHash,
      sourceIdentity: contract.sourceIdentity,
      promotionWave: "sh3c-first-wave",
      entrypointId,
      scenarioId,
      category: scenario.category,
      requiredDimensions: scenario.requiredDimensions,
      decisionIds: scenario.decisionIds,
      sourceDraft: {
        path: relativeCasePath(draftPath),
        sha256: documentHash(draft),
      },
      stateProfile: {
        path: relativeCasePath(stateProfilePath),
        sha256: stateProfileFileHash,
        status: stateProfile.status,
        applicableScenarios: stateProfile.applicableScenarios ?? [],
      },
      collectors,
      requestPlan: {
        status: placeholderPaths.length === 0 ? "authored" : "review-required",
        placeholderPaths,
        environmentBindings: draft.environmentBindings ?? [],
      },
      seedPlan: {
        status: javaSeedReady && rustSeedReady ? "authored" : "review-required",
        plannedRows: blueprints[scenarioId].plannedSeedRows,
        java: {
          protocol: "migration-guard.batch-update-l4c-java-seed/v1",
          resourceRole: "projection",
          binding: "scenario.seedProfiles.source",
          ...(javaSeedReady
            ? {
                path: relativeCasePath(javaSeedPath),
                sha256: javaSeedFileHash,
              }
            : {}),
        },
        rust: {
          status: rustSeedReady ? "adapter-bound" : "adapter-required",
          resourceRole: "projection",
          binding: "scenario.seedProfiles.target",
          ...(rustSeedReady
            ? {
                path: relativeCasePath(rustSeedPath),
                sha256: rustSeedFileHash,
              }
            : {}),
        },
      },
      expectedObservation: {
        status: websocketReady && stateProfileReady
          ? "authored"
          : "review-required",
        dimensions: scenario.requiredDimensions,
        invariants: blueprints[scenarioId].invariants,
      },
      semanticIntent: {
        intent: blueprints[scenarioId].intent,
        contractExpectations: draft.expectations,
      },
      formalPromotion: {
        command:
          `migration-guard migrate runtime-fixture-promote --case-dir ` +
          `cases/zboss-batch-update-with-progress --entrypoint ${entrypointId} ` +
          `--scenario ${scenarioId} --reviewed-by <reviewer>`,
        allowedOnlyWhenBlockersEmpty: true,
        status: formallyPromoted ? "promoted" : "pending",
        ...(formallyPromoted
          ? {
              reviewedBy: promotedFixture.authoring.reviewedBy,
              reviewedAt: promotedFixture.authoring.reviewedAt,
              fixturePath: relativeCasePath(promotedFixturePath),
              fixtureSha256: documentHash(promotedFixture),
            }
          : {}),
      },
      blockers,
      packageHash: "",
    };
    document.packageHash = packageHash(document);
    packages.push(document);
  }
  const technicalReview = {
    schemaVersion: 1,
    protocol: TECHNICAL_REVIEW_PROTOCOL,
    status: packages.every((item) => item.blockers.length === 0)
      ? "ready-for-human-approval"
      : "changes-required",
    reviewKind: "automated-technical",
    humanApprovalClaimed: false,
    projectId: contract.projectId,
    projectHash: contract.projectHash,
    runtimeContractHash: contract.contractHash,
    promotionWave: "sh3c-first-wave",
    packages: packages.map((item) => ({
      scenarioId: item.scenarioId,
      packageHash: item.packageHash,
      decision: item.blockers.length === 0
        ? "ready-for-human-approval"
        : "changes-required",
      blockers: item.blockers,
    })),
    summary: {
      scenarioCount: packages.length,
      readyCount: packages.filter((item) => item.blockers.length === 0).length,
      changesRequiredCount:
        packages.filter((item) => item.blockers.length > 0).length,
    },
    reviewHash: "",
  };
  technicalReview.reviewHash = technicalReviewHash(technicalReview);
  const manifest = {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-scenario-promotion-manifest/v1",
    status: "review-required",
    realEvidenceEligible: false,
    projectId: contract.projectId,
    projectHash: contract.projectHash,
    runtimeContractHash: contract.contractHash,
    promotionWave: "sh3c-first-wave",
    scenarioOrder: FIRST_WAVE,
    packages: packages.map((item) => ({
      scenarioId: item.scenarioId,
      path: `evidence/runtime/l4c/scenario-promotion/packages/${item.scenarioId}.json`,
      hash: item.packageHash,
      blockerCount: item.blockers.length,
    })),
    technicalReview: {
      path: "evidence/runtime/l4c/scenario-promotion/technical-review.json",
      hash: technicalReview.reviewHash,
      status: technicalReview.status,
    },
    readyForHumanReview: true,
    readyForRealPromotion: packages.some((item) => item.status === "promoted"),
    manifestHash: "",
  };
  manifest.manifestHash = manifestHash(manifest);
  return { packages, manifest, technicalReview };
}

export function validatePromotionSet(value) {
  const findings = [];
  if (
    value.packages.length !== FIRST_WAVE.length
    || JSON.stringify(value.packages.map((item) => item.scenarioId))
      !== JSON.stringify(FIRST_WAVE)
  ) {
    findings.push("MG-SH3C-FIRST-WAVE-MISMATCH");
  }
  for (const item of value.packages) {
    findings.push(...validatePackage(item).map((finding) =>
      `${finding}:${item.scenarioId}`));
  }
  findings.push(...validateTechnicalReview(
    value.technicalReview,
    value.packages,
  ));
  if (
    value.manifest.realEvidenceEligible !== false
    || value.manifest.readyForRealPromotion
      !== value.packages.some((item) => item.status === "promoted")
    || value.manifest.manifestHash !== manifestHash(value.manifest)
    || value.manifest.technicalReview?.hash
      !== value.technicalReview?.reviewHash
    || value.manifest.technicalReview?.status
      !== value.technicalReview?.status
    || value.manifest.packages.some((reference, index) =>
      reference.scenarioId !== value.packages[index]?.scenarioId
      || reference.hash !== value.packages[index]?.packageHash)
  ) {
    findings.push("MG-SH3C-MANIFEST-INVALID");
  }
  return [...new Set(findings)].sort();
}

export function validateTechnicalReview(value, packages) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== TECHNICAL_REVIEW_PROTOCOL
    || !["changes-required", "ready-for-human-approval"].includes(
      value?.status,
    )
    || value?.reviewKind !== "automated-technical"
    || value?.humanApprovalClaimed !== false
    || !Array.isArray(value?.packages)
    || value.packages.length !== FIRST_WAVE.length
  ) {
    findings.push("MG-SH3C-TECHNICAL-REVIEW-PROTOCOL-INVALID");
  }
  for (const [index, item] of (value?.packages ?? []).entries()) {
    const expected = packages[index];
    if (
      !expected
      || item.scenarioId !== expected.scenarioId
      || item.packageHash !== expected.packageHash
      || item.decision !== (expected.blockers.length === 0
        ? "ready-for-human-approval"
        : "changes-required")
      || stableStringify(item.blockers) !== stableStringify(expected.blockers)
    ) {
      findings.push(`MG-SH3C-TECHNICAL-REVIEW-PACKAGE-MISMATCH:${
        expected?.scenarioId ?? index
      }`);
    }
  }
  const expectedReady = packages.filter((item) => item.blockers.length === 0).length;
  if (
    value?.status !== (expectedReady === packages.length
      ? "ready-for-human-approval"
      : "changes-required")
    || value?.summary?.scenarioCount !== packages.length
    || value?.summary?.readyCount !== expectedReady
    || value?.summary?.changesRequiredCount !== packages.length - expectedReady
  ) {
    findings.push("MG-SH3C-TECHNICAL-REVIEW-SUMMARY-INVALID");
  }
  if (value?.reviewHash !== technicalReviewHash(value)) {
    findings.push("MG-SH3C-TECHNICAL-REVIEW-HASH-MISMATCH");
  }
  return findings;
}

export function validatePackage(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== PROMOTION_PROTOCOL
    || !["review-required", "ready-for-review", "promoted"].includes(
      value?.status,
    )
  ) {
    findings.push("MG-SH3C-PACKAGE-PROTOCOL-INVALID");
  }
  if (
    value?.status !== "promoted"
    && value?.realEvidenceEligible !== false
  ) {
    findings.push("MG-SH3C-PREMATURE-REAL-ELIGIBILITY");
  }
  if (
    value?.status === "promoted"
    && (
      value.realEvidenceEligible !== true
      || value.blockers?.length !== 0
      || value.formalPromotion?.status !== "promoted"
      || typeof value.formalPromotion?.reviewedBy !== "string"
      || !value.formalPromotion.reviewedBy.trim()
      || !/^[a-f0-9]{64}$/.test(
        value.formalPromotion?.fixtureSha256 ?? "",
      )
    )
  ) {
    findings.push("MG-SH3C-PROMOTION-EVIDENCE-INVALID");
  }
  if (!Array.isArray(value?.blockers)) {
    findings.push("MG-SH3C-REVIEW-BLOCKERS-INVALID");
  }
  if (
    value?.stateProfile?.status === "approved"
    && !value.stateProfile?.applicableScenarios?.includes(value?.scenarioId)
  ) {
    findings.push("MG-SH3C-STATE-PROFILE-SCENARIO-NOT-APPROVED");
  }
  if (
    !Array.isArray(value?.requestPlan?.placeholderPaths)
    || !["review-required", "authored"].includes(value?.seedPlan?.status)
    || !["adapter-required", "adapter-bound"].includes(
      value?.seedPlan?.rust?.status,
    )
    || !["review-required", "authored"].includes(
      value?.expectedObservation?.status,
    )
  ) {
    findings.push("MG-SH3C-REVIEW-PLAN-INCOMPLETE");
  }
  if (
    value?.status === "ready-for-review"
    && (
      value.blockers?.length !== 0
      || value.requestPlan?.status !== "authored"
      || value.seedPlan?.status !== "authored"
      || value.seedPlan?.rust?.status !== "adapter-bound"
      || value.expectedObservation?.status !== "authored"
      || value.stateProfile?.status !== "approved"
    )
  ) {
    findings.push("MG-SH3C-READY-STATE-INVALID");
  }
  if (
    value?.status === "review-required"
    && value.blockers?.length === 0
  ) {
    findings.push("MG-SH3C-REVIEW-BLOCKERS-MISSING");
  }
  if (value?.packageHash !== packageHash(value)) {
    findings.push("MG-SH3C-PACKAGE-HASH-MISMATCH");
  }
  return findings;
}

async function writePromotionSet(value) {
  const findings = validatePromotionSet(value);
  if (findings.length > 0) throw new Error(findings.join(", "));
  await mkdir(packageDirectory, { recursive: true });
  for (const item of value.packages) {
    await writeJson(path.join(packageDirectory, `${item.scenarioId}.json`), item);
  }
  await writeJson(manifestPath, value.manifest);
  await writeJson(technicalReviewPath, value.technicalReview);
}

async function checkPersistedPromotionSet(expected) {
  const findings = validatePromotionSet(expected);
  for (const item of expected.packages) {
    const persistedPath = path.join(packageDirectory, `${item.scenarioId}.json`);
    try {
      const persisted = await readJson(persistedPath);
      findings.push(...validatePackage(persisted).map((finding) =>
        `${finding}:${item.scenarioId}`));
      if (stableStringify(persisted) !== stableStringify(item)) {
        findings.push(`MG-SH3C-PACKAGE-STALE:${item.scenarioId}`);
      }
    } catch {
      findings.push(`MG-SH3C-PACKAGE-MISSING:${item.scenarioId}`);
    }
  }
  try {
    const persistedManifest = await readJson(manifestPath);
    if (stableStringify(persistedManifest) !== stableStringify(expected.manifest)) {
      findings.push("MG-SH3C-MANIFEST-STALE");
    }
  } catch {
    findings.push("MG-SH3C-MANIFEST-MISSING");
  }
  try {
    const persistedReview = await readJson(technicalReviewPath);
    findings.push(...validateTechnicalReview(
      persistedReview,
      expected.packages,
    ));
    if (stableStringify(persistedReview)
      !== stableStringify(expected.technicalReview)) {
      findings.push("MG-SH3C-TECHNICAL-REVIEW-STALE");
    }
  } catch {
    findings.push("MG-SH3C-TECHNICAL-REVIEW-MISSING");
  }
  return [...new Set(findings)].sort();
}

function collectorFindings(value) {
  const findings = [];
  if (!["ready", "not-applicable"].includes(value.status)) {
    findings.push("STATUS-NOT-READY");
  }
  const serialized = JSON.stringify(value);
  if (/replace[-_: ]?me/i.test(serialized)) findings.push("PLACEHOLDER-PROBE");
  if (value.collector === "redis" && value.notApplicable !== true) {
    findings.push("JAVA-PROGRESS-IS-NOT-REDIS-BACKED");
  }
  if (value.collector === "events" && value.status !== "ready") {
    findings.push("WEBSOCKET-CAPTURE-NOT-CONFIRMED");
  }
  return findings;
}

function placeholderLocations(value, current = "$", output = []) {
  if (typeof value === "string" && /<[^>]+>/.test(value)) {
    output.push(current);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      placeholderLocations(item, `${current}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      placeholderLocations(item, `${current}.${key}`, output);
    }
  }
  return output.sort();
}

function packageHash(value) {
  return hashValue({ ...value, packageHash: undefined });
}

function manifestHash(value) {
  return hashValue({ ...value, manifestHash: undefined });
}

function technicalReviewHash(value) {
  return hashValue({ ...value, reviewHash: undefined });
}

function documentHash(value) {
  return hashValue(value);
}

function hashValue(value) {
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

function relativeCasePath(value) {
  const relative = path.relative(caseDirectory, value);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("scenario promotion source escapes case directory");
  }
  return relative.replaceAll("\\", "/");
}

async function readJson(value) {
  return JSON.parse(await readFile(value, "utf8"));
}

async function readJsonIfPresent(value) {
  try {
    return await readJson(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileHash(value) {
  return canonicalFileHash(await readFile(value));
}

function canonicalFileHash(content) {
  return createHash("sha256")
    .update(content.toString("utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summary(value, status) {
  return {
    status,
    stage: "SH-3C",
    promotionWave: "sh3c-first-wave",
    scenarioCount: value.packages.length,
    readyForHumanReview: true,
    readyForRealPromotion: value.manifest.readyForRealPromotion,
    technicalReviewStatus: value.technicalReview.status,
    manifestPath: path.relative(repositoryRoot, manifestPath),
  };
}
