import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(
  serviceRoot,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const caseDir = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const artifactDirectory = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
);
const reportPath = path.join(artifactDirectory, "trust-gate.json");

const { assessMigrationCapability } = await importDist("migrationCapability.js");
const { scanArtifactFiles } = await importDist("artifactSecurity.js");
const { inspectMigrationGateFreshness } = await importDist("migrationWorkflow.js");
const { loadMigrationProject } = await importDist("migrationProject.js");
const { inspectRustProductionPath } = await importDist("productionPathAttestation.js");

const pkg = await loadMigrationProject(caseDir);
const l3 = await readJson(path.join(artifactDirectory, "l3-gate.json"));
const container = await readJson(
  path.join(artifactDirectory, "container-adapter-gate.json"),
);
const offlineFreshness = await inspectMigrationGateFreshness(caseDir, "offline");
const realFreshness = await inspectMigrationGateFreshness(caseDir, "real");
const productionPath = await inspectRustProductionPath(
  engineRoot,
  pkg.profile.target.productionPath ?? {
    requiredTraits: [],
    requiredRouteFragments: pkg.profile.entrypoints
      .map((entrypoint) => entrypoint.path)
      .filter(Boolean),
  },
);
const securityFindings = await scanArtifactFiles([
  artifactDirectory,
  path.join(caseDir, "evidence"),
  path.join(caseDir, "fixtures"),
]);
const scenarioCount = Number(l3?.evidence?.scenarioCount ?? 0);
const realGate = await readJson(
  path.join(caseDir, "evidence", "gates", "real-gate.json"),
);
const capability = assessMigrationCapability({
  sourceReadOnlyGuardPassed:
    checkPassed(l3, "reference-source-unchanged"),
  analysisComplete:
    checkPassed(l3, "deep-static-analysis"),
  offlineContractPassed:
    l3?.evidence?.offlineGate === "passed"
      && offlineFreshness.length === 0,
  implementationChecksPassed:
    l3?.status === "pass"
      && checkPassed(l3, "rust-tests")
      && checkPassed(l3, "rust-clippy"),
  scenarioContractPassed:
    scenarioCount === 19
      && checkPassed(l3, "scenario-contract-match"),
  dependencyProtocolChecksPassed:
    container?.status === "pass"
      && container?.decision === "L4-A-PROTOCOL-READY",
  concreteAdaptersAttested: productionPath.concreteAdapters,
  deployableServiceAttested: productionPath.deployableService,
  realEvidencePassed:
    realGate?.status === "passed"
      && realFreshness.length === 0,
  dualReplayPassed: false,
  unifiedRealGatePassed:
    realGate?.status === "passed"
      && realFreshness.length === 0,
});

const integrityFindings = [
  ...offlineFreshness.map((finding) => `offline:${finding}`),
  ...securityFindings.map((finding) =>
    `security:${relative(finding.file)}:${finding.rule}:${finding.location}`),
];
const report = {
  schemaVersion: 1,
  stage: "batch-update-project-trust",
  status: integrityFindings.length === 0 ? "pass" : "blocked",
  decision: capability.achieved,
  capability,
  productionPath,
  gateFreshness: {
    offline: offlineFreshness,
    real: realFreshness,
    note: "A blocked or stale real gate prevents L4-C/L4 but does not invalidate a truthful lower-level claim.",
  },
  artifactSecurity: {
    scannedRoots: [
      relative(artifactDirectory),
      relative(path.join(caseDir, "evidence")),
      relative(path.join(caseDir, "fixtures")),
    ],
    findingCount: securityFindings.length,
    findings: securityFindings.map((finding) => ({
      ...finding,
      file: relative(finding.file),
    })),
  },
  integrityFindings,
};

await mkdir(artifactDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: report.status,
  decision: report.decision,
  securityFindings: securityFindings.length,
  offlineFreshnessFindings: offlineFreshness.length,
  realFreshnessFindings: realFreshness.length,
  productionEligible: productionPath.productionEligible,
  reportPath,
}, null, 2));
if (report.status !== "pass") process.exitCode = 1;

async function importDist(file) {
  return import(pathToFileURL(path.join(repositoryRoot, "dist", "core", file)).href);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function checkPassed(reportValue, id) {
  return reportValue?.checks?.some((check) => check.id === id && check.pass === true)
    ?? false;
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}
