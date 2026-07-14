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

test("normalizeCheckOutput removes Webpack, Jest, and pnpm run noise", () => {
  const output = [
    "Scope: 3 of 4 workspace projects",
    "D:\\repo\\packages\\shared: build complete",
    "asset extension.js 27.2 KiB [emitted]",
    "webpack 5.103.0 compiled successfully in 3818 ms",
    "Time: 4.221 s, estimated 5 s",
    "Ran all test suites matching /test/i."
  ].join("\n");

  assert.equal(
    normalizeCheckOutput(output, { presets: ["pnpm", "webpack", "jest"] }),
    [
      "Scope: <workspace>",
      "<workspace>/shared: build complete",
      "asset extension.js <size> [emitted]",
      "webpack <version> compiled successfully in <duration>",
      "Time: <duration>",
      "Ran all test suites <normalized>"
    ].join("\n")
  );
});

test("normalizeCheckOutput treats Go cached and timed package results equally", () => {
  assert.equal(normalizeCheckOutput("ok  \taiway/internal/account\t(cached)", { presets: ["go"] }), "ok  \taiway/internal/account\t<duration>");
  assert.equal(normalizeCheckOutput("ok  \taiway/internal/account\t1.234s", { presets: ["go"] }), "ok  \taiway/internal/account\t<duration>");
});

test("normalizeCheckOutput sorts Go diagnostic package blocks", () => {
  const first = [
    "# aiway/cmd/ip_limit_test",
    "# [aiway/cmd/ip_limit_test]",
    "cmd\\ip_limit_test\\main.go:106:2: fmt.Println arg list ends with redundant newline",
    "# aiway/scripts",
    "# [aiway/scripts]",
    "vet.exe: scripts\\insert_test_data.go:11:6: main redeclared in this block",
    "# aiway",
    "# [aiway]",
    ".\\test_proxy_fields.go:20:2: fmt.Println arg list ends with redundant newline",
    "# aiway/internal/middleware",
    "# [aiway/internal/middleware]",
    "vet.exe: internal\\middleware\\binding_auth_test.go:18:18: undefined: db.NewRepository"
  ].join("\n");
  const second = [
    "# aiway/scripts",
    "# [aiway/scripts]",
    "vet.exe: scripts\\insert_test_data.go:11:6: main redeclared in this block",
    "# aiway",
    "# [aiway]",
    ".\\test_proxy_fields.go:20:2: fmt.Println arg list ends with redundant newline",
    "# aiway/cmd/ip_limit_test",
    "# [aiway/cmd/ip_limit_test]",
    "cmd\\ip_limit_test\\main.go:106:2: fmt.Println arg list ends with redundant newline",
    "# aiway/internal/middleware",
    "# [aiway/internal/middleware]",
    "vet.exe: internal\\middleware\\binding_auth_test.go:18:18: undefined: db.NewRepository"
  ].join("\n");

  assert.equal(
    normalizeCheckOutput(first, { presets: ["go", "paths", "timing"] }),
    normalizeCheckOutput(second, { presets: ["go", "paths", "timing"] })
  );
});
