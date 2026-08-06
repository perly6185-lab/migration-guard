import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stableHash,
  validateReplayPlan,
} from "./l4c-replay-core.mjs";

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
const caseRoot = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const entrypointId =
  "post-zboss-data-view-dynamic-engine-use-engine-use-batch-page-batchUpdateWithProgress";
const l4cRoot = path.join(caseRoot, "evidence", "runtime", "l4c");
const templatePath = path.join(l4cRoot, "replay-plan.template.json");
const outputPath = path.join(l4cRoot, "replay-plan.json");
const environmentPath = path.join(repositoryRoot, "zboss-l4c.runtime.env.local");
const contractPath = path.join(
  caseRoot,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const promotionRoot = path.join(l4cRoot, "scenario-promotion");
const packageRoot = path.join(promotionRoot, "packages");
const manifestPath = path.join(promotionRoot, "manifest.json");
const technicalReviewPath = path.join(promotionRoot, "technical-review.json");
const fixtureRoot = path.join(
  caseRoot,
  "fixtures",
  "java-runtime",
  entrypointId,
);
const draftRoot = path.join(
  caseRoot,
  "fixtures",
  "java-runtime-drafts",
  entrypointId,
);

const FIRST_WAVE = [
  "primary-success",
  "validation-failure",
  "batch-partial-failure",
  "dependency-failure",
  "concurrent-write",
];

const options = parseArguments(process.argv.slice(2));
const contract = await readJson(contractPath);
const template = await readJson(templatePath);
const entry = contract.entries.find((item) => item.id === entrypointId);
if (!entry) throw new Error(`runtime scenario entry is missing: ${entrypointId}`);

const contractScenarioIds = entry.scenarios.map((scenario) => scenario.id);
const selectedScenarioIds = selectScenarios(options, contractScenarioIds);
const bindingPath = resolveRepositoryPath(
  options.bindingFile
    ?? (options.firstWave
      ? "cases/zboss-batch-update-with-progress/evidence/runtime/l4c/bindings.primary-success.approved.json"
      : "cases/zboss-batch-update-with-progress/evidence/runtime/l4c/bindings.full.approved.json"),
  "binding file",
);
const stateProfilePath = resolveRepositoryPath(
  options.stateProfile
    ?? (options.firstWave
      ? "cases/zboss-batch-update-with-progress/evidence/runtime/l4c/java-state-profile.primary-success.approved.json"
      : "cases/zboss-batch-update-with-progress/evidence/runtime/l4c/java-state-profile.full.approved.json"),
  "state profile",
);

const archivedPaths = [];
if (options.replace) {
  for (const [file, label] of [
    [outputPath, "approved replay plan"],
    [environmentPath, "local runtime environment"],
  ]) {
    const archived = await archiveIfPresent(file, label);
    if (archived) archivedPaths.push(archived);
  }
} else {
  await requireAbsent(outputPath, "approved replay plan");
  await requireAbsent(environmentPath, "local runtime environment");
}

const binding = await readJson(bindingPath);
const stateProfile = await readJson(stateProfilePath);
const stateProfileHash = await canonicalFileHash(stateProfilePath);
const promotion = await readPromotionEvidence(
  selectedScenarioIds,
  contract,
);
const scope = buildScope(template.scope, promotion.fixtures);
const nonce = randomBytes(32).toString("hex");
const plan = structuredClone(template);
Object.assign(plan, {
  status: "approved",
  projectId: contract.projectId,
  projectHash: contract.projectHash,
  runtimeContractHash: contract.contractHash,
  approval: {
    mode: "disposable-test-write",
    approvedBy: promotion.approvedBy,
    ticket: options.ticket,
    approvedAt: promotion.approvedAt,
    expiresAt: promotion.expiresAt,
    executionNonceSha256: stableHash(nonce),
  },
  scope,
  scenarios: selectedScenarioIds,
});
plan.requiredEnvironment = unique([
  ...plan.requiredEnvironment,
  "MG_L4C_BINDING_FILE",
  "MG_L4C_JAVA_STATE_PROFILE",
]);
plan.environmentValueBindings = unique([
  ...plan.environmentValueBindings,
  "MG_JAVA_USER_ID",
]);
plan.normalization = {
  ...plan.normalization,
  supportedScenarios: selectedScenarioIds,
};
plan.targets.source.baseUrl = template.targets.source.baseUrl;
plan.targets.target.baseUrl = template.targets.target.baseUrl;

const validation = validateReplayPlan(plan, contract, {
  repositoryRoot,
  allowPartialScenarios: !isCompleteScenarioSet(selectedScenarioIds, contractScenarioIds),
});
if (validation.findings.length > 0) {
  throw new Error(validation.findings.join(", "));
}
validateBindingSelection(
  binding,
  selectedScenarioIds,
  contract,
  stateProfileHash,
);
validateStateProfileSelection(stateProfile, selectedScenarioIds);

const environment = [
  "# Local-only L4-C execution values. This file is ignored by Git.",
  `MG_L4C_APPROVAL_NONCE=${nonce}`,
  "MG_L4C_REAL_WRITE_APPROVED=zboss-batch-update-with-progress:disposable-write",
  `MG_L4C_BINDING_FILE=${relative(bindingPath)}`,
  `MG_L4C_JAVA_STATE_PROFILE=${relative(stateProfilePath)}`,
  "MG_L4C_DATASOURCE=zz_boss_test",
  "",
  "# Add these values locally before connected preflight:",
  "# MG_JAVA_TOKEN=",
  "# MG_JAVA_USER_ID=",
  "# MG_JAVA_DATABASE_URL=",
  "# ZBOSS_BATCH_UPDATE_MYSQL_URL=",
  "# ZBOSS_BATCH_UPDATE_REDIS_URL=",
  "",
].join("\n");

await writeFile(environmentPath, environment, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
try {
  await chmod(environmentPath, 0o600);
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
} catch (error) {
  throw new Error(`write approved replay assets: ${safeMessage(error)}`);
}

console.log(JSON.stringify({
  status: "approved",
  ticket: options.ticket,
  approvedBy: plan.approval.approvedBy,
  expiresAt: plan.approval.expiresAt,
  wave: options.firstWave ? "sh3c-first-wave" : "complete-contract",
  scenarioCount: selectedScenarioIds.length,
  completeScenarioSet: isCompleteScenarioSet(
    selectedScenarioIds,
    contractScenarioIds,
  ),
  scenarios: selectedScenarioIds,
  planPath: relative(outputPath),
  environmentPath: relative(environmentPath),
  bindingPath: relative(bindingPath),
  stateProfilePath: relative(stateProfilePath),
  archivedPaths,
  noncePersistedLocally: true,
  noncePrinted: false,
}, null, 2));

function parseArguments(arguments_) {
  const result = {
    bindingFile: undefined,
    firstWave: false,
    replace: false,
    scenarios: [],
    stateProfile: undefined,
    ticket: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--first-wave") result.firstWave = true;
    else if (argument === "--scenario") {
      result.scenarios.push(requiredArgument(arguments_, ++index, argument));
    } else if (argument === "--binding-file") {
      result.bindingFile = requiredArgument(arguments_, ++index, argument);
    } else if (argument === "--state-profile") {
      result.stateProfile = requiredArgument(arguments_, ++index, argument);
    } else if (argument === "--ticket") {
      result.ticket = requiredArgument(arguments_, ++index, argument);
    } else if (argument === "--replace") {
      result.replace = true;
    } else if (argument === "--help" || argument === "-h") {
      console.log(renderHelp());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!result.ticket || result.ticket.startsWith("--")) {
    throw new Error("--ticket is required");
  }
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(result.ticket)) {
    throw new Error("--ticket has an unsafe format");
  }
  if (result.firstWave && result.scenarios.length > 0) {
    throw new Error("--first-wave and --scenario are mutually exclusive");
  }
  return result;
}

function selectScenarios(options_, contractScenarioIds_) {
  const selected = options_.firstWave
    ? FIRST_WAVE
    : options_.scenarios.length > 0
      ? options_.scenarios
      : contractScenarioIds_;
  if (new Set(selected).size !== selected.length) {
    throw new Error("selected scenarios must be unique");
  }
  const unknown = selected.filter((id) => !contractScenarioIds_.includes(id));
  if (unknown.length > 0) {
    throw new Error(`unknown scenarios: ${unknown.join(",")}`);
  }
  return selected;
}

async function readPromotionEvidence(scenarioIds, contractValue) {
  const manifest = await readJson(manifestPath);
  const technicalReview = await readJson(technicalReviewPath);
  if (manifest.projectId !== contractValue.projectId
    || manifest.projectHash !== contractValue.projectHash
    || manifest.runtimeContractHash !== contractValue.contractHash) {
    throw new Error("promotion manifest is bound to a different runtime contract");
  }
  if (technicalReview.status !== "ready-for-human-approval"
    || technicalReview.humanApprovalClaimed !== false) {
    throw new Error("promotion technical review is not ready for human approval");
  }
  const fixtures = [];
  for (const scenarioId of scenarioIds) {
    const packageValue = await readJson(path.join(packageRoot, `${scenarioId}.json`));
    const reference = manifest.packages?.find((item) => item.scenarioId === scenarioId);
    if (
      !reference
      || reference.hash !== packageValue.packageHash
      || packageValue.status !== "promoted"
      || packageValue.realEvidenceEligible !== true
      || packageValue.blockers?.length !== 0
      || packageValue.formalPromotion?.status !== "promoted"
    ) {
      throw new Error(`scenario is not formally promoted: ${scenarioId}`);
    }
    const fixturePath = path.join(fixtureRoot, `${scenarioId}.json`);
    const draftPath = path.join(draftRoot, scenarioId, "fixture.draft.json");
    const fixture = await readJson(fixturePath);
    const draft = await readJson(draftPath);
    validatePromotedFixture(fixture, draft, contractValue, scenarioId);
    if (packageValue.formalPromotion.fixtureSha256 !== stableHash(fixture)) {
      throw new Error(`promotion fixture hash mismatch: ${scenarioId}`);
    }
    fixtures.push(fixture);
  }
  const approvedBy = fixtures[0]?.authoring?.reviewedBy;
  const approvedAt = Math.max(...fixtures.map((fixture) =>
    Date.parse(fixture.authoring.reviewedAt)));
  const expiresAt = Math.min(...fixtures.map((fixture) =>
    Date.parse(fixture.writeSafety.expiresAt)));
  if (!approvedBy || fixtures.some((fixture) =>
    fixture.authoring.reviewedBy !== approvedBy)) {
    throw new Error("selected fixtures do not share one reviewer identity");
  }
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("selected fixtures have invalid approval timestamps");
  }
  if (expiresAt <= Date.now() || expiresAt <= approvedAt) {
    throw new Error("selected disposable-write approval is expired or invalid");
  }
  return {
    approvedAt: new Date(approvedAt).toISOString(),
    approvedBy,
    expiresAt: new Date(expiresAt).toISOString(),
    fixtures,
  };
}

function validatePromotedFixture(fixture, draft, contractValue, scenarioId) {
  if (
    fixture?.schemaVersion !== 1
    || fixture.fixtureKind !== "real-runtime"
    || fixture.status !== "ready"
    || fixture.realEvidenceEligible !== true
    || fixture.projectId !== contractValue.projectId
    || fixture.projectHash !== contractValue.projectHash
    || fixture.entrypointId !== entrypointId
    || fixture.scenarioId !== scenarioId
    || fixture.authoring?.reviewed !== true
    || typeof fixture.authoring.reviewedBy !== "string"
    || !fixture.authoring.reviewedBy.trim()
    || fixture.authoring.sourceDraftHash !== stableHash(draft)
  ) {
    throw new Error(`promoted fixture provenance is invalid: ${scenarioId}`);
  }
  const safety = fixture.writeSafety;
  if (
    safety?.mode !== "disposable"
    || safety.disposable !== true
    || safety.writeApproved !== true
    || !Array.isArray(safety.allowedTenantIds)
    || safety.allowedTenantIds.length === 0
    || !Array.isArray(safety.allowedPanelIds)
    || safety.allowedPanelIds.length === 0
    || !Array.isArray(safety.allowedTables)
    || safety.allowedTables.length === 0
    || !Number.isInteger(safety.maxAffectedRows)
    || safety.maxAffectedRows < 1
    || !safety.cleanupVerificationRequired
  ) {
    throw new Error(`promoted fixture write scope is invalid: ${scenarioId}`);
  }
}

function buildScope(templateScope, fixtures) {
  const first = fixtures[0]?.writeSafety;
  const table = first?.allowedTables?.find((value) => /^cust_table\d+$/.test(value));
  if (!first || !table) throw new Error("promoted fixtures have no safe projection table");
  const sameScope = fixtures.every((fixture) => {
    const safety = fixture.writeSafety;
    return safety.allowedTenantIds[0] === first.allowedTenantIds[0]
      && safety.allowedPanelIds[0] === first.allowedPanelIds[0]
      && safety.allowedTables.includes(table)
      && safety.maxAffectedRows === first.maxAffectedRows;
  });
  if (!sameScope) throw new Error("selected fixtures do not share one disposable write scope");
  return {
    ...templateScope,
    tenantId: first.allowedTenantIds[0],
    panelId: first.allowedPanelIds[0],
    table,
    maxRowsPerScenario: first.maxAffectedRows,
    schemaChangesAllowed: false,
  };
}

function validateBindingSelection(
  binding,
  scenarioIds,
  contractValue,
  stateProfileHash,
) {
  if (binding?.status !== "approved"
    || binding.projectId !== contractValue.projectId
    || binding.targets?.source?.stateProfileSha256 !== stateProfileHash
    || scenarioIds.some((scenarioId) => !binding.scenarios?.[scenarioId])) {
    throw new Error("binding file does not cover the selected promoted scenarios");
  }
}

function validateStateProfileSelection(profile, scenarioIds) {
  if (profile?.status !== "approved"
    || scenarioIds.some((scenarioId) =>
      !profile.applicableScenarios?.includes(scenarioId))) {
    throw new Error("state profile does not cover the selected promoted scenarios");
  }
}

function isCompleteScenarioSet(selected, contractScenarioIds) {
  return selected.length === contractScenarioIds.length
    && selected.every((scenarioId, index) => scenarioId === contractScenarioIds[index]);
}

function unique(values) {
  return [...new Set(values)];
}

function requiredArgument(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function renderHelp() {
  return `Author an L4-C replay plan from formally promoted fixtures.

First-wave pilot plan:
  node l4c-plan-author.mjs --first-wave --ticket <approval-ticket>

Complete contract plan:
  node l4c-plan-author.mjs --ticket <approval-ticket> \\
    --binding-file <full-binding.json> --state-profile <full-profile.json>

Select an explicit scenario set with repeatable --scenario. All selected
scenarios must be formally promoted, share one disposable write scope and use
an unexpired approval. A first-wave plan is intentionally not a complete
19-scenario L4-C plan and cannot claim final real eligibility.

Use --replace only to archive an existing stale plan and local environment
before writing a newly approved plan; backups remain in place.`;
}

async function requireAbsent(file, label) {
  try {
    await access(file);
    throw new Error(`${label} already exists: ${relative(file)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function archiveIfPresent(file, label) {
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const backup = `${file}.stale-${Date.now()}`;
  await rename(file, backup);
  return `${label}: ${relative(backup)}`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function canonicalFileHash(file) {
  const content = await readFile(file, "utf8");
  return createHash("sha256")
    .update(content.replaceAll("\r\n", "\n"))
    .digest("hex");
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function resolveRepositoryPath(value, label) {
  const candidate = path.resolve(repositoryRoot, value);
  const relativePath = path.relative(repositoryRoot, candidate);
  if (
    relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must remain inside the repository`);
  }
  return candidate;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
