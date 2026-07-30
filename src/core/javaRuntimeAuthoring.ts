import path from "node:path";
import {
  pathExists,
  readJsonFile,
  toPosixPath,
  writeJsonFile,
  writeTextFile
} from "./files.js";
import { sha256 } from "./hash.js";
import {
  containsSensitiveKey,
  validateMigrationFixture,
  type MigrationCollectorKind,
  type MigrationFixtureMetadata
} from "./migrationFixture.js";
import {
  loadMigrationProject,
  migrationProjectHash,
  type MigrationProjectPackage
} from "./migrationProject.js";
import { stableStringify } from "./normalize.js";
import {
  containsRuntimeAuthoringPlaceholder,
  validateRuntimeCollectorSpec,
  type RuntimeCollectorSpec
} from "./runtimeCollectors.js";
import type { JavaRuntimeContract, JavaRuntimeEntryContract } from "./javaRuntimeEvidence.js";

const RUNTIME_CONTRACT = path.join("evidence", "runtime", "java", "runtime-contract.json");
const AUTHORING_REPORT = path.join("evidence", "runtime", "java", "authoring-report.json");
const ENVIRONMENT_CONTRACT = path.join("evidence", "runtime", "java", "environment-contract.json");
const ENVIRONMENT_EXAMPLE = path.join("evidence", "runtime", "java", ".env.example");

export interface JavaRuntimeEnvironmentContract {
  version: 1;
  projectId: string;
  projectHash: string;
  variables: Array<{
    name: string;
    required: true;
    sensitive: boolean;
    purpose: "driver-operation" | "database" | "redis" | "runtime";
  }>;
  contractHash: string;
}

export interface JavaRuntimeAuthoringScenario {
  entrypointId: string;
  scenarioId: string;
  draftFixture: string;
  requiredCollectors: MigrationCollectorKind[];
  collectorSpecs: Partial<Record<MigrationCollectorKind, string>>;
  placeholderFindings: string[];
  promotable: boolean;
}

export interface JavaRuntimeAuthoringReport {
  version: 1;
  generatedAt: string;
  projectId: string;
  projectHash: string;
  contractHash: string;
  scenarioCount: number;
  draftCount: number;
  authoringReady: boolean;
  environmentContract: string;
  environmentExample: string;
  deploymentObservation?: {
    path: string;
    hash: string;
  };
  scenarios: JavaRuntimeAuthoringScenario[];
  findings: string[];
}

export interface JavaRuntimeFixturePromotion {
  status: "promoted";
  projectId: string;
  entrypointId: string;
  scenarioId: string;
  reviewedBy: string;
  fixturePath: string;
  fixtureHash: string;
  collectorSpecs: Partial<Record<MigrationCollectorKind, { path: string; hash: string }>>;
}

export async function prepareJavaRuntimeAuthoring(
  caseDir: string,
  force = false
): Promise<JavaRuntimeAuthoringReport> {
  const pkg = await loadMigrationProject(caseDir);
  const contractPath = path.join(pkg.caseDir, RUNTIME_CONTRACT);
  if (!await pathExists(contractPath)) {
    throw new Error("Java runtime contract is missing; run migrate runtime-prepare first.");
  }
  const contract = await readJsonFile<JavaRuntimeContract>(contractPath);
  if (contract.projectHash !== migrationProjectHash(pkg)) {
    throw new Error("Java runtime contract is stale; run migrate runtime-prepare first.");
  }
  const environment = createEnvironmentContract(pkg, contract);
  const environmentPath = path.join(pkg.caseDir, ENVIRONMENT_CONTRACT);
  await writeJsonFile(environmentPath, environment);
  await writeTextFile(path.join(pkg.caseDir, ENVIRONMENT_EXAMPLE), renderEnvironmentExample(environment));

  const scenarios: JavaRuntimeAuthoringScenario[] = [];
  for (const entry of contract.entries) {
    for (const scenario of entry.scenarios) {
      const templatePath = safeCasePath(pkg, scenario.fixtureTemplate.path);
      const template = await readJsonFile<Record<string, unknown>>(templatePath);
      const draftDir = path.join(
        pkg.fixturesDir,
        "java-runtime-drafts",
        safeSegment(entry.id),
        safeSegment(scenario.id)
      );
      const collectorSpecs: JavaRuntimeAuthoringScenario["collectorSpecs"] = {};
      const collectorReferences: MigrationFixtureMetadata["collectorSpecs"] = {};
      const placeholderFindings: string[] = [];
      const requiredCollectors = scenario.requiredCollectors ?? entry.requiredCollectors;
      for (const collector of requiredCollectors) {
        const templateReference = contract.collectorTemplates[collector];
        if (!templateReference) {
          placeholderFindings.push(`MG-JAVA-AUTHORING-COLLECTOR-TEMPLATE-MISSING:${collector}`);
          continue;
        }
        const collectorTemplate = await readJsonFile<RuntimeCollectorSpec>(
          safeCasePath(pkg, templateReference.path)
        );
        const draftSpec = createCollectorDraft(collectorTemplate, entry.id, scenario.id);
        const specPath = path.join(draftDir, "collectors", `${collector}.draft.json`);
        if (force || !await pathExists(specPath)) await writeJsonFile(specPath, draftSpec);
        const persistedSpec = await readJsonFile<RuntimeCollectorSpec>(specPath);
        const relative = toPosixPath(path.relative(pkg.caseDir, specPath));
        collectorSpecs[collector] = relative;
        collectorReferences![collector] = {
          path: relative,
          hash: sha256(stableStringify(persistedSpec))
        };
        placeholderFindings.push(...validateRuntimeCollectorSpec(persistedSpec, { requireReady: false })
          .map((finding) => `${collector}:${finding}`));
      }
      const fixturePath = path.join(draftDir, "fixture.draft.json");
      const generatedDraft = createFixtureDraft(pkg, template, entry, scenario.id, collectorReferences);
      if (force || !await pathExists(fixturePath)) await writeJsonFile(fixturePath, generatedDraft);
      else {
        const existingDraft = await readJsonFile<Record<string, unknown>>(fixturePath);
        await writeJsonFile(fixturePath, refreshFixtureDraft(existingDraft, generatedDraft));
      }
      const persistedFixture = await readJsonFile<unknown>(fixturePath);
      placeholderFindings.push(...fixtureAuthoringFindings(persistedFixture));
      scenarios.push({
        entrypointId: entry.id,
        scenarioId: scenario.id,
        draftFixture: toPosixPath(path.relative(pkg.caseDir, fixturePath)),
        requiredCollectors: [...requiredCollectors],
        collectorSpecs,
        placeholderFindings: [...new Set(placeholderFindings)].sort(),
        promotable: placeholderFindings.length === 0
      });
    }
  }
  const findings: string[] = [];
  if (scenarios.length === 0) findings.push("MG-JAVA-AUTHORING-SCENARIOS-MISSING");
  if (scenarios.length !== contract.entries.reduce((sum, entry) => sum + entry.scenarios.length, 0)) {
    findings.push("MG-JAVA-AUTHORING-DRAFT-COVERAGE-INCOMPLETE");
  }
  const deploymentObservationPath = path.join(pkg.caseDir, "evidence", "runtime", "java", "deployment-observation.json");
  let deploymentObservation: JavaRuntimeAuthoringReport["deploymentObservation"];
  if (await pathExists(deploymentObservationPath)) {
    const observation = await readJsonFile<Record<string, unknown>>(deploymentObservationPath);
    findings.push(...validateDeploymentObservation(observation));
    deploymentObservation = {
      path: toPosixPath(path.relative(pkg.caseDir, deploymentObservationPath)),
      hash: sha256(stableStringify(observation))
    };
  }
  const report: JavaRuntimeAuthoringReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    contractHash: contract.contractHash,
    scenarioCount: scenarios.length,
    draftCount: scenarios.length,
    authoringReady: findings.length === 0,
    environmentContract: toPosixPath(path.relative(pkg.caseDir, environmentPath)),
    environmentExample: ENVIRONMENT_EXAMPLE.replaceAll("\\", "/"),
    deploymentObservation,
    scenarios,
    findings
  };
  await writeJsonFile(path.join(pkg.caseDir, AUTHORING_REPORT), report);
  return report;
}

export async function inspectJavaRuntimeAuthoring(
  pkg: MigrationProjectPackage,
  contract: JavaRuntimeContract
): Promise<{ ready: boolean; findings: string[] }> {
  const findings: string[] = [];
  const reportPath = path.join(pkg.caseDir, AUTHORING_REPORT);
  const environmentPath = path.join(pkg.caseDir, ENVIRONMENT_CONTRACT);
  const examplePath = path.join(pkg.caseDir, ENVIRONMENT_EXAMPLE);
  if (!await pathExists(reportPath)) return { ready: false, findings: ["MG-JAVA-AUTHORING-REPORT-MISSING"] };
  const report = await readJsonFile<JavaRuntimeAuthoringReport>(reportPath);
  if (report.projectHash !== migrationProjectHash(pkg)) findings.push("MG-JAVA-AUTHORING-PROJECT-HASH-MISMATCH");
  if (report.contractHash !== contract.contractHash) findings.push("MG-JAVA-AUTHORING-CONTRACT-HASH-MISMATCH");
  const expectedCount = contract.entries.reduce((sum, entry) => sum + entry.scenarios.length, 0);
  if (report.scenarioCount !== expectedCount || report.draftCount !== expectedCount) {
    findings.push("MG-JAVA-AUTHORING-DRAFT-COVERAGE-INCOMPLETE");
  }
  if (!await pathExists(environmentPath)) findings.push("MG-JAVA-AUTHORING-ENV-CONTRACT-MISSING");
  if (!await pathExists(examplePath)) findings.push("MG-JAVA-AUTHORING-ENV-EXAMPLE-MISSING");
  if (report.deploymentObservation) {
    const observationPath = safeCasePath(pkg, report.deploymentObservation.path);
    if (!await pathExists(observationPath)) {
      findings.push("MG-JAVA-AUTHORING-DEPLOYMENT-OBSERVATION-MISSING");
    } else {
      const observation = await readJsonFile<Record<string, unknown>>(observationPath);
      findings.push(...validateDeploymentObservation(observation));
      if (sha256(stableStringify(observation)) !== report.deploymentObservation.hash) {
        findings.push("MG-JAVA-AUTHORING-DEPLOYMENT-OBSERVATION-HASH-MISMATCH");
      }
    }
  }
  for (const scenario of report.scenarios ?? []) {
    if (!await pathExists(safeCasePath(pkg, scenario.draftFixture))) {
      findings.push(`MG-JAVA-AUTHORING-DRAFT-MISSING:${scenario.entrypointId}:${scenario.scenarioId}`);
    }
  }
  return { ready: report.authoringReady && findings.length === 0, findings: [...new Set(findings)].sort() };
}

export async function promoteJavaRuntimeFixture(
  caseDir: string,
  entrypointId: string,
  scenarioId: string,
  reviewedBy: string,
  force = false
): Promise<JavaRuntimeFixturePromotion> {
  if (!reviewedBy.trim()) throw new Error("Fixture promotion requires a non-empty reviewer identity.");
  const pkg = await loadMigrationProject(caseDir);
  const contract = await readJsonFile<JavaRuntimeContract>(path.join(pkg.caseDir, RUNTIME_CONTRACT));
  const entry = contract.entries.find((item) => item.id === entrypointId);
  const scenario = entry?.scenarios.find((item) => item.id === scenarioId);
  if (!entry || !scenario) throw new Error(`Unknown Java runtime scenario: ${entrypointId}/${scenarioId}.`);
  const draftPath = path.join(
    pkg.fixturesDir, "java-runtime-drafts", safeSegment(entrypointId), safeSegment(scenarioId), "fixture.draft.json"
  );
  if (!await pathExists(draftPath)) throw new Error(`Java runtime fixture draft is missing: ${draftPath}.`);
  const draft = await readJsonFile<Record<string, unknown>>(draftPath);
  const findings = fixtureAuthoringFindings(draft);
  const collectorSpecs: JavaRuntimeFixturePromotion["collectorSpecs"] = {};
  const validatedSpecs: Partial<Record<MigrationCollectorKind, RuntimeCollectorSpec>> = {};
  const references = (draft.collectorSpecs ?? {}) as MigrationFixtureMetadata["collectorSpecs"];
  const requiredCollectors = scenario.requiredCollectors ?? entry.requiredCollectors;
  for (const collector of requiredCollectors) {
    const reference = references?.[collector];
    if (!reference) {
      findings.push(`MG-FIXTURE-COLLECTOR-SPEC-MISSING:${collector}`);
      continue;
    }
    const specPath = safeCasePath(pkg, reference.path);
    if (!await pathExists(specPath)) {
      findings.push(`MG-COLLECTOR-SPEC-MISSING:${collector}`);
      continue;
    }
    const spec = await readJsonFile<RuntimeCollectorSpec>(specPath);
    findings.push(...validateRuntimeCollectorSpec(spec).map((finding) => `${collector}:${finding}`));
    validatedSpecs[collector] = spec;
  }
  if (findings.length) {
    throw new Error(`Java runtime fixture is not promotable: ${[...new Set(findings)].sort().join(", ")}.`);
  }
  const outputDir = path.join(pkg.fixturesDir, "java-runtime", safeSegment(entrypointId));
  const outputPath = path.join(outputDir, `${safeSegment(scenarioId)}.json`);
  const collectorOutputDir = path.join(outputDir, `${safeSegment(scenarioId)}.collectors`);
  if (await pathExists(outputPath) && !force) {
    throw new Error(`Real runtime fixture already exists: ${outputPath}. Use --force to replace it.`);
  }
  for (const collector of requiredCollectors) {
    const spec = validatedSpecs[collector]!;
    const frozenPath = path.join(collectorOutputDir, `${collector}.json`);
    if (await pathExists(frozenPath) && !force) {
      throw new Error(`Frozen runtime collector already exists: ${frozenPath}. Use --force to replace it.`);
    }
    await writeJsonFile(frozenPath, spec);
    collectorSpecs[collector] = {
      path: toPosixPath(path.relative(pkg.caseDir, frozenPath)),
      hash: sha256(stableStringify(spec))
    };
  }
  const reviewedAt = new Date().toISOString();
  const realFixture = {
    ...draft,
    fixtureKind: "real-runtime",
    status: "ready",
    realEvidenceEligible: true,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    entrypointId,
    scenarioId,
    collectorSpecs,
    authoring: {
      reviewed: true,
      reviewedBy: reviewedBy.trim(),
      reviewedAt,
      sourceDraftHash: sha256(stableStringify(draft))
    }
  };
  const validation = validateMigrationFixture(realFixture, {
    kind: "real-runtime",
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    entrypointId,
    scenarioId,
    batch: scenario.semanticGates?.includes("batch") ?? (entry.workload === "batch"),
    page: scenario.semanticGates?.includes("page") ?? false,
    writeSafety: scenario.semanticGates?.includes("batch") ?? (entry.workload === "batch"),
    collectors: requiredCollectors
  });
  if (validation.length) throw new Error(`Promoted Java runtime fixture is invalid: ${validation.join(", ")}.`);
  await writeJsonFile(outputPath, realFixture);
  return {
    status: "promoted",
    projectId: pkg.profile.projectId,
    entrypointId,
    scenarioId,
    reviewedBy: reviewedBy.trim(),
    fixturePath: outputPath,
    fixtureHash: sha256(stableStringify(realFixture)),
    collectorSpecs
  };
}

function createFixtureDraft(
  pkg: MigrationProjectPackage,
  template: Record<string, unknown>,
  entry: JavaRuntimeEntryContract,
  scenarioId: string,
  collectorSpecs: MigrationFixtureMetadata["collectorSpecs"]
): Record<string, unknown> {
  const draft: Record<string, unknown> = {
    ...template,
    schemaVersion: 1,
    fixtureKind: "draft-runtime",
    status: "draft",
    realEvidenceEligible: false,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    entrypointId: entry.id,
    scenarioId,
    request: redactSensitiveKeys(template.request),
    environmentBindings: [
      { path: "request.headers.authorization", environment: "MG_JAVA_TOKEN" }
    ],
    collectorSpecs,
    authoring: {
      reviewed: false,
      instructions: "Replace request and collector placeholders, set collector specs to ready, then run runtime-fixture-promote."
    }
  };
  delete draft.secrets;
  return draft;
}

function refreshFixtureDraft(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>
): Record<string, unknown> {
  const contractOwnedFields = [
    "schemaVersion",
    "fixtureKind",
    "status",
    "realEvidenceEligible",
    "projectId",
    "projectHash",
    "entrypointId",
    "scenarioId",
    "requestFocus",
    "expectedComparison",
    "requiredDimensions",
    "expectations",
    "compatibilityDecisionIds",
    "collectorSpecs"
  ];
  const refreshed = { ...existing };
  for (const field of contractOwnedFields) {
    if (generated[field] === undefined) delete refreshed[field];
    else refreshed[field] = generated[field];
  }
  return refreshed;
}

function createCollectorDraft(
  template: RuntimeCollectorSpec,
  entrypointId: string,
  scenarioId: string
): RuntimeCollectorSpec {
  if (template.collector === "events"
    || template.collector === "sql-trace"
    || template.collector === "ai-trace"
    || template.collector === "stream-trace"
    || template.collector === "tool-trace") {
    const folders: Record<typeof template.collector, string> = {
      events: "events",
      "sql-trace": "sql-traces",
      "ai-trace": "ai-traces",
      "stream-trace": "stream-traces",
      "tool-trace": "tool-traces"
    };
    return {
      ...template,
      status: "draft",
      scenarioId,
      file: `evidence/runtime/java/${folders[template.collector]}/${safeSegment(entrypointId)}/${safeSegment(scenarioId)}.jsonl`
    };
  }
  return { ...template, status: "draft" };
}

function fixtureAuthoringFindings(value: unknown): string[] {
  const findings = validateMigrationFixture(value, { kind: "draft-runtime" });
  if (containsSensitiveKey(value)) findings.push("MG-JAVA-AUTHORING-SENSITIVE-CONTENT");
  const request = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).request
    : undefined;
  if (containsRuntimeAuthoringPlaceholder(request)) findings.push("MG-JAVA-AUTHORING-REQUEST-PLACEHOLDER");
  return [...new Set(findings)].sort();
}

function createEnvironmentContract(
  pkg: MigrationProjectPackage,
  contract: JavaRuntimeContract
): JavaRuntimeEnvironmentContract {
  const variables = contract.requiredEnvironment.map((name) => ({
    name,
    required: true as const,
    sensitive: /TOKEN|PASSWORD|SECRET|DATABASE_URL|REDIS_URL/i.test(name),
    purpose: environmentPurpose(name)
  }));
  const base = {
    version: 1 as const,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    variables
  };
  return { ...base, contractHash: sha256(stableStringify(base)) };
}

function environmentPurpose(name: string): JavaRuntimeEnvironmentContract["variables"][number]["purpose"] {
  if (name === "MG_JAVA_DATABASE_URL") return "database";
  if (name === "MG_JAVA_REDIS_URL") return "redis";
  if (name.startsWith("MG_JAVA_") && name.endsWith("_CMD")) return "driver-operation";
  return "runtime";
}

function renderEnvironmentExample(contract: JavaRuntimeEnvironmentContract): string {
  return [
    "# Generated by migration-guard. Keep real credentials out of this file.",
    ...contract.variables.map((variable) =>
      `${variable.name}=${variable.sensitive ? "" : `<${variable.purpose}>`}`
    ),
    ""
  ].join("\n");
}

function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/authorization|token|cookie|password|phone|mobile|secret|api[-_]?key/i.test(key))
    .map(([key, item]) => [key, redactSensitiveKeys(item)]));
}

function validateDeploymentObservation(value: Record<string, unknown>): string[] {
  const findings: string[] = [];
  if (value.schemaVersion !== 1) findings.push("MG-JAVA-DEPLOYMENT-OBSERVATION-VERSION-UNSUPPORTED");
  if (value.protocol !== "migration-guard.runtime-environment-observation/v1") {
    findings.push("MG-JAVA-DEPLOYMENT-OBSERVATION-PROTOCOL-INVALID");
  }
  if (value.redactionComplete !== true) findings.push("MG-JAVA-DEPLOYMENT-OBSERVATION-REDACTION-UNDECLARED");
  if (containsSensitiveKey(value)) findings.push("MG-JAVA-DEPLOYMENT-OBSERVATION-SENSITIVE-CONTENT");
  return findings;
}

function safeCasePath(pkg: MigrationProjectPackage, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Unsafe case-relative path: ${relativePath}.`);
  const resolved = path.resolve(pkg.caseDir, relativePath);
  const relative = path.relative(pkg.caseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes case directory: ${relativePath}.`);
  return resolved;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
