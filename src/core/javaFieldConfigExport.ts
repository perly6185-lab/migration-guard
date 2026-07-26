import type { AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";
import {
  createJavaFieldConfigSnapshot,
  type JavaFieldConfigSnapshot,
  type JavaFieldConfigSnapshotField,
  type JavaFieldFormatterKind
} from "./javaFieldConfigSnapshot.js";

export interface ZbossFieldConfigExportRow {
  id: string | number;
  panelId: string | number;
  field: string;
  fieldTagInnerKey?: string | null;
  fieldFormatTag?: string | null;
  unionFieldTag?: string | null;
  relationFieldIds?: Array<string | number>;
  isPercentageData?: boolean;
  isDateData?: boolean;
  isMonthData?: boolean;
  isDateTimeData?: boolean;
}

export interface ZbossFieldConfigExport {
  version: 1;
  tenantId: string | number;
  panelIds: Array<string | number>;
  fields: ZbossFieldConfigExportRow[];
}

export interface ZbossFieldConfigConversion {
  snapshot: JavaFieldConfigSnapshot;
  classifiedFields: number;
  unclassifiedFields: Array<{ fieldId: string; panelId: string; alias: string; reason: string }>;
}

export function requiredJavaReleaseFromMavenPom(pom: string): number {
  const property = pom.match(/<java\.version>\s*(\d+)\s*<\/java\.version>/)?.[1];
  const release = pom.match(/<maven\.compiler\.release>\s*(?:\$\{java\.version\}|(\d+))\s*<\/maven\.compiler\.release>/)?.[1];
  const value = release ?? property;
  if (!value) throw new Error("Unable to determine the zboss Java release from pom.xml.");
  return Number(value);
}

export function javaRuntimeMajor(versionOutput: string): number {
  const value = versionOutput.match(/(?:java|openjdk)\s+(?:version\s+)?\"?(\d+)/i)?.[1];
  if (!value) throw new Error("Unable to determine the installed Java runtime version.");
  return Number(value);
}

export function assertZbossJavaRuntime(pom: string, versionOutput: string): number {
  const required = requiredJavaReleaseFromMavenPom(pom);
  const actual = javaRuntimeMajor(versionOutput);
  if (actual !== required) {
    throw new Error(`zboss requires JDK ${required}, but the active Java runtime is ${actual}.`);
  }
  return required;
}

export function convertZbossFieldConfigExport(
  value: unknown,
  source: AssessmentSourceIdentity
): ZbossFieldConfigConversion {
  const raw = parseExport(value);
  const unclassifiedFields: ZbossFieldConfigConversion["unclassifiedFields"] = [];
  const fields: JavaFieldConfigSnapshotField[] = raw.fields.map((field) => {
    const fieldId = String(field.id);
    const panelId = String(field.panelId);
    const alias = field.field.trim();
    const booleans = [
      field.isPercentageData,
      field.isDateData,
      field.isMonthData,
      field.isDateTimeData
    ];
    let formatterKinds: JavaFieldFormatterKind[] | undefined;
    if (booleans.every((item) => typeof item === "boolean")) {
      formatterKinds = [
        ...(field.isPercentageData ? ["percentage" as const] : []),
        ...(field.isDateData || field.isMonthData || field.isDateTimeData ? ["date" as const] : [])
      ];
    } else {
      unclassifiedFields.push({
        fieldId,
        panelId,
        alias,
        reason: "zboss-formatter-classification-incomplete"
      });
    }
    return {
      fieldId,
      panelId,
      alias,
      ...(field.fieldTagInnerKey ? { fieldTag: field.fieldTagInnerKey } : {}),
      ...(field.fieldFormatTag ? { formatTag: field.fieldFormatTag } : {}),
      ...(formatterKinds ? { formatterKinds } : {}),
      ...(field.relationFieldIds ? {
        relationFieldIds: field.relationFieldIds.map(String)
      } : {})
    };
  });
  return {
    snapshot: createJavaFieldConfigSnapshot({
      source,
      tenantId: String(raw.tenantId),
      panelIds: raw.panelIds.map(String),
      fields
    }),
    classifiedFields: fields.length - unclassifiedFields.length,
    unclassifiedFields
  };
}

export function renderZbossFieldConfigExportSql(): string {
  return [
    "-- Core field rows. Formatter booleans must be produced by the zboss service export,",
    "-- because their Java predicates are the authoritative business rules.",
    "SELECT",
    "  CAST(f.id AS CHAR) AS id,",
    "  CAST(f.panel_id AS CHAR) AS panelId,",
    "  f.field AS field,",
    "  f.field_tag_inner_key AS fieldTagInnerKey,",
    "  f.field_format_tag AS fieldFormatTag,",
    "  f.union_field_tag AS unionFieldTag",
    "FROM boss_view_dynamic_field_data f",
    "WHERE f.tenant_id = :tenantId",
    "  AND f.panel_id IN (:panelIds)",
    "  AND f.deleted = 0",
    "ORDER BY f.panel_id, f.field, f.id;",
    "",
    "-- Relation field ids, grouped by field_id in the exporter.",
    "SELECT",
    "  CAST(u.field_id AS CHAR) AS fieldId,",
    "  CAST(u.left_panel_field_id AS CHAR) AS leftFieldId,",
    "  CAST(u.right_panel_field_id AS CHAR) AS rightFieldId",
    "FROM boss_view_dynamic_field_union_data u",
    "WHERE u.tenant_id = :tenantId",
    "  AND u.field_panel_id IN (:panelIds)",
    "  AND u.deleted = 0",
    "ORDER BY u.field_id, u.id;"
  ].join("\n");
}

function parseExport(value: unknown): ZbossFieldConfigExport {
  if (!isRecord(value) || value.version !== 1
    || (typeof value.tenantId !== "string" && typeof value.tenantId !== "number")
    || !Array.isArray(value.panelIds) || value.panelIds.length === 0
    || !Array.isArray(value.fields)) {
    throw new Error("Invalid zboss field configuration export.");
  }
  const panels = new Set(value.panelIds.map(String));
  const fields = value.fields.map((item) => {
    if (!isRecord(item)
      || (typeof item.id !== "string" && typeof item.id !== "number")
      || (typeof item.panelId !== "string" && typeof item.panelId !== "number")
      || typeof item.field !== "string" || !item.field.trim()
      || !panels.has(String(item.panelId))) {
      throw new Error("Invalid or out-of-scope zboss field configuration row.");
    }
    for (const key of ["isPercentageData", "isDateData", "isMonthData", "isDateTimeData"]) {
      if (item[key] !== undefined && typeof item[key] !== "boolean") {
        throw new Error(`Invalid zboss field formatter classification: ${key}.`);
      }
    }
    return item as unknown as ZbossFieldConfigExportRow;
  });
  return {
    version: 1,
    tenantId: value.tenantId,
    panelIds: value.panelIds as Array<string | number>,
    fields
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
