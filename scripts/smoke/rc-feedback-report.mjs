import path from "node:path";
import {
  PILOTS,
  getPilotContext,
  parseReleaseRunId,
  readCoreArtifactPayload,
  readJson,
  releaseRunDir,
  verifyArtifactDescriptor,
  writeJsonAtomic,
  writeTextAtomic
} from "../release/evidence.mjs";

const workspace = process.cwd();
const releaseRunId = parseReleaseRunId(process.argv.slice(2));
if (!releaseRunId) throw new Error("pilot report requires --release-run <id> or MG_RELEASE_RUN_ID; historical pilot artifacts are not accepted");
const smokePath = path.join(releaseRunDir(workspace, releaseRunId), "pilot-smoke.json");
let smoke;
try {
  smoke = await readJson(smokePath);
} catch {
  smoke = { releaseRunId, results: [] };
}

const rows = [];
for (const pilot of PILOTS) rows.push(await evaluatePilot(pilot));

const report = {
  version: 2,
  releaseRunId,
  createdAt: new Date().toISOString(),
  go: rows.length === PILOTS.length && rows.every((row) => row.status === "passed" && row.regressions === 0 && row.changedFailures === 0),
  projects: rows,
  metrics: {
    configuredProjects: PILOTS.length,
    executedProjects: rows.filter((row) => row.status !== "skipped").length,
    passedProjects: rows.filter((row) => row.status === "passed").length,
    totalDifferences: rows.reduce((sum, row) => sum + (row.differences ?? 0), 0)
  }
};
const runDir = releaseRunDir(workspace, releaseRunId);
await writeJsonAtomic(path.join(runDir, "pilot-report.json"), report);
await writeTextAtomic(path.join(runDir, "pilot-report.md"), renderPilotReport(report));
await writeJsonAtomic(path.join(workspace, ".migration-guard", "rc-feedback-report.json"), report);
console.log(JSON.stringify(report, null, 2));
if (!report.go) process.exitCode = 1;

async function evaluatePilot(pilot) {
  const smokeEntry = smoke.releaseRunId === releaseRunId ? smoke.results?.find((entry) => entry.project === pilot.project) : undefined;
  if (!smokeEntry) return { project: pilot.project, status: "skipped", reason: `current release run has no smoke evidence for ${pilot.project}` };
  const resultEvidence = await verifyArtifactDescriptor(smokeEntry.evidence, workspace);
  if (!resultEvidence.valid) return { project: pilot.project, status: "stale", reason: resultEvidence.reason };
  let result;
  try {
    result = await readJson(resultEvidence.filePath);
  } catch {
    return { project: pilot.project, status: "skipped", reason: `current release run has no pilot result for ${pilot.project}` };
  }
  if (result.releaseRunId !== releaseRunId) return { project: pilot.project, status: "stale", reason: "pilot result belongs to a different release run" };
  if (result.status === "skipped") return { project: pilot.project, status: "skipped", reason: result.reason };
  if (result.status !== "passed") return { project: pilot.project, status: "failed", reason: result.reason ?? "pilot execution failed", ...result.metrics };

  const currentContext = await getPilotContext(workspace, pilot);
  if (!currentContext.available) return { project: pilot.project, status: "stale", reason: currentContext.reason };
  if (currentContext.configHash !== result.configHash) return { project: pilot.project, status: "stale", reason: "pilot config hash changed after execution" };
  if (currentContext.fingerprint !== result.rootFingerprintAfter) return { project: pilot.project, status: "stale", reason: "pilot root fingerprint changed after execution" };

  const verified = {};
  for (const kind of ["scan", "baseline", "run", "compare"]) {
    const check = await verifyArtifactDescriptor(result.artifacts?.[kind], workspace);
    if (!check.valid) return { project: pilot.project, status: "stale", reason: check.reason };
    verified[kind] = check.filePath;
  }
  const baseline = await readCoreArtifactPayload(verified.baseline, "snapshot");
  const run = await readCoreArtifactPayload(verified.run, "snapshot");
  const compare = await readCoreArtifactPayload(verified.compare, "compare");
  if (compare.baselineId !== baseline.id || compare.currentId !== run.id) {
    return { project: pilot.project, status: "stale", reason: "compare does not reference current-run baseline and run artifacts" };
  }
  if (!compare.passed) return { project: pilot.project, status: "failed", reason: "current-run compare failed", ...result.metrics };
  return { project: pilot.project, status: "passed", ...result.metrics, evidence: result.artifacts };
}

function renderPilotReport(value) {
  return [
    `# Pilot Report ${value.releaseRunId}`,
    "",
    `- GO: ${value.go}`,
    `- Created: ${value.createdAt}`,
    "",
    "| Project | Status | Differences | Regressions | Changed failures |",
    "| --- | --- | ---: | ---: | ---: |",
    ...value.projects.map((project) => `| ${project.project} | ${project.status} | ${project.differences ?? 0} | ${project.regressions ?? 0} | ${project.changedFailures ?? 0} |`),
    "",
    ...value.projects.filter((project) => project.reason).flatMap((project) => [`- ${project.project}: ${project.reason}`]),
    ""
  ].join("\n");
}
