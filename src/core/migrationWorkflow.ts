import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
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
  validateJavaRuntimeEvidenceBundle,
  type JavaRuntimeEvidenceBundle
} from "./javaRuntimeEvidence.js";
import { inspectMigrationFixtures } from "./migrationFixture.js";
import { JAVA_SEMANTIC_RULE_PACKAGE } from "./javaSemanticRegistry.js";
import {
  createSemanticRulePackageLock,
  type SemanticRulePackageLock
} from "./semanticRulePackage.js";

export interface MigrationAnalyzeResult {
  version: 1;
  projectId: string;
  projectHash: string;
  sourceIdentity: AssessmentSourceIdentity;
  sourceAccess: "read-only";
  adapter: string;
  semanticRulePackages?: SemanticRulePackageLock[];
  status: "ready" | "blocked";
  entries: Array<{
    id: string;
    analysisPath: string;
    graphPath: string;
    planPath: string;
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
  const sourceIdentity = await captureAssessmentSourceIdentity(sourceRoot);
  try {
    for (const entrypoint of pkg.profile.entrypoints) {
      const report = await adapter.analyze(pkg, entrypoint, options);
      const result = createEndpointReplacementPlanFromJava(report, {
        ownershipPolicy: pkg.semanticRules.ownershipPolicy,
        classifications: pkg.semanticRules.classifications
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
        graphPath,
        planPath,
        status: result.plan.status,
        findings: result.plan.findings
      });
    }
  } finally {
    await assertReferenceSourceUnchanged(sourceRoot, sourceIdentity, "analysis");
  }
  const value: MigrationAnalyzeResult = {
    version: 1,
    projectId: pkg.profile.projectId,
    projectHash: migrationProjectHash(pkg),
    sourceIdentity,
    sourceAccess: "read-only",
    adapter: adapter.id,
    semanticRulePackages: [createSemanticRulePackageLock(JAVA_SEMANTIC_RULE_PACKAGE)],
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
  const sourceIdentity = await captureAssessmentSourceIdentity(sourceRoot);
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
    await assertReferenceSourceUnchanged(sourceRoot, sourceIdentity, "scaffold");
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
    if (index.semanticRulePackages) {
      const currentPackage = createSemanticRulePackageLock(JAVA_SEMANTIC_RULE_PACKAGE);
      const recordedPackage = index.semanticRulePackages.find((item) => item.packageId === currentPackage.packageId);
      if (!recordedPackage || recordedPackage.packageHash !== currentPackage.packageHash) {
        findings.push(`MG-OFFLINE-SEMANTIC-PACKAGE-MISMATCH:${currentPackage.packageId}`);
      }
    }
  }
  for (const entrypoint of pkg.profile.entrypoints) {
    const entryDir = path.join(pkg.evidenceDir, "analysis", safeSegment(entrypoint.id));
    const graphPath = path.join(entryDir, "behavior-graph.json");
    const planPath = path.join(entryDir, "endpoint-replacement-plan.json");
    if (!await pathExists(graphPath)) findings.push(`MG-OFFLINE-GRAPH-MISSING:${entrypoint.id}`);
    else evidence.push(graphPath);
    if (!await pathExists(planPath)) {
      findings.push(`MG-OFFLINE-PLAN-MISSING:${entrypoint.id}`);
      continue;
    }
    evidence.push(planPath);
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
    evidence: [...new Set(evidence)].sort()
  });
}

async function writeGateReport(pkg: MigrationProjectPackage, report: MigrationGateReport): Promise<MigrationGateReport> {
  await writeJsonFile(path.join(pkg.evidenceDir, "gates", `${report.gate}-gate.json`), report);
  return report;
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

async function assertReferenceSourceUnchanged(
  sourceRoot: string,
  before: AssessmentSourceIdentity,
  operation: string
): Promise<void> {
  const after = await captureAssessmentSourceIdentity(sourceRoot);
  if (stableSourceIdentity(before) !== stableSourceIdentity(after)) {
    throw new Error(`MG-SOURCE-READ-ONLY-VIOLATION:${operation}:${sourceRoot}`);
  }
}
