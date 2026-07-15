import path from "node:path";
import { sha256 } from "./hash.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { stableStringify } from "./normalize.js";
import type { CompareReport, Snapshot } from "../types.js";
import type { UiJob } from "./uiJobTypes.js";

export type CoreArtifactKind = "snapshot" | "compare" | "ui-job";

export interface ArtifactV2Envelope<T = unknown, M = unknown> {
  artifactSchemaVersion: 2;
  kind: CoreArtifactKind;
  migratedAt: string;
  sourceVersion: number;
  payloadHash: string;
  metadata: M;
  payload: T;
}

export interface SnapshotArtifactMetadata {
  snapshotId: string;
  snapshotKind: Snapshot["kind"];
  normalization: Array<{ name: string; applied: string[] }>;
  healthFingerprints: Array<{ name: string; status: string; fingerprint: string }>;
  packages: Array<{ name: string; path: string; sourceFiles: number; testFiles: number }>;
}

export interface CompareArtifactMetadata {
  baselineId: string;
  currentId: string;
  baselineSnapshotHash?: string;
  currentSnapshotHash?: string;
  healthSummary?: CompareReport["checkHealth"];
  healthDebt?: {
    ledgerPath: string;
    newCount: number;
    acceptedCount: number;
    expiredCount: number;
    recoveredCount: number;
    strictPassed: boolean;
  };
  policyDecision: "passed" | "failed";
}

export interface UiJobArtifactMetadata {
  action: UiJob["action"];
  status: UiJob["status"];
  ownerPid?: number;
  retryOf?: string;
  attempt: number;
  heartbeatAt?: string;
  leaseDurationMs?: number;
  artifactPaths: string[];
}

export function createCoreArtifactV2<T, M>(
  kind: CoreArtifactKind,
  payload: T,
  metadata: M,
  now = new Date().toISOString()
): ArtifactV2Envelope<T, M> {
  const sourceVersion = Number((payload as { version?: unknown })?.version ?? 1);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 1) {
    throw new Error(`Unsupported source artifact version: ${String(sourceVersion)}`);
  }
  return {
    artifactSchemaVersion: 2,
    kind,
    migratedAt: now,
    sourceVersion,
    payloadHash: sha256(stableStringify(payload)),
    metadata,
    payload
  };
}

export function migrateCoreArtifactToV2(
  kind: CoreArtifactKind,
  value: unknown,
  now = new Date().toISOString()
): ArtifactV2Envelope {
  if (isArtifactV2Envelope(value)) {
    validateArtifactV2(value, kind);
    return value.metadata === undefined ? { ...value, metadata: coreArtifactMetadata(kind, value.payload) } : value;
  }
  return createCoreArtifactV2(kind, value, coreArtifactMetadata(kind, value), now);
}

export function decodeCoreArtifact<T>(kind: CoreArtifactKind, value: unknown): T {
  if (isArtifactV2Envelope(value)) {
    validateArtifactV2(value, kind);
    return value.payload as T;
  }
  const sourceVersion = Number((value as { version?: unknown })?.version ?? 1);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 1) {
    throw new Error(`Unsupported source artifact version: ${String(sourceVersion)}`);
  }
  return value as T;
}

export async function readCoreArtifactFile<T>(filePath: string, kind: CoreArtifactKind): Promise<T> {
  return decodeCoreArtifact<T>(kind, await readJsonFile<unknown>(filePath));
}

export async function writeCoreArtifactFile<T, M>(
  filePath: string,
  kind: CoreArtifactKind,
  payload: T,
  metadata: M
): Promise<void> {
  await writeJsonFile(filePath, createCoreArtifactV2(kind, payload, metadata));
}

export async function writeSnapshotArtifactFile(filePath: string, snapshot: Snapshot): Promise<void> {
  await writeCoreArtifactFile(filePath, "snapshot", snapshot, snapshotArtifactMetadata(snapshot));
}

export async function readCompareArtifactFile(filePath: string): Promise<CompareReport> {
  return readCoreArtifactFile<CompareReport>(filePath, "compare");
}

export async function writeCompareArtifactFile(
  filePath: string,
  report: CompareReport,
  baseline?: Snapshot,
  current?: Snapshot,
  healthDebt?: CompareArtifactMetadata["healthDebt"]
): Promise<void> {
  await writeCoreArtifactFile(filePath, "compare", report, compareArtifactMetadata(report, baseline, current, healthDebt));
}

export function validateArtifactV2(value: ArtifactV2Envelope, expectedKind?: CoreArtifactKind): void {
  if (value.artifactSchemaVersion !== 2) throw new Error(`Unsupported core artifact schema version: ${String(value.artifactSchemaVersion)}`);
  if (!(["snapshot", "compare", "ui-job"] as const).includes(value.kind)) throw new Error(`Unsupported core artifact kind: ${String(value.kind)}`);
  if (expectedKind && value.kind !== expectedKind) throw new Error(`Core artifact kind mismatch: expected ${expectedKind}, received ${value.kind}`);
  if (!Number.isInteger(value.sourceVersion) || value.sourceVersion < 1 || value.sourceVersion > 1) throw new Error(`Unsupported source artifact version: ${String(value.sourceVersion)}`);
  if (value.metadata !== undefined && (typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata))) throw new Error("Core artifact v2 metadata must be an object");
  if (value.payloadHash !== sha256(stableStringify(value.payload))) throw new Error("Core artifact v2 payload hash mismatch");
}

export function snapshotArtifactMetadata(snapshot: Snapshot): SnapshotArtifactMetadata {
  const checks = snapshot.checks ?? [];
  return {
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    normalization: checks.map((check) => ({ name: check.name, applied: check.normalizationApplied ?? [] })),
    healthFingerprints: checks.map((check) => ({
      name: check.name,
      status: check.status,
      fingerprint: sha256(stableStringify({
        name: check.name,
        status: check.status,
        exitCode: check.exitCode,
        stdout: check.normalizedStdoutHash ?? check.stdoutHash,
        stderr: check.normalizedStderrHash ?? check.stderrHash
      }))
    })),
    packages: (snapshot.scan?.packages ?? []).map((pkg) => ({
      name: pkg.name,
      path: pkg.path,
      sourceFiles: pkg.sourceFiles,
      testFiles: pkg.testFiles
    }))
  };
}

export function compareArtifactMetadata(
  report: CompareReport,
  baseline?: Snapshot,
  current?: Snapshot,
  healthDebt?: CompareArtifactMetadata["healthDebt"]
): CompareArtifactMetadata {
  return {
    baselineId: report.baselineId,
    currentId: report.currentId,
    baselineSnapshotHash: baseline ? sha256(stableStringify(baseline)) : undefined,
    currentSnapshotHash: current ? sha256(stableStringify(current)) : undefined,
    healthSummary: report.checkHealth,
    healthDebt: healthDebt ? { ...healthDebt, ledgerPath: toPortablePath(healthDebt.ledgerPath) } : undefined,
    policyDecision: report.passed ? "passed" : "failed"
  };
}

export function uiJobArtifactMetadata(
  job: UiJob,
  claim?: { ownerPid?: number; heartbeatAt?: string; leaseDurationMs?: number }
): UiJobArtifactMetadata {
  return {
    action: job.action,
    status: job.status,
    ownerPid: claim?.ownerPid ?? job.ownerPid,
    retryOf: job.retryOf,
    attempt: job.attempt ?? Math.max(1, (job.events ?? []).filter((event) => event.type === "started" || event.type === "recovered").length),
    heartbeatAt: claim?.heartbeatAt ?? job.heartbeatAt,
    leaseDurationMs: claim?.leaseDurationMs ?? job.leaseDurationMs,
    artifactPaths: [...(job.artifactPaths ?? [])]
  };
}

function isArtifactV2Envelope(value: unknown): value is ArtifactV2Envelope {
  return Boolean(value && typeof value === "object" && (value as { artifactSchemaVersion?: unknown }).artifactSchemaVersion === 2);
}

function coreArtifactMetadata(kind: CoreArtifactKind, payload: unknown): SnapshotArtifactMetadata | CompareArtifactMetadata | UiJobArtifactMetadata | Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  if (kind === "snapshot") return snapshotArtifactMetadata(payload as Snapshot);
  if (kind === "compare") return compareArtifactMetadata(payload as CompareReport);
  return uiJobArtifactMetadata(payload as UiJob);
}

function toPortablePath(value: string): string {
  return path.normalize(value).replace(/\\/g, "/");
}
