import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVIEW_PROTOCOL =
  "migration-guard.batch-update-l4c-remaining-wave-human-review/v1";
const FIRST_WAVE = new Set([
  "primary-success",
  "validation-failure",
  "batch-partial-failure",
  "dependency-failure",
  "concurrent-write",
]);
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
const componentManifestPath = path.join(outputRoot, "components.json");
const packageManifestPath = path.join(outputRoot, "manifest.json");
const bindingPath = path.join(outputRoot, "binding-preparation.json");
const reviewRoot = path.join(outputRoot, "human-review");
const reviewPath = path.join(reviewRoot, "remaining-wave-review.json");
const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--self-test")
    ? "self-test"
    : "check";

const built = await buildReview();
if (mode === "write") {
  await mkdir(reviewRoot, { recursive: true });
  await writeJson(reviewPath, built);
  console.log(JSON.stringify(summary(built, "written"), null, 2));
} else if (mode === "check") {
  const findings = await checkPersistedReview(built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "passed" : "blocked"),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else {
  const findings = validateReview(built);
  if (findings.length > 0) throw new Error(findings.join(", "));
  const tamperedHash = structuredClone(built);
  tamperedHash.scenarios[0].hashChecks.javaSeed.status = "fail";
  if (validateReview(tamperedHash).length === 0) {
    throw new Error("hash tampering was not rejected");
  }
  const tamperedApproval = structuredClone(built);
  tamperedApproval.scenarios[0].humanDecision = "approved";
  if (validateReview(tamperedApproval).length === 0) {
    throw new Error("premature approval was not rejected");
  }
  console.log(JSON.stringify({
    status: "pass",
    checks: 4,
    coverage: [
      "fourteen-scenarios-reconciled",
      "cross-file-hashes-verified",
      "hash-tamper-rejected",
      "premature-approval-rejected",
    ],
  }, null, 2));
}

async function buildReview() {
  const componentsManifest = await readJson(componentManifestPath);
  const packageManifest = await readJson(packageManifestPath);
  const binding = await readJson(bindingPath);
  const scenarioOrder = componentsManifest.scenarioOrder;
  const scenarios = [];
  for (const scenarioId of scenarioOrder) {
    const componentIndex = componentsManifest.components.find((item) =>
      item.scenarioId === scenarioId);
    const component = await readJson(path.join(
      caseDirectory,
      componentIndex.path,
    ));
    const packageIndex = packageManifest.packages.find((item) =>
      item.scenarioId === scenarioId);
    const packageValue = await readJson(path.join(
      caseDirectory,
      packageIndex.path,
    ));
    const sourceDraft = await readCaseReference(component.sourceDraft.path);
    const javaSeed = await readCaseReference(component.seedCandidates.java.path);
    const rustSeed = await readCaseReference(component.seedCandidates.rust.path);
    const collectors = {};
    for (const [collector, reference] of Object.entries(
      component.collectorCandidates,
    )) {
      collectors[collector] = await readCaseReference(reference.path);
    }
    const bindingScenario = binding.scenarios?.[scenarioId];
    const hashChecks = {
      sourceDraft: hashCheck(
        stableHash(sourceDraft),
        component.sourceDraft.sha256,
      ),
      component: hashCheck(
        componentHash(component),
        component.componentHash,
      ),
      javaSeed: hashCheck(
        stableHash(javaSeed),
        component.seedCandidates.java.sha256,
      ),
      rustSeed: hashCheck(
        stableHash(rustSeed),
        component.seedCandidates.rust.sha256,
      ),
      binding: hashCheck(
        bindingHash(binding),
        binding.bindingHash,
      ),
      package: hashCheck(
        packageHash(packageValue),
        packageValue.packageHash,
      ),
      packageComponent: hashCheck(
        packageValue.componentPreparation?.sha256,
        component.componentHash,
      ),
      bindingJavaSeed: hashCheck(
        bindingScenario?.seedProfiles?.source?.sha256,
        stableHash(javaSeed),
      ),
      bindingRustSeed: hashCheck(
        bindingScenario?.seedProfiles?.target?.sha256,
        stableHash(rustSeed),
      ),
    };
    for (const [collector, value] of Object.entries(collectors)) {
      hashChecks[`collector:${collector}`] = hashCheck(
        stableHash(value),
        component.collectorCandidates[collector].sha256,
      );
      hashChecks[`bindingCollector:${collector}`] = hashCheck(
        bindingScenario?.collectors?.[collector]?.sha256,
        stableHash(value),
      );
    }
    const hashStatus = Object.values(hashChecks).every((item) =>
      item.status === "pass")
      ? "pass"
      : "blocked";
    const contentFindings = [
      "SEED-SEMANTICS-REVIEW-REQUIRED",
      "COLLECTOR-SEMANTICS-REVIEW-REQUIRED",
      "BINDING-SCOPE-REVIEW-REQUIRED",
      ...(FAULT_SCENARIOS.has(scenarioId)
        ? ["FAULT-CONTROL-ENDPOINT-REVIEW-REQUIRED"]
        : []),
      ...(packageValue.requestPlan?.placeholderPaths?.length > 0
        ? ["REQUEST-PLACEHOLDERS-REVIEW-REQUIRED"]
        : []),
    ];
    scenarios.push({
      scenarioId,
      hashStatus,
      hashChecks,
      sourceDraft: {
        path: component.sourceDraft.path,
        status: "verified-reference",
      },
      seed: {
        javaPath: component.seedCandidates.java.path,
        rustPath: component.seedCandidates.rust.path,
        status: "pending-human-semantic-review",
        candidateStatuses: [javaSeed.status, rustSeed.status],
      },
      collectors: Object.fromEntries(Object.entries(collectors).map(
        ([collector, value]) => [collector, {
          path: component.collectorCandidates[collector].path,
          status: "pending-human-semantic-review",
          candidateStatus: value.status,
        }],
      )),
      binding: {
        path: "evidence/runtime/l4c/scenario-preparation/remaining-wave/binding-preparation.json",
        status: "pending-human-scope-review",
        scenarioBindingPresent: Boolean(bindingScenario),
      },
      contentFindings,
      packageBlockers: packageValue.blockers,
      componentBlockers: component.blockers,
      humanDecision: "pending",
    });
  }
  const value = {
    schemaVersion: 1,
    protocol: REVIEW_PROTOCOL,
    status: "pending-human-review",
    realEvidenceEligible: false,
    projectId: componentsManifest.projectId,
    projectHash: componentsManifest.projectHash,
    runtimeContractHash: componentsManifest.runtimeContractHash,
    promotionWave: "sh3c-remaining-wave",
    scenarioOrder,
    scenarios,
    summary: {
      scenarioCount: scenarios.length,
      hashVerifiedScenarioCount: scenarios.filter((item) =>
        item.hashStatus === "pass").length,
      hashBlockedScenarioCount: scenarios.filter((item) =>
        item.hashStatus !== "pass").length,
      semanticReviewPendingCount: scenarios.filter((item) =>
        item.humanDecision === "pending").length,
      approvedCount: scenarios.filter((item) =>
        item.humanDecision === "approved").length,
    },
    reviewInputs: {
      components: "evidence/runtime/l4c/scenario-preparation/remaining-wave/components.json",
      packages: "evidence/runtime/l4c/scenario-preparation/remaining-wave/manifest.json",
      binding: "evidence/runtime/l4c/scenario-preparation/remaining-wave/binding-preparation.json",
      faultMatrix: "evidence/runtime/l4c/scenario-preparation/remaining-wave/fault-mechanism-matrix.json",
    },
    reportHash: "",
  };
  value.reportHash = reportHash(value);
  return value;
}

async function checkPersistedReview(expected) {
  const findings = validateReview(expected);
  try {
    const persisted = await readJson(reviewPath);
    if (stableStringify(persisted) !== stableStringify(expected)) {
      findings.push("MG-SH3C-HUMAN-REVIEW-STALE");
    }
  } catch {
    findings.push("MG-SH3C-HUMAN-REVIEW-MISSING");
  }
  return [...new Set(findings)].sort();
}

function validateReview(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== REVIEW_PROTOCOL
    || value?.status !== "pending-human-review"
    || value?.realEvidenceEligible !== false
    || !Array.isArray(value?.scenarios)
    || value.scenarios.length !== 14
    || value.summary?.approvedCount !== 0
  ) {
    findings.push("MG-SH3C-HUMAN-REVIEW-PROTOCOL-INVALID");
  }
  if (value?.scenarioOrder?.some((scenarioId) => FIRST_WAVE.has(scenarioId))) {
    findings.push("MG-SH3C-HUMAN-REVIEW-FIRST-WAVE-MIXED");
  }
  for (const scenario of value?.scenarios ?? []) {
    if (
      scenario.hashStatus !== "pass"
      || scenario.humanDecision !== "pending"
      || Object.values(scenario.hashChecks ?? {}).some((item) =>
        item.status !== "pass")
    ) {
      findings.push(`MG-SH3C-HUMAN-REVIEW-SCENARIO-INVALID:${scenario.scenarioId}`);
    }
  }
  if (value?.reportHash !== reportHash(value)) {
    findings.push("MG-SH3C-HUMAN-REVIEW-HASH-MISMATCH");
  }
  return [...new Set(findings)].sort();
}

async function readCaseReference(reference) {
  return readJson(path.join(caseDirectory, reference));
}

function hashCheck(actual, expected) {
  return {
    status: actual === expected ? "pass" : "fail",
    actual,
    expected,
  };
}

function componentHash(value) {
  return stableHash({ ...value, componentHash: undefined });
}

function bindingHash(value) {
  return stableHash({ ...value, bindingHash: undefined });
}

function packageHash(value) {
  return stableHash({ ...value, packageHash: undefined });
}

function reportHash(value) {
  return stableHash({ ...value, reportHash: undefined });
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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summary(value, status) {
  return {
    status,
    stage: "SH-3C-remaining-wave-human-review",
    scenarioCount: value.summary.scenarioCount,
    hashVerifiedScenarioCount: value.summary.hashVerifiedScenarioCount,
    semanticReviewPendingCount: value.summary.semanticReviewPendingCount,
    approvedCount: value.summary.approvedCount,
    reviewPath: path.relative(repositoryRoot, reviewPath),
  };
}
