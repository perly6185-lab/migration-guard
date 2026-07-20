import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, createDefaultConfig, loadConfig } from "../core/config.js";
import { pathExists, writeJsonFile } from "../core/files.js";
import type { LoadedConfig } from "../types.js";

export interface DesktopHostConfigOptions {
  currentWorkingDirectory: string;
  userDataDir: string;
  configPath?: string;
}

export async function loadDesktopHostConfig(options: DesktopHostConfigOptions): Promise<LoadedConfig> {
  if (options.configPath) {
    return loadConfig(options.configPath, options.currentWorkingDirectory);
  }

  try {
    return await loadConfig(undefined, options.currentWorkingDirectory);
  } catch (error) {
    if (!isMissingConfigError(error)) {
      throw error;
    }
  }

  const configPath = await ensureDesktopHostConfig(options.userDataDir);
  return loadConfig(configPath, path.dirname(configPath));
}

export async function ensureDesktopHostConfig(userDataDir: string): Promise<string> {
  const hostDir = path.join(userDataDir, "host");
  const targetRoot = path.join(hostDir, "target");
  const artifactsDir = path.join(hostDir, "artifacts");
  const configPath = path.join(hostDir, CONFIG_FILE_NAME);
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });

  if (!await pathExists(configPath)) {
    await writeJsonFile(configPath, {
      ...createDefaultConfig("target"),
      artifactsDir: "artifacts"
    });
  }

  return configPath;
}

function isMissingConfigError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(`Could not find ${CONFIG_FILE_NAME}`);
}
