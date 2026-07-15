import path from "node:path";
import { readJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { GuardPolicy, PolicyConfig, PolicyResolution } from "../types.js";

export const BUILTIN_POLICIES: Record<string, GuardPolicy> = {
  "js-ts-monorepo": { maxChangedFiles: 12, maxCommands: 8, artifactRetentionRuns: 20, requireStrictHealth: true, allowTargetEdit: true, allowGithubMutation: false, allowReleaseMutation: false },
  "go-service": { maxChangedFiles: 8, maxCommands: 6, artifactRetentionRuns: 15, requireStrictHealth: true, allowTargetEdit: true, allowGithubMutation: false, allowReleaseMutation: false },
  "conservative-migration": { maxChangedFiles: 3, maxCommands: 4, artifactRetentionRuns: 30, requireStrictHealth: true, allowTargetEdit: true, allowGithubMutation: false, allowReleaseMutation: false }
};

const LEGACY_POLICY: GuardPolicy = { maxChangedFiles: 50, maxCommands: 50, artifactRetentionRuns: 5, requireStrictHealth: false, allowTargetEdit: true, allowGithubMutation: false, allowReleaseMutation: false };

export async function resolvePolicy(config: PolicyConfig | undefined, baseDir: string): Promise<PolicyResolution> {
  const name = config?.preset ?? "legacy-default";
  const builtin = name === "legacy-default" ? LEGACY_POLICY : BUILTIN_POLICIES[name];
  const presetPath = builtin ? undefined : path.resolve(baseDir, name);
  if (presetPath && path.relative(baseDir, presetPath).startsWith("..")) throw new Error("Policy preset must be a local file inside the config directory.");
  const preset = builtin ?? await readJsonFile<GuardPolicy>(presetPath as string);
  validatePolicy(preset, `preset ${name}`);
  const findings: string[] = [];
  const override = config?.overrides ?? {};
  const policy: GuardPolicy = {
    maxChangedFiles: tightenNumber("maxChangedFiles", preset.maxChangedFiles, override.maxChangedFiles, findings),
    maxCommands: tightenNumber("maxCommands", preset.maxCommands, override.maxCommands, findings),
    artifactRetentionRuns: tightenRetention(preset.artifactRetentionRuns, override.artifactRetentionRuns, findings),
    requireStrictHealth: preset.requireStrictHealth || override.requireStrictHealth === true,
    allowTargetEdit: tightenPermission("allowTargetEdit", preset.allowTargetEdit, override.allowTargetEdit, findings),
    allowGithubMutation: tightenPermission("allowGithubMutation", preset.allowGithubMutation, override.allowGithubMutation, findings),
    allowReleaseMutation: tightenPermission("allowReleaseMutation", preset.allowReleaseMutation, override.allowReleaseMutation, findings)
  };
  return { preset: name, source: builtin ? `builtin:${name}` : presetPath as string, policy, hash: sha256(stableStringify(policy)), findings };
}

export function listBuiltinPolicies(): Array<{ name: string; policy: GuardPolicy; hash: string }> { return Object.entries(BUILTIN_POLICIES).map(([name, policy]) => ({ name, policy, hash: sha256(stableStringify(policy)) })); }
function tightenNumber(name: string, base: number, value: number | undefined, findings: string[]): number { if (value === undefined) return base; if (!Number.isInteger(value) || value < 0) throw new Error(`Policy ${name} must be a non-negative integer.`); if (value > base) findings.push(`Override ${name}=${value} was capped at preset value ${base}.`); return Math.min(base, value); }
function tightenPermission(name: string, base: boolean, value: boolean | undefined, findings: string[]): boolean { if (value === true && !base) findings.push(`Override ${name}=true was rejected because the preset denies it.`); return base && value !== false; }
function tightenRetention(base: number, value: number | undefined, findings: string[]): number { if (value === undefined) return base; if (!Number.isInteger(value) || value < 0) throw new Error("Policy artifactRetentionRuns must be a non-negative integer."); if (value < base) findings.push(`Override artifactRetentionRuns=${value} was raised to preset minimum ${base}.`); return Math.max(base, value); }
function validatePolicy(policy: GuardPolicy, label: string): void { for (const key of ["maxChangedFiles", "maxCommands", "artifactRetentionRuns"] as const) if (!Number.isInteger(policy[key]) || policy[key] < 0) throw new Error(`Invalid ${label}: ${key} must be a non-negative integer.`); for (const key of ["requireStrictHealth", "allowTargetEdit", "allowGithubMutation", "allowReleaseMutation"] as const) if (typeof policy[key] !== "boolean") throw new Error(`Invalid ${label}: ${key} must be boolean.`); }
