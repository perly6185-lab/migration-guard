import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig lets environment variables override config variables", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-config-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const previous = process.env.MG_TEST_TARGET;
  process.env.MG_TEST_TARGET = "from-env";

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "${MG_TEST_TARGET}",
      artifactsDir: ".migration-guard",
      variables: {
        MG_TEST_TARGET: "from-config"
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);

    assert.equal(loaded.targetRoot, path.join(dir, "from-env"));
  } finally {
    if (previous === undefined) {
      delete process.env.MG_TEST_TARGET;
    } else {
      process.env.MG_TEST_TARGET = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
