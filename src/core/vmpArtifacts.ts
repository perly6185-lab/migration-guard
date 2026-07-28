import { promises as fs } from "node:fs";
import { sha256 } from "./hash.js";
import { writeJsonFile } from "./files.js";
import {
  VMP_REPLAY_BEHAVIORS,
  checkVmpReadiness,
  type VmpEvidenceBundle,
  type VmpReplayBehavior,
  type VmpReplayCase
} from "./vmpReplay.js";

export interface VmpEvidenceEnvelope {
  schemaVersion: 1;
  integrity: { algorithm: "sha256"; hash: string };
  bundle: VmpEvidenceBundle;
}

export async function loadVmpFixtureCases(filePath: string): Promise<VmpReplayCase[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("VMP fixture root must be an array");
  const cases = parsed.map(validateCase);
  const readiness = checkVmpReadiness({
    oldService: true,
    newService: true,
    oldDatabase: true,
    newDatabase: true,
    token: true,
    cases
  });
  const fixtureBlockers = readiness.blockers.filter((blocker) =>
    blocker.startsWith("行为用例缺失:") ||
    blocker.startsWith("用例 ID 无效或重复:") ||
    blocker.startsWith("用例包含敏感字段:"));
  if (fixtureBlockers.length) throw new Error(`Invalid VMP fixture: ${fixtureBlockers.join(", ")}`);
  return cases;
}

export async function writeVmpEvidenceEnvelope(filePath: string, bundle: VmpEvidenceBundle): Promise<VmpEvidenceEnvelope> {
  const envelope: VmpEvidenceEnvelope = {
    schemaVersion: 1,
    integrity: { algorithm: "sha256", hash: evidenceHash(bundle) },
    bundle
  };
  await writeJsonFile(filePath, envelope);
  return envelope;
}

export async function readVmpEvidenceEnvelope(filePath: string): Promise<VmpEvidenceEnvelope> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<VmpEvidenceEnvelope>;
  if (parsed.schemaVersion !== 1 || parsed.integrity?.algorithm !== "sha256" || !parsed.bundle) {
    throw new Error("Unsupported or malformed VMP evidence envelope");
  }
  const actual = evidenceHash(parsed.bundle);
  if (parsed.integrity.hash !== actual) throw new Error("VMP evidence integrity hash mismatch");
  return parsed as VmpEvidenceEnvelope;
}

function validateCase(value: unknown, index: number): VmpReplayCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`VMP fixture case ${index} must be an object`);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) throw new Error(`VMP fixture case ${index} has no id`);
  if (typeof item.behavior !== "string" || !VMP_REPLAY_BEHAVIORS.includes(item.behavior as VmpReplayBehavior)) {
    throw new Error(`VMP fixture case ${item.id} has an unsupported behavior`);
  }
  if (!item.request || typeof item.request !== "object" || Array.isArray(item.request)) {
    throw new Error(`VMP fixture case ${item.id} request must be an object`);
  }
  if (item.expectedStatus !== undefined && (!Number.isInteger(item.expectedStatus) || Number(item.expectedStatus) < 100 || Number(item.expectedStatus) > 599)) {
    throw new Error(`VMP fixture case ${item.id} has an invalid expectedStatus`);
  }
  if (item.volatilePaths !== undefined && (!Array.isArray(item.volatilePaths) || item.volatilePaths.some((path) => typeof path !== "string"))) {
    throw new Error(`VMP fixture case ${item.id} has invalid volatilePaths`);
  }
  return item as unknown as VmpReplayCase;
}

function evidenceHash(bundle: VmpEvidenceBundle): string {
  return sha256(stableJson(bundle));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
