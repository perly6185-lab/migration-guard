import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const testFiles = 
["dist/core/normalize.test.js","dist/core/configDoctor.test.js","dist/core/healthDebt.test.js","dist/core/artifactV2.test.js","dist/core/scan.test.js","dist/core/checkNormalize.test.js","dist/core/config.test.js","dist/core/compare.test.js","dist/core/diffDecision.test.js","dist/core/files.test.js","dist/core/checkpoint.test.js","dist/core/bootstrap.test.js","dist/core/dashboard.test.js","dist/core/uiServer.test.js","dist/core/uiJobStore.test.js","dist/core/issueControl.test.js","dist/core/patch.test.js","dist/core/refactorReadiness.test.js","dist/core/oneShot.test.js","dist/core/repairLoopCli.test.js","dist/core/repairStrategy.test.js","dist/core/taskGraph.test.js"]
;
const startedAt = performance.now();
const child = spawn(process.execPath, ["--test", ...testFiles], { cwd: process.cwd(), windowsHide: true });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { const text = chunk.toString(); stdout += text; process.stdout.write(text); });
child.stderr.on("data", (chunk) => { const text = chunk.toString(); stderr += text; process.stderr.write(text); });
const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
const durationMs = performance.now() - startedAt;
const slowTests = parseTapDurations(stdout).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
const summary = [
  "## Migration Guard test summary",
  "",
  `- Total test command duration: ${(durationMs / 1000).toFixed(2)}s`,
  `- Test files: ${testFiles.length}`,
  `- Exit code: ${exitCode}`,
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
process.exitCode = Number(exitCode ?? 1);

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
