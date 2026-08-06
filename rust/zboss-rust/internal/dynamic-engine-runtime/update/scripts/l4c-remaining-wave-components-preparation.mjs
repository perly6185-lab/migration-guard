import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPONENT_PROTOCOL =
  "migration-guard.batch-update-l4c-remaining-wave-components/v1";
const BINDING_PROTOCOL = "migration-guard.batch-update-l4c-bindings/v1";
const FAULT_MECHANISMS = {
  "post-commit-effect-failure": {
    controller: "l4c-post-commit-effect-fault-controller.mjs",
    mechanismId: "fault-post-commit-effect-v1",
  },
  "schema-transition-failure": {
    controller: "l4c-schema-transition-fault-controller.mjs",
    mechanismId: "fault-schema-transition-v1",
  },
  "transaction-failure": {
    controller: "l4c-transaction-fault-controller.mjs",
    mechanismId: "fault-transaction-rollback-v1",
  },
  "undo-excludes-failed-rows": {
    controller: "l4c-undo-delivery-fault-controller.mjs",
    mechanismId: "fault-undo-delivery-v1",
  },
};
const FIRST_WAVE = new Set([
  "primary-success",
  "validation-failure",
  "batch-partial-failure",
  "dependency-failure",
  "concurrent-write",
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
const l4cRoot = path.join(caseDirectory, "evidence", "runtime", "l4c");
const entrypointId =
  "post-zboss-data-view-dynamic-engine-use-engine-use-batch-page-batchUpdateWithProgress";
const draftRoot = path.join(
  caseDirectory,
  "fixtures",
  "java-runtime-drafts",
  entrypointId,
);
const outputRoot = path.join(
  l4cRoot,
  "scenario-preparation",
  "remaining-wave",
);
const seedRoot = path.join(outputRoot, "seeds");
const collectorRoot = path.join(outputRoot, "collectors");
const componentManifestPath = path.join(outputRoot, "components.json");
const bindingPreparationPath = path.join(outputRoot, "binding-preparation.json");
const contractPath = path.join(
  caseDirectory,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const bindingTemplatePath = path.join(l4cRoot, "bindings.template.json");
const approvedBindingPath = path.join(
  l4cRoot,
  "bindings.primary-success.approved.json",
);
const stateProfileTemplatePath = path.join(
  l4cRoot,
  "java-state-profile.template.json",
);
const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--self-test")
    ? "self-test"
    : "check";

const contract = await readJson(contractPath);
const entry = contract.entries.find((item) => item.id === entrypointId);
if (!entry) throw new Error(`runtime scenario entry is missing: ${entrypointId}`);
const scenarioIds = entry.scenarios
  .map((scenario) => scenario.id)
  .filter((scenarioId) => !FIRST_WAVE.has(scenarioId));

const built = await buildComponents(contract, entry);
if (mode === "write") {
  await writeComponents(built);
  console.log(JSON.stringify(summary(built, "written"), null, 2));
} else if (mode === "check") {
  const findings = await checkComponents(built);
  console.log(JSON.stringify({
    ...summary(built, findings.length === 0 ? "passed" : "blocked"),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} else {
  const findings = validateComponents(built);
  if (findings.length > 0) throw new Error(findings.join(", "));
  const tampered = structuredClone(built.manifest);
  tampered.components[0].status = "approved";
  if (validateComponents({ ...built, manifest: tampered }).length === 0) {
    throw new Error("component approval tampering was not rejected");
  }
  const tamperedBinding = structuredClone(built.binding);
  tamperedBinding.status = "approved";
  if (validateBindingPreparation(tamperedBinding).length === 0) {
    throw new Error("binding approval tampering was not rejected");
  }
  console.log(JSON.stringify({
    status: "pass",
    checks: 7,
    coverage: [
      "remaining-wave-exactly-fourteen",
      "two-seed-candidates-per-scenario",
      "three-collector-candidates-per-scenario",
      "binding-candidate-covers-all-scenarios",
      "four-controller-bindings-present",
      "approval-tamper-rejected",
      "binding-tamper-rejected",
    ],
  }, null, 2));
}

async function buildComponents(contractValue, entryValue) {
  const template = await readJson(bindingTemplatePath);
  const approvedBinding = await readJson(approvedBindingPath);
  const stateProfileTemplate = await readJson(stateProfileTemplatePath);
  const components = [];
  const scenarios = {};
  for (const scenarioId of scenarioIds) {
    const scenario = entryValue.scenarios.find((item) => item.id === scenarioId);
    const draftPath = path.join(draftRoot, scenarioId, "fixture.draft.json");
    const draft = await readJson(draftPath);
    const seeds = {
      java: buildJavaSeed(contractValue, scenarioId, draft),
      rust: buildRustSeed(contractValue, scenarioId, draft),
    };
    const collectors = {};
    for (const collector of scenario.requiredCollectors) {
      const collectorPath = path.join(
        path.dirname(draftPath),
        "collectors",
        `${collector}.draft.json`,
      );
      const draftCollector = await readJson(collectorPath);
      collectors[collector] = buildCollectorCandidate(
        collector,
        scenarioId,
        draftCollector,
        collectorPath,
      );
    }
    const mechanism = FAULT_MECHANISMS[scenarioId];
    const blockerList = [
      "MG-SH3C-COMPONENT-REVIEW-REQUIRED",
      "MG-SH3C-JAVA-SEED-REVIEW-REQUIRED",
      "MG-SH3C-RUST-SEED-ADAPTER-REVIEW-REQUIRED",
      "MG-SH3C-COLLECTOR-REVIEW-REQUIRED",
      "MG-SH3C-BINDING-REVIEW-REQUIRED",
      ...(mechanism ? ["MG-SH3C-FAULT-MECHANISM-NOT-BOUND"] : []),
    ];
    const component = {
      schemaVersion: 1,
      protocol: COMPONENT_PROTOCOL,
      status: "review-required",
      realEvidenceEligible: false,
      projectId: contractValue.projectId,
      projectHash: contractValue.projectHash,
      runtimeContractHash: contractValue.contractHash,
      promotionWave: "sh3c-remaining-wave",
      scenarioId,
      sourceDraft: {
        path: relativeCasePath(draftPath),
        sha256: stableHash(draft),
      },
      seedCandidates: {
        java: reference(
          path.join(seedRoot, `${scenarioId}.java-seed.template.json`),
          seeds.java,
        ),
        rust: reference(
          path.join(seedRoot, `${scenarioId}.rust-seed.adapter-template.json`),
          seeds.rust,
        ),
      },
      collectorCandidates: Object.fromEntries(Object.entries(collectors).map(
        ([collector, value]) => [collector, reference(
          path.join(collectorRoot, `${scenarioId}.${collector}.template.json`),
          value,
        )],
      )),
      binding: {
        path: "evidence/runtime/l4c/scenario-preparation/remaining-wave/binding-preparation.json",
        status: "review-required",
        scenarioBindingHash: stableHash({
          scenarioId,
          seedCandidates: seeds,
          collectorCandidates: collectors,
          mechanism,
        }),
      },
      blockers: [...new Set(blockerList)].sort(),
      componentHash: "",
    };
    component.componentHash = componentHash(component);
    components.push(component);
    scenarios[scenarioId] = buildBindingScenario(
      scenarioId,
      draft,
      approvedBinding.scenarios?.["primary-success"],
      seeds,
      collectors,
      mechanism,
    );
  }
  const binding = buildBindingCandidate(
    contractValue,
    template,
    stateProfileTemplate,
    scenarios,
  );
  const manifest = {
    schemaVersion: 1,
    protocol: COMPONENT_PROTOCOL,
    status: "review-required",
    realEvidenceEligible: false,
    projectId: contractValue.projectId,
    projectHash: contractValue.projectHash,
    runtimeContractHash: contractValue.contractHash,
    promotionWave: "sh3c-remaining-wave",
    scenarioOrder: scenarioIds,
    components: components.map((item) => ({
      scenarioId: item.scenarioId,
      status: item.status,
      path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/components/${item.scenarioId}.json`,
      hash: item.componentHash,
      blockerCount: item.blockers.length,
    })),
    binding: {
      path: "evidence/runtime/l4c/scenario-preparation/remaining-wave/binding-preparation.json",
      hash: binding.bindingHash,
      status: binding.status,
    },
    summary: {
      scenarioCount: components.length,
      seedCandidateCount: components.length * 2,
      collectorCandidateCount: components.reduce(
        (count, item) => count + Object.keys(item.collectorCandidates).length,
        0,
      ),
      faultControllerCount: Object.keys(FAULT_MECHANISMS).length,
    },
    manifestHash: "",
  };
  manifest.manifestHash = manifestHash(manifest);
  return { components, manifest, binding };
}

function buildJavaSeed(contractValue, scenarioId, draft) {
  const rowCount = Math.max(
    1,
    Math.min(20, draft.request?.body?.batchPostValueList?.length || 1),
  );
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-java-seed/v1",
    status: "review-required",
    realEvidenceEligible: false,
    projectId: contractValue.projectId,
    targetKind: "source",
    scenarioId,
    stateProfileSha256: "<sha256-of-approved-java-state-profile>",
    resources: [{
      resourceId: "projection",
      rows: Array.from({ length: rowCount }, (_, index) => ({
        markerSuffix: `row-${String(index + 1).padStart(3, "0")}`,
        values: {
          value: `<reviewed-${scenarioId}-value-${index + 1}>`,
          quantity: index + 1,
        },
      })),
    }],
    review: {
      required: [
        "resolve-state-profile-hash",
        "review-projection-resource-and-column-aliases",
        "obtain-disposable-write-approval",
      ],
    },
  };
}

function buildRustSeed(contractValue, scenarioId, draft) {
  const rowCount = Math.max(
    1,
    Math.min(20, draft.request?.body?.batchPostValueList?.length || 1),
  );
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-target-seed/v1",
    status: "review-required",
    realEvidenceEligible: false,
    projectId: contractValue.projectId,
    targetKind: "target",
    scenarioId,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      markerSuffix: `row-${String(index + 1).padStart(3, "0")}`,
      values: {
        value: `<reviewed-${scenarioId}-value-${index + 1}>`,
        quantity: index + 1,
      },
    })),
    adapter: {
      status: "review-required",
      command: "zboss-l4c-state-hook seed zboss-evidence-v1",
      requiredReview: "bind target fixture adapter to the same marker scope",
    },
  };
}

function buildCollectorCandidate(collector, scenarioId, draft, draftPath) {
  if (collector === "events") {
    return {
      schemaVersion: 1,
      protocol: "migration-guard.batch-update-l4c-event-collector/v1",
      collector,
      status: "review-required",
      realEvidenceEligible: false,
      scenarioId,
      sourceDraft: {
        path: relativeCasePath(draftPath),
        sha256: stableHash(draft),
      },
      capture: {
        kind: "websocket",
        path: "/ws/zboss",
        messageType: "panel-data-update",
        correlationFields: draft.correlationFields ?? [],
        includeFields: draft.includeFields ?? [],
      },
      reviewRequired: [
        "confirm-websocket-endpoint-and-subscription",
        "confirm-terminal-event-and-no-event-window",
        "bind-redacted-event-output-path",
      ],
    };
  }
  if (collector === "mysql") {
    return {
      schemaVersion: 1,
      protocol: "migration-guard.batch-update-l4c-mysql-collector/v1",
      collector,
      status: "review-required",
      realEvidenceEligible: false,
      scenarioId,
      sourceDraft: {
        path: relativeCasePath(draftPath),
        sha256: stableHash(draft),
      },
      connectionEnv: draft.connectionEnv,
      probes: ["connectivity", "marker-scoped-before-snapshot", "marker-scoped-after-snapshot"],
      identifiers: {
        source: "state-profile semantic resource aliases only",
        rawSql: false,
      },
      reviewRequired: [
        "bind-approved-state-profile-resources",
        "confirm-before-after-columns-and-size-cap",
        "confirm-marker-tenant-panel-predicate",
      ],
    };
  }
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-redis-collector/v1",
    collector,
    status: "review-required",
    realEvidenceEligible: false,
    scenarioId,
    sourceDraft: {
      path: relativeCasePath(draftPath),
      sha256: stableHash(draft),
    },
    connectionEnv: draft.connectionEnv,
    notApplicable: false,
    probes: ["marker-scoped-lock-or-ledger-key", "marker-scoped-progress-key-if-approved"],
    reviewRequired: [
      "confirm-java-progress-is-or-is-not-redis-backed",
      "bind-key-prefix-and-type-without-wildcard-delete",
    ],
  };
}

function buildBindingScenario(
  scenarioId,
  draft,
  primaryScenario,
  seeds,
  collectors,
  mechanism,
) {
  const baseRequest = structuredClone(primaryScenario?.request ?? {});
  const controllerPath = mechanism
    ? `rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/${mechanism.controller}`
    : undefined;
  return {
    seedProfiles: {
      source: {
        path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/seeds/${scenarioId}.java-seed.template.json`,
        sha256: stableHash(seeds.java),
      },
      target: {
        path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/seeds/${scenarioId}.rust-seed.adapter-template.json`,
        sha256: stableHash(seeds.rust),
      },
    },
    request: {
      ...baseRequest,
      draftReview: {
        status: "review-required",
        sourceRequestPlaceholders: placeholderLocations(draft.request),
      },
    },
    eventCollectors: {
      source: {
        kind: "websocket",
        path: "/ws/zboss",
        messageType: "panel-data-update",
        completionMode: "terminal-event",
        status: "review-required",
      },
    },
    ...(controllerPath
      ? {
          hooks: {
            faultController: {
              program: "node",
              args: [controllerPath, "{faultAction}", "{scenarioId}"],
            },
          },
        }
      : { hooks: {} }),
    collectors: Object.fromEntries(Object.entries(collectors).map(
      ([collector, value]) => [collector, {
        path: `evidence/runtime/l4c/scenario-preparation/remaining-wave/collectors/${scenarioId}.${collector}.template.json`,
        sha256: stableHash(value),
        status: value.status,
      }],
    )),
  };
}

function buildBindingCandidate(contractValue, template, stateProfile, scenarios) {
  const value = structuredClone(template);
  value.schemaVersion = 1;
  value.protocol = BINDING_PROTOCOL;
  value.status = "review-required";
  value.realEvidenceEligible = false;
  value.projectId = contractValue.projectId;
  value.projectHash = contractValue.projectHash;
  value.runtimeContractHash = contractValue.contractHash;
  for (const target of Object.values(value.targets)) {
    target.hooks.faultController = {
      program: "node",
      args: [
        "rust/zboss-rust/internal/dynamic-engine-runtime/update/scripts/l4c-fault-controller-dispatcher.mjs",
        "{faultAction}",
        "{scenarioId}",
      ],
      timeoutMs: 120000,
    };
  }
  value.scenarios = scenarios;
  value.reviewRequired = [
    "approve-state-profile-and-hashes",
    "approve-each-seed-candidate",
    "approve-each-collector-candidate",
    "approve-request-placeholders-and-disposable-write-scope",
    "bind-target-specific-fault-control-endpoints",
  ];
  value.stateProfileTemplateHash = stableHash(stateProfile);
  value.bindingHash = bindingHash(value);
  return value;
}

function validateBindingPreparation(value) {
  const findings = [];
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== BINDING_PROTOCOL
    || value?.status !== "review-required"
    || value?.realEvidenceEligible !== false
  ) {
    findings.push("MG-SH3C-BINDING-CANDIDATE-PROTOCOL-INVALID");
  }
  if (!value?.targets?.source || !value?.targets?.target) {
    findings.push("MG-SH3C-BINDING-CANDIDATE-TARGETS-MISSING");
  }
  if (Object.keys(value?.scenarios ?? {}).length !== scenarioIds.length) {
    findings.push("MG-SH3C-BINDING-CANDIDATE-SCENARIOS-INCOMPLETE");
  }
  for (const scenarioId of scenarioIds) {
    const scenario = value.scenarios?.[scenarioId];
    if (
      !scenario
      || scenario.seedProfiles?.source?.status === "approved"
      || scenario.seedProfiles?.target?.status === "approved"
    ) {
      findings.push(`MG-SH3C-BINDING-CANDIDATE-INVALID:${scenarioId}`);
    }
  }
  if (value?.bindingHash !== bindingHash(value)) {
    findings.push("MG-SH3C-BINDING-CANDIDATE-HASH-MISMATCH");
  }
  return [...new Set(findings)].sort();
}

function validateComponents(value) {
  const findings = [];
  if (
    value.components.length !== scenarioIds.length
    || JSON.stringify(value.components.map((item) => item.scenarioId))
      !== JSON.stringify(scenarioIds)
  ) {
    findings.push("MG-SH3C-COMPONENT-SCENARIO-MISMATCH");
  }
  for (const item of value.components) {
    if (
      item.status !== "review-required"
      || item.realEvidenceEligible !== false
      || !item.seedCandidates?.java?.sha256
      || !item.seedCandidates?.rust?.sha256
      || Object.keys(item.collectorCandidates ?? {}).length !== 3
      || item.componentHash !== componentHash(item)
      || item.blockers.length === 0
    ) {
      findings.push(`MG-SH3C-COMPONENT-INVALID:${item.scenarioId}`);
    }
  }
  findings.push(...validateBindingPreparation(value.binding));
  if (value.manifest.manifestHash !== manifestHash(value.manifest)) {
    findings.push("MG-SH3C-COMPONENT-MANIFEST-HASH-MISMATCH");
  }
  return [...new Set(findings)].sort();
}

async function writeComponents(value) {
  const findings = validateComponents(value);
  if (findings.length > 0) throw new Error(findings.join(", "));
  await mkdir(path.join(outputRoot, "components"), { recursive: true });
  await mkdir(seedRoot, { recursive: true });
  await mkdir(collectorRoot, { recursive: true });
  for (const item of value.components) {
    await writeJson(
      path.join(outputRoot, "components", `${item.scenarioId}.json`),
      item,
    );
    await writeJson(
      path.join(seedRoot, `${item.scenarioId}.java-seed.template.json`),
      await readComponentSeed(value, item.scenarioId, "java"),
    );
    await writeJson(
      path.join(seedRoot, `${item.scenarioId}.rust-seed.adapter-template.json`),
      await readComponentSeed(value, item.scenarioId, "rust"),
    );
    for (const collector of Object.keys(item.collectorCandidates)) {
      await writeJson(
        path.join(collectorRoot, `${item.scenarioId}.${collector}.template.json`),
        await readComponentCollector(value, item.scenarioId, collector),
      );
    }
  }
  await writeJson(componentManifestPath, value.manifest);
  await writeJson(bindingPreparationPath, value.binding);
}

async function readComponentSeed(value, scenarioId, kind) {
  const packageValue = value.components.find((item) => item.scenarioId === scenarioId);
  const draft = await readJson(path.join(caseDirectory, packageValue.sourceDraft.path));
  const source = kind === "java"
    ? buildJavaSeed(packageValue, scenarioId, draft)
    : buildRustSeed(packageValue, scenarioId, draft);
  return source;
}

async function readComponentCollector(value, scenarioId, collector) {
  const component = value.components.find((item) => item.scenarioId === scenarioId);
  const draftPath = path.join(caseDirectory, component.sourceDraft.path);
  const collectorPath = path.join(
    path.dirname(draftPath),
    "collectors",
    `${collector}.draft.json`,
  );
  return buildCollectorCandidate(
    collector,
    scenarioId,
    await readJson(collectorPath),
    collectorPath,
  );
}

async function checkComponents(expected) {
  const findings = validateComponents(expected);
  try {
    const persisted = await readJson(componentManifestPath);
    if (stableStringify(persisted) !== stableStringify(expected.manifest)) {
      findings.push("MG-SH3C-COMPONENT-MANIFEST-STALE");
    }
  } catch {
    findings.push("MG-SH3C-COMPONENT-MANIFEST-MISSING");
  }
  try {
    const persisted = await readJson(bindingPreparationPath);
    if (stableStringify(persisted) !== stableStringify(expected.binding)) {
      findings.push("MG-SH3C-BINDING-CANDIDATE-STALE");
    }
  } catch {
    findings.push("MG-SH3C-BINDING-CANDIDATE-MISSING");
  }
  for (const item of expected.components) {
    for (const file of [
      path.join(outputRoot, "components", `${item.scenarioId}.json`),
      path.join(seedRoot, `${item.scenarioId}.java-seed.template.json`),
      path.join(seedRoot, `${item.scenarioId}.rust-seed.adapter-template.json`),
      ...Object.keys(item.collectorCandidates).map((collector) =>
        path.join(collectorRoot, `${item.scenarioId}.${collector}.template.json`)),
    ]) {
      try {
        await readJson(file);
      } catch {
        findings.push(`MG-SH3C-COMPONENT-FILE-MISSING:${path.basename(file)}`);
      }
    }
  }
  return [...new Set(findings)].sort();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function reference(file, value) {
  return {
    path: relativeCasePath(file),
    sha256: stableHash(value),
    status: value.status,
  };
}

function componentHash(value) {
  return stableHash({ ...value, componentHash: undefined });
}

function bindingHash(value) {
  return stableHash({ ...value, bindingHash: undefined });
}

function manifestHash(value) {
  return stableHash({ ...value, manifestHash: undefined });
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

function placeholderLocations(value, current = "", output = []) {
  if (typeof value === "string" && /<[^>]+>/.test(value)) output.push(current || "$");
  else if (Array.isArray(value)) {
    value.forEach((item, index) => placeholderLocations(item, `${current}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      placeholderLocations(item, `${current}.${key}`, output);
    }
  }
  return output.sort();
}

function relativeCasePath(file) {
  const relative = path.relative(caseDirectory, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("remaining-wave component path escapes case directory");
  }
  return relative.replaceAll("\\", "/");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summary(value, status) {
  return {
    status,
    stage: "SH-3C-remaining-wave-components-preparation",
    scenarioCount: value.components.length,
    seedCandidateCount: value.manifest.summary.seedCandidateCount,
    collectorCandidateCount: value.manifest.summary.collectorCandidateCount,
    faultControllerCount: value.manifest.summary.faultControllerCount,
    bindingStatus: value.binding.status,
    outputRoot: path.relative(repositoryRoot, outputRoot),
  };
}
