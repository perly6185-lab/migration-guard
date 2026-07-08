import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, toPosixPath, writeJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import type { LoadedConfig } from "../types.js";

export const CURRENT_ARTIFACT_SCHEMA_VERSION = 1;

export type ArtifactMigrationKind =
  | "proposal"
  | "proposal-verification-report"
  | "proposal-batch-plan"
  | "proposal-batch-report"
  | "proposal-replan-context"
  | "proposal-repair-acceptance";
export type ArtifactMigrationStatus = "up-to-date" | "would-migrate" | "migrated" | "unsupported" | "invalid-json";

export interface ArtifactMigrationOptions {
  apply?: boolean;
  applyConfirm?: string;
}

export interface ArtifactMigrationEntry {
  path: string;
  kind: ArtifactMigrationKind;
  status: ArtifactMigrationStatus;
  changes: string[];
  message?: string;
}

export interface ArtifactMigrationReport {
  version: 1;
  artifactSchemaVersion: 1;
  artifactsDir: string;
  migrationRunsDir: string;
  applied: boolean;
  planHash: string;
  scannedCount: number;
  migratedCount: number;
  unchangedCount: number;
  unsupportedCount: number;
  invalidCount: number;
  entries: ArtifactMigrationEntry[];
}

type JsonObject = Record<string, unknown>;

interface ArtifactFileCandidate {
  path: string;
  kind: ArtifactMigrationKind;
}

interface MigrationResult {
  value: JsonObject;
  changes: string[];
}

interface PlannedArtifactMigrationEntry {
  candidate: ArtifactFileCandidate;
  status: ArtifactMigrationStatus;
  changes: string[];
  migratedValue?: JsonObject;
  message?: string;
}

export async function collectArtifactMigrationReport(
  loaded: LoadedConfig,
  options: ArtifactMigrationOptions = {}
): Promise<ArtifactMigrationReport> {
  const artifactsDir = path.resolve(loaded.artifactsDir);
  const migrationRunsDir = path.join(artifactsDir, "migration-runs");
  const candidates = await listMigrationArtifactFiles(migrationRunsDir);
  const plannedEntries: PlannedArtifactMigrationEntry[] = [];

  for (const candidate of candidates) {
    let value: JsonObject;
    try {
      value = await readJsonFile<JsonObject>(candidate.path);
    } catch (error) {
      plannedEntries.push({
        candidate,
        status: "invalid-json",
        changes: [],
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const migration = migrateArtifactValue(candidate.kind, value);
    if (migration.changes.length === 0) {
      plannedEntries.push({
        candidate,
        status: "up-to-date",
        changes: []
      });
      continue;
    }

    plannedEntries.push({
      candidate,
      status: "would-migrate",
      changes: migration.changes,
      migratedValue: migration.value
    });
  }

  const planHash = createArtifactMigrationPlanHash(plannedEntries);
  const changedEntries = plannedEntries.filter((entry) => entry.status === "would-migrate");
  const invalidEntries = plannedEntries.filter((entry) => entry.status === "invalid-json");
  if (options.apply && invalidEntries.length > 0) {
    throw new Error(`Refusing to apply artifact migration with ${invalidEntries.length} invalid JSON artifact(s).`);
  }
  if (options.apply && changedEntries.length > 0 && options.applyConfirm !== planHash) {
    throw new Error(`Artifact migration apply requires --apply-confirm ${planHash}. Re-run dry-run, review the plan, then apply with that hash.`);
  }
  if (options.apply) {
    for (const entry of changedEntries) {
      if (entry.migratedValue) {
        await writeJsonFile(entry.candidate.path, entry.migratedValue);
      }
    }
  }

  const entries = plannedEntries.map((entry): ArtifactMigrationEntry => ({
    path: entry.candidate.path,
    kind: entry.candidate.kind,
    status: options.apply && entry.status === "would-migrate" ? "migrated" : entry.status,
    changes: entry.changes,
    message: entry.message
  }));

  return {
    version: 1,
    artifactSchemaVersion: CURRENT_ARTIFACT_SCHEMA_VERSION,
    artifactsDir,
    migrationRunsDir,
    applied: Boolean(options.apply),
    planHash,
    scannedCount: entries.length,
    migratedCount: entries.filter((entry) => entry.status === "migrated" || entry.status === "would-migrate").length,
    unchangedCount: entries.filter((entry) => entry.status === "up-to-date").length,
    unsupportedCount: entries.filter((entry) => entry.status === "unsupported").length,
    invalidCount: entries.filter((entry) => entry.status === "invalid-json").length,
    entries
  };
}

export function renderArtifactMigrationReport(report: ArtifactMigrationReport): string {
  const lines = [
    "Artifact Migration",
    `Artifacts: ${report.artifactsDir}`,
    `Migration runs: ${report.migrationRunsDir}`,
    `Mode: ${report.applied ? "apply" : "dry-run"}`,
    `Schema version: ${report.artifactSchemaVersion}`,
    `Plan hash: ${report.planHash}`,
    `Scanned: ${report.scannedCount}`,
    `Would migrate / migrated: ${report.migratedCount}`,
    `Unchanged: ${report.unchangedCount}`,
    `Invalid: ${report.invalidCount}`,
    ""
  ];
  const changed = report.entries.filter((entry) => entry.status === "would-migrate" || entry.status === "migrated");
  if (changed.length === 0) {
    lines.push("Changes: none");
    return lines.join("\n");
  }
  lines.push("Changes:");
  for (const entry of changed) {
    lines.push(`- ${entry.status} ${entry.kind}: ${entry.path}`);
    for (const change of entry.changes) {
      lines.push(`  - ${change}`);
    }
  }
  return lines.join("\n");
}

function createArtifactMigrationPlanHash(entries: PlannedArtifactMigrationEntry[]): string {
  const plan = {
    artifactSchemaVersion: CURRENT_ARTIFACT_SCHEMA_VERSION,
    entries: entries
      .filter((entry) => entry.status === "would-migrate")
      .map((entry) => ({
        path: path.resolve(entry.candidate.path),
        kind: entry.candidate.kind,
        changes: entry.changes
      }))
  };
  return sha256(JSON.stringify(plan));
}

function migrateArtifactValue(kind: ArtifactMigrationKind, value: JsonObject): MigrationResult {
  switch (kind) {
    case "proposal":
      return migrateProposal(value);
    case "proposal-verification-report":
      return migrateProposalVerificationReport(value);
    case "proposal-batch-plan":
      return migrateProposalBatchPlan(value);
    case "proposal-batch-report":
      return migrateProposalBatchReport(value);
    case "proposal-replan-context":
      return migrateProposalReplanContext(value);
    case "proposal-repair-acceptance":
      return migrateProposalRepairAcceptance(value);
  }
}

function migrateProposal(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  const applyState = stringValue(migrated.applyState);
  if ((applyState === "rejected" || applyState === "ignored") && !isRecord(migrated.exclusion)) {
    migrated.exclusion = {
      state: applyState,
      createdAt: stringValue(migrated.createdAt) ?? new Date(0).toISOString()
    };
    changes.push("backfilled exclusion metadata for rejected/ignored proposal");
  }
  if (migrated.generatedFiles === undefined) {
    migrated.generatedFiles = [];
    changes.push("backfilled generatedFiles as []");
  }
  return { value: migrated, changes };
}

function migrateProposalBatchPlan(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  if (!Array.isArray(migrated.excluded)) {
    migrated.excluded = [];
    changes.push("backfilled excluded as []");
  }
  if (migrated.excludedCount === undefined) {
    migrated.excludedCount = Array.isArray(migrated.excluded) ? migrated.excluded.length : 0;
    changes.push("backfilled excludedCount");
  }
  return { value: migrated, changes };
}

function migrateProposalVerificationReport(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  if (!Array.isArray(migrated.timeline)) {
    migrated.timeline = [];
    changes.push("backfilled timeline as []");
  }
  return { value: migrated, changes };
}

function migrateProposalBatchReport(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  if (!Array.isArray(migrated.skipped)) {
    migrated.skipped = [];
    changes.push("backfilled skipped as []");
  }
  if (!Array.isArray(migrated.excluded)) {
    migrated.excluded = [];
    changes.push("backfilled excluded as []");
  }
  if (migrated.excludedCount === undefined) {
    migrated.excludedCount = Array.isArray(migrated.excluded) ? migrated.excluded.length : 0;
    changes.push("backfilled excludedCount");
  }
  return { value: migrated, changes };
}

function migrateProposalReplanContext(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  const proposal = isRecord(migrated.proposal) ? migrated.proposal : undefined;
  if (proposal && !Array.isArray(proposal.sourceSnippets)) {
    proposal.sourceSnippets = [];
    changes.push("backfilled proposal.sourceSnippets as []");
  }
  const failure = isRecord(migrated.failure) ? migrated.failure : undefined;
  const firstFailedCheck = failure && isRecord(failure.firstFailedCheck) ? failure.firstFailedCheck : undefined;
  if (failure && !isRecord(failure.latestFailedOutput) && firstFailedCheck) {
    failure.latestFailedOutput = {
      stdout: stringValue(firstFailedCheck.stdout) ?? "",
      stderr: stringValue(firstFailedCheck.stderr) ?? ""
    };
    changes.push("backfilled failure.latestFailedOutput from firstFailedCheck");
  }
  if (!Array.isArray(migrated.acceptanceChecklist)) {
    migrated.acceptanceChecklist = [
      "Confirm the repaired proposal addresses the recorded failure evidence.",
      "Re-run the proposal checks before applying.",
      "Keep the retry proposal linked to the source proposal."
    ];
    changes.push("backfilled acceptanceChecklist");
  }
  return { value: migrated, changes };
}

function migrateProposalRepairAcceptance(value: JsonObject): MigrationResult {
  const migrated = clone(value);
  const changes = ensureArtifactSchemaVersion(migrated);
  if (!Array.isArray(migrated.checklist)) {
    migrated.checklist = [];
    changes.push("backfilled checklist as []");
  }
  if (migrated.accepted === undefined) {
    migrated.accepted = Array.isArray(migrated.checklist)
      ? migrated.checklist.every((item) => isRecord(item) && item.status === "accepted")
      : false;
    changes.push("backfilled accepted");
  }
  return { value: migrated, changes };
}

function ensureArtifactSchemaVersion(value: JsonObject): string[] {
  if (value.artifactSchemaVersion === CURRENT_ARTIFACT_SCHEMA_VERSION) {
    return [];
  }
  value.artifactSchemaVersion = CURRENT_ARTIFACT_SCHEMA_VERSION;
  return ["set artifactSchemaVersion to 1"];
}

async function listMigrationArtifactFiles(migrationRunsDir: string): Promise<ArtifactFileCandidate[]> {
  if (!await pathExists(migrationRunsDir)) {
    return [];
  }
  const files = await listJsonFiles(migrationRunsDir);
  return files
    .map((filePath) => {
      const normalized = toPosixPath(filePath);
      if (normalized.endsWith("/proposal.json") && normalized.includes("/proposals/")) {
        return { path: filePath, kind: "proposal" as const };
      }
      if (normalized.includes("/proposals/") && /\/verification-[^/]+\.json$/.test(normalized)) {
        return { path: filePath, kind: "proposal-verification-report" as const };
      }
      if (normalized.endsWith("/batch-plan.json") && normalized.includes("/proposal-batches/")) {
        return { path: filePath, kind: "proposal-batch-plan" as const };
      }
      if (normalized.includes("/proposal-batches/") && /\/proposal-batch-report-[^/]+\.json$/.test(normalized)) {
        return { path: filePath, kind: "proposal-batch-report" as const };
      }
      if (normalized.endsWith("/replan-context.json") && normalized.includes("/replans/")) {
        return { path: filePath, kind: "proposal-replan-context" as const };
      }
      if (normalized.includes("/replans/") && /\/repair-acceptance-[^/]+\.json$/.test(normalized)) {
        return { path: filePath, kind: "proposal-repair-acceptance" as const };
      }
      return undefined;
    })
    .filter((candidate): candidate is ArtifactFileCandidate => candidate !== undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
