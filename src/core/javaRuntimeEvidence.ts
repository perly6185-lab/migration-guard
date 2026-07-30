import path from "node:path";
import {
  captureAssessmentSourceIdentity,
  type AssessmentSourceIdentity
} from "./assessmentSourceIdentity.js";
import type { JavaEndpointAnalysisReport } from "./javaEndpointAnalysis.js";
import type {
  EndpointReplacementEvidence,
  EndpointReplacementPlan,
  EndpointWorkloadKind,
  ReplacementScenario
} from "./endpointReplacementModel.js";
import { pathExists, readJsonFile, toPosixPath, writeJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import {
  loadMigrationProject,
  migrationProjectHash,
  resolveMigrationProjectPath,
  type MigrationProjectPackage
} from "./migrationProject.js";
import type { MigrationAnalyzeResult } from "./migrationWorkflow.js";
import { stableStringify } from "./normalize.js";
import type { EndpointRuntimeDriverResult } from "./endpointReplacementRuntime.js";
import {
  runEndpointRuntimeDriver,
  type EndpointRuntimeDriverConfig
} from "./endpointReplacementRuntime.js";
import {
  classifyMigrationFixture,
  containsSensitiveKey,
  validateMigrationFixture,
  type MigrationFixtureMetadata
} from "./migrationFixture.js";
import {
  gateBatchEvidence,
  type BatchEvidenceInput
} from "./vmpBatch.js";
import {
  gatePageEvidence,
  type PageEvidenceInput,
  type PageGateRequirements
} from "./pageRuntimeEvidence.js";
import {
  gateQueryEvidence,
  type QueryGateRequirements,
  type QueryRuntimeEvidenceInput
} from "./queryRuntimeEvidence.js";
import {
  collectRuntimeEvidence,
  validateRuntimeCollectorEvidence,
  type RuntimeCollectorEvidence,
  type RuntimeCollectorKind,
  type RuntimeCollectorSpec
} from "./runtimeCollectors.js";
import { inspectJavaRuntimeAuthoring } from "./javaRuntimeAuthoring.js";
import {
  validateRuntimeCorrelationTrace,
  type RuntimeCorrelationTrace
} from "./runtimeCorrelation.js";
import {
  assertReferenceSourceSnapshotUnchanged,
  captureReferenceSourceSnapshot,
  referenceSourceSnapshotsEqual,
  type ReferenceSourceSnapshot
} from "./referenceSourceGuard.js";

const RUNTIME_OPERATIONS = [
  "setup", "start", "health", "seed", "invoke", "inject-fault",
  "snapshot", "collect", "cleanup", "stop"
] as const;
const REQUIRED_RUNTIME_OPERATIONS = RUNTIME_OPERATIONS.filter((item) => item !== "inject-fault");

const RUNTIME_DIR = ["runtime", "java"] as const;
const CONTRACT_FILE = "runtime-contract.json";
const DRIVER_TEMPLATE_FILE = "driver.template.json";
const EVIDENCE_SCHEMA_FILE = "runtime-evidence.schema.json";

export type JavaRuntimeEvidenceKind = "synthetic" | "real";

export interface JavaRuntimeArtifactReference {
  path: string;
  hash: string;
}

export interface JavaRuntimeScenarioContract {
  id: string;
  title: string;
  category: ReplacementScenario["category"];
  requiredDimensions: ReplacementScenario["requiredDimensions"];
  requiredCollectors: RuntimeCollectorKind[];
  semanticGates: Array<"batch" | "page" | "query">;
  decisionIds: string[];
  fixtureTemplate: JavaRuntimeArtifactReference;
}

export interface JavaRuntimeEntryContract {
  id: string;
  method?: string;
  path?: string;
  workload: EndpointWorkloadKind;
  requiredCollectors: RuntimeCollectorKind[];
  analysisHash: string;
  planHash: string;
  scenarios: JavaRuntimeScenarioContract[];
}

export interface JavaRuntimeContract {
  version: 1;
  generatedAt: string;
  projectId: string;
  projectHash: string;
  sourceIdentity: AssessmentSourceIdentity;
  sourceSnapshot: ReferenceSourceSnapshot;
  entries: JavaRuntimeEntryContract[];
  requiredEnvironment: string[];
  driverTemplate: JavaRuntimeArtifactReference;
  evidenceSchema: JavaRuntimeArtifactReference;
  collectorTemplates: Partial<Record<RuntimeCollectorKind, JavaRuntimeArtifactReference>>;
  contractHash: string;
}

export interface JavaRuntimeDriverTemplate {
  version: 1;
  status: "unconfigured";
  protocol: "endpoint-runtime-v1";
  root: string;
  requiredEnvironment: string[];
  operations: Record<string, {
    required: boolean;
    commandVariable: string;
    output: "operation-evidence" | "runtime-observation";
  }>;
}

export interface JavaRuntimePreflightReport {
  version: 1;
  projectId: string;
  status: "ready-to-run" | "blocked";
  staticReady: boolean;
  authoringReady: boolean;
  fixturesReady: boolean;
  environmentReady: boolean;
  executionReady: boolean;
  evidenceReady: boolean;
  checks: Array<{
    id: string;
    status: "passed" | "blocked";
    reason: string;
  }>;
  findings: string[];
  contractHash?: string;
}

export interface JavaRuntimeScenarioEvidence {
  scenarioId: string;
  origin: "endpoint-runtime-driver" | "synthetic-self-test";
  status: "passed" | "blocked";
  protocol?: "migration-guard.runtime-observation/v1";
  fixtureKind?: "template" | "synthetic" | "real-runtime";
  fixtureHash: string;
  driverResultHash: string;
  observationHash: string;
  dimensions: Partial<Record<ReplacementScenario["requiredDimensions"][number], unknown>>;
  collectors: Partial<Record<RuntimeCollectorKind, RuntimeCollectorEvidence>>;
  correlation?: RuntimeCorrelationTrace;
  semantics: {
    batch?: BatchEvidenceInput;
    page?: PageEvidenceInput;
    query?: QueryRuntimeEvidenceInput;
  };
  findings: string[];
}

export interface JavaRuntimeEntryEvidence {
  readiness: EndpointReplacementEvidence;
  scenarios: Record<string, JavaRuntimeScenarioEvidence>;
}

export interface JavaRuntimeEvidenceBundle {
  version: 1;
  provenance: {
    kind: JavaRuntimeEvidenceKind;
    generatedBy: "migration-guard";
    createdAt: string;
    projectId: string;
    projectHash: string;
    sourceIdentity: AssessmentSourceIdentity;
    runtimeContractHash: string;
  };
  entries: Record<string, JavaRuntimeEntryEvidence>;
  bundleHash: string;
}

export interface JavaRuntimeEvidenceValidation {
  valid: boolean;
  realEligible: boolean;
  findings: string[];
}

export interface JavaRuntimeBaselineGateReport {
  version: 1;
  projectId: string;
  status: "passed" | "blocked";
  evidencePath: string;
  scenarioCount: number;
  findings: string[];
}

export async function prepareJavaRuntimeEvidence(caseDir: string): Promise<JavaRuntimeContract> {
  const pkg = await loadMigrationProject(caseDir);
  const indexPath = path.join(pkg.evidenceDir, "analysis", "index.json");
  if (!await pathExists(indexPath)) throw new Error("Java runtime prepare requires migrate analyze evidence.");
  const index = await readJsonFile<MigrationAnalyzeResult>(indexPath);
  if (index.projectHash !== migrationProjectHash(pkg)) {
    throw new Error("Java runtime prepare blocked: project package changed after analysis.");
  }
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  const sourceSnapshot = await captureReferenceSourceSnapshot(sourceRoot, pkg.profile.source.directories);
  const sourceIdentity = sourceSnapshot.identity;
  if (!index.sourceIdentity || !sameSourceIdentity(index.sourceIdentity, sourceIdentity)) {
    throw new Error("Java runtime prepare blocked: Java source identity changed after analysis.");
  }
  if (!index.sourceSnapshot || !referenceSourceSnapshotsEqual(index.sourceSnapshot, sourceSnapshot)) {
    throw new Error("Java runtime prepare blocked: Java source tree changed after analysis.");
  }
  const runtimeDir = javaRuntimeDir(pkg);
  const entries: JavaRuntimeEntryContract[] = [];
  const requiredEnvironment = new Set<string>(["MG_JAVA_BASE_URL"]);
  for (const entrypoint of pkg.profile.entrypoints) {
    const indexed = index.entries.find((item) => item.id === entrypoint.id);
    if (!indexed) throw new Error(`Java runtime prepare missing analysis entry: ${entrypoint.id}.`);
    const report = await readJsonFile<JavaEndpointAnalysisReport>(indexed.analysisPath);
    const plan = await readJsonFile<EndpointReplacementPlan>(indexed.planPath);
    for (const context of plan.contracts.contexts) {
      const variable = contextEnvironmentVariable(context.name);
      if (variable) requiredEnvironment.add(variable);
    }
    if (plan.contracts.states.some((item) => item.operations.includes("lock"))
      || plan.contracts.effects.some((item) => item.kind === "lock")) {
      requiredEnvironment.add("MG_JAVA_REDIS_URL");
    }
    if (plan.contracts.states.length > 0 || report.sqlSources.length > 0) {
      requiredEnvironment.add("MG_JAVA_DATABASE_URL");
    }
    if (plan.contracts.contexts.some((item) => item.name === "user")) requiredEnvironment.add("MG_JAVA_TOKEN");
    const entryCollectors = requiredCollectorsFor(plan, report);
    const scenarios: JavaRuntimeScenarioContract[] = [];
    const configuredScenarios: ReplacementScenario[] = (pkg.semanticRules.runtimeScenarios ?? [])
      .filter((scenario) => scenario.entrypointId === entrypoint.id)
      .map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        category: scenario.category,
        sourceNodes: [],
        requiredDimensions: scenario.requiredDimensions,
        reason: scenario.reason
      }));
    const scenarioIds = new Set<string>();
    for (const scenario of [...plan.scenarios, ...configuredScenarios]) {
      if (scenarioIds.has(scenario.id)) {
        throw new Error(
          `Java runtime prepare duplicate scenario for ${entrypoint.id}: ${scenario.id}.`
        );
      }
      scenarioIds.add(scenario.id);
      const binding = runtimeBindingFor(pkg, entrypoint.id, scenario.id, plan.workload, entryCollectors);
      const fixturePath = path.join(runtimeDir, "fixtures", safeSegment(entrypoint.id), `${safeSegment(scenario.id)}.template.json`);
      const fixture = createFixtureTemplate(pkg, report, entrypoint.id, scenario, binding);
      await writeJsonFile(fixturePath, fixture);
      scenarios.push({
        id: scenario.id,
        title: scenario.title,
        category: scenario.category,
        requiredDimensions: scenario.requiredDimensions,
        requiredCollectors: binding.collectors,
        semanticGates: Object.keys(binding.expectations).sort() as Array<"batch" | "page" | "query">,
        decisionIds: binding.decisionIds,
        fixtureTemplate: artifactReference(pkg, fixturePath, fixture)
      });
    }
    const configuredCollectors = [...new Set(scenarios.flatMap((scenario) => scenario.requiredCollectors))].sort();
    entries.push({
      id: entrypoint.id,
      method: entrypoint.method,
      path: entrypoint.path,
      workload: plan.workload,
      requiredCollectors: configuredCollectors,
      analysisHash: sha256(stableStringify(report)),
      planHash: plan.planHash,
      scenarios
    });
  }
  for (const operation of REQUIRED_RUNTIME_OPERATIONS) {
    requiredEnvironment.add(driverCommandVariable(operation));
  }
  if (entries.some((entry) => entry.scenarios.some((scenario) => scenario.category === "fault"))) {
    requiredEnvironment.add(driverCommandVariable("inject-fault"));
  }
  const finalizedEnvironment = [...requiredEnvironment].sort();
  const driverTemplatePath = path.join(runtimeDir, DRIVER_TEMPLATE_FILE);
  const driverTemplate = createDriverTemplate(sourceRoot, finalizedEnvironment);
  await writeJsonFile(driverTemplatePath, driverTemplate);
  const schemaPath = path.join(runtimeDir, EVIDENCE_SCHEMA_FILE);
  const schema = createEvidenceSchema();
  await writeJsonFile(schemaPath, schema);
  const collectorTemplates: JavaRuntimeContract["collectorTemplates"] = {};
  const requiredCollectors = [...new Set(entries.flatMap((entry) =>
    entry.scenarios.flatMap((scenario) => scenarioCollectors(entry, scenario))))].sort();
  for (const collector of requiredCollectors) {
    const collectorPath = path.join(runtimeDir, "collectors", `${collector}.template.json`);
    const template = createCollectorTemplate(collector);
    await writeJsonFile(collectorPath, template);
    collectorTemplates[collector] = artifactReference(pkg, collectorPath, template);
  }
  const base = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    sourceIdentity,
    sourceSnapshot,
    entries,
    requiredEnvironment: finalizedEnvironment,
    driverTemplate: artifactReference(pkg, driverTemplatePath, driverTemplate),
    evidenceSchema: artifactReference(pkg, schemaPath, schema),
    collectorTemplates
  };
  const contract: JavaRuntimeContract = {
    ...base,
    contractHash: sha256(stableStringify({ ...base, generatedAt: undefined }))
  };
  await writeJsonFile(path.join(runtimeDir, CONTRACT_FILE), contract);
  return contract;
}

export async function preflightJavaRuntimeEvidence(
  caseDir: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<JavaRuntimePreflightReport> {
  const pkg = await loadMigrationProject(caseDir);
  const checks: JavaRuntimePreflightReport["checks"] = [];
  const contract = await readJavaRuntimeContract(pkg);
  if (!contract) {
    return {
      version: 1,
      projectId: pkg.profile.projectId,
      status: "blocked",
      staticReady: false,
      authoringReady: false,
      fixturesReady: false,
      environmentReady: false,
      executionReady: false,
      evidenceReady: false,
      checks: [{ id: "runtime-contract", status: "blocked", reason: "run migrate runtime-prepare" }],
      findings: ["MG-JAVA-RUNTIME-CONTRACT-MISSING"]
    };
  }
  check(checks, "project-hash", contract.projectHash === migrationProjectHash(pkg), "runtime contract matches the project package");
  check(checks, "contract-hash", contract.contractHash === runtimeContractHash(contract), "runtime contract integrity");
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  const currentSource = await captureAssessmentSourceIdentity(sourceRoot);
  check(checks, "source-identity", sameSourceIdentity(contract.sourceIdentity, currentSource), "Java source identity is unchanged");
  const currentSnapshot = await captureReferenceSourceSnapshot(sourceRoot, pkg.profile.source.directories);
  check(
    checks,
    "source-tree",
    Boolean(contract.sourceSnapshot) && referenceSourceSnapshotsEqual(contract.sourceSnapshot, currentSnapshot),
    "configured Java source directories are unchanged"
  );
  for (const artifact of [
    contract.driverTemplate,
    contract.evidenceSchema,
    ...Object.values(contract.collectorTemplates ?? {}),
    ...contract.entries.flatMap((entry) => entry.scenarios.map((scenario) => scenario.fixtureTemplate))
  ]) {
    const absolute = path.resolve(pkg.caseDir, artifact.path);
    const valid = await pathExists(absolute) && sha256(stableStringify(await readJsonFile<unknown>(absolute))) === artifact.hash;
    check(checks, `artifact:${artifact.path}`, valid, "prepared runtime artifact integrity");
  }
  for (const variable of contract.requiredEnvironment) {
    check(checks, `environment:${variable}`, Boolean(environment[variable]?.trim()), `${variable} is configured`);
  }
  const authoring = await inspectJavaRuntimeAuthoring(pkg, contract);
  check(checks, "authoring-package", authoring.ready, "draft fixtures, environment contract and coverage matrix are prepared");
  for (const entry of contract.entries) {
    for (const scenario of entry.scenarios) {
      const fixturePath = realFixturePath(pkg, entry.id, scenario.id);
      const available = await pathExists(fixturePath);
      let valid = false;
      if (available) {
        const fixture = await readJsonFile<unknown>(fixturePath);
        valid = validateMigrationFixture(fixture, {
          kind: "real-runtime",
          projectId: pkg.profile.projectId,
          projectHash: migrationProjectHash(pkg),
          entrypointId: entry.id,
          scenarioId: scenario.id,
          batch: scenarioSemanticGates(entry, scenario).includes("batch"),
          page: scenarioSemanticGates(entry, scenario).includes("page"),
          query: scenarioSemanticGates(entry, scenario).includes("query"),
          writeSafety: scenarioSemanticGates(entry, scenario).includes("batch"),
          collectors: scenarioCollectors(entry, scenario)
        }).length === 0;
        if (valid) valid = await validateFixtureCollectorArtifacts(
          pkg,
          fixture as MigrationFixtureMetadata,
          scenarioCollectors(entry, scenario)
        );
      }
      check(checks, `fixture:${entry.id}:${scenario.id}`, available && valid, "typed, ready and redacted real-runtime fixture is available");
    }
  }
  const staticReady = checks.filter((item) =>
    !item.id.startsWith("environment:")
      && !item.id.startsWith("fixture:")
      && item.id !== "authoring-package")
    .every((item) => item.status === "passed");
  const authoringReady = authoring.ready;
  const fixturesReady = checks.filter((item) => item.id.startsWith("fixture:")).every((item) => item.status === "passed");
  const environmentReady = checks.filter((item) => item.id.startsWith("environment:")).every((item) => item.status === "passed");
  const executionReady = staticReady && fixturesReady && environmentReady;
  const realEvidencePath = path.join(javaRuntimeDir(pkg), "real-evidence.json");
  let evidenceReady = false;
  if (await pathExists(realEvidencePath)) {
    try {
      const validation = await validateJavaRuntimeEvidenceBundle(
        pkg.caseDir,
        await readJsonFile<JavaRuntimeEvidenceBundle>(realEvidencePath)
      );
      evidenceReady = validation.realEligible;
    } catch {
      evidenceReady = false;
    }
  }
  check(checks, "real-evidence", evidenceReady, "validated real runtime evidence is available");
  const findings = checks.filter((item) => item.status === "blocked").map((item) =>
    item.id.startsWith("environment:")
      ? `MG-JAVA-RUNTIME-ENV-MISSING:${item.id.slice("environment:".length)}`
      : item.id.startsWith("fixture:")
        ? `MG-JAVA-RUNTIME-FIXTURE-MISSING:${item.id.slice("fixture:".length)}`
      : item.id === "authoring-package"
        ? "MG-JAVA-RUNTIME-AUTHORING-INCOMPLETE"
      : item.id === "real-evidence"
        ? "MG-JAVA-RUNTIME-EVIDENCE-NOT-READY"
      : `MG-JAVA-RUNTIME-STATIC-BLOCKED:${item.id}`
  );
  return {
    version: 1,
    projectId: pkg.profile.projectId,
    status: executionReady ? "ready-to-run" : "blocked",
    staticReady,
    authoringReady,
    fixturesReady,
    environmentReady,
    executionReady,
    evidenceReady,
    checks,
    findings,
    contractHash: contract.contractHash
  };
}

export async function generateSyntheticJavaRuntimeEvidence(caseDir: string): Promise<{
  bundle: JavaRuntimeEvidenceBundle;
  validation: JavaRuntimeEvidenceValidation;
  outputPath: string;
}> {
  const pkg = await loadMigrationProject(caseDir);
  const contract = await requireJavaRuntimeContract(pkg);
  const entries: Record<string, JavaRuntimeEntryEvidence> = {};
  for (const entry of contract.entries) {
    const scenarios: Record<string, JavaRuntimeScenarioEvidence> = {};
    for (const scenario of entry.scenarios) {
      const dimensions = Object.fromEntries(scenario.requiredDimensions.map((dimension) => [
        dimension,
        { synthetic: true, note: "schema and evidence-pipeline self-test only" }
      ])) as JavaRuntimeScenarioEvidence["dimensions"];
      scenarios[scenario.id] = {
        scenarioId: scenario.id,
        origin: "synthetic-self-test",
        status: "passed",
        protocol: "migration-guard.runtime-observation/v1",
        fixtureKind: "synthetic",
        fixtureHash: scenario.fixtureTemplate.hash,
        driverResultHash: sha256(`synthetic-driver:${entry.id}:${scenario.id}`),
        observationHash: scenarioObservationHash({
          protocol: "migration-guard.runtime-observation/v1",
          fixtureKind: "synthetic",
          dimensions,
          collectors: {},
          semantics: {}
        }),
        dimensions,
        collectors: {},
        semantics: {},
        findings: []
      };
    }
    entries[entry.id] = {
      readiness: completeReadinessEvidence(),
      scenarios
    };
  }
  const bundle = createEvidenceBundle(pkg, contract, "synthetic", entries);
  const validation = await validateJavaRuntimeEvidenceBundle(pkg.caseDir, bundle);
  const outputPath = path.join(javaRuntimeDir(pkg), "synthetic-evidence.json");
  await writeJsonFile(outputPath, bundle);
  await writeJsonFile(path.join(javaRuntimeDir(pkg), "synthetic-self-test-report.json"), validation);
  return { bundle, validation, outputPath };
}

export async function assembleJavaRuntimeEvidence(
  caseDir: string,
  kind: JavaRuntimeEvidenceKind,
  entries: Record<string, JavaRuntimeEntryEvidence>,
  outputPath?: string
): Promise<{ bundle: JavaRuntimeEvidenceBundle; validation: JavaRuntimeEvidenceValidation; outputPath: string }> {
  const pkg = await loadMigrationProject(caseDir);
  const contract = await requireJavaRuntimeContract(pkg);
  const bundle = createEvidenceBundle(pkg, contract, kind, entries);
  const validation = await validateJavaRuntimeEvidenceBundle(pkg.caseDir, bundle);
  const resolvedOutput = outputPath
    ? path.resolve(outputPath)
    : path.join(javaRuntimeDir(pkg), kind === "real" ? "real-evidence.json" : "synthetic-evidence.json");
  await writeJsonFile(resolvedOutput, bundle);
  return { bundle, validation, outputPath: resolvedOutput };
}

export async function runJavaRuntimeEvidence(
  caseDir: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<{
  bundle: JavaRuntimeEvidenceBundle;
  validation: JavaRuntimeEvidenceValidation;
  outputPath: string;
  driverResults: EndpointRuntimeDriverResult[];
}> {
  const pkg = await loadMigrationProject(caseDir);
  const sourceSnapshot = await captureReferenceSourceSnapshot(
    resolveMigrationProjectPath(pkg, pkg.profile.source.root),
    pkg.profile.source.directories
  );
  try {
    return await runJavaRuntimeEvidenceGuarded(pkg, environment);
  } finally {
    await assertReferenceSourceSnapshotUnchanged(sourceSnapshot, "runtime-run");
  }
}

async function runJavaRuntimeEvidenceGuarded(
  pkg: MigrationProjectPackage,
  environment: NodeJS.ProcessEnv
): Promise<{
  bundle: JavaRuntimeEvidenceBundle;
  validation: JavaRuntimeEvidenceValidation;
  outputPath: string;
  driverResults: EndpointRuntimeDriverResult[];
}> {
  const contract = await requireJavaRuntimeContract(pkg);
  const preflight = await preflightJavaRuntimeEvidence(pkg.caseDir, environment);
  if (preflight.status !== "ready-to-run") {
    throw new Error(`Java runtime preflight is blocked: ${preflight.findings.join(", ")}.`);
  }
  const template = await readJsonFile<JavaRuntimeDriverTemplate>(
    path.resolve(pkg.caseDir, contract.driverTemplate.path)
  );
  const entries: Record<string, JavaRuntimeEntryEvidence> = {};
  const driverResults: EndpointRuntimeDriverResult[] = [];
  for (const entry of contract.entries) {
    const scenarios: Record<string, JavaRuntimeScenarioEvidence> = {};
    for (const scenario of entry.scenarios) {
      const fixturePath = realFixturePath(pkg, entry.id, scenario.id);
      const fixtureHash = await realFixtureHash(pkg, entry.id, scenario.id);
      if (!fixtureHash) throw new Error(`Java runtime fixture missing: ${entry.id}/${scenario.id}.`);
      const operations = Object.fromEntries(RUNTIME_OPERATIONS.flatMap((operation) => {
        const variable = template.operations[operation]?.commandVariable;
        const command = variable ? environment[variable] : undefined;
        if (!command) return [];
        return [[operation, expandDriverCommand(command, {
          fixturePath,
          caseDir: pkg.caseDir,
          entrypointId: entry.id
        })]];
      })) as EndpointRuntimeDriverConfig["operations"];
      const config: EndpointRuntimeDriverConfig = {
        id: `java-${safeSegment(entry.id)}`,
        root: resolveMigrationProjectPath(pkg, pkg.profile.source.root),
        timeoutMs: 120_000,
        maxOutputBytes: 4 * 1024 * 1024,
        operations
      };
      const replacementScenario: ReplacementScenario = {
        id: scenario.id,
        title: scenario.title,
        category: scenario.category,
        sourceNodes: [],
        requiredDimensions: scenario.requiredDimensions,
        reason: "Prepared Java runtime contract"
      };
      const result = await runEndpointRuntimeDriver(
        config,
        replacementScenario,
        scenario.category === "fault" ? { fault: scenario.id } : {}
      );
      if (result.observation) {
        const fixture = await readRealFixture(pkg, entry.id, scenario.id);
        result.observation.collectors ??= {};
        for (const collector of scenarioCollectors(entry, scenario)) {
          const reference = fixture?.collectorSpecs?.[collector];
          if (!reference) continue;
          const spec = await readJsonFile<RuntimeCollectorSpec>(path.resolve(pkg.caseDir, reference.path));
          result.observation.collectors[collector] = await collectRuntimeEvidence(spec, {
            cwd: pkg.caseDir,
            environment
          });
        }
      }
      driverResults.push(result);
      scenarios[scenario.id] = createJavaRuntimeScenarioEvidence(result, fixtureHash);
    }
    const results = Object.values(scenarios);
    entries[entry.id] = {
      readiness: {
        graphComplete: true,
        contractsComplete: true,
        ownershipComplete: false,
        replayPassed: false,
        concurrencyPassed: scenarioCategoryPassed(entry, scenarios, "concurrency"),
        faultPassed: scenarioCategoryPassed(entry, scenarios, "fault"),
        performancePassed: scenarioCategoryPassed(entry, scenarios, "scale"),
        sourceOffPassed: false,
        rollbackPassed: false,
        evidenceCreatedAt: new Date().toISOString(),
        maxEvidenceAgeMs: 86_400_000
      },
      scenarios
    };
    if (results.some((item) => item.status !== "passed")) {
      entries[entry.id]!.readiness.replayPassed = false;
    }
  }
  const assembled = await assembleJavaRuntimeEvidence(pkg.caseDir, "real", entries);
  return { ...assembled, driverResults };
}

export async function gateJavaRuntimeBaseline(
  caseDir: string,
  evidencePath?: string
): Promise<JavaRuntimeBaselineGateReport> {
  const pkg = await loadMigrationProject(caseDir);
  const resolvedEvidencePath = evidencePath
    ? path.resolve(evidencePath)
    : path.join(javaRuntimeDir(pkg), "real-evidence.json");
  const findings: string[] = [];
  let scenarioCount = 0;
  if (!await pathExists(resolvedEvidencePath)) {
    findings.push("MG-JAVA-RUNTIME-EVIDENCE-MISSING");
  } else {
    const bundle = await readJsonFile<JavaRuntimeEvidenceBundle>(resolvedEvidencePath);
    const validation = await validateJavaRuntimeEvidenceBundle(pkg.caseDir, bundle);
    findings.push(...validation.findings);
    if (!validation.realEligible) findings.push("MG-JAVA-RUNTIME-EVIDENCE-NOT-REAL");
    scenarioCount = Object.values(bundle.entries ?? {}).reduce(
      (total, entry) => total + Object.keys(entry.scenarios ?? {}).length,
      0
    );
  }
  const report: JavaRuntimeBaselineGateReport = {
    version: 1,
    projectId: pkg.profile.projectId,
    status: findings.length === 0 ? "passed" : "blocked",
    evidencePath: resolvedEvidencePath,
    scenarioCount,
    findings: [...new Set(findings)].sort()
  };
  await writeJsonFile(path.join(javaRuntimeDir(pkg), "runtime-gate.json"), report);
  return report;
}

export function createJavaRuntimeScenarioEvidence(
  driverResult: EndpointRuntimeDriverResult,
  fixtureHash: string
): JavaRuntimeScenarioEvidence {
  const dimensions = driverResult.observation?.dimensions ?? {};
  const protocol = driverResult.observation?.protocol;
  const fixtureKind = driverResult.observation?.fixtureKind;
  const collectors = driverResult.observation?.collectors ?? {};
  const correlation = driverResult.observation?.correlation;
  const semantics = driverResult.observation?.semantics ?? {};
  return {
    scenarioId: driverResult.scenarioId,
    origin: "endpoint-runtime-driver",
    status: driverResult.status,
    protocol,
    fixtureKind,
    fixtureHash,
    driverResultHash: driverResult.resultHash,
    observationHash: scenarioObservationHash({ protocol, fixtureKind, dimensions, collectors, correlation, semantics }),
    dimensions,
    collectors,
    correlation,
    semantics,
    findings: driverResult.findings
  };
}

export async function validateJavaRuntimeEvidenceBundle(
  caseDir: string,
  bundle: JavaRuntimeEvidenceBundle
): Promise<JavaRuntimeEvidenceValidation> {
  const pkg = await loadMigrationProject(caseDir);
  const contract = await readJavaRuntimeContract(pkg);
  const findings: string[] = [];
  if (!contract) return { valid: false, realEligible: false, findings: ["MG-JAVA-RUNTIME-CONTRACT-MISSING"] };
  if (bundle.version !== 1) findings.push("MG-JAVA-EVIDENCE-VERSION-UNSUPPORTED");
  if (bundle.provenance?.projectId !== pkg.profile.projectId) findings.push("MG-JAVA-EVIDENCE-PROJECT-ID-MISMATCH");
  if (bundle.provenance?.projectHash !== migrationProjectHash(pkg)) findings.push("MG-JAVA-EVIDENCE-PROJECT-HASH-MISMATCH");
  if (bundle.provenance?.runtimeContractHash !== contract.contractHash) findings.push("MG-JAVA-EVIDENCE-CONTRACT-HASH-MISMATCH");
  if (!bundle.provenance?.sourceIdentity || !sameSourceIdentity(bundle.provenance.sourceIdentity, contract.sourceIdentity)) {
    findings.push("MG-JAVA-EVIDENCE-SOURCE-IDENTITY-MISMATCH");
  }
  const currentSource = await captureAssessmentSourceIdentity(resolveMigrationProjectPath(pkg, pkg.profile.source.root));
  if (!sameSourceIdentity(currentSource, contract.sourceIdentity)) findings.push("MG-JAVA-EVIDENCE-SOURCE-STALE");
  if (bundle.bundleHash !== evidenceBundleHash(bundle)) findings.push("MG-JAVA-EVIDENCE-BUNDLE-HASH-MISMATCH");
  for (const entry of contract.entries) {
    const evidence = bundle.entries?.[entry.id];
    if (!evidence) {
      findings.push(`MG-JAVA-EVIDENCE-ENTRY-MISSING:${entry.id}`);
      continue;
    }
    for (const scenario of entry.scenarios) {
      const observation = evidence.scenarios?.[scenario.id];
      if (!observation) {
        findings.push(`MG-JAVA-EVIDENCE-SCENARIO-MISSING:${entry.id}:${scenario.id}`);
        continue;
      }
      if (observation.status !== "passed") findings.push(`MG-JAVA-EVIDENCE-SCENARIO-BLOCKED:${entry.id}:${scenario.id}`);
      if (bundle.provenance.kind === "real" && observation.origin !== "endpoint-runtime-driver") {
        findings.push(`MG-JAVA-EVIDENCE-REAL-DRIVER-MISSING:${entry.id}:${scenario.id}`);
      }
      if (bundle.provenance.kind === "real" && observation.protocol !== "migration-guard.runtime-observation/v1") {
        findings.push(`MG-JAVA-EVIDENCE-PROTOCOL-MISSING:${entry.id}:${scenario.id}`);
      }
      if (bundle.provenance.kind === "real" && observation.fixtureKind !== "real-runtime") {
        findings.push(`MG-JAVA-EVIDENCE-FIXTURE-KIND-INVALID:${entry.id}:${scenario.id}`);
      }
      const expectedFixtureHash = bundle.provenance.kind === "synthetic"
        ? scenario.fixtureTemplate.hash
        : await realFixtureHash(pkg, entry.id, scenario.id);
      if (!expectedFixtureHash || observation.fixtureHash !== expectedFixtureHash) {
        findings.push(`MG-JAVA-EVIDENCE-FIXTURE-HASH-MISMATCH:${entry.id}:${scenario.id}`);
      }
      for (const dimension of scenario.requiredDimensions) {
        if (observation.dimensions?.[dimension] === undefined) {
          findings.push(`MG-JAVA-EVIDENCE-DIMENSION-MISSING:${entry.id}:${scenario.id}:${dimension}`);
        }
      }
      if (!observation.driverResultHash || !observation.observationHash) {
        findings.push(`MG-JAVA-EVIDENCE-LINEAGE-MISSING:${entry.id}:${scenario.id}`);
      }
      if (observation.observationHash !== scenarioObservationHash(observation)) {
        findings.push(`MG-JAVA-EVIDENCE-OBSERVATION-HASH-MISMATCH:${entry.id}:${scenario.id}`);
      }
      if (bundle.provenance.kind === "real" && containsSyntheticMarker({
        dimensions: observation.dimensions,
        collectors: observation.collectors,
        correlation: observation.correlation,
        semantics: observation.semantics
      })) {
        findings.push(`MG-JAVA-EVIDENCE-SYNTHETIC-CONTENT:${entry.id}:${scenario.id}`);
      }
      if (bundle.provenance.kind === "real") {
        const fixture = await readRealFixture(pkg, entry.id, scenario.id);
        for (const collector of scenarioCollectors(entry, scenario)) {
          const collectorEvidence = observation.collectors?.[collector];
          if (!collectorEvidence) {
            findings.push(`MG-JAVA-EVIDENCE-COLLECTOR-MISSING:${entry.id}:${scenario.id}:${collector}`);
            continue;
          }
          findings.push(...validateRuntimeCollectorEvidence(collectorEvidence)
            .map((finding) => `${finding}:${entry.id}:${scenario.id}`));
          const expectedSpecHash = fixture?.collectorSpecs?.[collector]?.hash;
          if (!expectedSpecHash || collectorEvidence.specHash !== expectedSpecHash) {
            findings.push(`MG-JAVA-EVIDENCE-COLLECTOR-SPEC-HASH-MISMATCH:${entry.id}:${scenario.id}:${collector}`);
          }
        }
        const requiredCollectors = scenarioCollectors(entry, scenario);
        if (requiredCollectors.length > 1 || requiredCollectors.includes("sql-trace")) {
          findings.push(...validateRuntimeCorrelationTrace(
            observation.correlation,
            scenario.id,
            requiredCollectors,
            observation.collectors
          ).map((finding) => `${finding}:${entry.id}:${scenario.id}`));
        }
        if (entry.workload === "batch") {
          const batch = observation.semantics?.batch;
          const requirements = fixture?.expectations?.batch;
          if (!requirements) {
            findings.push(`MG-JAVA-EVIDENCE-BATCH-EXPECTATION-MISSING:${entry.id}:${scenario.id}`);
          }
          if (!batch) {
            findings.push(`MG-JAVA-EVIDENCE-BATCH-SEMANTICS-MISSING:${entry.id}:${scenario.id}`);
          } else if (requirements) {
            try {
              const gate = gateBatchEvidence(batch, requirements);
              findings.push(...gate.blockers.map((blocker) =>
                `MG-JAVA-EVIDENCE-BATCH:${entry.id}:${scenario.id}:${blocker}`));
            } catch {
              findings.push(`MG-JAVA-EVIDENCE-BATCH-MALFORMED:${entry.id}:${scenario.id}`);
            }
          }
        }
        const pageRequirements = fixture?.expectations?.page;
        const page = observation.semantics?.page;
        if (pageRequirements && !page) {
          findings.push(`MG-JAVA-EVIDENCE-PAGE-SEMANTICS-MISSING:${entry.id}:${scenario.id}`);
        } else if (pageRequirements && page) {
          try {
            const gate = gatePageEvidence(page, pageRequirements);
            findings.push(...gate.blockers.map((blocker) =>
              `MG-JAVA-EVIDENCE-PAGE:${entry.id}:${scenario.id}:${blocker}`));
          } catch {
            findings.push(`MG-JAVA-EVIDENCE-PAGE-MALFORMED:${entry.id}:${scenario.id}`);
          }
        } else if (page) {
          findings.push(`MG-JAVA-EVIDENCE-PAGE-EXPECTATION-MISSING:${entry.id}:${scenario.id}`);
        }
        const queryRequirements = fixture?.expectations?.query;
        const query = observation.semantics?.query;
        if (queryRequirements && !query) {
          findings.push(`MG-JAVA-EVIDENCE-QUERY-SEMANTICS-MISSING:${entry.id}:${scenario.id}`);
        } else if (queryRequirements && query) {
          try {
            const gate = gateQueryEvidence(query, queryRequirements);
            findings.push(...gate.blockers.map((blocker) =>
              `MG-JAVA-EVIDENCE-QUERY:${entry.id}:${scenario.id}:${blocker}`));
          } catch {
            findings.push(`MG-JAVA-EVIDENCE-QUERY-MALFORMED:${entry.id}:${scenario.id}`);
          }
        } else if (query) {
          findings.push(`MG-JAVA-EVIDENCE-QUERY-EXPECTATION-MISSING:${entry.id}:${scenario.id}`);
        }
      }
    }
  }
  const valid = findings.length === 0;
  return {
    valid,
    realEligible: valid && bundle.provenance.kind === "real",
    findings: bundle.provenance.kind === "synthetic"
      ? [...findings, "MG-JAVA-EVIDENCE-SYNTHETIC-NOT-REAL"].sort()
      : findings.sort()
  };
}

export function evidenceBundleHash(bundle: JavaRuntimeEvidenceBundle): string {
  return sha256(stableStringify({ ...bundle, bundleHash: undefined }));
}

function createEvidenceBundle(
  pkg: MigrationProjectPackage,
  contract: JavaRuntimeContract,
  kind: JavaRuntimeEvidenceKind,
  entries: Record<string, JavaRuntimeEntryEvidence>
): JavaRuntimeEvidenceBundle {
  const base = {
    version: 1 as const,
    provenance: {
      kind,
      generatedBy: "migration-guard" as const,
      createdAt: new Date().toISOString(),
      projectId: pkg.profile.projectId,
      projectHash: migrationProjectHash(pkg),
      sourceIdentity: contract.sourceIdentity,
      runtimeContractHash: contract.contractHash
    },
    entries
  };
  return { ...base, bundleHash: sha256(stableStringify(base)) };
}

function createFixtureTemplate(
  pkg: MigrationProjectPackage,
  report: JavaEndpointAnalysisReport,
  entrypointId: string,
  scenario: ReplacementScenario,
  binding: RuntimeScenarioBinding
): unknown {
  const golden = report.goldenCasePlan.cases.find((item) => item.id === scenario.id);
  return {
    schemaVersion: 1,
    status: "template",
    fixtureKind: "template",
    realEvidenceEligible: false,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    entrypointId,
    scenarioId: scenario.id,
    category: scenario.category,
    request: {
      headers: report.goldenCasePlan.fixtureTemplate.headers,
      body: {
        ...report.goldenCasePlan.fixtureTemplate.body,
        _scenario: scenario.id
      }
    },
    requestFocus: golden?.requestFocus ?? [],
    expectedComparison: golden?.expectedComparison ?? scenario.requiredDimensions,
    requiredDimensions: scenario.requiredDimensions,
    collectorSpecs: Object.fromEntries(binding.collectors.map((collector) => {
      const template = createCollectorTemplate(collector);
      return [collector, {
        path: `evidence/runtime/java/collectors/${collector}.template.json`,
        hash: sha256(stableStringify(template))
      }];
    })),
    expectations: binding.expectations,
    compatibilityDecisionIds: binding.decisionIds,
    secrets: {
      policy: "environment-only",
      persistedValuesAllowed: false
    }
  };
}

function createDriverTemplate(root: string, requiredEnvironment: string[]): JavaRuntimeDriverTemplate {
  return {
    version: 1,
    status: "unconfigured",
    protocol: "endpoint-runtime-v1",
    root,
    requiredEnvironment,
    operations: Object.fromEntries(RUNTIME_OPERATIONS.map((operation) => [
      operation,
      {
        required: operation !== "inject-fault",
        commandVariable: driverCommandVariable(operation),
        output: operation === "collect" ? "runtime-observation" : "operation-evidence"
      }
    ]))
  };
}

function createCollectorTemplate(collector: RuntimeCollectorKind): unknown {
  if (collector === "mysql") {
    return {
      version: 1,
      collector: "mysql",
      status: "template",
      connectionEnv: "MG_JAVA_DATABASE_URL",
      includeRows: false,
      queries: [
        { id: "connectivity", sql: "SELECT 1 AS migration_guard_probe" },
        { id: "replace-with-before-after-snapshot", sql: "SELECT 1 AS replace_me" }
      ]
    };
  }
  if (collector === "redis") {
    return {
      version: 1,
      collector: "redis",
      status: "template",
      connectionEnv: "MG_JAVA_REDIS_URL",
      includeValues: false,
      probes: [
        { id: "replace-with-lock-or-ledger-key", command: ["GET", "migration-guard:replace-me"] }
      ]
    };
  }
  if (collector === "sql-trace") {
    return {
      version: 1,
      collector: "sql-trace",
      status: "template",
      file: "evidence/runtime/java/sql-traces/replace-with-scenario.jsonl",
      correlationEnv: "MG_JAVA_REQUEST_ID",
      correlationFields: ["requestId", "correlationId"]
    };
  }
  if (collector === "ai-trace") {
    return {
      version: 1,
      collector,
      status: "template",
      file: "evidence/runtime/java/ai-traces/replace-with-scenario.jsonl",
      correlationEnv: "MG_JAVA_REQUEST_ID",
      correlationFields: ["requestId", "correlationId"],
      includeFields: ["sequence", "model", "finishReason", "toolCallCount", "factSourceCount"]
    };
  }
  if (collector === "stream-trace") {
    return {
      version: 1,
      collector,
      status: "template",
      file: "evidence/runtime/java/stream-traces/replace-with-scenario.jsonl",
      correlationEnv: "MG_JAVA_REQUEST_ID",
      correlationFields: ["requestId", "correlationId"],
      includeFields: ["sequence", "eventType", "terminal"]
    };
  }
  if (collector === "tool-trace") {
    return {
      version: 1,
      collector,
      status: "template",
      file: "evidence/runtime/java/tool-traces/replace-with-scenario.jsonl",
      correlationEnv: "MG_JAVA_REQUEST_ID",
      correlationFields: ["requestId", "correlationId"],
      includeFields: ["sequence", "toolName", "status", "argumentFingerprint", "resultFingerprint"]
    };
  }
  return {
    version: 1,
    collector: "events",
    status: "template",
    file: "evidence/runtime/java/events/replace-with-scenario.jsonl",
    correlationFields: ["scenarioId", "requestId", "batchId"],
    includeFields: ["scenarioId", "requestId", "batchId", "type", "stage", "sequence"]
  };
}

function createEvidenceSchema(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Migration Guard Java Runtime Evidence",
    type: "object",
    additionalProperties: false,
    required: ["version", "provenance", "entries", "bundleHash"],
    properties: {
      version: { const: 1 },
      provenance: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "generatedBy", "createdAt", "projectId", "projectHash", "sourceIdentity", "runtimeContractHash"],
        properties: {
          kind: { enum: ["synthetic", "real"] },
          generatedBy: { const: "migration-guard" },
          createdAt: { type: "string", format: "date-time" },
          projectId: { type: "string", minLength: 1 },
          projectHash: { $ref: "#/$defs/hash" },
          sourceIdentity: {
            type: "object",
            required: ["revision", "dirty", "dirtyFingerprint", "identity"],
            properties: {
              revision: { type: "string", minLength: 1 },
              dirty: { type: "boolean" },
              dirtyFingerprint: { $ref: "#/$defs/hash" },
              identity: { type: "string", minLength: 1 }
            }
          },
          runtimeContractHash: { $ref: "#/$defs/hash" }
        }
      },
      entries: {
        type: "object",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["readiness", "scenarios"],
          properties: {
            readiness: { type: "object" },
            scenarios: {
              type: "object",
              minProperties: 1,
              additionalProperties: { $ref: "#/$defs/scenarioEvidence" }
            }
          }
        }
      },
      bundleHash: { $ref: "#/$defs/hash" }
    },
    $defs: {
      hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      collectorEvidence: {
        type: "object",
        additionalProperties: false,
        required: ["version", "collector", "status", "capturedAt", "specHash", "payload", "payloadHash", "findings", "evidenceHash"],
        properties: {
          version: { const: 1 },
          collector: { enum: ["mysql", "redis", "events", "sql-trace", "ai-trace", "stream-trace", "tool-trace"] },
          status: { enum: ["passed", "blocked"] },
          capturedAt: { type: "string", format: "date-time" },
          specHash: { $ref: "#/$defs/hash" },
          payload: {},
          payloadHash: { $ref: "#/$defs/hash" },
          findings: { type: "array", items: { type: "string" } },
          evidenceHash: { $ref: "#/$defs/hash" }
        }
      },
      batchEvidence: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "committed", "undoRows", "progress", "lockRecords", "chunkAcceptance"],
        properties: {
          plan: {
            type: "object",
            required: ["requested", "valid", "failed", "inserts", "updates"],
            properties: {
              requested: { $ref: "#/$defs/indexes" },
              valid: { $ref: "#/$defs/indexes" },
              failed: { $ref: "#/$defs/indexes" },
              inserts: { $ref: "#/$defs/indexes" },
              updates: { $ref: "#/$defs/indexes" }
            }
          },
          committed: { $ref: "#/$defs/indexes" },
          undoRows: { $ref: "#/$defs/indexes" },
          responseFailedRows: { $ref: "#/$defs/indexes" },
          progress: {
            type: "array",
            items: {
              type: "object",
              required: ["stage", "processed", "failed", "total"],
              properties: {
                stage: { enum: ["accepted", "validating", "writing", "committed", "success", "partial-failed", "failed"] },
                processed: { type: "integer", minimum: 0 },
                failed: { type: "integer", minimum: 0 },
                total: { type: "integer", minimum: 0 },
                sequence: { type: "integer", minimum: 0 },
                eventId: { type: "string", minLength: 1 },
                deliveryAttempt: { type: "integer", minimum: 1 }
              }
            }
          },
          lockRecords: { type: "array", items: { type: "object", required: ["event", "resource", "ownerToken", "at"] } },
          chunkAcceptance: {
            type: "array",
            items: { enum: ["accepted", "replayed", "conflict", "out-of-order", "missing"] }
          },
          transactions: {
            type: "array",
            items: {
              type: "object",
              required: ["transactionId", "event", "sequence"],
              properties: {
                transactionId: { type: "string", minLength: 1 },
                event: { enum: ["begin", "commit", "rollback"] },
                sequence: { type: "integer", minimum: 0 },
                rowIndex: { type: "integer", minimum: 0 }
              }
            }
          },
          requestValidations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "caseId", "postRowCount", "headerRowCount", "rowLimit", "outcome",
                "writeCount", "progressEventCount", "coordinationEventCount",
                "transactionEventCount", "undoIntentCount"
              ],
              properties: {
                caseId: { enum: ["post-over-limit", "post-at-limit", "header-non-empty"] },
                postRowCount: { type: "integer", minimum: 0 },
                headerRowCount: { type: "integer", minimum: 0 },
                rowLimit: { type: "integer", minimum: 1 },
                outcome: { enum: ["accepted", "rejected"] },
                writeCount: { type: "integer", minimum: 0 },
                progressEventCount: { type: "integer", minimum: 0 },
                coordinationEventCount: { type: "integer", minimum: 0 },
                transactionEventCount: { type: "integer", minimum: 0 },
                undoIntentCount: { type: "integer", minimum: 0 }
              }
            }
          },
          chunkAttempts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "tenantId", "sessionId", "chunkNo", "requestHash", "isLast",
                "outcome", "ledgerPersisted", "effectsApplied"
              ],
              properties: {
                tenantId: { type: "string", minLength: 1 },
                sessionId: { type: "string", minLength: 1 },
                chunkNo: { type: "integer", minimum: 0 },
                requestHash: { $ref: "#/$defs/hash" },
                isLast: { type: "boolean" },
                outcome: { enum: ["accepted", "replayed", "conflict", "out-of-order", "missing"] },
                ledgerPersisted: { type: "boolean" },
                effectsApplied: { type: "integer", minimum: 0 },
                resultHash: { $ref: "#/$defs/hash" }
              }
            }
          },
          undoIntents: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rowIndex", "idempotencyKey", "transactionId", "sequence", "status"],
              properties: {
                rowIndex: { type: "integer", minimum: 0 },
                idempotencyKey: { type: "string", minLength: 1 },
                transactionId: { type: "string", minLength: 1 },
                sequence: { type: "integer", minimum: 0 },
                status: { enum: ["persisted", "materialized", "permanent-failure"] },
                observable: { type: "boolean" }
              }
            }
          }
        }
      },
      pageEvidence: {
        type: "object",
        additionalProperties: false,
        required: ["response"],
        properties: {
          response: {
            type: "object",
            additionalProperties: false,
            required: ["status", "pageNumber", "pageSize", "total", "returnedRows", "rowKeys", "rowsHash"],
            properties: {
              status: { type: "integer", minimum: 100, maximum: 599 },
              pageNumber: { type: "integer", minimum: 1 },
              pageSize: { type: "integer", minimum: 1 },
              total: { type: "integer", minimum: 0 },
              returnedRows: { type: "integer", minimum: 0 },
              rowKeys: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
              rowsHash: { $ref: "#/$defs/hash" },
              orderHash: { $ref: "#/$defs/hash" }
            }
          },
          query: {
            type: "object",
            additionalProperties: false,
            required: ["whereFields", "havingFields", "aggregateFields"],
            properties: {
              whereFields: { $ref: "#/$defs/fieldNames" },
              havingFields: { $ref: "#/$defs/fieldNames" },
              aggregateFields: { $ref: "#/$defs/fieldNames" },
              groupByFields: { $ref: "#/$defs/fieldNames" },
              orderByFields: { $ref: "#/$defs/fieldNames" },
              distinct: { type: "boolean" },
              dataFilterHash: { $ref: "#/$defs/hash" },
              totalFilterHash: { $ref: "#/$defs/hash" }
            }
          },
          horizontal: {
            type: "object",
            additionalProperties: false,
            required: ["pageKeys", "cellRowKeys", "distinctTotal"],
            properties: {
              pageKeys: { $ref: "#/$defs/keys" },
              cellRowKeys: { $ref: "#/$defs/keys" },
              distinctTotal: { type: "integer", minimum: 0 },
              pivotKeys: { $ref: "#/$defs/keys" }
            }
          },
          refresh: {
            type: "object",
            additionalProperties: false,
            required: ["mode", "syncSucceeded", "effects"],
            properties: {
              mode: { enum: ["manual", "auto", "column"] },
              syncSucceeded: { type: "boolean" },
              querySucceeded: { type: "boolean" },
              effects: {
                type: "array",
                uniqueItems: true,
                items: { enum: ["sync", "timestamp", "undo-clear", "reconcile", "query", "terminal-event", "unlock"] }
              },
              lock: {
                type: "object",
                additionalProperties: false,
                required: ["resource", "ownerFingerprint", "acquired", "released"],
                properties: {
                  resource: { type: "string", minLength: 1 },
                  ownerFingerprint: { $ref: "#/$defs/hash" },
                  acquired: { type: "boolean" },
                  released: { type: "boolean" },
                  releaseOwnerFingerprint: { $ref: "#/$defs/hash" }
                }
              },
              terminalEvent: { enum: ["completed", "failed", "rejected"] }
            }
          }
        }
      },
      indexes: {
        type: "array",
        uniqueItems: true,
        items: { type: "integer", minimum: 0 }
      },
      fieldNames: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", minLength: 1 }
      },
      keys: {
        type: "array",
        items: { type: "string", minLength: 1 }
      },
      scenarioEvidence: {
        type: "object",
        additionalProperties: false,
        required: [
          "scenarioId", "origin", "status", "protocol", "fixtureKind", "fixtureHash",
          "driverResultHash", "observationHash", "dimensions", "collectors", "semantics", "findings"
        ],
        properties: {
          scenarioId: { type: "string", minLength: 1 },
          origin: { enum: ["endpoint-runtime-driver", "synthetic-self-test"] },
          status: { enum: ["passed", "blocked"] },
          protocol: { const: "migration-guard.runtime-observation/v1" },
          fixtureKind: { enum: ["template", "synthetic", "real-runtime"] },
          fixtureHash: { $ref: "#/$defs/hash" },
          driverResultHash: { $ref: "#/$defs/hash" },
          observationHash: { $ref: "#/$defs/hash" },
          dimensions: { type: "object" },
          collectors: {
            type: "object",
            additionalProperties: false,
            properties: {
              mysql: { $ref: "#/$defs/collectorEvidence" },
              redis: { $ref: "#/$defs/collectorEvidence" },
              events: { $ref: "#/$defs/collectorEvidence" },
              "sql-trace": { $ref: "#/$defs/collectorEvidence" },
              "ai-trace": { $ref: "#/$defs/collectorEvidence" },
              "stream-trace": { $ref: "#/$defs/collectorEvidence" },
              "tool-trace": { $ref: "#/$defs/collectorEvidence" }
            }
          },
          correlation: { $ref: "#/$defs/correlationTrace" },
          semantics: {
            type: "object",
            additionalProperties: false,
            properties: {
              batch: { $ref: "#/$defs/batchEvidence" },
              page: { $ref: "#/$defs/pageEvidence" }
            }
          },
          findings: { type: "array", items: { type: "string" } }
        }
      }
      ,
      correlationTrace: {
        type: "object",
        additionalProperties: false,
        required: ["version", "scenarioId", "requestFingerprint", "sources", "traceHash"],
        properties: {
          version: { const: 1 },
          scenarioId: { type: "string", minLength: 1 },
          requestFingerprint: { $ref: "#/$defs/hash" },
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["source", "scenarioId", "requestFingerprint"],
              properties: {
                source: { enum: ["http", "mysql", "redis", "events", "sql-trace", "ai-trace", "stream-trace", "tool-trace"] },
                scenarioId: { type: "string", minLength: 1 },
                requestFingerprint: { $ref: "#/$defs/hash" }
              }
            }
          },
          traceHash: { $ref: "#/$defs/hash" }
        }
      }
    }
  };
}

function completeReadinessEvidence(): EndpointReplacementEvidence {
  return {
    graphComplete: true,
    contractsComplete: true,
    ownershipComplete: true,
    replayPassed: true,
    concurrencyPassed: true,
    faultPassed: true,
    performancePassed: true,
    sourceOffPassed: true,
    rollbackPassed: true,
    evidenceCreatedAt: new Date().toISOString(),
    maxEvidenceAgeMs: 86_400_000
  };
}

function contextEnvironmentVariable(context: string): string | undefined {
  const values: Record<string, string> = {
    tenant: "MG_JAVA_TENANT_ID",
    user: "MG_JAVA_USER_ID",
    request: "MG_JAVA_REQUEST_ID",
    datasource: "MG_JAVA_DATABASE_URL",
    device: "MG_JAVA_DEVICE_ID",
    locale: "MG_JAVA_LOCALE"
  };
  return values[context];
}

async function readJavaRuntimeContract(pkg: MigrationProjectPackage): Promise<JavaRuntimeContract | undefined> {
  const contractPath = path.join(javaRuntimeDir(pkg), CONTRACT_FILE);
  return await pathExists(contractPath) ? readJsonFile<JavaRuntimeContract>(contractPath) : undefined;
}

async function requireJavaRuntimeContract(pkg: MigrationProjectPackage): Promise<JavaRuntimeContract> {
  const contract = await readJavaRuntimeContract(pkg);
  if (!contract) throw new Error("Java runtime contract is missing. Run migrate runtime-prepare.");
  if (contract.contractHash !== runtimeContractHash(contract)) throw new Error("Java runtime contract integrity check failed.");
  return contract;
}

function runtimeContractHash(contract: JavaRuntimeContract): string {
  const { contractHash: _contractHash, ...base } = contract;
  return sha256(stableStringify({ ...base, generatedAt: undefined }));
}

function artifactReference(pkg: MigrationProjectPackage, file: string, value: unknown): JavaRuntimeArtifactReference {
  return {
    path: toPosixPath(path.relative(pkg.caseDir, file)),
    hash: sha256(stableStringify(value))
  };
}

function javaRuntimeDir(pkg: MigrationProjectPackage): string {
  return path.join(pkg.evidenceDir, ...RUNTIME_DIR);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function check(
  checks: JavaRuntimePreflightReport["checks"],
  id: string,
  passed: boolean,
  reason: string
): void {
  checks.push({ id, status: passed ? "passed" : "blocked", reason });
}

async function realFixtureHash(
  pkg: MigrationProjectPackage,
  entrypointId: string,
  scenarioId: string
): Promise<string | undefined> {
  const fixture = await readRealFixture(pkg, entrypointId, scenarioId);
  if (!fixture) return undefined;
  const entry = (await readJavaRuntimeContract(pkg))?.entries.find((item) => item.id === entrypointId);
  const scenario = entry?.scenarios.find((item) => item.id === scenarioId);
  if (validateMigrationFixture(fixture, {
    kind: "real-runtime",
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    entrypointId,
    scenarioId,
    batch: entry && scenario ? scenarioSemanticGates(entry, scenario).includes("batch") : false,
    page: entry && scenario ? scenarioSemanticGates(entry, scenario).includes("page") : false,
    query: entry && scenario ? scenarioSemanticGates(entry, scenario).includes("query") : false,
    writeSafety: entry && scenario ? scenarioSemanticGates(entry, scenario).includes("batch") : false,
    collectors: entry && scenario ? scenarioCollectors(entry, scenario) : []
  }).length > 0) return undefined;
  return sha256(stableStringify(fixture));
}

async function readRealFixture(
  pkg: MigrationProjectPackage,
  entrypointId: string,
  scenarioId: string
): Promise<MigrationFixtureMetadata | undefined> {
  const fixturePath = realFixturePath(pkg, entrypointId, scenarioId);
  if (!await pathExists(fixturePath)) return undefined;
  const fixture = await readJsonFile<unknown>(fixturePath);
  return classifyMigrationFixture(fixture) === "real-runtime"
    ? fixture as MigrationFixtureMetadata
    : undefined;
}

async function validateFixtureCollectorArtifacts(
  pkg: MigrationProjectPackage,
  fixture: MigrationFixtureMetadata,
  collectors: RuntimeCollectorKind[]
): Promise<boolean> {
  for (const collector of collectors) {
    const reference = fixture.collectorSpecs?.[collector];
    if (!reference) return false;
    const specPath = path.resolve(pkg.caseDir, reference.path);
    if (!await pathExists(specPath)) return false;
    const spec = await readJsonFile<{ status?: string; collector?: string }>(specPath);
    if (spec.status !== "ready" || spec.collector !== collector) return false;
    if (sha256(stableStringify(spec)) !== reference.hash) return false;
  }
  return true;
}

function realFixturePath(pkg: MigrationProjectPackage, entrypointId: string, scenarioId: string): string {
  return path.join(pkg.fixturesDir, "java-runtime", safeSegment(entrypointId), `${safeSegment(scenarioId)}.json`);
}

function driverCommandVariable(operation: typeof RUNTIME_OPERATIONS[number]): string {
  return `MG_JAVA_DRIVER_${operation.replace("-", "_").toUpperCase()}_COMMAND`;
}

function expandDriverCommand(
  command: string,
  values: { fixturePath: string; caseDir: string; entrypointId: string }
): string {
  return command
    .replaceAll("{fixture}", values.fixturePath)
    .replaceAll("{caseDir}", values.caseDir)
    .replaceAll("{entrypointId}", values.entrypointId);
}

function scenarioCategoryPassed(
  entry: JavaRuntimeEntryContract,
  scenarios: Record<string, JavaRuntimeScenarioEvidence>,
  category: ReplacementScenario["category"]
): boolean {
  const expected = entry.scenarios.filter((item) => item.category === category);
  return expected.length > 0 && expected.every((item) => scenarios[item.id]?.status === "passed");
}

function requiredCollectorsFor(
  plan: EndpointReplacementPlan,
  report: JavaEndpointAnalysisReport
): RuntimeCollectorKind[] {
  const collectors = new Set<RuntimeCollectorKind>();
  if (report.sqlSources.length > 0
    || plan.contracts.states.some((item) => item.resource === "database")
    || plan.contracts.effects.some((item) => item.kind === "database" || item.kind === "transaction" || item.kind === "undo")) {
    collectors.add("mysql");
  }
  if (plan.contracts.states.some((item) => item.resource === "cache" || item.operations.includes("lock"))
    || plan.contracts.effects.some((item) => item.kind === "cache" || item.kind === "lock")) {
    collectors.add("redis");
  }
  if (plan.contracts.states.some((item) => item.resource === "event-stream")
    || plan.contracts.effects.some((item) => item.kind === "event")) {
    collectors.add("events");
  }
  const semanticSymbols = [
    ...report.callGraph.nodes.map((node) => `${node.id} ${node.className}.${node.methodName} ${node.signature ?? ""}`),
    ...report.callGraph.edges.map((edge) => `${edge.call.expression} ${edge.unresolvedTarget ?? ""}`)
  ].join("\n");
  if (/\b(?:requestSpec|dashscope(?:Chat)?Model|chatModel)\.(?:call|stream)\b|\bembeddingModel\.(?:embed|embedForResponse)\b/i.test(semanticSymbols)) {
    collectors.add("ai-trace");
  }
  if (/\b(?:SseEmitter|emitter\.(?:send|complete)|bridge\.(?:start|complete)|session\.sendMessage|WebSocket)\b/i.test(semanticSymbols)) {
    collectors.add("stream-trace");
  }
  if (/\b(?:ProxyAiChatModel\.invokeLocalToolCallback|ToolCallback|toolCall)\b/i.test(semanticSymbols)) {
    collectors.add("tool-trace");
  }
  return [...collectors].sort();
}

interface RuntimeScenarioBinding {
  collectors: RuntimeCollectorKind[];
  expectations: {
    batch?: import("./vmpBatch.js").BatchGateRequirements;
    page?: PageGateRequirements;
    query?: QueryGateRequirements;
  };
  decisionIds: string[];
}

function runtimeBindingFor(
  pkg: MigrationProjectPackage,
  entrypointId: string,
  scenarioId: string,
  workload: EndpointWorkloadKind,
  defaultCollectors: RuntimeCollectorKind[]
): RuntimeScenarioBinding {
  const entryRules = (pkg.semanticRules.runtimeGates ?? []).filter((rule) => rule.entrypointId === entrypointId);
  if (entryRules.length === 0) {
    return {
      collectors: [...defaultCollectors],
      expectations: workload === "batch" ? {
        batch: {
          requireUndoCorrespondence: true,
          requireProgressTerminal: true,
          requireSharedLock: false,
          requireChunkIdempotency: false,
          requireTransactionTerminalOrdering: true
        }
      } : {},
      decisionIds: []
    };
  }
  const matching = entryRules.filter((rule) => new RegExp(rule.scenarioPattern).test(scenarioId));
  if (matching.length === 0) {
    throw new Error(`Java runtime semantic gates do not cover scenario: ${entrypointId}/${scenarioId}.`);
  }
  const expectations: RuntimeScenarioBinding["expectations"] = {};
  for (const rule of matching) {
    if (rule.gates.batch) expectations.batch = { ...expectations.batch, ...rule.gates.batch };
    if (rule.gates.page) expectations.page = { ...expectations.page, ...rule.gates.page };
    if (rule.gates.query) expectations.query = { ...expectations.query, ...rule.gates.query };
  }
  return {
    collectors: [...new Set(matching.flatMap((rule) => rule.collectors))].sort(),
    expectations,
    decisionIds: [...new Set(matching.flatMap((rule) => rule.decisionIds ?? []))].sort()
  };
}

function scenarioCollectors(
  entry: JavaRuntimeEntryContract,
  scenario: JavaRuntimeScenarioContract
): RuntimeCollectorKind[] {
  return scenario.requiredCollectors ?? entry.requiredCollectors ?? [];
}

function scenarioSemanticGates(
  entry: JavaRuntimeEntryContract,
  scenario: JavaRuntimeScenarioContract
): Array<"batch" | "page" | "query"> {
  if (scenario.semanticGates) return scenario.semanticGates;
  return entry.workload === "batch" ? ["batch"] : [];
}

function scenarioObservationHash(value: Pick<
  JavaRuntimeScenarioEvidence,
  "protocol" | "fixtureKind" | "dimensions" | "collectors" | "correlation" | "semantics"
>): string {
  return sha256(stableStringify({
    protocol: value.protocol,
    fixtureKind: value.fixtureKind,
    dimensions: value.dimensions,
    collectors: value.collectors,
    correlation: value.correlation,
    semantics: value.semantics
  }));
}

function containsSyntheticMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSyntheticMarker);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.synthetic === true) return true;
  return Object.values(record).some(containsSyntheticMarker);
}

function sameSourceIdentity(left: AssessmentSourceIdentity, right: AssessmentSourceIdentity): boolean {
  return left.revision === right.revision
    && left.dirty === right.dirty
    && left.dirtyFingerprint === right.dirtyFingerprint;
}
