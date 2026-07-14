import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  PILOTS,
  createReleaseRunId,
  describeArtifact,
  getPilotContext,
  parseReleaseRunId,
  pilotResultPath,
  readCoreArtifactPayload,
  releaseRunDir,
  writeJsonAtomic
} from "../release/evidence.mjs";

const workspace = process.cwd();
const releaseRunId = parseReleaseRunId(process.argv.slice(2)) ?? createReleaseRunId();
const runDir = releaseRunDir(workspace, releaseRunId);
const results = [];

for (const pilot of PILOTS) {
  const startedAt = new Date().toISOString();
  const contextBefore = await getPilotContext(workspace, pilot);
  if (!contextBefore.available) {
    const result = {
      version: 1,
      releaseRunId,
      project: pilot.project,
      status: "skipped",
      startedAt,
      finishedAt: new Date().toISOString(),
      reason: contextBefore.reason,
      configHash: contextBefore.configHash,
      env: pilot.env
    };
    await writeJsonAtomic(pilotResultPath(workspace, releaseRunId, pilot.project), result);
    results.push(result);
    console.log(`pilot skipped: ${pilot.project}; ${contextBefore.reason}`);
    continue;
  }

  const artifactRoot = path.join(workspace, ".migration-guard", "pilots", pilot.project);
  const before = {
    scans: await listJson(path.join(artifactRoot, "scan")),
    baselines: await listJson(path.join(artifactRoot, "baselines")),
    runs: await listJson(path.join(artifactRoot, "runs")),
    compares: await listJson(path.join(artifactRoot, "compare"))
  };
  const config = path.join("pilots", `${pilot.project}.migration-guard.json`);
  const steps = [];
  for (const command of [
    ["scan", "--config", config, "--json"],
    ["baseline", "--config", config],
    ["verify", "--config", config]
  ]) {
    const step = await runCli(command);
    steps.push(step);
    if (step.status === "failed" && command[0] !== "verify") break;
  }

  const after = {
    scans: await listJson(path.join(artifactRoot, "scan")),
    baselines: await listJson(path.join(artifactRoot, "baselines")),
    runs: await listJson(path.join(artifactRoot, "runs")),
    compares: await listJson(path.join(artifactRoot, "compare"))
  };
  const newFiles = {
    scan: addedFile(before.scans, after.scans),
    baseline: addedFile(before.baselines, after.baselines),
    run: addedFile(before.runs, after.runs),
    compare: addedFile(before.compares, after.compares)
  };
  const artifacts = {};
  for (const [kind, filePath] of Object.entries(newFiles)) {
    if (filePath) artifacts[kind] = await describeArtifact(filePath, workspace);
  }
  const compare = newFiles.compare ? await readCoreArtifactPayload(newFiles.compare, "compare") : undefined;
  const baseline = newFiles.baseline ? await readCoreArtifactPayload(newFiles.baseline, "snapshot") : undefined;
  const run = newFiles.run ? await readCoreArtifactPayload(newFiles.run, "snapshot") : undefined;
  const contextAfter = await getPilotContext(workspace, pilot);
  const missingArtifacts = ["scan", "baseline", "run", "compare"].filter((kind) => !artifacts[kind]);
  const failedStep = steps.find((step) => step.status === "failed");
  const status = !failedStep && missingArtifacts.length === 0 && compare?.passed === true
    && compare.baselineId === baseline?.id && compare.currentId === run?.id ? "passed" : "failed";
  const result = {
    version: 1,
    releaseRunId,
    project: pilot.project,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    configHash: contextBefore.configHash,
    rootFingerprintBefore: contextBefore.fingerprint,
    rootFingerprintAfter: contextAfter.fingerprint,
    root: contextBefore.root,
    steps,
    artifacts,
    metrics: compare ? {
      baselineDurationMs: sumDuration(baseline),
      verifyDurationMs: sumDuration(run),
      differences: compare.differences?.length ?? 0,
      inheritedFailures: compare.checkHealth?.inheritedFailure ?? 0,
      regressions: compare.checkHealth?.regression ?? 0,
      changedFailures: compare.checkHealth?.changedFailure ?? 0
    } : undefined,
    reason: failedStep?.error ?? (missingArtifacts.length > 0 ? `missing current-run artifacts: ${missingArtifacts.join(", ")}` : compare?.passed === false ? "compare failed" : undefined)
  };
  await writeJsonAtomic(pilotResultPath(workspace, releaseRunId, pilot.project), result);
  results.push(result);
  console.log(`pilot ${status}: ${pilot.project}`);
}

const summary = {
  version: 1,
  releaseRunId,
  createdAt: new Date().toISOString(),
  results: await Promise.all(results.map(async ({ project, status, reason }) => ({
    project,
    status,
    reason,
    evidence: await describeArtifact(pilotResultPath(workspace, releaseRunId, project), workspace)
  }))),
  executed: results.filter((result) => result.status !== "skipped").length,
  skipped: results.filter((result) => result.status === "skipped").length
};
await writeJsonAtomic(path.join(runDir, "pilot-smoke.json"), summary);
console.log(`pilot smoke complete: ${summary.executed} executed, ${summary.skipped} skipped; release run ${releaseRunId}`);

function runCli(args) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: workspace, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => resolve({ command: args, status: "failed", exitCode: 1, durationMs: Date.now() - started, error: error.message }));
    child.on("close", (code) => resolve({
      command: args,
      status: code === 0 ? "passed" : "failed",
      exitCode: Number(code ?? 1),
      durationMs: Date.now() - started,
      ...(code === 0 ? {} : { error: `${args.join(" ")} failed with ${code}` })
    }));
  });
}

async function listJson(folder) {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith(".json")).map((name) => path.join(folder, name)).sort();
  } catch {
    return [];
  }
}

function addedFile(before, after) {
  const previous = new Set(before);
  return after.filter((filePath) => !previous.has(filePath)).at(-1);
}

function sumDuration(snapshot) {
  return [...(snapshot?.checks ?? []), ...(snapshot?.probes ?? [])].reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
}
