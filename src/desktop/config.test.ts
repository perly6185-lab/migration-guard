import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { CONFIG_FILE_NAME, createDefaultConfig } from "../core/config.js";
import { ensureDesktopHostConfig, loadDesktopHostConfig } from "./config.js";

test("desktop host config uses the working directory config when available", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-cwd-"));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-userdata-"));
  try {
    const configPath = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(configPath, JSON.stringify({
      ...createDefaultConfig("."),
      artifactsDir: ".migration-guard"
    }, null, 2));

    const loaded = await loadDesktopHostConfig({ currentWorkingDirectory: dir, userDataDir });
    assert.equal(loaded.path, configPath);
    assert.equal(loaded.targetRoot, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("desktop host config creates a user-data fallback when no config is nearby", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-empty-"));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-userdata-"));
  try {
    const loaded = await loadDesktopHostConfig({ currentWorkingDirectory: dir, userDataDir });
    const expectedConfig = path.join(userDataDir, "host", CONFIG_FILE_NAME);
    assert.equal(loaded.path, expectedConfig);
    assert.equal(loaded.targetRoot, path.join(userDataDir, "host", "target"));
    assert.equal(loaded.artifactsDir, path.join(userDataDir, "host", "artifacts"));

    const raw = JSON.parse(await readFile(expectedConfig, "utf8")) as Record<string, unknown>;
    assert.equal(raw.targetRoot, "target");
    assert.equal(raw.artifactsDir, "artifacts");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("desktop host config does not hide invalid local configs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-invalid-"));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-userdata-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({ schemaVersion: 2 }));
    await assert.rejects(
      () => loadDesktopHostConfig({ currentWorkingDirectory: dir, userDataDir }),
      /Unsupported config schemaVersion/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("ensureDesktopHostConfig is idempotent", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-desktop-userdata-"));
  try {
    const first = await ensureDesktopHostConfig(userDataDir);
    const second = await ensureDesktopHostConfig(userDataDir);
    assert.equal(second, first);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
