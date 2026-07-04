import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCheckOutput } from "./checkNormalize.js";

test("normalizeCheckOutput removes common Vitest and path noise", () => {
  const output = [
    "Test Files  1 passed (1)",
    "Tests  2 passed (2)",
    "Start at 10:15:30",
    "Duration 1.23s",
    "close timed out after 1000ms",
    "You can try to identify the cause by enabling \"hanging-process\" reporter. See https://vitest.dev/guide/reporters#hanging-process-reporter",
    "D:\\repo\\apps\\web\\src\\main.ts"
  ].join("\n");

  assert.equal(
    normalizeCheckOutput(output, {
      trimWhitespace: true,
      presets: ["vitest", "paths", "timing"]
    }),
    [
      "Test Files <normalized>",
      "Tests <normalized>",
      "Start at <time>",
      "Duration <normalized>",
      "<path>"
    ].join("\n")
  );
});

test("normalizeCheckOutput removes Vite timing warnings", () => {
  const output = [
    "[PLUGIN_TIMINGS] Your build spent significant time in plugin unplugin-vue-components.",
    "dist/assets/index-AbCd1234.js  12.34 kB | gzip: 4.56 kB",
    "built in 2.42s"
  ].join("\n");

  assert.equal(
    normalizeCheckOutput(output, {
      trimWhitespace: true,
      presets: ["vite", "timing"]
    }),
    [
      "dist/assets/<asset>.js <size>",
      "built in <duration>"
    ].join("\n")
  );
});
