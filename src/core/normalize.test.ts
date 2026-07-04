import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, stableStringify } from "./normalize.js";

test("stableStringify sorts object keys recursively", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    "{\"a\":{\"c\":3,\"d\":4},\"b\":1}"
  );
});

test("normalizeText can ignore nondeterministic JSON fields", () => {
  const input = JSON.stringify({
    generatedAt: "2026-07-04T00:00:00Z",
    result: {
      b: 2,
      a: 1
    }
  });

  assert.equal(
    normalizeText(input, {
      trimWhitespace: true,
      json: {
        sortKeys: true,
        ignoreFields: ["generatedAt"]
      }
    }),
    "{\"result\":{\"a\":1,\"b\":2}}"
  );
});
