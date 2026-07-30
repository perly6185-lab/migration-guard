import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const fixtureRoot = path.join(serviceRoot, "fixtures");
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-delete-rust");
const outputPath =
  process.env.BATCH_DELETE_REPLAY_OUTPUT
  ?? path.join(artifactRoot, "offline-replay.json");
const binary = path.join(
  path.resolve(engineRoot, "..", ".."),
  "target",
  "debug",
  process.platform === "win32"
    ? "batch-delete-offline-driver.exe"
    : "batch-delete-offline-driver",
);

await mkdir(artifactRoot, { recursive: true });

try {
  const javaStub = JSON.parse(
    await readFile(path.join(fixtureRoot, "java-reference-stub.json"), "utf8"),
  );
  const decisionContract = JSON.parse(
    await readFile(path.join(fixtureRoot, "compatibility-decisions.json"), "utf8"),
  );
  validateFixture(javaStub, decisionContract);
  const cases = [];
  for (const sourceCase of javaStub.cases) {
    const rust = runDriver(sourceCase.caseId);
    if (
      process.env.BATCH_DELETE_INJECT_UNCLASSIFIED === "1"
      && sourceCase.caseId === "success"
    ) {
      rust.code = "TAMPERED";
    }
    const differences = compare(sourceCase.observation, rust)
      .map((difference) => classify(sourceCase.caseId, difference, decisionContract));
    const unclassified = differences.filter(
      (difference) => difference.classification === "unclassified",
    );
    cases.push({
      caseId: sourceCase.caseId,
      status: unclassified.length === 0 ? "pass" : "fail",
      classification: differences.length === 0
        ? "compatible"
        : unclassified.length === 0
          ? "approved-correction"
          : "unclassified-drift",
      source: sourceCase.observation,
      target: rust,
      differences,
      unclassifiedDifferences: unclassified.length,
    });
  }
  const unclassifiedDifferences = cases.reduce(
    (sum, item) => sum + item.unclassifiedDifferences,
    0,
  );
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-offline-dual-replay",
    status: unclassifiedDifferences === 0 ? "pass" : "fail",
    decision: unclassifiedDifferences === 0
      ? "offline-replay-accepted"
      : "offline-replay-rejected",
    drivers: [
      {
        driverId: javaStub.driverId,
        provenance: javaStub.provenance,
        realEvidence: false,
      },
      {
        driverId: "rust-batch-delete-memory",
        provenance: "deterministic-offline-memory-execution",
        realEvidence: false,
      },
    ],
    fixtureHashes: {
      javaReferenceStub: stableHash(javaStub),
      compatibilityDecisions: stableHash(decisionContract),
    },
    metrics: {
      casesPassed: cases.filter((item) => item.status === "pass").length,
      casesFailed: cases.filter((item) => item.status !== "pass").length,
      exactCompatibleCases: cases.filter(
        (item) => item.classification === "compatible",
      ).length,
      approvedCorrectionCases: cases.filter(
        (item) => item.classification === "approved-correction",
      ).length,
      classifiedDifferences: cases.reduce(
        (sum, item) =>
          sum
          + item.differences.filter(
            (difference) => difference.classification !== "unclassified",
          ).length,
        0,
      ),
      unclassifiedDifferences,
    },
    cases,
    limitations: [
      "The Java driver is a frozen synthetic source-semantic stub, not fresh real Java runtime evidence.",
      "The Rust driver uses in-process memory state, not production MySQL, Redis or WebSocket adapters.",
      "The supplied three-row request is stored as a write candidate and was not invoked by this gate.",
    ],
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(outputPath, report);
  if (report.status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-offline-dual-replay",
    status: "fail",
    decision: "offline-replay-rejected",
    error: error instanceof Error ? error.message : String(error),
  };
  await writeJson(outputPath, { ...payload, reportHash: stableHash(payload) });
  process.exitCode = 1;
}

function validateFixture(javaStub, decisionContract) {
  const expectedCases = [
    "success",
    "partial-reference-skip",
    "all-reference-skip",
    "missing-active-row",
    "snapshot-failure",
    "undo-failure",
    "duplicate-replay",
    "compensation-failure",
  ];
  if (
    javaStub.schemaVersion !== 1
    || javaStub.provenance !== "synthetic-frozen-stub-not-real-java-runtime-evidence"
    || stableStringify(javaStub.cases?.map((item) => item.caseId))
      !== stableStringify(expectedCases)
    || decisionContract.schemaVersion !== 1
    || decisionContract.decisions?.length !== 3
  ) {
    throw new Error("batch-delete replay fixture contract is invalid");
  }
}

function runDriver(caseId) {
  const result = spawnSync(binary, ["--case", caseId], {
    cwd: engineRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `rust memory driver failed for ${caseId}: ${
        result.error?.message ?? result.stderr
      }`,
    );
  }
  const raw = JSON.parse(result.stdout.trim());
  if (
    raw.schemaVersion !== 1
    || raw.driverId !== "rust-batch-delete-memory"
    || raw.caseId !== caseId
  ) {
    throw new Error(`rust memory driver returned invalid evidence for ${caseId}`);
  }
  const { schemaVersion, driverId, caseId: ignoredCaseId, ...observation } = raw;
  void schemaVersion;
  void driverId;
  void ignoredCaseId;
  return observation;
}

function compare(source, target, prefix = "") {
  if (stableStringify(source) === stableStringify(target)) return [];
  if (
    source === null
    || target === null
    || typeof source !== "object"
    || typeof target !== "object"
    || Array.isArray(source)
    || Array.isArray(target)
  ) {
    return [{ path: prefix, source, target }];
  }
  const keys = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  return keys.flatMap((key) =>
    compare(source[key], target[key], prefix ? `${prefix}.${key}` : key)
  );
}

function classify(caseId, difference, decisionContract) {
  const matches = decisionContract.decisions.filter(
    (decision) =>
      decision.caseId === caseId && decision.paths.includes(difference.path),
  );
  return {
    ...difference,
    classification: matches.length === 1
      ? matches[0].classification
      : "unclassified",
    decisionId: matches.length === 1 ? matches[0].decisionId : null,
  };
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
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
