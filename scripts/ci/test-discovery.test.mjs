import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyTestFile, discoverTestFiles } from "./test-discovery.mjs";

test("test discovery is recursive, filtered and stably sorted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-test-discovery-"));
  try {
    await mkdir(path.join(root, "dist", "nested"), { recursive: true });
    await mkdir(path.join(root, "scripts", "release"), { recursive: true });
    await writeFile(path.join(root, "dist", "z.test.js"), "");
    await writeFile(path.join(root, "dist", "nested", "a.test.js"), "");
    await writeFile(path.join(root, "dist", "nested", "ignored.test.ts"), "");
    await writeFile(path.join(root, "scripts", "release", "evidence.test.mjs"), "");
    assert.deepEqual(await discoverTestFiles(root), [
      "dist/nested/a.test.js",
      "dist/z.test.js",
      "scripts/release/evidence.test.mjs"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test layers separate integration files from focused unit files", () => {
  assert.equal(classifyTestFile("dist/core/normalize.test.js"), "unit");
  assert.equal(classifyTestFile("dist/core/issueControl.test.js"), "integration");
  assert.equal(classifyTestFile("scripts/release/evidence.test.mjs"), "integration");
});
