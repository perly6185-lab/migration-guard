import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { classifyTestFile, discoverTestFiles } from "./test-discovery.mjs";
import {
  planTestShards,
  resolveTestExecutionOptions
} from "./test-orchestration.mjs";
import { parseTapDurations, parseTapTestCount } from "./tap-summary.mjs";

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
const executionOptions = resolveTestExecutionOptions();
const shards = planTestShards(testFiles, classifyTestFile, executionOptions);
const startedAt = performance.now();
const shardResults = [];
let currentChild;
let interrupted = false;
const interrupt = async () => {
  if (interrupted) return;
  interrupted = true;
  if (currentChild) await terminateProcessTree(currentChild);
  process.exitCode = 130;
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
for (const [index, shard] of shards.entries()) {
  if (interrupted) break;
  process.stdout.write(
    `\n[tests] shard ${index + 1}/${shards.length} ${shard.id} `
    + `files=${shard.files.length} concurrency=${shard.concurrency} timeoutMs=${shard.timeoutMs}\n`
  );
  process.stdout.write(`[tests] files: ${shard.files.join(", ")}\n`);
  const result = await runShard(shard, executionOptions.testTimeoutMs, (child) => {
    currentChild = child;
  });
  currentChild = undefined;
  shardResults.push(result);
  if (result.timedOut || result.exitCode !== 0 || result.testCount === 0) break;
}
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);
const durationMs = performance.now() - startedAt;
const slowTests = shardResults
  .flatMap((result) => parseTapDurations(result.stdout))
  .sort((a, b) => b.durationMs - a.durationMs)
  .slice(0, 10);
const testCount = shardResults.reduce((count, result) => count + result.testCount, 0);
const failedShard = shardResults.find(
  (result) => result.timedOut || result.exitCode !== 0 || result.testCount === 0
);
if (!failedShard && shardResults.length === shards.length && testCount < manifest.minimumTests) {
  process.stderr.write(`\nTest count ${testCount} is below the required minimum ${manifest.minimumTests}.\n`);
}
const effectiveExitCode = !interrupted
  && !failedShard
  && shardResults.length === shards.length
  && testCount >= manifest.minimumTests
  ? 0
  : 1;
const summary = [
  "## Migration Guard test summary",
  "",
  `- Total test command duration: ${(durationMs / 1000).toFixed(2)}s`,
  `- Test files: ${testFiles.length}`,
  `- Tests: ${testCount}`,
  `- Shards: ${shardResults.length}/${shards.length}`,
  `- Layers: unit ${layerCounts.unit ?? 0}, integration ${layerCounts.integration ?? 0}`,
  `- Unit concurrency: ${executionOptions.unitConcurrency}`,
  `- Exit code: ${effectiveExitCode}`,
  ...(failedShard ? [
    `- Failed shard: ${failedShard.id}`,
    `- Failed shard timed out: ${failedShard.timedOut}`,
    `- Failed shard files: ${failedShard.files.join(", ")}`
  ] : []),
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

function escapeTable(value) { return value.replace(/\|/g, "\\|"); }

async function runShard(shard, testTimeoutMs, onChild) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [
    "--test",
    `--test-concurrency=${shard.concurrency}`,
    `--test-timeout=${testTimeoutMs}`,
    ...shard.files
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    detached: process.platform !== "win32"
  });
  onChild(child);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });
  const timer = setTimeout(async () => {
    timedOut = true;
    process.stderr.write(
      `\n[tests] ${shard.id} exceeded ${shard.timeoutMs}ms; terminating its process tree.\n`
    );
    await terminateProcessTree(child);
  }, shard.timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));
  return {
    ...shard,
    exitCode: Number(exitCode ?? 1),
    timedOut,
    stdout,
    stderr,
    testCount: parseTapTestCount(stdout),
    durationMs: performance.now() - startedAt
  };
}

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
