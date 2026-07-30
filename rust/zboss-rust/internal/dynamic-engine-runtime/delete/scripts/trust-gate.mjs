import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const caseRoot = path.join(repositoryRoot, "cases", "zboss-batch-delete");
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-delete-rust");
const reportPath = path.join(artifactRoot, "trust-gate.json");
const acceptancePath = path.join(artifactRoot, "l4a-project-acceptance.md");

const { assessMigrationCapability } = await importDist("migrationCapability.js");
const { inspectRustProductionPath } = await importDist(
  "productionPathAttestation.js",
);

const profile = await readJson(path.join(caseRoot, "profile.json"));
const analysis = await readJson(
  path.join(caseRoot, "evidence", "analysis", "index.json"),
);
const riskCases = await readJson(
  path.join(caseRoot, "fixtures", "offline-contract", "batch-delete-risk-cases.json"),
);
const l3 = await readJson(path.join(artifactRoot, "l3-gate.json"));
const container = await readJson(
  path.join(artifactRoot, "container-adapter-gate.json"),
);
const productionPath = await inspectRustProductionPath(
  engineRoot,
  profile.target.productionPath,
);

const integrityChecks = [
  {
    id: "analysis-ready",
    pass:
      analysis.status === "ready"
      && analysis.entries?.every(
        (entry) => entry.status === "ready" && entry.findings.length === 0,
      ),
  },
  {
    id: "l3-gate-valid",
    pass:
      l3.status === "pass"
      && l3.decision === "L3-OFFLINE-ACCEPTED"
      && validReportHash(l3),
  },
  {
    id: "container-gate-valid",
    pass:
      container.status === "pass"
      && container.decision === "L4-A-PROTOCOL-READY"
      && validReportHash(container),
  },
  {
    id: "source-snapshot-parity",
    pass:
      l3.sourceSnapshot?.treeHash === container.sourceSnapshot?.treeHash
      && l3.sourceSnapshot?.identity === container.sourceSnapshot?.identity,
  },
  {
    id: "scenario-contract",
    pass:
      riskCases.cases?.length === 10
      && new Set(riskCases.cases.map((entry) => entry.id)).size === 10,
  },
  {
    id: "concrete-protocol-adapters",
    pass:
      productionPath.concreteAdapters
      && productionPath.evidence?.traitImplementations?.BatchDeleteStore
      && productionPath.evidence?.traitImplementations?.ProgressSink
      && productionPath.evidence?.traitImplementations?.CompensationOutbox,
  },
];

const capability = assessMigrationCapability({
  sourceReadOnlyGuardPassed: integrityChecks[3].pass,
  analysisComplete: integrityChecks[0].pass,
  offlineContractPassed: integrityChecks[1].pass,
  implementationChecksPassed:
    l3.metrics?.rustTestsPassed >= 18
    && l3.metrics?.unclassifiedDifferences === 0,
  scenarioContractPassed: integrityChecks[4].pass,
  dependencyProtocolChecksPassed: integrityChecks[2].pass,
  concreteAdaptersAttested: productionPath.concreteAdapters,
  deployableServiceAttested: productionPath.deployableService,
  realEvidencePassed: false,
  dualReplayPassed: false,
  unifiedRealGatePassed: false,
});

const pass =
  integrityChecks.every((check) => check.pass)
  && capability.achieved === "L4-A"
  && capability.next === "L4-B";
const payload = {
  schemaVersion: 1,
  stage: "batch-delete-project-trust",
  status: pass ? "pass" : "blocked",
  decision: capability.achieved,
  capability,
  productionPath,
  evidence: {
    analysisProjectHash: analysis.projectHash,
    l3ReportHash: l3.reportHash,
    containerReportHash: container.reportHash,
    sourceTreeHash: container.sourceSnapshot?.treeHash,
    rustTestsPassed: l3.metrics?.rustTestsPassed,
    replayCasesPassed: l3.metrics?.dualReplayCasesPassed,
    containerChecksPassed: container.metrics?.checksPassed,
  },
  boundary: {
    realBusinessRequestExecuted: false,
    productionEligible: false,
    next: [
      "Implement concrete MySQL and Redis network executors behind the attested protocol wrappers.",
      "Add an HTTP runtime and bind the batchDelete route.",
      "Run an approved disposable real-write replay with marker-bound cleanup.",
    ],
  },
  checks: integrityChecks,
};
const report = { ...payload, reportHash: stableHash(payload) };
await mkdir(artifactRoot, { recursive: true });
await writeJson(reportPath, report);
await writeFile(acceptancePath, renderAcceptance(report), "utf8");
console.log(JSON.stringify({
  status: report.status,
  decision: report.decision,
  next: report.capability.next,
  concreteAdapters: report.productionPath.concreteAdapters,
  deployableService: report.productionPath.deployableService,
  reportPath,
}, null, 2));
if (!pass) process.exitCode = 1;

function validReportHash(report) {
  const { reportHash, ...payload } = report;
  return reportHash === stableHash(payload);
}

function renderAcceptance(report) {
  return [
    "# `batchDelete` L4-A 项目验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "BLOCKED"}`,
    "",
    `Decision: ${report.decision}`,
    `Next: ${report.capability.next}`,
    `Rust tests: ${report.evidence.rustTestsPassed}`,
    `Offline replay: ${report.evidence.replayCasesPassed}/8`,
    `Container checks: ${report.evidence.containerChecksPassed}`,
    `Concrete protocol adapters: ${report.productionPath.concreteAdapters}`,
    `Deployable HTTP service: ${report.productionPath.deployableService}`,
    `Real business request executed: ${report.boundary.realBusinessRequestExecuted}`,
    "",
    `Reference tree hash: \`${report.evidence.sourceTreeHash}\``,
    "",
  ].join("\n");
}

async function importDist(file) {
  return import(
    pathToFileURL(path.join(repositoryRoot, "dist", "core", file)).href
  );
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
