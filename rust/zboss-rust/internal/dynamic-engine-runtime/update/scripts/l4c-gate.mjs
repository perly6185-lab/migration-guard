import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  stableHash,
  validateReplayReport,
} from "./l4c-replay-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(
  serviceRoot,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const caseRoot = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
);
const args = parseArguments(process.argv.slice(2));
const evidencePath = path.resolve(
  args.evidence ?? path.join(artifactRoot, "l4c-real-replay.json"),
);
const reviewPath = path.resolve(
  args.review
    ?? path.join(caseRoot, "evidence", "runtime", "l4c", "review.json"),
);
const outputPath = path.join(artifactRoot, "l4c-gate.json");
const acceptancePath = path.join(artifactRoot, "l4c-acceptance.md");
const contract = await readJson(
  path.join(caseRoot, "evidence", "runtime", "java", "runtime-contract.json"),
);
const evidence = await optionalJson(evidencePath);
const review = await optionalJson(reviewPath);
const findings = evidence
  ? validateReplayReport(evidence, contract, review)
  : ["MG-L4C-REPORT-MISSING"];
const priorReports = await validatePriorReports();
findings.push(...priorReports.findings);

let capability;
try {
  const { assessMigrationCapability } = await importDist(
    "migrationCapability.js",
  );
  capability = assessMigrationCapability({
    sourceReadOnlyGuardPassed: priorReports.valid,
    analysisComplete: priorReports.valid,
    offlineContractPassed: priorReports.valid,
    implementationChecksPassed: priorReports.valid,
    scenarioContractPassed: priorReports.valid,
    dependencyProtocolChecksPassed: priorReports.valid,
    concreteAdaptersAttested: priorReports.valid,
    deployableServiceAttested: priorReports.valid,
    realEvidencePassed: findings.length === 0,
    dualReplayPassed: findings.length === 0,
    unifiedRealGatePassed: false,
  });
} catch (error) {
  findings.push(
    `MG-L4C-CAPABILITY-MODULE:${error instanceof Error
      ? error.message
      : String(error)}`,
  );
}

if (
  findings.length === 0
  && (capability?.achieved !== "L4-C" || capability?.next !== "L4")
) {
  findings.push("MG-L4C-CAPABILITY-ASSESSMENT-MISMATCH");
}
const status = findings.length === 0 ? "pass" : "blocked";
const payload = {
  schemaVersion: 1,
  stage: "batch-update-l4c-real-dual-replay-gate",
  status,
  decision: status === "pass" ? "L4-C" : "KEEP-L4-B",
  capability,
  projectId: contract.projectId,
  projectHash: contract.projectHash,
  executedAt: evidence?.executedAt,
  review: review
    ? {
        identity: review.identity,
        decision: review.decision,
        reviewedAt: review.reviewedAt,
        evidenceReportHash: review.evidenceReportHash,
      }
    : undefined,
  controls: {
    "real.runtime-evidence": status === "pass",
    "real.dual-replay": status === "pass",
    "real.disposable-write-scope": status === "pass",
    "real.cleanup-verification": status === "pass",
  },
  evidence: {
    replayPath: relative(evidencePath),
    replayReportHash: evidence?.reportHash,
    reviewPath: relative(reviewPath),
    l3ReportHash: priorReports.l3?.reportHash,
    dependencyReportHash: priorReports.dependency?.reportHash,
    productionReportHash: priorReports.production?.reportHash,
    scenarioCount: evidence?.scenarioCount ?? 0,
    cleanupVerified: evidence?.cleanupVerified === true,
    dualReplayPassed: evidence?.dualReplayPassed === true,
  },
  findings: [...new Set(findings)].sort(),
};
const report = { ...payload, reportHash: stableHash(payload) };
await mkdir(artifactRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(
  acceptancePath,
  renderAcceptance(report, evidencePath, reviewPath),
  "utf8",
);
console.log(JSON.stringify({
  status: report.status,
  decision: report.decision,
  scenarioCount: report.evidence.scenarioCount,
  findings: report.findings,
  outputPath,
}, null, 2));
if (status !== "pass") process.exitCode = 1;

async function validatePriorReports() {
  const result = {
    findings: [],
    l3: await optionalJson(path.join(artifactRoot, "l3-gate.json")),
    dependency: await optionalJson(
      path.join(artifactRoot, "container-adapter-gate.json"),
    ),
    production: await optionalJson(path.join(artifactRoot, "l4b-gate.json")),
  };
  for (const [name, report] of Object.entries({
    l3: result.l3,
    dependency: result.dependency,
    production: result.production,
  })) {
    if (!report) {
      result.findings.push(`MG-L4C-PRIOR-REPORT-MISSING:${name}`);
      continue;
    }
    if (report.status !== "pass") {
      result.findings.push(`MG-L4C-PRIOR-REPORT-BLOCKED:${name}`);
    }
    if (
      !report.reportHash
      || report.reportHash !== stableHash({ ...report, reportHash: undefined })
    ) {
      result.findings.push(`MG-L4C-PRIOR-REPORT-HASH-MISMATCH:${name}`);
    }
    const reportPath = name === "l3"
      ? path.join(artifactRoot, "l3-gate.json")
      : name === "dependency"
        ? path.join(artifactRoot, "container-adapter-gate.json")
        : path.join(artifactRoot, "l4b-gate.json");
    try {
      const ageMs = Date.now() - (await stat(reportPath)).mtimeMs;
      if (ageMs < -300_000 || ageMs > 72 * 3_600_000) {
        result.findings.push(`MG-L4C-PRIOR-REPORT-STALE:${name}`);
      }
    } catch {
      result.findings.push(`MG-L4C-PRIOR-REPORT-STAT-MISSING:${name}`);
    }
  }
  result.valid = result.findings.length === 0;
  return result;
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--evidence") result.evidence = required(values, ++index, value);
    else if (value === "--review") result.review = required(values, ++index, value);
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function required(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function optionalJson(file) {
  try {
    return await readJson(file);
  } catch {
    return undefined;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function importDist(file) {
  return import(
    pathToFileURL(path.join(repositoryRoot, "dist", "core", file)).href
  );
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function renderAcceptance(report, evidencePathValue, reviewPathValue) {
  return `# Batch update L4-C acceptance

Status: ${report.status}
Decision: ${report.decision}
Scenarios: ${report.evidence.scenarioCount}
Cleanup verified: ${report.evidence.cleanupVerified}
Dual replay passed: ${report.evidence.dualReplayPassed}
Evidence: ${relative(evidencePathValue)}
Review: ${relative(reviewPathValue)}

Findings:
${report.findings.length > 0
  ? report.findings.map((finding) => `- ${finding}`).join("\n")
  : "- none"}
`;
}
