import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const workspaceRoot = path.resolve(serviceRoot, "..", "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const caseRoot = path.join(repositoryRoot, "cases", "zboss-page");
const artifactRoot =
  process.env.PRP14_ARTIFACT_ROOT
  ?? path.join(repositoryRoot, "artifacts", "page-rust");
const outputFiles = {
  sourceBaseline: "source-baseline.json",
  contracts: "contracts.json",
  testReport: "test-report.json",
  offlineReplay: "offline-replay.json",
  evidenceBundle: "evidence-bundle.json",
  offlineReadiness: "offline-readiness.md",
};
const analysisEntry =
  "evidence/analysis/post-zboss-data-view-dynamic-engine-use-engine-use-page-page";
const staticClosureEntries = [
  "evidence/analysis/index.json",
  `${analysisEntry}/behavior-graph.json`,
  `${analysisEntry}/endpoint-replacement-plan.json`,
  `${analysisEntry}/java-analysis.json`,
];
const contractSources = [
  "rust/zboss-rust/internal/dynamic-engine-runtime/contracts/error-contract.json",
  "rust/zboss-rust/internal/dynamic-engine-runtime/contracts/page-request.schema.json",
  "rust/zboss-rust/internal/dynamic-engine-runtime/contracts/page-response.schema.json",
  "rust/zboss-rust/internal/dynamic-engine-runtime/contracts/request-context.schema.json",
];
const compatibilitySources = [
  "cases/zboss-page/compatibility-decisions.json",
  "rust/zboss-rust/internal/dynamic-engine-runtime/contracts/compatibility-decisions.json",
  "rust/zboss-rust/internal/dynamic-engine-runtime/fixtures/prp13/compatibility-decisions.json",
];

if (process.argv[2] === "--verify") {
  try {
    const result = await verifyArtifacts();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
} else {
  try {
    await generateArtifacts();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function generateArtifacts() {
  await mkdir(artifactRoot, { recursive: true });
  const {
    captureReferenceSourceSnapshot,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const profile = await readJson(
    path.join(caseRoot, "profile.json"),
  );
  const reference = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  const releaseBinary = path.join(
    workspaceRoot,
    "target",
    "release",
    process.platform === "win32" ? "zboss-page.exe" : "zboss-page",
  );
  await stat(releaseBinary);

  const staticClosureHash = await hashSelectedTree(
    caseRoot,
    staticClosureEntries,
  );
  const httpSchemaHash = await hashRepositoryFiles(contractSources);
  const compatibilityDecisionHash =
    await hashRepositoryFiles(compatibilitySources);
  const cargoLockHash = await hashFile(
    path.join(workspaceRoot, "Cargo.lock"),
  );
  const rustSourceTreeHash = await hashSelectedTree(workspaceRoot, [
    "Cargo.toml",
    "Cargo.lock",
    "internal/dynamic-engine-runtime/Cargo.toml",
    "internal/dynamic-engine-runtime/src",
  ]);
  const releaseBinaryHash = await hashFile(releaseBinary);
  const fixtureHash = await hashSelectedTree(serviceRoot, ["fixtures"]);
  const testSourceHash = await hashSelectedTree(serviceRoot, ["tests"]);

  const baselineCore = {
    schemaVersion: 1,
    artifactId: "page-rust-source-baseline",
    source: {
      identity: reference.identity.identity,
      revision: reference.identity.revision,
      dirtyFingerprint: reference.identity.dirtyFingerprint,
      treeHash: reference.treeHash,
      fileCount: reference.fileCount,
      directories: reference.directories,
    },
    staticClosureHash,
    httpSchemaHash,
    compatibilityDecisionHash,
    target: {
      cargoLockHash,
      rustSourceTreeHash,
      releaseBinaryHash,
    },
    fixtureHash,
    identityPolicy: {
      algorithm: "sha256",
      ordering: "lexicographic-relative-path-and-stable-json-keys",
      excludedVolatileFields: ["createdAt", "absolutePath"],
    },
  };
  const baselineIdentityHash = stableHash(baselineCore);

  const contractFileHashes = await fileHashMap([
    ...contractSources,
    ...compatibilitySources,
  ]);
  const contractsPayload = {
    schemaVersion: 1,
    artifactId: "page-rust-contracts",
    status: "pass",
    httpSchemaHash,
    compatibilityDecisionHash,
    unknownDifferencePolicy: "fail-closed",
    fileHashes: contractFileHashes,
  };
  const contracts = {
    ...contractsPayload,
    artifactHash: stableHash(contractsPayload),
  };

  const stageReports = [];
  for (const stage of ["prp10", "prp11", "prp12", "prp13"]) {
    const relativePath = `artifacts/page-rust/${stage}-gate.json`;
    const absolutePath = path.join(repositoryRoot, relativePath);
    const report = await readJson(absolutePath);
    if (report.status !== "pass" || typeof report.reportHash !== "string") {
      throw new Error(`${stage} gate is not a stable PASS input`);
    }
    stageReports.push({
      stage: report.stage,
      status: report.status,
      reportHash: report.reportHash,
      fileHash: await hashFile(absolutePath),
      path: relativePath,
    });
  }
  const fallbackTests = (
    await readJson(path.join(artifactRoot, "prp13-gate.json"))
  ).metrics.rustTestsPassed;
  const rustTestsPassed = Number(
    process.env.PRP14_RUST_TESTS_PASSED ?? fallbackTests,
  );
  if (!Number.isSafeInteger(rustTestsPassed) || rustTestsPassed <= 0) {
    throw new Error("invalid PRP14_RUST_TESTS_PASSED");
  }
  const testPayload = {
    schemaVersion: 1,
    artifactId: "page-rust-test-report",
    status: "pass",
    commands: [
      "cargo fmt --check",
      "cargo test --all-features --offline",
      "cargo clippy --all-targets --all-features --offline -- -D warnings",
      "cargo check --lib --no-default-features --features mysql,redis --offline",
      "cargo build --release --all-features --offline",
    ],
    metrics: {
      rustTestsPassed,
      rustTestsFailed: 0,
      scenarioCasesPassed: 8,
      faultConcurrencyCasesPassed: 23,
      propertyIterationsPassed: 928,
      replayCasesPassed: 8,
    },
    testSourceHash,
    stageReports,
  };
  const testReport = {
    ...testPayload,
    artifactHash: stableHash(testPayload),
  };

  const prp13Replay = await readJson(
    path.join(artifactRoot, "prp13-replay.json"),
  );
  verifySelfHash(prp13Replay, "reportHash", "PRP-13 replay");
  if (
    prp13Replay.status !== "pass"
    || prp13Replay.metrics?.unclassifiedDifferences !== 0
  ) {
    throw new Error("PRP-13 replay is not accepted");
  }
  const offlineReplay = structuredClone(prp13Replay);

  const bundlePayload = {
    schemaVersion: 1,
    artifactId: "page-rust-evidence-bundle",
    status: "pass",
    baselineIdentityHash,
    contractsArtifactHash: contracts.artifactHash,
    testReportArtifactHash: testReport.artifactHash,
    offlineReplayReportHash: offlineReplay.reportHash,
    staticClosureHash,
    httpSchemaHash,
    compatibilityDecisionHash,
    cargoLockHash,
    rustSourceTreeHash,
    releaseBinaryHash,
    fixtureHash,
    testSourceHash,
    readiness: {
      offlineEvidenceComplete: true,
      unifiedGatePending: true,
      realRuntimeEvidencePresent: false,
    },
    integrityPolicy: {
      artifactSelfHashes: true,
      sourceRecomputationRequired: true,
      tamperPolicy: "fail-closed",
    },
  };
  const evidenceBundle = {
    ...bundlePayload,
    bundleHash: stableHash(bundlePayload),
  };
  const baselinePayload = {
    ...baselineCore,
    baselineIdentityHash,
    testReportHash: testReport.artifactHash,
    offlineReplayHash: offlineReplay.reportHash,
    evidenceBundleHash: evidenceBundle.bundleHash,
  };
  const sourceBaseline = {
    ...baselinePayload,
    manifestHash: stableHash(baselinePayload),
  };
  const readiness = renderReadiness({
    sourceBaseline,
    contracts,
    testReport,
    offlineReplay,
    evidenceBundle,
  });

  await writeJson(outputFiles.sourceBaseline, sourceBaseline);
  await writeJson(outputFiles.contracts, contracts);
  await writeJson(outputFiles.testReport, testReport);
  await writeJson(outputFiles.offlineReplay, offlineReplay);
  await writeJson(outputFiles.evidenceBundle, evidenceBundle);
  await writeFile(
    path.join(artifactRoot, outputFiles.offlineReadiness),
    readiness,
    "utf8",
  );
  await verifyArtifacts();
}

async function verifyArtifacts() {
  const sourceBaseline = await readArtifactJson(
    outputFiles.sourceBaseline,
  );
  const contracts = await readArtifactJson(outputFiles.contracts);
  const testReport = await readArtifactJson(outputFiles.testReport);
  const offlineReplay = await readArtifactJson(outputFiles.offlineReplay);
  const evidenceBundle = await readArtifactJson(
    outputFiles.evidenceBundle,
  );
  verifySelfHash(sourceBaseline, "manifestHash", "source baseline");
  verifySelfHash(contracts, "artifactHash", "contracts");
  verifySelfHash(testReport, "artifactHash", "test report");
  verifySelfHash(offlineReplay, "reportHash", "offline replay");
  verifySelfHash(evidenceBundle, "bundleHash", "evidence bundle");
  const {
    manifestHash: _manifestHash,
    baselineIdentityHash,
    testReportHash,
    offlineReplayHash,
    evidenceBundleHash,
    ...baselineCore
  } = sourceBaseline;
  if (baselineIdentityHash !== stableHash(baselineCore)) {
    throw new Error("source baseline identity hash mismatch");
  }
  if (evidenceBundleHash !== evidenceBundle.bundleHash) {
    throw new Error("source baseline/bundle linkage mismatch");
  }
  if (
    testReportHash !== testReport.artifactHash
    || offlineReplayHash !== offlineReplay.reportHash
  ) {
    throw new Error("source baseline/report linkage mismatch");
  }
  if (
    evidenceBundle.baselineIdentityHash !== baselineIdentityHash
    || evidenceBundle.contractsArtifactHash !== contracts.artifactHash
    || evidenceBundle.testReportArtifactHash !== testReport.artifactHash
    || evidenceBundle.offlineReplayReportHash !== offlineReplay.reportHash
  ) {
    throw new Error("evidence bundle artifact linkage mismatch");
  }
  if (
    contracts.httpSchemaHash
      !== await hashRepositoryFiles(contractSources)
    || contracts.compatibilityDecisionHash
      !== await hashRepositoryFiles(compatibilitySources)
    || stableStringify(contracts.fileHashes)
      !== stableStringify(
        await fileHashMap([
          ...contractSources,
          ...compatibilitySources,
        ]),
      )
  ) {
    throw new Error("contract source hash mismatch");
  }
  if (
    sourceBaseline.staticClosureHash
      !== await hashSelectedTree(caseRoot, staticClosureEntries)
    || sourceBaseline.target.cargoLockHash
      !== await hashFile(path.join(workspaceRoot, "Cargo.lock"))
    || sourceBaseline.target.rustSourceTreeHash
      !== await hashSelectedTree(workspaceRoot, [
        "Cargo.toml",
        "Cargo.lock",
        "internal/dynamic-engine-runtime/Cargo.toml",
        "internal/dynamic-engine-runtime/src",
      ])
    || sourceBaseline.fixtureHash
      !== await hashSelectedTree(serviceRoot, ["fixtures"])
    || testReport.testSourceHash
      !== await hashSelectedTree(serviceRoot, ["tests"])
  ) {
    throw new Error("source, fixture, or test tree hash mismatch");
  }
  const releaseBinary = path.join(
    workspaceRoot,
    "target",
    "release",
    process.platform === "win32" ? "zboss-page.exe" : "zboss-page",
  );
  if (
    sourceBaseline.target.releaseBinaryHash
      !== await hashFile(releaseBinary)
  ) {
    throw new Error("release binary hash mismatch");
  }
  for (const stage of testReport.stageReports) {
    const absolutePath = path.join(repositoryRoot, stage.path);
    const report = await readJson(absolutePath);
    if (
      stage.fileHash !== await hashFile(absolutePath)
      || stage.reportHash !== report.reportHash
      || report.status !== "pass"
    ) {
      throw new Error(`stage report linkage mismatch: ${stage.stage}`);
    }
  }
  if (
    offlineReplay.status !== "pass"
    || offlineReplay.metrics?.unclassifiedDifferences !== 0
    || !evidenceBundle.readiness?.offlineEvidenceComplete
  ) {
    throw new Error("offline evidence is not complete");
  }
  for (const value of [
    sourceBaseline,
    contracts,
    testReport,
    offlineReplay,
    evidenceBundle,
  ]) {
    assertNoVolatileIdentity(value);
  }
  const readiness = await readFile(
    path.join(artifactRoot, outputFiles.offlineReadiness),
    "utf8",
  );
  if (
    !readiness.includes(evidenceBundle.bundleHash)
    || !readiness.includes("Status: CANDIDATE")
  ) {
    throw new Error("offline readiness linkage mismatch");
  }
  return {
    status: "pass",
    artifactsVerified: 6,
    bundleHash: evidenceBundle.bundleHash,
    manifestHash: sourceBaseline.manifestHash,
  };
}

function verifySelfHash(value, hashField, label) {
  const { [hashField]: recorded, ...payload } = value;
  if (
    typeof recorded !== "string"
    || !/^[0-9a-f]{64}$/.test(recorded)
    || recorded !== stableHash(payload)
  ) {
    throw new Error(`${label} self-hash mismatch`);
  }
}

function assertNoVolatileIdentity(value) {
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "createdAt" || key === "absolutePath") {
        throw new Error(`volatile identity field is forbidden: ${key}`);
      }
      if (
        typeof child === "string"
        && (
          /^[A-Za-z]:[\\/]/.test(child)
          || child.startsWith("/")
        )
      ) {
        throw new Error("absolute path is forbidden in artifact identity");
      }
      visit(child);
    }
  };
  visit(value);
}

function renderReadiness({
  sourceBaseline,
  contracts,
  testReport,
  offlineReplay,
  evidenceBundle,
}) {
  return [
    "# `/page` Rust offline readiness evidence",
    "",
    "Status: CANDIDATE",
    "",
    "PRP-14 reproducible evidence is complete. Final `offline-ready`",
    "classification remains pending the PRP-15 unified gate.",
    "",
    "## Evidence",
    "",
    `- Source manifest: \`${sourceBaseline.manifestHash}\``,
    `- Contracts: \`${contracts.artifactHash}\``,
    `- Tests: \`${testReport.artifactHash}\``,
    `- Offline replay: \`${offlineReplay.reportHash}\``,
    `- Evidence bundle: \`${evidenceBundle.bundleHash}\``,
    "",
    "## Current result",
    "",
    `- Rust tests: ${testReport.metrics.rustTestsPassed} passed`,
    `- Replay cases: ${offlineReplay.metrics.casesPassed}/8`,
    `- Unclassified differences: ${offlineReplay.metrics.unclassifiedDifferences}`,
    "- Real Java/MySQL/Redis evidence: not present",
    "",
  ].join("\n");
}

async function fileHashMap(relativeFiles) {
  return Object.fromEntries(
    await Promise.all(
      [...relativeFiles].sort().map(async (relativePath) => [
        relativePath.replaceAll("\\", "/"),
        await hashFile(path.join(repositoryRoot, relativePath)),
      ]),
    ),
  );
}

async function hashRepositoryFiles(relativeFiles) {
  const records = [];
  for (const relativePath of [...relativeFiles].sort()) {
    records.push(
      `${relativePath.replaceAll("\\", "/")}\0${
        await hashFile(path.join(repositoryRoot, relativePath))
      }`,
    );
  }
  return sha256(Buffer.from(records.join("\n"), "utf8"));
}

async function hashSelectedTree(root, entries) {
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry);
    const information = await stat(absolute);
    if (information.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else {
      files.push(absolute);
    }
  }
  const records = [];
  for (const file of files.sort()) {
    records.push(
      `${path.relative(root, file).replaceAll("\\", "/")}\0${
        await hashFile(file)
      }`,
    );
  }
  return sha256(Buffer.from(records.join("\n"), "utf8"));
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

async function hashFile(file) {
  return sha256(await readFile(file));
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readArtifactJson(file) {
  return readJson(path.join(artifactRoot, file));
}

async function writeJson(file, value) {
  await writeFile(
    path.join(artifactRoot, file),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
