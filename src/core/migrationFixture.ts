import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists, readJsonFile } from "./files.js";
import type { BatchGateRequirements } from "./vmpBatch.js";
import type { PageGateRequirements } from "./pageRuntimeEvidence.js";
import type { QueryGateRequirements } from "./queryRuntimeEvidence.js";
import { scanArtifactText } from "./artifactSecurity.js";

export type MigrationFixtureKind = "template" | "specification" | "synthetic" | "draft-runtime" | "real-runtime" | "unclassified";
export type MigrationCollectorKind =
  | "mysql"
  | "redis"
  | "events"
  | "sql-trace"
  | "ai-trace"
  | "stream-trace"
  | "tool-trace";

export interface MigrationFixtureMetadata {
  schemaVersion: 1;
  fixtureKind: Exclude<MigrationFixtureKind, "unclassified">;
  status?: "template" | "draft" | "ready";
  realEvidenceEligible?: boolean;
  projectId?: string;
  projectHash?: string;
  entrypointId?: string;
  scenarioId?: string;
  request?: unknown;
  collectorSpecs?: Partial<Record<MigrationCollectorKind, { path: string; hash: string }>>;
  writeSafety?: MigrationFixtureWriteSafety;
  expectations?: {
    batch?: BatchGateRequirements;
    page?: PageGateRequirements;
    query?: QueryGateRequirements;
  };
}

export interface MigrationFixtureWriteSafety {
  mode: "read-only" | "disposable";
  disposable: boolean;
  writeApproved: boolean;
  allowedTenantIds: string[];
  allowedPanelIds: string[];
  allowedTables: string[];
  maxAffectedRows: number;
  markerKey: string;
  cleanupPredicate: string;
  cleanupVerificationRequired: boolean;
  expiresAt: string;
}

export interface MigrationFixtureInspection {
  path: string;
  kind: MigrationFixtureKind;
  valid: boolean;
  findings: string[];
}

export function classifyMigrationFixture(value: unknown): MigrationFixtureKind {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unclassified";
  const kind = (value as Record<string, unknown>).fixtureKind;
  return kind === "template" || kind === "specification" || kind === "synthetic"
    || kind === "draft-runtime" || kind === "real-runtime"
    ? kind
    : "unclassified";
}

export function validateMigrationFixture(
  value: unknown,
  expected: {
    kind?: Exclude<MigrationFixtureKind, "unclassified">;
    projectId?: string;
    projectHash?: string;
    entrypointId?: string;
    scenarioId?: string;
    batch?: boolean;
    page?: boolean;
    query?: boolean;
    writeSafety?: boolean;
    collectors?: MigrationCollectorKind[];
  } = {}
): string[] {
  const findings: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["MG-FIXTURE-OBJECT-REQUIRED"];
  const fixture = value as Partial<MigrationFixtureMetadata>;
  const kind = classifyMigrationFixture(value);
  if (fixture.schemaVersion !== 1) findings.push("MG-FIXTURE-VERSION-UNSUPPORTED");
  if (kind === "unclassified") findings.push("MG-FIXTURE-KIND-UNCLASSIFIED");
  if (expected.kind && kind !== expected.kind) findings.push(`MG-FIXTURE-KIND-MISMATCH:${expected.kind}`);
  if (expected.projectId && fixture.projectId !== expected.projectId) findings.push("MG-FIXTURE-PROJECT-ID-MISMATCH");
  if (expected.projectHash && fixture.projectHash !== expected.projectHash) findings.push("MG-FIXTURE-PROJECT-HASH-MISMATCH");
  if (expected.entrypointId && fixture.entrypointId !== expected.entrypointId) findings.push("MG-FIXTURE-ENTRYPOINT-MISMATCH");
  if (expected.scenarioId && fixture.scenarioId !== expected.scenarioId) findings.push("MG-FIXTURE-SCENARIO-MISMATCH");
  if (kind === "draft-runtime") {
    if (fixture.status !== "draft") findings.push("MG-FIXTURE-DRAFT-STATUS-INVALID");
    if (fixture.realEvidenceEligible === true) findings.push("MG-FIXTURE-NONREAL-CLAIMS-ELIGIBILITY");
    if (fixture.request === undefined) findings.push("MG-FIXTURE-REQUEST-MISSING");
    if (containsSensitiveKey(value)) findings.push("MG-FIXTURE-SENSITIVE-CONTENT");
  } else if (kind === "real-runtime") {
    if (fixture.status !== "ready") findings.push("MG-FIXTURE-REAL-NOT-READY");
    if (fixture.realEvidenceEligible !== true) findings.push("MG-FIXTURE-REAL-ELIGIBILITY-MISSING");
    if (fixture.request === undefined) findings.push("MG-FIXTURE-REQUEST-MISSING");
    if (containsSensitiveKey(value)) findings.push("MG-FIXTURE-SENSITIVE-CONTENT");
    if (expected.batch && !fixture.expectations?.batch) findings.push("MG-FIXTURE-BATCH-EXPECTATION-MISSING");
    if (expected.page && !fixture.expectations?.page) findings.push("MG-FIXTURE-PAGE-EXPECTATION-MISSING");
    if (expected.query && !fixture.expectations?.query) findings.push("MG-FIXTURE-QUERY-EXPECTATION-MISSING");
    for (const collector of expected.collectors ?? []) {
      const reference = fixture.collectorSpecs?.[collector];
      if (!reference) {
        findings.push(`MG-FIXTURE-COLLECTOR-SPEC-MISSING:${collector}`);
        continue;
      }
      if (!reference.path || path.isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes("..")) {
        findings.push(`MG-FIXTURE-COLLECTOR-SPEC-PATH-UNSAFE:${collector}`);
      }
      if (!/^[a-f0-9]{64}$/.test(reference.hash)) findings.push(`MG-FIXTURE-COLLECTOR-SPEC-HASH-INVALID:${collector}`);
    }
  } else if (fixture.realEvidenceEligible === true) {
    findings.push("MG-FIXTURE-NONREAL-CLAIMS-ELIGIBILITY");
  }
  if (expected.writeSafety) findings.push(...validateFixtureWriteSafety(fixture.writeSafety));
  return [...new Set(findings)].sort();
}

export async function inspectMigrationFixtures(dir: string): Promise<MigrationFixtureInspection[]> {
  const files = await listJsonFiles(dir);
  return Promise.all(files.map(async (file) => {
    try {
      const value = await readJsonFile<unknown>(file);
      const kind = classifyMigrationFixture(value);
      const findings = validateMigrationFixture(value);
      return { path: file, kind, valid: findings.length === 0, findings };
    } catch {
      return { path: file, kind: "unclassified" as const, valid: false, findings: ["MG-FIXTURE-JSON-MALFORMED"] };
    }
  }));
}

export function containsSensitiveKey(value: unknown): boolean {
  return scanArtifactText(JSON.stringify(value), "fixture.json").length > 0;
}

export function validateFixtureWriteSafety(
  safety: MigrationFixtureWriteSafety | undefined,
  now = Date.now()
): string[] {
  if (!safety) return ["MG-FIXTURE-WRITE-SAFETY-MISSING"];
  const findings: string[] = [];
  if (safety.mode !== "disposable" || safety.disposable !== true) {
    findings.push("MG-FIXTURE-WRITE-SCOPE-NOT-DISPOSABLE");
  }
  if (safety.writeApproved !== true) findings.push("MG-FIXTURE-WRITE-APPROVAL-MISSING");
  if (!nonEmptyStrings(safety.allowedTenantIds)) findings.push("MG-FIXTURE-WRITE-TENANTS-MISSING");
  if (!nonEmptyStrings(safety.allowedPanelIds)) findings.push("MG-FIXTURE-WRITE-PANELS-MISSING");
  if (!nonEmptyStrings(safety.allowedTables)) findings.push("MG-FIXTURE-WRITE-TABLES-MISSING");
  if (!Number.isInteger(safety.maxAffectedRows)
    || safety.maxAffectedRows <= 0
    || safety.maxAffectedRows > 10_000) {
    findings.push("MG-FIXTURE-WRITE-ROW-LIMIT-INVALID");
  }
  if (!safety.markerKey?.trim()) findings.push("MG-FIXTURE-WRITE-MARKER-MISSING");
  if (!safety.cleanupPredicate?.trim()
    || (safety.markerKey?.trim() && !safety.cleanupPredicate.includes(safety.markerKey.trim()))) {
    findings.push("MG-FIXTURE-WRITE-CLEANUP-PREDICATE-INVALID");
  }
  if (safety.cleanupVerificationRequired !== true) {
    findings.push("MG-FIXTURE-WRITE-CLEANUP-VERIFICATION-MISSING");
  }
  const expiresAt = Date.parse(safety.expiresAt);
  if (!Number.isFinite(expiresAt)) findings.push("MG-FIXTURE-WRITE-EXPIRY-INVALID");
  else if (expiresAt <= now) findings.push("MG-FIXTURE-WRITE-SCOPE-EXPIRED");
  return [...new Set(findings)].sort();
}

async function listJsonFiles(dir: string): Promise<string[]> {
  if (!await pathExists(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()
      && !isCollectorSpecDirectory(entry.name)
      && !isCandidateBundleDirectory(entry.name)) {
      files.push(...await listJsonFiles(child));
    }
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(child);
  }
  return files.sort();
}

function isCollectorSpecDirectory(name: string): boolean {
  return name === "collectors" || name.endsWith(".collectors");
}

function isCandidateBundleDirectory(name: string): boolean {
  return name === "real-candidates"
    || name === "real-readonly"
    || name === "real-runtime-candidates";
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}
