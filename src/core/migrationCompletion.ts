import { promises as fs } from "node:fs";
import path from "node:path";
import { scanArtifactFiles, type SensitiveArtifactFinding } from "./artifactSecurity.js";
import { pathExists, readJsonFile, writeJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import {
  assessMigrationCapability,
  type MigrationCapabilityAssessment,
  type MigrationCapabilityLevel,
  type MigrationCapabilitySignals
} from "./migrationCapability.js";
import { finalizeGateIntegrity } from "./migrationGateLineage.js";
import {
  loadMigrationProject,
  migrationProjectHash,
  resolveMigrationProjectPath,
  type MigrationProjectPackage
} from "./migrationProject.js";

export const MIGRATION_COMPLETION_CONTRACT_FILE = "completion-contract.json";
export const MIGRATION_COMPLETION_EVIDENCE_TEMPLATE_FILE = "completion-evidence.template.json";

export type MigrationCompletionEvidenceKind =
  | "source-snapshot"
  | "analysis-report"
  | "test-report"
  | "static-attestation"
  | "container-integration"
  | "runtime-replay"
  | "operational-drill";

export interface MigrationCompletionControl {
  id: string;
  level: Exclude<MigrationCapabilityLevel, "L0">;
  signal: keyof MigrationCapabilitySignals;
  category: string;
  description: string;
  evidenceKind: MigrationCompletionEvidenceKind;
  maxAgeHours: number;
}

export interface MigrationCompletionContract {
  schemaVersion: 1;
  projectId: string;
  controls: MigrationCompletionControl[];
}

export interface MigrationCompletionArtifact {
  path: string;
  sha256: string;
  controlId: string;
  evidenceKind: MigrationCompletionEvidenceKind;
}

export interface MigrationCompletionControlArtifact {
  schemaVersion: 1;
  protocol: "migration-guard.completion-control-evidence/v1";
  projectId: string;
  projectHash: string;
  controlId: string;
  evidenceKind: MigrationCompletionEvidenceKind;
  status: "passed" | "blocked";
  observedAt: string;
  synthetic: false;
  realEligible: boolean;
  producer: {
    tool: string;
    version: string;
    command: string;
    identity: string;
  };
  review?: {
    decision: "approved" | "rejected";
    identity: string;
    reviewedAt: string;
  };
  claims: Record<string, boolean | string | number>;
}

export interface MigrationCompletionControlEvidence {
  status: "passed" | "blocked";
  observedAt: string;
  artifacts: MigrationCompletionArtifact[];
  note?: string;
}

export interface MigrationCompletionEvidenceBundle {
  schemaVersion: 1;
  projectId: string;
  projectHash: string;
  generatedAt: string;
  controls: Record<string, MigrationCompletionControlEvidence>;
}

export interface MigrationCompletionGateReport {
  schemaVersion: 1;
  gate: "completion";
  projectId: string;
  projectHash: string;
  status: "passed" | "blocked";
  capability: MigrationCapabilityAssessment;
  controlSummary: {
    total: number;
    passed: number;
    blocked: number;
  };
  findings: string[];
  securityFindings: SensitiveArtifactFinding[];
  evidence: string[];
  generatedAt?: string;
  freshness?: "fresh" | "stale";
  reportHash?: string;
}

export interface MigrationCompletionPrepareResult {
  schemaVersion: 1;
  status: "prepared";
  projectId: string;
  projectHash: string;
  contractPath: string;
  evidenceTemplatePath: string;
  controls: Record<string, number>;
}

const SIGNAL_LEVEL: Record<keyof MigrationCapabilitySignals, Exclude<MigrationCapabilityLevel, "L0">> = {
  sourceReadOnlyGuardPassed: "L1",
  analysisComplete: "L1",
  offlineContractPassed: "L2",
  implementationChecksPassed: "L3",
  scenarioContractPassed: "L3",
  dependencyProtocolChecksPassed: "L4-A",
  concreteAdaptersAttested: "L4-B",
  deployableServiceAttested: "L4-B",
  realEvidencePassed: "L4-C",
  dualReplayPassed: "L4-C",
  unifiedRealGatePassed: "L4"
};

export function createMigrationCompletionContract(
  pkg: MigrationProjectPackage
): MigrationCompletionContract {
  const controls: MigrationCompletionControl[] = [
    control("source.read-only-snapshot", "sourceReadOnlyGuardPassed", "source", "Reference source read-only snapshot is unchanged.", "source-snapshot", 168),
    control("analysis.complete", "analysisComplete", "analysis", "All configured entrypoints have complete analysis and replacement plans.", "analysis-report", 168),
    control("offline.contract", "offlineContractPassed", "offline", "Offline behavior contract gate passes with fresh lineage.", "analysis-report", 168),
    control("implementation.checks", "implementationChecksPassed", "implementation", "Target implementation checks and regression tests pass.", "test-report", 168),
    control("scenario.contract", "scenarioContractPassed", "implementation", "Required semantic, fault and concurrency scenarios pass.", "test-report", 168),
    control("dependency.protocol", "dependencyProtocolChecksPassed", "dependency", "Dependency protocol integration checks pass.", "container-integration", 72)
  ];
  const requiredTraits = pkg.profile.target.productionPath?.requiredTraits ?? [];
  if (requiredTraits.length === 0) {
    controls.push(control(
      "production.concrete-adapters",
      "concreteAdaptersAttested",
      "production",
      "All target-owned production adapters are concrete and non-test.",
      "static-attestation",
      72
    ));
  } else {
    for (const traitName of requiredTraits) {
      controls.push(control(
        `production.adapter.${safeControlSegment(traitName)}`,
        "concreteAdaptersAttested",
        "production",
        `Concrete non-test implementation exists for ${traitName}.`,
        "static-attestation",
        72
      ));
    }
  }
  controls.push(
    control("production.http-service", "deployableServiceAttested", "production", "The target starts as a deployable HTTP service with all configured routes.", "static-attestation", 72),
    control("production.configuration", "deployableServiceAttested", "production", "Startup configuration and secret bindings fail closed.", "container-integration", 72),
    control("production.health-readiness", "deployableServiceAttested", "operations", "Health and readiness probes traverse required dependencies.", "container-integration", 72)
  );
  if (hasBatchRuntimeGate(pkg)) {
    controls.push(
      control("schema-transition.client-boundary", "deployableServiceAttested", "schema-transition", "Batch execution calls an independent schema-transition service.", "container-integration", 72),
      control("schema-transition.lease", "deployableServiceAttested", "schema-transition", "Schema changes are protected by a renewable fenced lease.", "container-integration", 72),
      control("schema-transition.idempotency", "deployableServiceAttested", "schema-transition", "Create-table and add-column requests are idempotent.", "container-integration", 72),
      control("schema-transition.resume", "deployableServiceAttested", "schema-transition", "Batch execution resumes safely after a successful schema transition.", "container-integration", 72),
      control("schema-transition.ddl-fault", "deployableServiceAttested", "schema-transition", "DDL timeout, conflict and partial-failure evidence is captured.", "container-integration", 72)
    );
  }
  controls.push(
    control("real.runtime-evidence", "realEvidencePassed", "real-evidence", "Redacted real-runtime evidence passes semantic validation.", "runtime-replay", 24),
    control("real.dual-replay", "dualReplayPassed", "real-evidence", "Source and target replay outputs and side effects compare equal.", "runtime-replay", 24)
  );
  if (hasBatchRuntimeGate(pkg)) {
    controls.push(
      control("real.disposable-write-scope", "realEvidencePassed", "real-evidence", "Real writes are restricted to an approved disposable fixture scope.", "runtime-replay", 24),
      control("real.cleanup-verification", "realEvidencePassed", "real-evidence", "Fixture cleanup is marker-bound and verified after replay.", "runtime-replay", 24)
    );
  }
  controls.push(
    control("release.unified-real-gate", "unifiedRealGatePassed", "release", "The unified real-environment gate passes with fresh upstream evidence.", "runtime-replay", 24),
    control("release.observability", "unifiedRealGatePassed", "operations", "Metrics, logs, traces and correlation identifiers are verified.", "operational-drill", 24),
    control("release.canary", "unifiedRealGatePassed", "release", "A bounded canary or shadow rollout is rehearsed.", "operational-drill", 24),
    control("release.rollback-rehearsal", "unifiedRealGatePassed", "release", "Rollback restores service and data invariants inside the declared objective.", "operational-drill", 24),
    control("release.source-off", "unifiedRealGatePassed", "release", "Source-off behavior and fallback ownership are explicitly verified.", "operational-drill", 24)
  );
  return {
    schemaVersion: 1,
    projectId: pkg.profile.projectId,
    controls
  };
}

export function validateMigrationCompletionContract(
  contract: MigrationCompletionContract,
  expectedProjectId?: string
): string[] {
  const findings: string[] = [];
  if (contract.schemaVersion !== 1) findings.push("MG-COMPLETION-CONTRACT-VERSION-UNSUPPORTED");
  if (!contract.projectId || (expectedProjectId && contract.projectId !== expectedProjectId)) {
    findings.push("MG-COMPLETION-CONTRACT-PROJECT-MISMATCH");
  }
  if (!Array.isArray(contract.controls) || contract.controls.length === 0) {
    findings.push("MG-COMPLETION-CONTROLS-MISSING");
    return findings;
  }
  const ids = new Set<string>();
  const signalCounts = new Map<keyof MigrationCapabilitySignals, number>();
  for (const item of contract.controls) {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(item.id) || ids.has(item.id)) {
      findings.push(`MG-COMPLETION-CONTROL-ID-INVALID:${item.id || "missing"}`);
    }
    ids.add(item.id);
    if (SIGNAL_LEVEL[item.signal] !== item.level) {
      findings.push(`MG-COMPLETION-CONTROL-LEVEL-MISMATCH:${item.id}`);
    }
    if (!item.category || !item.description) findings.push(`MG-COMPLETION-CONTROL-DESCRIPTION-MISSING:${item.id}`);
    if (!Number.isFinite(item.maxAgeHours) || item.maxAgeHours <= 0) {
      findings.push(`MG-COMPLETION-CONTROL-MAX-AGE-INVALID:${item.id}`);
    }
    signalCounts.set(item.signal, (signalCounts.get(item.signal) ?? 0) + 1);
  }
  for (const signal of Object.keys(SIGNAL_LEVEL) as Array<keyof MigrationCapabilitySignals>) {
    if (!signalCounts.has(signal)) findings.push(`MG-COMPLETION-SIGNAL-CONTROL-MISSING:${signal}`);
  }
  return [...new Set(findings)].sort();
}

export async function prepareMigrationCompletion(
  caseDir: string,
  force = false
): Promise<MigrationCompletionPrepareResult> {
  let pkg = await loadMigrationProject(caseDir);
  const contractPath = path.join(pkg.caseDir, MIGRATION_COMPLETION_CONTRACT_FILE);
  if (force || !await pathExists(contractPath)) {
    await writeJsonFile(contractPath, createMigrationCompletionContract(pkg));
  }
  pkg = await loadMigrationProject(caseDir);
  const contract = await readJsonFile<MigrationCompletionContract>(contractPath);
  const findings = validateMigrationCompletionContract(contract, pkg.profile.projectId);
  if (findings.length > 0) throw new Error(`Invalid migration completion contract: ${findings.join(", ")}`);
  const projectHash = migrationProjectHash(pkg);
  const evidenceTemplatePath = path.join(pkg.caseDir, MIGRATION_COMPLETION_EVIDENCE_TEMPLATE_FILE);
  if (force || !await pathExists(evidenceTemplatePath)) {
    const generatedAt = new Date().toISOString();
    await writeJsonFile(evidenceTemplatePath, {
      schemaVersion: 1,
      projectId: pkg.profile.projectId,
      projectHash,
      generatedAt,
      controls: Object.fromEntries(contract.controls.map((item) => [
        item.id,
        {
          status: "blocked",
          observedAt: generatedAt,
          artifacts: [],
          note: `Attach ${item.evidenceKind} evidence and set status to passed after review.`
        }
      ]))
    } satisfies MigrationCompletionEvidenceBundle);
  }
  return {
    schemaVersion: 1,
    status: "prepared",
    projectId: pkg.profile.projectId,
    projectHash,
    contractPath,
    evidenceTemplatePath,
    controls: countByLevel(contract.controls)
  };
}

export async function evaluateMigrationCompletionGate(
  caseDir: string,
  evidencePath?: string,
  now = Date.now()
): Promise<MigrationCompletionGateReport> {
  const pkg = await loadMigrationProject(caseDir);
  const projectHash = migrationProjectHash(pkg);
  const contractPath = path.join(pkg.caseDir, MIGRATION_COMPLETION_CONTRACT_FILE);
  const findings: string[] = [];
  const evidenceFiles: string[] = [];
  let contract: MigrationCompletionContract | undefined;
  if (!await pathExists(contractPath)) {
    findings.push("MG-COMPLETION-CONTRACT-MISSING");
  } else {
    evidenceFiles.push(contractPath);
    contract = await readJsonFile<MigrationCompletionContract>(contractPath);
    findings.push(...validateMigrationCompletionContract(contract, pkg.profile.projectId));
  }
  const resolvedEvidencePath = evidencePath
    ? path.resolve(evidencePath)
    : path.join(pkg.caseDir, "completion-evidence.json");
  let bundle: MigrationCompletionEvidenceBundle | undefined;
  if (!await pathExists(resolvedEvidencePath)) {
    findings.push("MG-COMPLETION-EVIDENCE-MISSING");
  } else {
    evidenceFiles.push(resolvedEvidencePath);
    bundle = await readJsonFile<MigrationCompletionEvidenceBundle>(resolvedEvidencePath);
    if (bundle.schemaVersion !== 1) findings.push("MG-COMPLETION-EVIDENCE-VERSION-UNSUPPORTED");
    if (bundle.projectId !== pkg.profile.projectId) findings.push("MG-COMPLETION-EVIDENCE-PROJECT-MISMATCH");
    if (bundle.projectHash !== projectHash) findings.push("MG-COMPLETION-EVIDENCE-PROJECT-HASH-STALE");
    if (!validTimestamp(bundle.generatedAt)) findings.push("MG-COMPLETION-EVIDENCE-GENERATED-AT-INVALID");
  }
  const passedControls = new Set<string>();
  const artifactPaths = new Set<string>();
  const artifactOwners = new Map<string, string>();
  if (contract && bundle) {
    for (const item of contract.controls) {
      const current = bundle.controls?.[item.id];
      if (!current) {
        findings.push(`MG-COMPLETION-CONTROL-EVIDENCE-MISSING:${item.id}`);
        continue;
      }
      const controlFindings = await validateControlEvidence(
        pkg,
        item,
        current,
        now,
        artifactPaths,
        artifactOwners
      );
      findings.push(...controlFindings);
      if (current.status === "passed" && controlFindings.length === 0) passedControls.add(item.id);
    }
    for (const id of Object.keys(bundle.controls ?? {})) {
      if (!contract.controls.some((item) => item.id === id)) {
        findings.push(`MG-COMPLETION-CONTROL-EVIDENCE-UNKNOWN:${id}`);
      }
    }
  }
  const securityScanPaths = [...new Set([...evidenceFiles, ...artifactPaths])];
  const securityFindings = securityScanPaths.length > 0
    ? await scanArtifactFiles(securityScanPaths)
    : [];
  findings.push(...securityFindings.map((item) =>
    `MG-COMPLETION-ARTIFACT-SECRET:${path.basename(item.file)}:${item.rule}:${item.location}`
  ));
  evidenceFiles.push(...artifactPaths);
  const signals = completionSignals(contract?.controls ?? [], passedControls);
  const capability = assessMigrationCapability(signals);
  const uniqueFindings = [...new Set(findings)].sort();
  const report = finalizeGateIntegrity({
    schemaVersion: 1 as const,
    gate: "completion" as const,
    projectId: pkg.profile.projectId,
    projectHash,
    status: capability.achieved === "L4" && uniqueFindings.length === 0
      ? "passed" as const
      : "blocked" as const,
    capability,
    controlSummary: {
      total: contract?.controls.length ?? 0,
      passed: passedControls.size,
      blocked: Math.max(0, (contract?.controls.length ?? 0) - passedControls.size)
    },
    findings: uniqueFindings,
    securityFindings,
    evidence: [...new Set(evidenceFiles)].sort()
  });
  await writeJsonFile(path.join(pkg.evidenceDir, "gates", "completion-gate.json"), report);
  return report;
}

function control(
  id: string,
  signal: keyof MigrationCapabilitySignals,
  category: string,
  description: string,
  evidenceKind: MigrationCompletionEvidenceKind,
  maxAgeHours: number
): MigrationCompletionControl {
  return {
    id,
    level: SIGNAL_LEVEL[signal],
    signal,
    category,
    description,
    evidenceKind,
    maxAgeHours
  };
}

function hasBatchRuntimeGate(pkg: MigrationProjectPackage): boolean {
  return (pkg.semanticRules.runtimeGates ?? []).some((item) => item.gates.batch);
}

function safeControlSegment(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function countByLevel(controls: MigrationCompletionControl[]): Record<string, number> {
  return controls.reduce<Record<string, number>>((counts, item) => {
    counts[item.level] = (counts[item.level] ?? 0) + 1;
    return counts;
  }, {});
}

async function validateControlEvidence(
  pkg: MigrationProjectPackage,
  control: MigrationCompletionControl,
  current: MigrationCompletionControlEvidence,
  now: number,
  artifactPaths: Set<string>,
  artifactOwners: Map<string, string>
): Promise<string[]> {
  const findings: string[] = [];
  if (current.status !== "passed") findings.push(`MG-COMPLETION-CONTROL-BLOCKED:${control.id}`);
  const observedAt = Date.parse(current.observedAt);
  if (!Number.isFinite(observedAt)) {
    findings.push(`MG-COMPLETION-CONTROL-OBSERVED-AT-INVALID:${control.id}`);
  } else if (observedAt > now + 300_000 || now - observedAt > control.maxAgeHours * 3_600_000) {
    findings.push(`MG-COMPLETION-CONTROL-STALE:${control.id}`);
  }
  if (!Array.isArray(current.artifacts) || current.artifacts.length === 0) {
    findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-MISSING:${control.id}`);
    return findings;
  }
  for (const artifact of current.artifacts) {
    const resolved = path.resolve(pkg.caseDir, artifact.path);
    const priorOwner = artifactOwners.get(resolved);
    if (priorOwner && priorOwner !== control.id) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-REUSED:${control.id}:${priorOwner}`);
      continue;
    }
    artifactOwners.set(resolved, control.id);
    if (artifact.controlId !== control.id) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-CONTROL-MISMATCH:${control.id}`);
    }
    if (artifact.evidenceKind !== control.evidenceKind) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-KIND-MISMATCH:${control.id}`);
    }
    if (!allowedEvidencePath(pkg, resolved)) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-PATH-UNSAFE:${control.id}`);
      continue;
    }
    if (!await pathExists(resolved)) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-NOT-FOUND:${control.id}`);
      continue;
    }
    artifactPaths.add(resolved);
    const content = await fs.readFile(resolved);
    const actualHash = sha256(content.toString("base64"));
    if (!artifact.sha256 || artifact.sha256 !== actualHash) {
      findings.push(`MG-COMPLETION-CONTROL-ARTIFACT-HASH-MISMATCH:${control.id}`);
      continue;
    }
    findings.push(...validateCompletionControlArtifact(
      pkg,
      control,
      await parseCompletionControlArtifact(content),
      now
    ));
  }
  return findings;
}

async function parseCompletionControlArtifact(
  content: Buffer
): Promise<MigrationCompletionControlArtifact | undefined> {
  try {
    return JSON.parse(content.toString("utf8")) as MigrationCompletionControlArtifact;
  } catch {
    return undefined;
  }
}

function validateCompletionControlArtifact(
  pkg: MigrationProjectPackage,
  control: MigrationCompletionControl,
  document: MigrationCompletionControlArtifact | undefined,
  now: number
): string[] {
  const prefix = `MG-COMPLETION-CONTROL-ARTIFACT`;
  if (!document || document.protocol !== "migration-guard.completion-control-evidence/v1") {
    return [`${prefix}-PROTOCOL-INVALID:${control.id}`];
  }
  const findings: string[] = [];
  if (document.schemaVersion !== 1) findings.push(`${prefix}-VERSION-UNSUPPORTED:${control.id}`);
  if (document.projectId !== pkg.profile.projectId
    || document.projectHash !== migrationProjectHash(pkg)) {
    findings.push(`${prefix}-PROJECT-MISMATCH:${control.id}`);
  }
  if (document.controlId !== control.id) findings.push(`${prefix}-CONTROL-MISMATCH:${control.id}`);
  if (document.evidenceKind !== control.evidenceKind) findings.push(`${prefix}-KIND-MISMATCH:${control.id}`);
  if (document.status !== "passed") findings.push(`${prefix}-STATUS-BLOCKED:${control.id}`);
  if (document.synthetic !== false || document.realEligible === false) {
    findings.push(`${prefix}-NOT-REAL:${control.id}`);
  }
  const observedAt = Date.parse(document.observedAt);
  if (!Number.isFinite(observedAt)
    || observedAt > now + 300_000
    || now - observedAt > control.maxAgeHours * 3_600_000) {
    findings.push(`${prefix}-STALE:${control.id}`);
  }
  if (!document.producer?.tool
    || !document.producer.version
    || !document.producer.command
    || !document.producer.identity) {
    findings.push(`${prefix}-PRODUCER-MISSING:${control.id}`);
  }
  const requiredClaim = completionControlClaim(control);
  if (document.claims?.[requiredClaim] !== true) {
    findings.push(`${prefix}-CLAIM-MISSING:${control.id}:${requiredClaim}`);
  }
  if (control.level === "L4-C" || control.level === "L4") {
    const reviewedAt = Date.parse(document.review?.reviewedAt ?? "");
    if (document.review?.decision !== "approved"
      || !document.review.identity
      || document.review.identity === document.producer?.identity
      || !Number.isFinite(reviewedAt)
      || reviewedAt > now + 300_000
      || reviewedAt < observedAt) {
      findings.push(`${prefix}-INDEPENDENT-REVIEW-MISSING:${control.id}`);
    }
  }
  return findings;
}

function completionControlClaim(control: MigrationCompletionControl): string {
  const claims: Record<string, string> = {
    "source.read-only-snapshot": "sourceSnapshotUnchanged",
    "analysis.complete": "analysisComplete",
    "offline.contract": "offlineContractPassed",
    "implementation.checks": "implementationChecksPassed",
    "scenario.contract": "scenarioContractPassed",
    "dependency.protocol": "integrationPassed",
    "production.concrete-adapters": "productionEligible",
    "production.http-service": "productionEligible",
    "production.configuration": "integrationPassed",
    "production.health-readiness": "integrationPassed",
    "schema-transition.client-boundary": "integrationPassed",
    "schema-transition.lease": "integrationPassed",
    "schema-transition.idempotency": "integrationPassed",
    "schema-transition.resume": "integrationPassed",
    "schema-transition.ddl-fault": "integrationPassed",
    "real.runtime-evidence": "realEvidencePassed",
    "real.dual-replay": "dualReplayPassed",
    "real.disposable-write-scope": "disposableWriteScopePassed",
    "real.cleanup-verification": "cleanupVerified",
    "release.unified-real-gate": "unifiedRealGatePassed",
    "release.observability": "observabilityVerified",
    "release.canary": "canaryRehearsed",
    "release.rollback-rehearsal": "rollbackRehearsed",
    "release.source-off": "sourceOffVerified"
  };
  if (control.id.startsWith("production.adapter.")) return "productionEligible";
  return claims[control.id] ?? `${control.signal}Passed`;
}

function allowedEvidencePath(pkg: MigrationProjectPackage, candidate: string): boolean {
  const sourceRoot = resolveMigrationProjectPath(pkg, pkg.profile.source.root);
  if (nestedPath(sourceRoot, candidate)) return false;
  const targetRoot = resolveMigrationProjectPath(pkg, pkg.profile.target.root);
  return nestedPath(pkg.caseDir, candidate) || nestedPath(targetRoot, candidate);
}

function nestedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function completionSignals(
  controls: MigrationCompletionControl[],
  passedControls: Set<string>
): MigrationCapabilitySignals {
  return Object.fromEntries(
    (Object.keys(SIGNAL_LEVEL) as Array<keyof MigrationCapabilitySignals>).map((signal) => {
      const required = controls.filter((item) => item.signal === signal);
      return [signal, required.length > 0 && required.every((item) => passedControls.has(item.id))];
    })
  ) as unknown as MigrationCapabilitySignals;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
