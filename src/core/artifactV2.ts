import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface ArtifactV2Envelope<T = unknown> {
  artifactSchemaVersion: 2;
  kind: "snapshot" | "compare" | "ui-job";
  migratedAt: string;
  sourceVersion: number;
  payloadHash: string;
  payload: T;
}

export function migrateCoreArtifactToV2(kind: ArtifactV2Envelope["kind"], value: unknown, now = new Date().toISOString()): ArtifactV2Envelope {
  if (value && typeof value === "object" && (value as { artifactSchemaVersion?: unknown }).artifactSchemaVersion === 2) {
    const envelope = value as ArtifactV2Envelope;
    validateArtifactV2(envelope);
    return envelope;
  }
  const sourceVersion = Number((value as { version?: unknown })?.version ?? 1);
  if (sourceVersion > 1) throw new Error(`Unsupported source artifact version: ${sourceVersion}`);
  return { artifactSchemaVersion: 2, kind, migratedAt: now, sourceVersion, payloadHash: sha256(stableStringify(value)), payload: value };
}

export function validateArtifactV2(value: ArtifactV2Envelope): void {
  if (value.artifactSchemaVersion !== 2) throw new Error(`Unsupported core artifact schema version: ${String(value.artifactSchemaVersion)}`);
  if (value.payloadHash !== sha256(stableStringify(value.payload))) throw new Error("Core artifact v2 payload hash mismatch");
}