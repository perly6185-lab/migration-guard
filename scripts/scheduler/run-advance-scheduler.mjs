#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const options = parseArgs(process.argv.slice(2));
const maxCycles = options.once ? 1 : options.maxCycles;
const log = {
  version: 1,
  id: `issue-control-scheduler-run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  createdAt: new Date().toISOString(),
  mode: options.execute ? "execute" : "dry-run",
  maxCycles,
  sleepMs: options.sleepMs,
  cycles: [],
  status: "complete",
  stopReason: "Max cycles reached."
};

let exitCode = 0;
let latestState;

for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
  const statusResult = runCli([
    "issue-control",
    "advance-status",
    ...configArgs(options),
    ...inputArgs(options),
    "--json"
  ]);
  const statusJson = parseJson(statusResult.stdout);
  latestState = statusJson ?? latestState;
  const cycleLog = {
    index: cycle,
    statusExitCode: statusResult.status,
    statusStderr: statusResult.stderr.trim(),
    schedulerExitCode: undefined,
    schedulerStderr: undefined,
    schedulerReport: undefined,
    decision: statusJson?.schedulerDecision,
    actionTaken: "none"
  };
  log.cycles.push(cycleLog);

  if (!statusJson?.schedulerDecision) {
    log.status = "failed";
    log.stopReason = "advance-status did not return a schedulerDecision JSON object.";
    exitCode = statusResult.status || 1;
    break;
  }

  const decision = statusJson.schedulerDecision;
  if (decision.action !== "run-advance-loop" || !decision.canRunUnattended) {
    log.status = decision.exitCode === 0 ? "complete" : "blocked";
    log.stopReason = `Scheduler decision ${decision.action}: ${decision.reason}`;
    exitCode = decision.exitCode ?? statusResult.status ?? 0;
    break;
  }

  const schedulerArgs = [
    "issue-control",
    "advance-scheduler",
    ...configArgs(options),
    ...inputArgs(options),
    "--json"
  ];
  if (options.execute) {
    schedulerArgs.push("--execute");
  }
  const schedulerResult = runCli(schedulerArgs);
  const schedulerReport = parseJson(schedulerResult.stdout);
  cycleLog.schedulerExitCode = schedulerResult.status;
  cycleLog.schedulerStderr = schedulerResult.stderr.trim();
  cycleLog.schedulerReport = schedulerReport;
  cycleLog.actionTaken = options.execute ? "executed-advance-scheduler" : "planned-advance-scheduler";

  if (!schedulerReport) {
    log.status = "failed";
    log.stopReason = "advance-scheduler did not return JSON.";
    exitCode = schedulerResult.status || 1;
    break;
  }
  if (schedulerResult.status !== 0 || schedulerReport.status === "failed" || schedulerReport.status === "blocked") {
    log.status = schedulerReport.status === "blocked" ? "blocked" : "failed";
    log.stopReason = schedulerReport.reason ?? "advance-scheduler failed or blocked.";
    exitCode = schedulerResult.status || 1;
    break;
  }
  if (!options.execute) {
    log.status = "planned";
    log.stopReason = "Dry-run planned the next bounded advance loop. Pass --execute to run it.";
    break;
  }
  if (cycle < maxCycles && options.sleepMs > 0) {
    sleep(options.sleepMs);
  }
}

const paths = writeLog(log, latestState);
console.log(JSON.stringify({ ...log, outputPath: paths.jsonPath, markdownPath: paths.markdownPath }, null, 2));
process.exitCode = exitCode;

function parseArgs(argv) {
  const parsed = {
    config: undefined,
    input: undefined,
    execute: false,
    once: false,
    maxCycles: 1,
    sleepMs: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") {
      parsed.config = argv[++index];
    } else if (token === "--input") {
      parsed.input = argv[++index];
    } else if (token === "--execute") {
      parsed.execute = true;
    } else if (token === "--once") {
      parsed.once = true;
    } else if (token === "--max-cycles") {
      parsed.maxCycles = positiveInteger(argv[++index], "--max-cycles");
    } else if (token === "--sleep-ms") {
      parsed.sleepMs = nonNegativeInteger(argv[++index], "--sleep-ms");
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  return parsed;
}

function configArgs(parsed) {
  return parsed.config ? ["--config", parsed.config] : [];
}

function inputArgs(parsed) {
  return parsed.input ? ["--input", parsed.input] : [];
}

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : "")
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function writeLog(runLog, latestState) {
  const dir = latestState?.outputPath
    ? path.dirname(latestState.outputPath)
    : path.join(repoRoot, ".migration-guard", "scheduler");
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${runLog.id}.json`);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  writeFileSync(jsonPath, JSON.stringify(runLog, null, 2), "utf8");
  writeFileSync(markdownPath, renderMarkdown(runLog), "utf8");
  return { jsonPath, markdownPath };
}

function renderMarkdown(runLog) {
  return [
    `# Issue Control Scheduler Run: ${runLog.id}`,
    "",
    `- Mode: ${runLog.mode}`,
    `- Status: ${runLog.status}`,
    `- Max cycles: ${runLog.maxCycles}`,
    `- Sleep ms: ${runLog.sleepMs}`,
    `- Stop reason: ${runLog.stopReason}`,
    "",
    "## Cycles",
    "",
    "| # | Decision | Action | Status exit | Scheduler exit |",
    "| ---: | --- | --- | ---: | ---: |",
    ...runLog.cycles.map((cycle) => [
      `| ${cycle.index}`,
      cycle.decision?.action ?? "none",
      cycle.actionTaken,
      cycle.statusExitCode,
      `${cycle.schedulerExitCode ?? "none"} |`
    ].join(" | "))
  ].join("\n");
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
