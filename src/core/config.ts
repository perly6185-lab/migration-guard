import path from "node:path";
import { pathExists, readJsonFile, resolveMaybeRelative, writeJsonFile } from "./files.js";
import type { LoadedConfig, MigrationGuardConfig } from "../types.js";

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
      failOnProbeDiff: true
    }
  };
}

export async function initConfigFile(configPath: string, targetRoot: string, force: boolean): Promise<void> {
  if (!force && await pathExists(configPath)) {
    throw new Error(`Config already exists: ${configPath}`);
  }

  await writeJsonFile(configPath, createDefaultConfig(targetRoot));
}

export async function loadConfig(configPath?: string, startDir = process.cwd()): Promise<LoadedConfig> {
  const resolvedConfigPath = configPath
    ? path.resolve(startDir, configPath)
    : await findConfigPath(startDir);

  if (!resolvedConfigPath) {
    throw new Error(`Could not find ${CONFIG_FILE_NAME}. Run "migration-guard init" first.`);
  }

  const raw = await readJsonFile<Partial<MigrationGuardConfig>>(resolvedConfigPath);
  const baseDir = path.dirname(resolvedConfigPath);
  const config = mergeWithDefaults(raw);
  const targetRoot = resolveMaybeRelative(baseDir, config.targetRoot);
  const artifactsDir = resolveMaybeRelative(baseDir, config.artifactsDir);

  return {
    path: resolvedConfigPath,
    baseDir,
    targetRoot,
    artifactsDir,
    config
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

function mergeWithDefaults(raw: Partial<MigrationGuardConfig>): MigrationGuardConfig {
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
    }
  };
}
