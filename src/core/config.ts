import path from "node:path";
import { pathExists, readJsonFile, resolveMaybeRelative, writeJsonFile } from "./files.js";
import type { ComparePolicy, IssueSyncConfig, LoadedConfig, MigrationGuardConfig, MigrationGuardConfigProfile, OutputConfig, ProposalGateConfig } from "../types.js";
import { resolvePolicy } from "./policy.js";

export const CONFIG_FILE_NAME = ".migration-guard.json";

export const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".migration-guard"
];

type RawMigrationGuardConfig = Omit<Partial<MigrationGuardConfig>, "output" | "compare" | "proposalGate" | "issueSync"> & {
  output?: Partial<OutputConfig>;
  compare?: Partial<ComparePolicy>;
  proposalGate?: Partial<ProposalGateConfig>;
  issueSync?: Partial<IssueSyncConfig>;
};

export function createDefaultConfig(targetRoot = "."): MigrationGuardConfig {
  return {
    schemaVersion: 1,
    targetRoot,
    artifactsDir: ".migration-guard",
    ignore: DEFAULT_IGNORE,
    checks: [
      {
        name: "typecheck",
        command: "npm run typecheck --if-present",
        timeoutMs: 120000,
        critical: true
      },
      {
        name: "test",
        command: "npm test --if-present",
        timeoutMs: 120000,
        critical: true
      },
      {
        name: "build",
        command: "npm run build --if-present",
        timeoutMs: 180000,
        critical: true
      }
    ],
    probes: [],
    output: {
      maxOutputBytes: 262144
    },
    compare: {
      failOnCheckRegression: true,
      failOnProbeDiff: true,
      allowInheritedFailures: true,
      failOnChangedFailure: true
    },
    proposalGate: {
      defaultPolicy: "collect-all",
      batchPolicy: "fail-fast",
      retry: {
        "unit-test": {
          maxAttempts: 2,
          delayMs: 1000,
          retryOn: ["flake-suspected"]
        },
        "ui-probe": {
          maxAttempts: 2,
          delayMs: 1000,
          retryOn: ["flake-suspected", "timeout"]
        }
      }
    },
    issueSync: {},
    variables: {}
  };
}

export async function initConfigFile(configPath: string, targetRoot: string, force: boolean): Promise<void> {
  if (!force && await pathExists(configPath)) {
    throw new Error(`Config already exists: ${configPath}`);
  }

  await writeJsonFile(configPath, createDefaultConfig(targetRoot));
}

export async function loadConfig(configPath?: string, startDir = process.cwd(), profileName?: string): Promise<LoadedConfig> {
  const resolvedConfigPath = configPath
    ? path.resolve(startDir, configPath)
    : await findConfigPath(startDir);

  if (!resolvedConfigPath) {
    throw new Error(`Could not find ${CONFIG_FILE_NAME}. Run "migration-guard init" first.`);
  }

  const raw = await readJsonFile<unknown>(resolvedConfigPath);
  validateConfigSchema(raw, resolvedConfigPath);
  const baseDir = path.dirname(resolvedConfigPath);
  const selectedProfile = profileName ?? process.env.MG_PROFILE;
  const config = interpolateConfig(mergeWithDefaults(applyConfigProfile(raw, selectedProfile, resolvedConfigPath)));
  validateResolvedConfig(config, resolvedConfigPath);
  const targetRoot = resolveMaybeRelative(baseDir, config.targetRoot);
  const artifactsDir = resolveMaybeRelative(baseDir, config.artifactsDir);
  const policy = await resolvePolicy(config.policy, baseDir);

  return {
    path: resolvedConfigPath,
    baseDir,
    targetRoot,
    artifactsDir,
    profile: selectedProfile,
    config,
    policy
  };
}

async function findConfigPath(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function mergeWithDefaults(raw: RawMigrationGuardConfig): MigrationGuardConfig {
  const defaults = createDefaultConfig(raw.targetRoot ?? ".");

  return {
    ...defaults,
    ...raw,
    schemaVersion: 1,
    ignore: raw.ignore ?? defaults.ignore,
    checks: raw.checks ?? defaults.checks,
    probes: raw.probes ?? defaults.probes,
    output: {
      ...defaults.output,
      ...raw.output
    },
    compare: {
      ...defaults.compare,
      ...raw.compare
    },
    proposalGate: {
      ...defaults.proposalGate,
      ...raw.proposalGate,
      retry: {
        ...defaults.proposalGate.retry,
        ...raw.proposalGate?.retry
      }
    },
    issueSync: {
      ...defaults.issueSync,
      ...raw.issueSync
    },
    variables: raw.variables ?? defaults.variables,
    policy: raw.policy,
    profiles: raw.profiles
  };
}

function validateConfigSchema(raw: unknown, configPath: string): asserts raw is RawMigrationGuardConfig {
  if (!isRecord(raw)) throw new Error(`Invalid config in ${configPath}: root must be an object.`);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new Error(`Unsupported config schemaVersion ${String(raw.schemaVersion)} in ${configPath}. Expected 1.`);
  }
  if (raw.profiles !== undefined && !isRecord(raw.profiles)) invalid(configPath, "profiles must be an object");
}

function validateResolvedConfig(config: MigrationGuardConfig, configPath: string): void {
  requireString(config.targetRoot, "targetRoot", configPath);
  requireString(config.artifactsDir, "artifactsDir", configPath);
  requireStringArray(config.ignore, "ignore", configPath);
  if (!Array.isArray(config.checks)) invalid(configPath, "checks must be an array");
  config.checks.forEach((check, index) => {
    if (!isRecord(check)) invalid(configPath, `checks[${index}] must be an object`);
    requireString(check.name, `checks[${index}].name`, configPath);
    requireString(check.command, `checks[${index}].command`, configPath);
    optionalString(check.cwd, `checks[${index}].cwd`, configPath);
    optionalPositiveInteger(check.timeoutMs, `checks[${index}].timeoutMs`, configPath);
    optionalBoolean(check.critical, `checks[${index}].critical`, configPath);
    optionalBoolean(check.enabled, `checks[${index}].enabled`, configPath);
  });
  if (!Array.isArray(config.probes)) invalid(configPath, "probes must be an array");
  config.probes.forEach((probe, index) => {
    if (!isRecord(probe)) invalid(configPath, `probes[${index}] must be an object`);
    requireString(probe.name, `probes[${index}].name`, configPath);
    if (probe.type !== "command" && probe.type !== "http") invalid(configPath, `probes[${index}].type must be command or http`);
    requireString(probe.type === "command" ? probe.command : probe.url, `probes[${index}].${probe.type === "command" ? "command" : "url"}`, configPath);
    optionalPositiveInteger(probe.timeoutMs, `probes[${index}].timeoutMs`, configPath);
    optionalBoolean(probe.enabled, `probes[${index}].enabled`, configPath);
  });
  if (!isRecord(config.output)) invalid(configPath, "output must be an object");
  requirePositiveInteger(config.output.maxOutputBytes, "output.maxOutputBytes", configPath);
  if (!isRecord(config.compare)) invalid(configPath, "compare must be an object");
  for (const key of ["failOnCheckRegression", "failOnProbeDiff", "allowInheritedFailures", "failOnChangedFailure"] as const) {
    optionalBoolean(config.compare[key], `compare.${key}`, configPath, key === "failOnCheckRegression" || key === "failOnProbeDiff");
  }
  if (!isRecord(config.proposalGate)) invalid(configPath, "proposalGate must be an object");
  for (const key of ["defaultPolicy", "batchPolicy"] as const) {
    if (!(["fail-fast", "collect-all"] as unknown[]).includes(config.proposalGate[key])) invalid(configPath, `proposalGate.${key} must be fail-fast or collect-all`);
  }
  if (config.variables !== undefined) {
    if (!isRecord(config.variables) || Object.values(config.variables).some((value) => typeof value !== "string")) invalid(configPath, "variables values must be strings");
  }
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(configPath: string, message: string): never { throw new Error(`Invalid config in ${configPath}: ${message}.`); }
function requireString(value: unknown, name: string, configPath: string): asserts value is string { if (typeof value !== "string" || value.length === 0) invalid(configPath, `${name} must be a non-empty string`); }
function optionalString(value: unknown, name: string, configPath: string): void { if (value !== undefined) requireString(value, name, configPath); }
function requireStringArray(value: unknown, name: string, configPath: string): void { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(configPath, `${name} must be an array of strings`); }
function requirePositiveInteger(value: unknown, name: string, configPath: string): void { if (!Number.isInteger(value) || Number(value) <= 0) invalid(configPath, `${name} must be a positive integer`); }
function optionalPositiveInteger(value: unknown, name: string, configPath: string): void { if (value !== undefined) requirePositiveInteger(value, name, configPath); }
function optionalBoolean(value: unknown, name: string, configPath: string, required = false): void { if ((required && value === undefined) || (value !== undefined && typeof value !== "boolean")) invalid(configPath, `${name} must be a boolean`); }

function applyConfigProfile(
  raw: RawMigrationGuardConfig,
  profileName: string | undefined,
  configPath: string
): RawMigrationGuardConfig {
  if (!profileName) {
    return raw;
  }

  const profile = raw.profiles?.[profileName];
  if (!profile) {
    const known = Object.keys(raw.profiles ?? {}).sort().join(", ") || "none";
    throw new Error(`Config profile not found: ${profileName}. Available profiles: ${known}. Config: ${configPath}`);
  }

  return mergeProfile(raw, profile);
}

function mergeProfile(
  raw: RawMigrationGuardConfig,
  profile: MigrationGuardConfigProfile
): RawMigrationGuardConfig {
  return {
    ...raw,
    ...profile,
    output: {
      ...raw.output,
      ...profile.output
    },
    compare: {
      ...raw.compare,
      ...profile.compare
    },
    proposalGate: {
      ...raw.proposalGate,
      ...profile.proposalGate,
      retry: {
        ...raw.proposalGate?.retry,
        ...profile.proposalGate?.retry
      }
    },
    issueSync: {
      ...raw.issueSync,
      ...profile.issueSync
    },
    variables: {
      ...raw.variables,
      ...profile.variables
    },
    policy: profile.policy ?? raw.policy,
    profiles: raw.profiles
  };
}

function interpolateConfig(config: MigrationGuardConfig): MigrationGuardConfig {
  const variables = {
    ...config.variables,
    ...process.env
  };

  function interpolate(value: unknown): unknown {
    if (typeof value === "string") {
      return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (match, braced: string | undefined, bare: string | undefined) => {
        const key = braced ?? bare ?? "";
        return variables[key] ?? match;
      });
    }
    if (Array.isArray(value)) {
      return value.map(interpolate);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, interpolate(item)])
      );
    }
    return value;
  }

  return interpolate(config) as MigrationGuardConfig;
}
