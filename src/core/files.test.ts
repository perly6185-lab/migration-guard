import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { toPosixPath } from "./files.js";

test("toPosixPath normalizes Windows, POSIX, and mixed separators", () => {
  assert.equal(toPosixPath("apps\\web\\src\\App.vue"), "apps/web/src/App.vue");
  assert.equal(toPosixPath("apps/web/src/App.vue"), "apps/web/src/App.vue");
  assert.equal(toPosixPath("apps\\web/src\\App.vue"), "apps/web/src/App.vue");
});

test("toPosixPath normalizes native relative paths on every platform", () => {
  const nativeRelativePath = path.join("packages", "shared", "src", "types.ts");

  assert.equal(toPosixPath(nativeRelativePath), "packages/shared/src/types.ts");
});
