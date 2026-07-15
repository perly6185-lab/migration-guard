import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { classifyTestFile, discoverTestFiles } from "./test-discovery.mjs";

const workspace = process.cwd();
const manifest = JSON.parse(await readFile(new URL("./test-manifest.json", import.meta.url), "utf8"));
const testFiles = await discoverTestFiles(workspace);
if (testFiles.length < manifest.minimumTestFiles) {
  throw new Error(`Test discovery found ${testFiles.length} files; expected at least ${manifest.minimumTestFiles}. Check the build and test globs.`);
}
const layerCounts = testFiles.reduce((counts, file) => {
  const layer = classifyTestFile(file);
  counts[layer] = (counts[layer] ?? 0) + 1;
  return counts;
}, {});
const startedAt = performance.now();
const child = spawn(process.execPath, ["--test", ...testFiles], { cwd: process.cwd(), windowsHide: true });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { const text = chunk.toString(); stdout += text; process.stdout.write(text); });
child.stderr.on("data", (chunk) => { const text = chunk.toString(); stderr += text; process.stderr.write(text); });
const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
const durationMs = performance.now() - startedAt;
const slowTests = parseTapDurations(stdout).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
const testCount = parseTapTestCount(stdout);
if (Number(exitCode ?? 1) === 0 && testCount < manifest.minimumTests) {
  stderr += `\nTest count ${testCount} is below the required minimum ${manifest.minimumTests}.\n`;
  process.stderr.write(stderr.slice(stderr.lastIndexOf("\nTest count")));
}
const effectiveExitCode = Number(exitCode ?? 1) === 0 && testCount >= manifest.minimumTests ? 0 : 1;
const summary = [
  "## Migration Guard test summary",
  "",
  `- Total test command duration: ${(durationMs / 1000).toFixed(2)}s`,
  `- Test files: ${testFiles.length}`,
  `- Tests: ${testCount}`,
  `- Layers: unit ${layerCounts.unit ?? 0}, integration ${layerCounts.integration ?? 0}`,
  `- Exit code: ${effectiveExitCode}`,
  "",
  "### Slowest tests",
  "",
  "| Test | Duration |",
  "| --- | ---: |",
  ...slowTests.map((test) => `| ${escapeTable(test.name)} | ${test.durationMs.toFixed(1)} ms |`),
  ""
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
if (process.env.MG_TEST_SUMMARY === "1") process.stdout.write(`\n${summary}\n`);
process.exitCode = effectiveExitCode;

function parseTapDurations(output) {
  const lines = output.split(/\r?\n/);
  const stack = [];
  const results = [];
  for (const line of lines) {
    const subtest = line.match(/^# Subtest: (.+)$/);
    if (subtest) { stack.push(subtest[1]); continue; }
    const duration = line.match(/^\s*duration_ms:\s*([\d.]+)/);
    if (duration && stack.length > 0) results.push({ name: stack.shift(), durationMs: Number(duration[1]) });
  }
  return results;
}

function escapeTable(value) { return value.replace(/\|/g, "\\|"); }

function parseTapTestCount(output) {
  const matches = [...output.matchAll(/^# tests (\d+)$/gm)];
  return Number(matches.at(-1)?.[1] ?? 0);
}
