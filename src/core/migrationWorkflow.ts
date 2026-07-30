import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { getMigrationSourceAdapter, type MigrationAnalysisOptions } from "./migrationAdapters.js";
import {
  loadMigrationProject,
  migrationProjectHash,
  resolveMigrationProjectPath,
  type MigrationProjectPackage
} from "./migrationProject.js";
import {
  createEndpointReplacementPlanFromJava,
  evaluateEndpointReplacementReadiness
} from "./endpointReplacementPlanner.js";
import type {
  EndpointReplacementEvidence,
  EndpointReplacementPlan
} from "./endpointReplacementModel.js";
import {
  captureAssessmentSourceIdentity,
  type AssessmentSourceIdentity
} from "./assessmentSourceIdentity.js";
import {
  assertReferenceSourceSnapshotUnchanged,
  captureReferenceSourceSnapshot,
  referenceSourceSnapshotsEqual,
  type ReferenceSourceSnapshot
} from "./referenceSourceGuard.js";
import {
  validateJavaRuntimeEvidenceBundle,
  type JavaRuntimeEvidenceBundle
} from "./javaRuntimeEvidence.js";
import { inspectMigrationFixtures } from "./migrationFixture.js";
import {
  getBuiltinJavaSemanticRulePackage,
  resolveJavaSemanticRulePackages,
  type JavaSemanticPackageResolution
} from "./javaSemanticPackages.js";
import {
  createSemanticRulePackageLock,
  type SemanticRulePackageLock
} from "./semanticRulePackage.js";
import {
  finalizeGateIntegrity,
  gateReportHash,
  validateGateIntegrity,
  type MigrationGateUpstream
} from "./migrationGateLineage.js";
import {
  createRustProductionVerificationTemplate,
  inspectRustProductionPath
} from "./productionPathAttestation.js";

export interface MigrationAnalyzeResult {
  version: 1;
  projectId: string;
  projectHash: string;
  sourceIdentity: AssessmentSourceIdentity;
  sourceSnapshot: ReferenceSourceSnapshot;
  sourceAccess: "read-only";
  adapter: string;
  semanticRulePackages?: SemanticRulePackageLock[];
  semanticPackageResolution?: JavaSemanticPackageResolution;
  status: "ready" | "blocked";
  entries: Array<{
    id: string;
    analysisPath: string;
    analysisHash: string;
    graphPath: string;
    graphHash: string;
    planPath: string;
    planHash: string;
    status: EndpointReplacementPlan["status"];
    findings: string[];
  }>;
}

export interface MigrationGateReport {
  version: 1;
  gate: "offline" | "real";
  projectId: string;
  projectHash: string;
  status: "passed" | "blocked";
  findings: string[];
  evidence: string[];
  evidenceDigests?: Record<string, string>;
  generatedAt?: string;
  freshness?: "fresh" | "stale";
  upstream?: MigrationGateUpstream[];
  reportHash?: string;
}

export interface RustScaffoldResult {
  version: 1;
  projectId: string;
  projectHash: string;
  targetRoot: string;
  created: string[];
  status: "created";
}

export async function analyzeMigrationProject(
  caseDir: string,
  options: MigrationAnalysisOptions = {}
): Promise<MigrationAnalyzeResult> {
  const pkg = await loadMigrationProject(caseDir);
  const adapter = getMigrationSourceAdapter(pkg.profile);
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  if (!await pathExists(sourceRoot)) throw new Error(`Migration source root does not exist: ${sourceRoot}.`);
  const entries: MigrationAnalyzeResult["entries"] = [];
  const semanticPackageResolution = resolveProjectSemanticPackages(pkg);
  const selectedSemanticPackageIds = semanticPackageResolution.selected.map((item) => item.packageId);
  const sourceSnapshot = await captureReferenceSourceSnapshot(sourceRoot, pkg.profile.source.directories);
  const sourceIdentity = sourceSnapshot.identity;
  try {
    for (const entrypoint of pkg.profile.entrypoints) {
      const report = await adapter.analyze(pkg, entrypoint, options);
      const result = createEndpointReplacementPlanFromJava(report, {
        ownershipPolicy: pkg.semanticRules.ownershipPolicy,
        classifications: pkg.semanticRules.classifications,
        semanticPackageIds: selectedSemanticPackageIds,
        approvedFindingResolutions: pkg.compatibilityDecisions.decisions
          .filter((decision) => decision.status === "approved")
          .flatMap((decision) => (decision.resolvesFindings ?? []).map((finding) => ({
            finding,
            decisionId: decision.id,
            reason: decision.reason
          })))
      });
      const entryDir = path.join(pkg.evidenceDir, "analysis", safeSegment(entrypoint.id));
      const analysisPath = path.join(entryDir, "java-analysis.json");
      const graphPath = path.join(entryDir, "behavior-graph.json");
      const planPath = path.join(entryDir, "endpoint-replacement-plan.json");
      await writeJsonFile(analysisPath, report);
      await writeJsonFile(graphPath, result.graph);
      await writeJsonFile(planPath, result.plan);
      entries.push({
        id: entrypoint.id,
        analysisPath,
        analysisHash: await artifactFileHash(analysisPath),
        graphPath,
        graphHash: await artifactFileHash(graphPath),
        planPath,
        planHash: await artifactFileHash(planPath),
        status: result.plan.status,
        findings: result.plan.findings
      });
    }
  } finally {
    await assertReferenceSourceSnapshotUnchanged(sourceSnapshot, "analysis");
  }
  const value: MigrationAnalyzeResult = {
    version: 1,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    sourceIdentity,
    sourceSnapshot,
    sourceAccess: "read-only",
    adapter: adapter.id,
    semanticRulePackages: selectedSemanticPackageIds.map((packageId) =>
      createSemanticRulePackageLock(getBuiltinJavaSemanticRulePackage(packageId)!)
    ),
    semanticPackageResolution,
    status: entries.every((entry) => entry.status === "ready") ? "ready" : "blocked",
    entries
  };
  await writeJsonFile(path.join(pkg.evidenceDir, "analysis", "index.json"), value);
  return value;
}

export async function scaffoldRustMigrationProject(caseDir: string, force = false): Promise<RustScaffoldResult> {
  const pkg = await loadMigrationProject(caseDir);
  if (pkg.profile.target.language.toLowerCase() !== "rust") {
    throw new Error(`Unsupported scaffold target: ${pkg.profile.target.language}.`);
  }
  const targetRoot = resolveMigrationProjectPath(pkg, pkg.profile.target.root);
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  const sourceSnapshot = await captureReferenceSourceSnapshot(sourceRoot, pkg.profile.source.directories);
  const crateName = rustCrateName(pkg.profile.target.serviceName);
  const files = new Map<string, string>([
    [path.join(targetRoot, "Cargo.toml"), renderCargoToml(crateName)],
    [path.join(targetRoot, "src", "lib.rs"), renderRustLib(pkg)],
    [path.join(targetRoot, "src", "main.rs"), renderRustMain(crateName)],
    [path.join(targetRoot, "migration-contract.json"), `${JSON.stringify(createScaffoldContract(pkg), null, 2)}\n`],
    [path.join(targetRoot, "README.md"), renderRustReadme(pkg)]
  ]);
  const existing = [];
  for (const file of files.keys()) if (await pathExists(file)) existing.push(file);
  if (existing.length > 0 && !force) {
    throw new Error(`Rust scaffold would overwrite existing files: ${existing.join(", ")}. Use --force to replace them.`);
  }
  try {
    for (const [file, content] of files) await writeTextFile(file, content);
  } finally {
    await assertReferenceSourceSnapshotUnchanged(sourceSnapshot, "scaffold");
  }
  return {
    version: 1,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    targetRoot,
    created: [...files.keys()],
    status: "created"
  };
}

export async function evaluateMigrationOfflineGate(caseDir: string): Promise<MigrationGateReport> {
  const pkg = await loadMigrationProject(caseDir);
  const findings: string[] = [];
  const evidence: string[] = [];
  const fixtureInspections = await inspectMigrationFixtures(pkg.fixturesDir);
  const specificationFixtures = fixtureInspections.filter((item) => item.kind === "specification" && item.valid);
  if (specificationFixtures.length === 0) findings.push("MG-OFFLINE-SPEC-FIXTURES-MISSING");
  evidence.push(...fixtureInspections.filter((item) => item.valid).map((item) => item.path));
  for (const fixture of fixtureInspections.filter((item) => !item.valid)) {
    findings.push(...fixture.findings.map((finding) => `${finding}:${toRelativeFixturePath(pkg, fixture.path)}`));
  }
  const analysisIndexPath = path.join(pkg.evidenceDir, "analysis", "index.json");
  if (!await pathExists(analysisIndexPath)) {
    findings.push("MG-OFFLINE-ANALYSIS-INDEX-MISSING");
  } else {
    evidence.push(analysisIndexPath);
    const index = await readJsonFile<MigrationAnalyzeResult>(analysisIndexPath);
    if (index.projectHash !== migrationProjectHash(pkg)) findings.push("MG-OFFLINE-PROJECT-HASH-MISMATCH");
    const currentSource = await captureAssessmentSourceIdentity(resolveMigrationProjectPath(pkg, pkg.profile.source.root));
    if (!index.sourceIdentity || stableSourceIdentity(index.sourceIdentity) !== stableSourceIdentity(currentSource)) {
      findings.push("MG-OFFLINE-SOURCE-IDENTITY-MISMATCH");
    }
    const currentSnapshot = await captureReferenceSourceSnapshot(
      resolveMigrationProjectPath(pkg, pkg.profile.source.root),
      pkg.profile.source.directories
    );
    if (!index.sourceSnapshot) {
      findings.push("MG-OFFLINE-SOURCE-SNAPSHOT-MISSING");
    } else if (!referenceSourceSnapshotsEqual(index.sourceSnapshot, currentSnapshot)) {
      findings.push("MG-OFFLINE-SOURCE-SNAPSHOT-MISMATCH");
    }
    if (index.semanticRulePackages) {
      const expectedResolution = resolveProjectSemanticPackages(pkg);
      const expectedPackages = expectedResolution.selected.map((item) =>
        createSemanticRulePackageLock(getBuiltinJavaSemanticRulePackage(item.packageId)!)
      );
      if (!index.semanticPackageResolution
        || JSON.stringify(index.semanticPackageResolution) !== JSON.stringify(expectedResolution)
        || index.semanticRulePackages.length !== expectedPackages.length) {
        findings.push("MG-OFFLINE-SEMANTIC-PACKAGE-SELECTION-MISMATCH");
      }
      for (const currentPackage of expectedPackages) {
        const recordedPackage = index.semanticRulePackages.find((item) => item.packageId === currentPackage.packageId);
        if (!recordedPackage || recordedPackage.packageHash !== currentPackage.packageHash) {
          findings.push(`MG-OFFLINE-SEMANTIC-PACKAGE-MISMATCH:${currentPackage.packageId}`);
        }
      }
    }
  }
  for (const entrypoint of pkg.profile.entrypoints) {
    const entryDir = path.join(pkg.evidenceDir, "analysis", safeSegment(entrypoint.id));
    const analysisPath = path.join(entryDir, "java-analysis.json");
    const graphPath = path.join(entryDir, "behavior-graph.json");
    const planPath = path.join(entryDir, "endpoint-replacement-plan.json");
    const recordedEntry = await pathExists(analysisIndexPath)
      ? (await readJsonFile<MigrationAnalyzeResult>(analysisIndexPath)).entries
        .find((item) => item.id === entrypoint.id)
      : undefined;
    if (!recordedEntry) {
      findings.push(`MG-OFFLINE-ANALYSIS-ENTRY-MISSING:${entrypoint.id}`);
    }
    if (!await pathExists(analysisPath)) {
      findings.push(`MG-OFFLINE-ANALYSIS-MISSING:${entrypoint.id}`);
    } else {
      evidence.push(analysisPath);
      if (!recordedEntry?.analysisHash
        || recordedEntry.analysisHash !== await artifactFileHash(analysisPath)) {
        findings.push(`MG-OFFLINE-ANALYSIS-HASH-MISMATCH:${entrypoint.id}`);
      }
    }
    if (!await pathExists(graphPath)) findings.push(`MG-OFFLINE-GRAPH-MISSING:${entrypoint.id}`);
    else {
      evidence.push(graphPath);
      if (!recordedEntry?.graphHash
        || recordedEntry.graphHash !== await artifactFileHash(graphPath)) {
        findings.push(`MG-OFFLINE-GRAPH-HASH-MISMATCH:${entrypoint.id}`);
      }
    }
    if (!await pathExists(planPath)) {
      findings.push(`MG-OFFLINE-PLAN-MISSING:${entrypoint.id}`);
      continue;
    }
    evidence.push(planPath);
    if (!recordedEntry?.planHash
      || recordedEntry.planHash !== await artifactFileHash(planPath)) {
      findings.push(`MG-OFFLINE-PLAN-HASH-MISMATCH:${entrypoint.id}`);
    }
    const plan = await readJsonFile<EndpointReplacementPlan>(planPath);
    if (plan.status !== "ready") findings.push(`MG-OFFLINE-PLAN-BLOCKED:${entrypoint.id}`);
    if (plan.endpoint.path !== entrypoint.path || plan.endpoint.method !== entrypoint.method) {
      findings.push(`MG-OFFLINE-ENDPOINT-MISMATCH:${entrypoint.id}`);
    }
  }
  const pending = pkg.compatibilityDecisions.decisions.filter((item) => item.status === "pending");
  if (pkg.profile.compatibility.strict && pending.length > 0) {
    findings.push(...pending.map((item) => `MG-OFFLINE-COMPATIBILITY-PENDING:${item.id}`));
  }
  return writeGateReport(pkg, {
    version: 1,
    gate: "offline",
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    status: findings.length === 0 ? "passed" : "blocked",
    findings: [...new Set(findings)].sort(),
    evidence: [...new Set(evidence)].sort()
  });
}

function resolveProjectSemanticPackages(pkg: MigrationProjectPackage): JavaSemanticPackageResolution {
  return resolveJavaSemanticRulePackages({
    projectId: pkg.profile.projectId,
    language: pkg.profile.source.language,
    framework: pkg.profile.source.framework,
    explicitPackageIds: pkg.semanticRules.packageIds
  });
}

export async function evaluateMigrationRealGate(
  caseDir: string,
  evidencePath?: string,
  now = Date.now()
): Promise<MigrationGateReport> {
  const pkg = await loadMigrationProject(caseDir);
  const findings: string[] = [];
  const evidence: string[] = [];
  const offline = await evaluateMigrationOfflineGate(caseDir);
  const offlinePath = path.join(pkg.evidenceDir, "gates", "offline-gate.json");
  evidence.push(offlinePath);
  if (offline.status !== "passed") findings.push("MG-REAL-OFFLINE-GATE-BLOCKED");
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  const targetRoot = resolveMigrationProjectPath(pkg, pkg.profile.target.root);
  if (!await pathExists(sourceRoot)) findings.push("MG-REAL-SOURCE-ROOT-MISSING");
  if (!await pathExists(targetRoot)) findings.push("MG-REAL-TARGET-ROOT-MISSING");
  if (pkg.profile.target.language.toLowerCase() === "rust" && await pathExists(targetRoot)) {
    const implementationEvidenceDir = path.join(pkg.evidenceDir, "implementation");
    const productionVerificationEvidence = path.join(
      implementationEvidenceDir,
      "production-verification.json"
    );
    const productionPath = await inspectRustProductionPath(targetRoot, {
      requiredTraits: pkg.profile.target.productionPath?.requiredTraits ?? [],
      requiredRouteFragments: pkg.profile.target.productionPath?.requiredRouteFragments
        ?? pkg.profile.entrypoints.flatMap((entrypoint) => entrypoint.path ? [entrypoint.path] : []),
      projectId: pkg.profile.projectId,
      requireVerificationEvidence: pkg.profile.compatibility.strict,
      verificationEvidencePath: productionVerificationEvidence
    });
    const productionPathEvidence = path.join(
      implementationEvidenceDir,
      "production-path-attestation.json"
    );
    const productionVerificationTemplate = path.join(
      implementationEvidenceDir,
      "production-verification.template.json"
    );
    if (!await pathExists(productionVerificationEvidence)) {
      await writeJsonFile(productionVerificationTemplate, createRustProductionVerificationTemplate(
        pkg.profile.projectId,
        productionPath.targetSourceHash,
        pkg.profile.target.productionPath?.requiredRouteFragments
          ?? pkg.profile.entrypoints.flatMap((entrypoint) => entrypoint.path ? [entrypoint.path] : [])
      ));
    }
    await writeJsonFile(productionPathEvidence, productionPath);
    evidence.push(productionPathEvidence);
    evidence.push(...productionPath.evidence.verification.referencedFiles);
    findings.push(...productionPath.findings);
    if (!productionPath.productionEligible) findings.push("MG-REAL-PRODUCTION-PATH-NOT-ELIGIBLE");
  }
  const resolvedEvidencePath = evidencePath
    ? path.resolve(evidencePath)
    : path.join(pkg.evidenceDir, "runtime", "java", "real-evidence.json");
  if (!await pathExists(resolvedEvidencePath)) {
    findings.push("MG-REAL-EVIDENCE-MISSING");
  } else {
    evidence.push(resolvedEvidencePath);
    const value = await readJsonFile<JavaRuntimeEvidenceBundle>(resolvedEvidencePath);
    const validation = await validateJavaRuntimeEvidenceBundle(pkg.caseDir, value);
    findings.push(...validation.findings);
    if (!validation.realEligible) findings.push("MG-REAL-EVIDENCE-NOT-ELIGIBLE");
    for (const entrypoint of pkg.profile.entrypoints) {
      const current = value.entries?.[entrypoint.id]?.readiness;
      if (!current) {
        findings.push(`MG-REAL-ENTRY-EVIDENCE-MISSING:${entrypoint.id}`);
        continue;
      }
      const readiness = evaluateEndpointReplacementReadiness(current, now);
      if (readiness.status !== "ready") {
        findings.push(...readiness.levels.flatMap((level) => level.findings.map((finding) => `${finding}:${entrypoint.id}`)));
      }
    }
  }
  return writeGateReport(pkg, {
    version: 1,
    gate: "real",
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    status: findings.length === 0 ? "passed" : "blocked",
    findings: [...new Set(findings)].sort(),
    evidence: [...new Set(evidence)].sort(),
    upstream: [{
      gate: "offline",
      path: offlinePath,
      projectHash: offline.projectHash,
      reportHash: offline.reportHash ?? "",
      status: offline.status
    }]
  });
}

async function writeGateReport(pkg: MigrationProjectPackage, report: MigrationGateReport): Promise<MigrationGateReport> {
  const evidenceDigests = await hashEvidenceFiles(report.evidence);
  const finalized = finalizeGateIntegrity({
    ...report,
    evidenceDigests
  }) as MigrationGateReport;
  await writeJsonFile(path.join(pkg.evidenceDir, "gates", `${report.gate}-gate.json`), finalized);
  if (report.gate === "offline") await invalidateStaleRealGate(pkg, finalized);
  return finalized;
}

export async function inspectMigrationGateFreshness(
  caseDir: string,
  gate: "offline" | "real"
): Promise<string[]> {
  const pkg = await loadMigrationProject(caseDir);
  const reportPath = path.join(pkg.evidenceDir, "gates", `${gate}-gate.json`);
  if (!await pathExists(reportPath)) return [`MG-GATE-MISSING:${gate}`];
  const report = await readJsonFile<MigrationGateReport>(reportPath);
  let upstream: MigrationGateUpstream[] = [];
  if (gate === "real") {
    const offlinePath = path.join(pkg.evidenceDir, "gates", "offline-gate.json");
    if (!await pathExists(offlinePath)) return ["MG-GATE-UPSTREAM-MISSING:offline"];
    const offline = await readJsonFile<MigrationGateReport>(offlinePath);
    upstream = [{
      gate: "offline",
      path: offlinePath,
      projectHash: offline.projectHash,
      reportHash: offline.reportHash ?? "",
      status: offline.status
    }];
  }
  const findings = validateGateIntegrity(report, migrationProjectHash(pkg), upstream);
  findings.push(...await validateEvidenceDigests(report));
  return [...new Set(findings)].sort();
}

async function invalidateStaleRealGate(
  pkg: MigrationProjectPackage,
  offline: MigrationGateReport
): Promise<void> {
  const realPath = path.join(pkg.evidenceDir, "gates", "real-gate.json");
  if (!await pathExists(realPath)) return;
  const current = await readJsonFile<MigrationGateReport>(realPath);
  const expected: MigrationGateUpstream = {
    gate: "offline",
    path: path.join(pkg.evidenceDir, "gates", "offline-gate.json"),
    projectHash: offline.projectHash,
    reportHash: offline.reportHash ?? "",
    status: offline.status
  };
  if (validateGateIntegrity(current, migrationProjectHash(pkg), [expected]).length === 0) return;
  const base = finalizeGateIntegrity({
    version: 1 as const,
    gate: "real" as const,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    status: "blocked" as const,
    findings: ["MG-REAL-UPSTREAM-GATE-STALE"],
    evidence: [expected.path],
    evidenceDigests: await hashEvidenceFiles([expected.path]),
    upstream: [expected]
  });
  const stale = {
    ...base,
    freshness: "stale" as const,
    reportHash: ""
  };
  stale.reportHash = gateReportHash(stale);
  await writeJsonFile(realPath, stale);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function toRelativeFixturePath(pkg: MigrationProjectPackage, file: string): string {
  return path.relative(pkg.fixturesDir, file).replaceAll("\\", "/");
}

function rustCrateName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Unable to derive a Rust crate name from target.serviceName.");
  return normalized;
}

function rustModuleName(crateName: string): string {
  return crateName.replaceAll("-", "_");
}

function renderCargoToml(crateName: string): string {
  return `[package]\nname = "${crateName}"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n`;
}

function renderRustLib(pkg: MigrationProjectPackage): string {
  const entries = pkg.profile.entrypoints.map((item) => `"${item.id}"`).join(", ");
  return `//! Generated migration scaffold. Business behavior must be implemented and proven by the gates.\n\npub const MIGRATION_PROJECT_ID: &str = "${pkg.profile.projectId}";\npub const ENTRYPOINTS: &[&str] = &[${entries}];\n`;
}

function renderRustMain(crateName: string): string {
  return `fn main() {\n    println!("migration scaffold: {}", ${rustModuleName(crateName)}::MIGRATION_PROJECT_ID);\n}\n`;
}

function createScaffoldContract(pkg: MigrationProjectPackage): unknown {
  return {
    schemaVersion: 1,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    generatedFrom: pkg.profilePath,
    entrypoints: pkg.profile.entrypoints,
    contexts: pkg.profile.contexts,
    data: pkg.profile.data,
    infrastructure: pkg.profile.infrastructure,
    compatibility: pkg.profile.compatibility,
    implementationStatus: "scaffold-only"
  };
}

function renderRustReadme(pkg: MigrationProjectPackage): string {
  return `# ${pkg.profile.target.serviceName}\n\nGenerated by \`migration-guard migrate scaffold --target rust\`.\n\nThis is a compileable starting scaffold, not a completed migration. Implement the behavior graph contracts, add runtime adapters, and pass both offline and real gates before routing traffic here.\n`;
}

function stableSourceIdentity(value: AssessmentSourceIdentity): string {
  return `${value.revision}\u001f${value.dirty}\u001f${value.dirtyFingerprint}`;
}

async function artifactFileHash(file: string): Promise<string> {
  return sha256((await readFile(file)).toString("base64"));
}

async function hashEvidenceFiles(files: string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const file of [...new Set(files)].sort()) {
    if (await pathExists(file)) digests[file] = await artifactFileHash(file);
  }
  return digests;
}

async function validateEvidenceDigests(report: MigrationGateReport): Promise<string[]> {
  const findings: string[] = [];
  if (!report.evidenceDigests) return ["MG-GATE-EVIDENCE-DIGESTS-MISSING"];
  for (const file of report.evidence ?? []) {
    const expected = report.evidenceDigests[file];
    if (!expected) {
      findings.push(`MG-GATE-EVIDENCE-DIGEST-MISSING:${path.basename(file)}`);
      continue;
    }
    if (!await pathExists(file)) {
      findings.push(`MG-GATE-EVIDENCE-MISSING:${path.basename(file)}`);
      continue;
    }
    if (await artifactFileHash(file) !== expected) {
      findings.push(`MG-GATE-EVIDENCE-TAMPERED:${path.basename(file)}`);
    }
  }
  for (const file of Object.keys(report.evidenceDigests)) {
    if (!(report.evidence ?? []).includes(file)) {
      findings.push(`MG-GATE-EVIDENCE-DIGEST-ORPHAN:${path.basename(file)}`);
    }
  }
  return findings;
}
