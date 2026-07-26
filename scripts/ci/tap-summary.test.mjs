import test from "node:test";
import assert from "node:assert/strict";
import { parseTapDurations, parseTapTestCount } from "./tap-summary.mjs";

test("TAP test count supports Node 20 through 22 summary output", () => {
  assert.equal(parseTapTestCount("# tests 318\n# pass 318\n"), 318);
});

test("TAP test count supports Node 24 through 26 summary output", () => {
  assert.equal(parseTapTestCount("ℹ tests 318\nℹ pass 318\n"), 318);
});

test("TAP test count uses the final summary and fails closed when absent", () => {
  assert.equal(parseTapTestCount("# tests 2\nℹ tests 4\n"), 4);
  assert.equal(parseTapTestCount("all tests passed\n"), 0);
});

test("TAP durations support compact Node 24 through 26 output", () => {
  assert.deepEqual(
    parseTapDurations("✔ fast test (0.25ms)\n✖ failed test (12.5ms)\n"),
    [
      { name: "fast test", durationMs: 0.25 },
      { name: "failed test", durationMs: 12.5 }
    ]
  );
});

test("TAP durations support YAML diagnostics from Node 20 through 22", () => {
  assert.deepEqual(
    parseTapDurations("# Subtest: legacy test\nok 1 - legacy test\n  ---\n  duration_ms: 4.75\n  ...\n"),
    [{ name: "legacy test", durationMs: 4.75 }]
  );
});
