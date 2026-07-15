import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  PILOTS,
  createReleaseRunId,
  describeArtifact,
  getPilotContext,
  getReleaseContext,
  readJson,
  releaseRunDir,
  renderReleaseEvidence,
  sha256,
  verifyArtifactDescriptor,
  writeJsonAtomic,
  writeTextAtomic
} from "../release/evidence.mjs";

const workspace = process.cwd();
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const releaseRunId = resumeIndex >= 0 ? args[resumeIndex + 1] : createReleaseRunId();
if (!releaseRunId) throw new Error("--resume requires a release run id");

const packageJson = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
assert.match(packageJson.version, /^(?:0\.2\.0(?:-rc\.\d+)?|0\.3\.0-beta\.1)$/, `unexpected release version: ${packageJson.version}`);

const combinedContext = await collectContext();
if ((packageJson.version === "0.2.0" || packageJson.version === "0.3.0-beta.1") && combinedContext.release.git?.dirty) {
  throw new Error(`${packageJson.version} release gate requires a clean Git checkout`);
}
const currentContextHash = sha256(JSON.stringify(combinedContext));
const runDir = releaseRunDir(workspace, releaseRunId);
const manifestPath = path.join(runDir, "release-evidence.json");
const markdownPath = path.join(runDir, "release-evidence.md");
let manifest;

if (resumeIndex >= 0) {
  manifest = await readJson(manifestPath);
  if ((manifest.resumeContextHash ?? manifest.contextHash) !== currentContextHash) {
    throw new Error(`Release context changed; refusing to resume ${releaseRunId}. Start a new release run.`);
  }
  if (manifest.evidence?.pilotSmoke) {
    const verification = await verifyArtifactDescriptor(manifest.evidence.pilotSmoke, workspace);
    if (!verification.valid) throw new Error(`Release evidence changed; refusing to resume ${releaseRunId}: ${verification.reason}`);
  }
  manifest.status = "running";
  manifest.resumedAt = new Date().toISOString();
  delete manifest.error;
} else {
  manifest = {
    version: 1,
    releaseRunId,
    packageVersion: packageJson.version,
    status: "running",
    startedAt: new Date().toISOString(),
    contextHash: currentContextHash,
    context: combinedContext.release,
    pilotContexts: combinedContext.pilots,
    steps: [],
    evidence: {}
  };
}
await persist();

const steps = [
  { id: "test", command: "npm", args: ["test"] },
  { id: "beta-readiness", command: "npm", args: ["run", "beta:readiness"] },
  { id: "ui-smoke", command: "npm", args: ["run", "ui:smoke"] },
  { id: "package-audit", command: "npm", args: ["run", "package:audit"] },
  { id: "package-smoke", command: "npm", args: ["run", "package:smoke"] },
  { id: "package-golden", command: "npm", args: ["run", "package:golden"] },
  { id: "install-smoke", command: "npm", args: ["run", "install:smoke"] },
  { id: "diff-check", command: "git", args: ["diff", "--check"] },
  { id: "pilot-smoke", command: process.execPath, args: ["scripts/smoke/real-project-pilot.mjs", "--release-run", releaseRunId] },
  { id: "pilot-report", command: process.execPath, args: ["scripts/smoke/rc-feedback-report.mjs", "--release-run", releaseRunId], alwaysRun: true },
  { id: "ga-candidate", command: process.execPath, args: ["scripts/release/candidate.mjs"] }
];

try {
  for (const definition of steps) await runGate(definition);
  manifest.evidence.pilotSmoke = await describeArtifact(path.join(runDir, "pilot-smoke.json"), workspace);
  manifest.evidence.pilotReport = await describeArtifact(path.join(runDir, "pilot-report.json"), workspace);
  manifest.evidence.gaCandidate = await describeArtifact(path.join(runDir, "ga-candidate.json"), workspace);
  manifest.evidence.publishHandoff = await describeArtifact(path.join(runDir, "PUBLISH_HANDOFF.md"), workspace);
  const resumeContext = await collectContext();
  manifest.resumeContextHash = sha256(JSON.stringify(resumeContext));
  manifest.resumePilotContexts = resumeContext.pilots;
  manifest.status = "passed";
  manifest.finishedAt = new Date().toISOString();
  await persist();
  console.log(`release gate passed for ${packageJson.version}; release run ${releaseRunId}`);
  console.log(`release evidence: ${path.relative(workspace, manifestPath)}`);
  console.log("publish and tag remain manual reviewed actions");
} catch (error) {
  manifest.status = "failed";
  manifest.finishedAt = new Date().toISOString();
  manifest.error = error.message;
  await persist();
  console.error(`release gate failed; evidence: ${path.relative(workspace, manifestPath)}`);
  throw error;
}

async function runGate(definition) {
  const commandFingerprint = sha256(JSON.stringify({ command: definition.command, args: definition.args, contextHash: manifest.contextHash }));
  const existing = manifest.steps.find((step) => step.id === definition.id);
  if (!definition.alwaysRun && existing?.status === "passed" && existing.commandFingerprint === commandFingerprint) {
    console.log(`release gate resume: ${definition.id} already passed`);
    return;
  }
  const step = existing ?? { id: definition.id };
  step.command = [definition.command, ...definition.args];
  step.commandFingerprint = commandFingerprint;
  step.status = "running";
  step.startedAt = new Date().toISOString();
  delete step.error;
  if (!existing) manifest.steps.push(step);
  await persist();
  const started = Date.now();
  const exitCode = await run(definition.command, definition.args);
  step.durationMs = Date.now() - started;
  step.finishedAt = new Date().toISOString();
  step.exitCode = exitCode;
  step.status = exitCode === 0 ? "passed" : "failed";
  if (exitCode !== 0) step.error = `${definition.command} ${definition.args.join(" ")} failed with ${exitCode}`;
  await persist();
  if (exitCode !== 0) throw new Error(step.error);
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: workspace, stdio: "inherit", shell: process.platform === "win32", windowsHide: true, env: { ...process.env, MG_RELEASE_RUN_ID: releaseRunId } });
    child.on("error", reject);
    child.on("close", (code) => resolve(Number(code ?? 1)));
  });
}

async function persist() {
  await writeJsonAtomic(manifestPath, manifest);
  await writeTextAtomic(markdownPath, `${renderReleaseEvidence(manifest)}\n`);
}

function sanitizePilotContext(context) {
  return {
    project: context.project,
    env: context.env,
    available: context.available,
    reason: context.reason,
    configHash: context.configHash,
    root: context.root,
    fingerprint: context.fingerprint,
    git: context.git,
    manifests: context.manifests
  };
}

async function collectContext() {
  const release = await getReleaseContext(workspace);
  const pilots = await Promise.all(PILOTS.map((pilot) => getPilotContext(workspace, pilot)));
  return { release, pilots: pilots.map(sanitizePilotContext) };
}
