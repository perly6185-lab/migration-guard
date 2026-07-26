import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

export interface JavaFieldConfigSnapshotField {
  fieldId: string;
  panelId: string;
  alias: string;
  fieldTag?: string;
  formatTag?: string;
  formatterKinds?: JavaFieldFormatterKind[];
  relationFieldIds?: string[];
}

export type JavaFieldFormatterKind = "percentage" | "date";

export interface JavaFieldProjectionFacts {
  panelId: string;
  selectedAliases: string[];
  formatterKinds: JavaFieldFormatterKind[];
  complete: boolean;
  reasons: string[];
  evidenceHash: string;
}

export interface JavaFieldConfigSnapshotInput {
  source: AssessmentSourceIdentity;
  tenantId: string;
  panelIds: string[];
  fields: JavaFieldConfigSnapshotField[];
}

export interface JavaFieldConfigSnapshot {
  version: 1;
  source: AssessmentSourceIdentity;
  scope: {
    tenantId: string;
    panelIds: string[];
  };
  fields: JavaFieldConfigSnapshotField[];
  snapshotHash: string;
}

export interface JavaFieldConfigSnapshotExpectation {
  source: AssessmentSourceIdentity;
  tenantId: string;
  panelIds: Iterable<string>;
}

export interface JavaFieldConfigSnapshotValidation {
  trusted: boolean;
  reasons: string[];
  snapshot?: JavaFieldConfigSnapshot;
}

export function createJavaFieldConfigSnapshot(input: JavaFieldConfigSnapshotInput): JavaFieldConfigSnapshot {
  const core = normalizeSnapshotCore({
    version: 1,
    source: input.source,
    scope: { tenantId: input.tenantId, panelIds: input.panelIds },
    fields: input.fields
  });
  assertSnapshotShape(core);
  return { ...core, snapshotHash: snapshotHash(core) };
}

export function validateJavaFieldConfigSnapshot(
  value: unknown,
  expected: JavaFieldConfigSnapshotExpectation
): JavaFieldConfigSnapshotValidation {
  const reasons: string[] = [];
  if (!isRecord(value) || value.version !== 1 || typeof value.snapshotHash !== "string") {
    return { trusted: false, reasons: ["field-config-snapshot-invalid-shape"] };
  }
  let snapshot: JavaFieldConfigSnapshot;
  try {
    const core = normalizeSnapshotCore(value as unknown as Omit<JavaFieldConfigSnapshot, "snapshotHash">);
    assertSnapshotShape(core);
    snapshot = { ...core, snapshotHash: value.snapshotHash };
  } catch {
    return { trusted: false, reasons: ["field-config-snapshot-invalid-shape"] };
  }
  if (snapshot.snapshotHash !== snapshotHash(snapshot)) reasons.push("field-config-snapshot-hash-mismatch");
  if (snapshot.source.revision !== expected.source.revision) reasons.push("field-config-snapshot-source-revision-mismatch");
  if (snapshot.source.dirty !== expected.source.dirty
    || snapshot.source.dirtyFingerprint !== expected.source.dirtyFingerprint) {
    reasons.push("field-config-snapshot-source-worktree-mismatch");
  }
  if (snapshot.scope.tenantId !== expected.tenantId) reasons.push("field-config-snapshot-tenant-mismatch");
  const expectedPanels = normalizedStrings(expected.panelIds);
  const coveredPanels = new Set(snapshot.scope.panelIds);
  if (expectedPanels.some((panelId) => !coveredPanels.has(panelId))) {
    reasons.push("field-config-snapshot-panel-scope-incomplete");
  }
  if (hasConflictingFields(snapshot.fields)) reasons.push("field-config-snapshot-field-conflict");
  return reasons.length === 0 ? { trusted: true, reasons, snapshot } : { trusted: false, reasons };
}

export function javaFieldConfigByAlias(
  snapshot: JavaFieldConfigSnapshot,
  panelId: string
): Map<string, JavaFieldConfigSnapshotField> {
  return new Map(snapshot.fields
    .filter((field) => field.panelId === panelId)
    .map((field) => [field.alias, field]));
}

export function deriveJavaFieldProjectionFacts(
  snapshot: JavaFieldConfigSnapshot,
  panelId: string,
  selectedAliases: Iterable<string>
): JavaFieldProjectionFacts {
  const aliases = normalizedStrings(selectedAliases);
  const fields = javaFieldConfigByAlias(snapshot, panelId);
  const reasons: string[] = [];
  const formatterKinds = new Set<JavaFieldFormatterKind>();
  if (!snapshot.scope.panelIds.includes(panelId)) reasons.push("projection-panel-outside-snapshot-scope");
  for (const alias of aliases) {
    const field = fields.get(alias);
    if (!field) {
      reasons.push(`projection-alias-missing:${alias}`);
      continue;
    }
    if (!field.formatterKinds) {
      reasons.push(`projection-formatter-classification-missing:${alias}`);
      continue;
    }
    for (const kind of field.formatterKinds) formatterKinds.add(kind);
  }
  const core = {
    panelId,
    selectedAliases: aliases,
    formatterKinds: [...formatterKinds].sort() as JavaFieldFormatterKind[],
    complete: reasons.length === 0,
    reasons: [...reasons].sort()
  };
  return { ...core, evidenceHash: sha256(stableStringify({ snapshotHash: snapshot.snapshotHash, ...core })) };
}

function normalizeSnapshotCore(
  value: Omit<JavaFieldConfigSnapshot, "snapshotHash">
): Omit<JavaFieldConfigSnapshot, "snapshotHash"> {
  const source = value.source;
  const fields = [...(value.fields ?? [])].map((field) => ({
    fieldId: String(field.fieldId),
    panelId: String(field.panelId),
    alias: String(field.alias),
    ...(field.fieldTag ? { fieldTag: String(field.fieldTag) } : {}),
    ...(field.formatTag ? { formatTag: String(field.formatTag) } : {}),
    ...(field.formatterKinds ? {
      formatterKinds: [...new Set(field.formatterKinds)]
        .filter((kind): kind is JavaFieldFormatterKind => kind === "percentage" || kind === "date")
        .sort()
    } : {}),
    ...(field.relationFieldIds ? { relationFieldIds: normalizedStrings(field.relationFieldIds) } : {})
  })).sort((a, b) =>
    a.panelId.localeCompare(b.panelId)
    || a.alias.localeCompare(b.alias)
    || a.fieldId.localeCompare(b.fieldId));
  return {
    version: 1,
    source: {
      revision: String(source?.revision ?? ""),
      dirty: Boolean(source?.dirty),
      dirtyFingerprint: String(source?.dirtyFingerprint ?? ""),
      identity: String(source?.identity ?? "")
    },
    scope: {
      tenantId: String(value.scope?.tenantId ?? ""),
      panelIds: normalizedStrings(value.scope?.panelIds ?? [])
    },
    fields
  };
}

function assertSnapshotShape(value: Omit<JavaFieldConfigSnapshot, "snapshotHash">): void {
  if (!value.source.revision || !value.source.identity || !/^[a-f0-9]{64}$/.test(value.source.dirtyFingerprint)) {
    throw new Error("Invalid field configuration snapshot source identity.");
  }
  if (!value.scope.tenantId || value.scope.panelIds.length === 0) {
    throw new Error("Field configuration snapshot scope must include a tenant and at least one panel.");
  }
  const panels = new Set(value.scope.panelIds);
  for (const field of value.fields) {
    if (!field.fieldId || !field.panelId || !field.alias || !panels.has(field.panelId)) {
      throw new Error("Field configuration snapshot contains an invalid or out-of-scope field.");
    }
  }
  if (hasConflictingFields(value.fields)) throw new Error("Field configuration snapshot contains conflicting fields.");
}

function hasConflictingFields(fields: JavaFieldConfigSnapshotField[]): boolean {
  const byId = new Map<string, string>();
  const byAlias = new Map<string, string>();
  for (const field of fields) {
    const normalized = stableStringify(field);
    const idKey = `${field.panelId}:${field.fieldId}`;
    const aliasKey = `${field.panelId}:${field.alias}`;
    if ((byId.has(idKey) && byId.get(idKey) !== normalized)
      || (byAlias.has(aliasKey) && byAlias.get(aliasKey) !== normalized)) return true;
    byId.set(idKey, normalized);
    byAlias.set(aliasKey, normalized);
  }
  return false;
}

function snapshotHash(value: Omit<JavaFieldConfigSnapshot, "snapshotHash"> | JavaFieldConfigSnapshot): string {
  const { snapshotHash: _snapshotHash, ...core } = value as JavaFieldConfigSnapshot;
  return sha256(stableStringify(core));
}

function normalizedStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map(String).filter(Boolean))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
