import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactRoot = path.resolve(
  process.env.PRP15_ARTIFACT_ROOT
    ?? path.join(repositoryRoot, "artifacts", "page-rust"),
);
const caseRoot = path.join(repositoryRoot, "cases", "zboss-page");
const analysisRoot = path.join(
  caseRoot,
  "evidence",
  "analysis",
  "post-zboss-data-view-dynamic-engine-use-engine-use-page-page",
);
const stageDefinitions = [
  ["batch2", "page-rust-batch2", "batch2-accepted"],
  ["prp10", "page-rust-prp10", "prp10-accepted"],
  ["prp11", "page-rust-prp11", "prp11-accepted"],
  ["prp12", "page-rust-prp12", "prp12-accepted"],
  ["prp13", "page-rust-prp13", "prp13-accepted"],
  ["prp14", "page-rust-prp14", "prp14-accepted"],
];
const realEvidenceBlockers = [
  "seven redacted real requests",
  "Java reference service and Rust service",
  "two same-origin isolated database snapshots",
  "Redis/database network access and permissions",
  "real token and tenant/user/device/request contexts",
  "real SQL, response, side-effect and lock-trace evidence",
  "final capacity and latency SLO",
];

try {
  const result = await assessOfflineReadiness();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function assessOfflineReadiness() {
  const {
    stableStringify: coreStableStringify,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "normalize.js"),
    ).href
  );
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(
        repositoryRoot,
        "dist",
        "core",
        "referenceSourceGuard.js",
      ),
    ).href
  );

  const reports = {};
  for (const [id, expectedStage, expectedDecision] of stageDefinitions) {
    const report = await readJson(
      path.join(artifactRoot, `${id}-gate.json`),
    );
    verifyGateReportHash(report, id);
    if (
      report.stage !== expectedStage
      || report.status !== "pass"
      || report.decision !== expectedDecision
      || report.checks?.some((check) => !check.pass)
    ) {
      throw new Error(`${id} gate is not an accepted PASS`);
    }
    reports[id] = report;
  }

  const sourceBaseline = await readJson(
    path.join(artifactRoot, "source-baseline.json"),
  );
  const contracts = await readJson(
    path.join(artifactRoot, "contracts.json"),
  );
  const testReport = await readJson(
    path.join(artifactRoot, "test-report.json"),
  );
  const offlineReplay = await readJson(
    path.join(artifactRoot, "offline-replay.json"),
  );
  const evidenceBundle = await readJson(
    path.join(artifactRoot, "evidence-bundle.json"),
  );
  verifySelfHash(sourceBaseline, "manifestHash", "source baseline");
  verifySelfHash(contracts, "artifactHash", "contracts");
  verifySelfHash(testReport, "artifactHash", "test report");
  verifySelfHash(offlineReplay, "reportHash", "offline replay");
  verifySelfHash(evidenceBundle, "bundleHash", "evidence bundle");
  verifyArtifactLinks({
    sourceBaseline,
    contracts,
    testReport,
    offlineReplay,
    evidenceBundle,
  });

  const graph = await readJson(
    path.join(analysisRoot, "behavior-graph.json"),
  );
  const replacementPlan = await readJson(
    path.join(analysisRoot, "endpoint-replacement-plan.json"),
  );
  const javaAnalysis = await readJson(
    path.join(analysisRoot, "java-analysis.json"),
  );
  verifyCoreArtifactHash(
    graph,
    "graphHash",
    "behavior graph",
    coreStableStringify,
  );
  verifyCoreArtifactHash(
    replacementPlan,
    "planHash",
    "endpoint replacement plan",
    coreStableStringify,
  );
  const staticClosure = {
    complete: graph.completeness?.complete === true,
    edgeCapHit: graph.completeness?.edgeCapHit === true,
    depthCapHit: graph.completeness?.depthCapHit === true,
    unresolvedEdges: graph.completeness?.unresolvedEdges ?? -1,
    unexpandedNodes: graph.completeness?.unexpandedNodes?.length ?? -1,
    highRiskUnknownBoundaries:
      graph.classificationCoverage?.highRiskUnknownNodeIds?.length ?? -1,
    lowRiskUnknownNodes:
      graph.classificationCoverage?.unknownNodeIds?.length ?? -1,
    exactEndpointMatches: javaAnalysis.summary?.exactMatchCount ?? -1,
  };
  if (
    !staticClosure.complete
    || staticClosure.edgeCapHit
    || staticClosure.depthCapHit
    || staticClosure.unresolvedEdges !== 0
    || staticClosure.unexpandedNodes !== 0
    || staticClosure.highRiskUnknownBoundaries !== 0
    || staticClosure.exactEndpointMatches !== 1
    || replacementPlan.behaviorGraphHash !== graph.graphHash
  ) {
    throw new Error("Java endpoint static closure is incomplete");
  }

  validateStageMetrics(reports);
  const compatibility = await readJson(
    path.join(
      serviceRoot,
      "contracts",
      "compatibility-decisions.json",
    ),
  );
  if (
    compatibility.defaultPolicy !== "strict-parity"
    || compatibility.unknownDifferencePolicy !== "fail-closed"
    || compatibility.approvedCorrections?.length < 4
  ) {
    throw new Error("compatibility decisions are incomplete");
  }
  const placeholders = await findRustPlaceholders(
    path.join(serviceRoot, "src"),
  );
  if (placeholders.length > 0) {
    throw new Error(
      `Rust source contains forbidden placeholders: ${placeholders.join(", ")}`,
    );
  }

  const profile = await readJson(path.join(caseRoot, "profile.json"));
  const currentSource = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  const recordedSource = {
    identity: {
      identity: sourceBaseline.source.identity,
      revision: sourceBaseline.source.revision,
      dirty: sourceBaseline.source.identity.includes("+dirty:"),
      dirtyFingerprint: sourceBaseline.source.dirtyFingerprint,
    },
    treeHash: sourceBaseline.source.treeHash,
    fileCount: sourceBaseline.source.fileCount,
    directories: sourceBaseline.source.directories,
  };
  if (!referenceSourceSnapshotsEqual(currentSource, recordedSource)) {
    throw new Error("reference source no longer matches evidence baseline");
  }

  return {
    schemaVersion: 1,
    status: "pass",
    decision: "offline-ready",
    offlineBlockers: [],
    realEvidenceBlockers,
    staticClosure,
    metrics: {
      rustTestsPassed: reports.prp14.metrics.rustTestsPassed,
      scenariosPassed: reports.prp10.metrics.scenariosPassed,
      faultConcurrencyCasesPassed: reports.prp11.metrics.matrixPassed,
      propertyCasesPassed: reports.prp12.metrics.generatedCases,
      replayCasesPassed: reports.prp13.metrics.replayCasesPassed,
      unclassifiedDifferences:
        reports.prp13.metrics.unclassifiedDifferences,
      evidenceArtifactsVerified:
        reports.prp14.metrics.artifactsVerified,
    },
    identities: {
      sourceManifestHash: sourceBaseline.manifestHash,
      evidenceBundleHash: evidenceBundle.bundleHash,
      stageReportHashes: Object.fromEntries(
        stageDefinitions.map(([id]) => [id, reports[id].reportHash]),
      ),
    },
  };
}

function validateStageMetrics(reports) {
  if (
    reports.batch2.metrics?.rustTestsFailed !== 0
    || reports.batch2.metrics?.unresolvedStaticDependencies !== 0
    || reports.batch2.metrics?.ambiguousStaticDependencies !== 0
    || reports.batch2.metrics?.truncatedStaticDependencies !== 0
    || reports.prp10.metrics?.scenariosPassed !== 8
    || reports.prp10.metrics?.scenariosFailed !== 0
    || reports.prp11.metrics?.matrixPassed !== 23
    || reports.prp11.metrics?.matrixFailed !== 0
    || reports.prp12.metrics?.propertiesPassed !== 7
    || reports.prp12.metrics?.propertiesFailed !== 0
    || reports.prp12.metrics?.generatedCases !== 928
    || reports.prp13.metrics?.replayCasesPassed !== 8
    || reports.prp13.metrics?.replayCasesFailed !== 0
    || reports.prp13.metrics?.unclassifiedDifferences !== 0
    || reports.prp13.metrics?.tamperSelfTestPassed !== true
    || reports.prp14.metrics?.artifactsVerified !== 6
    || reports.prp14.metrics?.reproducibleArtifacts !== 6
    || reports.prp14.metrics?.tamperSelfTestPassed !== true
    || reports.prp14.metrics?.rustTestsFailed !== 0
  ) {
    throw new Error("one or more completion metrics are below threshold");
  }
}

function verifyArtifactLinks({
  sourceBaseline,
  contracts,
  testReport,
  offlineReplay,
  evidenceBundle,
}) {
  if (
    sourceBaseline.testReportHash !== testReport.artifactHash
    || sourceBaseline.offlineReplayHash !== offlineReplay.reportHash
    || sourceBaseline.evidenceBundleHash !== evidenceBundle.bundleHash
    || evidenceBundle.contractsArtifactHash !== contracts.artifactHash
    || evidenceBundle.testReportArtifactHash !== testReport.artifactHash
    || evidenceBundle.offlineReplayReportHash !== offlineReplay.reportHash
    || evidenceBundle.readiness?.offlineEvidenceComplete !== true
    || offlineReplay.metrics?.unclassifiedDifferences !== 0
  ) {
    throw new Error("evidence bundle linkage is incomplete");
  }
}

function verifyGateReportHash(report, id) {
  const { reportHash, ...payload } = report;
  const expected = id === "prp14"
    ? stableHash(payload)
    : sha256(Buffer.from(JSON.stringify(payload), "utf8"));
  if (reportHash !== expected) {
    throw new Error(`${id} gate report self-hash mismatch`);
  }
}

function verifySelfHash(value, hashField, label) {
  const { [hashField]: recorded, ...payload } = value;
  if (
    typeof recorded !== "string"
    || recorded !== stableHash(payload)
  ) {
    throw new Error(`${label} self-hash mismatch`);
  }
}

function verifyCoreArtifactHash(
  value,
  hashField,
  label,
  coreStableStringify,
) {
  const { [hashField]: recorded, ...payload } = value;
  const normalized = { ...payload, createdAt: undefined };
  const expected = sha256(
    Buffer.from(coreStableStringify(normalized), "utf8"),
  );
  if (recorded !== expected) {
    throw new Error(`${label} self-hash mismatch`);
  }
}

async function findRustPlaceholders(root) {
  const findings = [];
  for (const file of await collectFiles(root)) {
    if (!file.endsWith(".rs")) continue;
    const source = await readFile(file, "utf8");
    if (/\b(?:todo|unimplemented)!\s*\(/.test(source)) {
      findings.push(path.relative(serviceRoot, file).replaceAll("\\", "/"));
    }
  }
  return findings.sort();
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value) {
  return sha256(Buffer.from(stableStringify(value), "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
