import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readJsonFile, toPosixPath, writeJsonFile } from "./files.js";

test("toPosixPath normalizes Windows, POSIX, and mixed separators", () => {
  assert.equal(toPosixPath("apps\\web\\src\\App.vue"), "apps/web/src/App.vue");
  assert.equal(toPosixPath("apps/web/src/App.vue"), "apps/web/src/App.vue");
  assert.equal(toPosixPath("apps\\web/src\\App.vue"), "apps/web/src/App.vue");
});

test("toPosixPath normalizes native relative paths on every platform", () => {
  const nativeRelativePath = path.join("packages", "shared", "src", "types.ts");

  assert.equal(toPosixPath(nativeRelativePath), "packages/shared/src/types.ts");
});

test("writeJsonFile safely handles concurrent writes to one path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-files-concurrent-"));
  const filePath = path.join(dir, "state.json");
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonFile(filePath, { index })));
    const result = await readJsonFile<{ index: number }>(filePath);
    assert.ok(Number.isInteger(result.index));
    assert.ok(result.index >= 0 && result.index < 20);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
