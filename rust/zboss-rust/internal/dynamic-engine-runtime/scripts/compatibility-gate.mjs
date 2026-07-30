import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const rustRoot = path.resolve(serviceRoot, "..", "..");
const repositoryRoot = path.resolve(rustRoot, "..", "..");
const evidencePath = path.join(
  serviceRoot,
  "contracts",
  "zboss-02-compatibility-evidence.json",
);
const decisionPaths = [
  path.join(repositoryRoot, "cases", "zboss-page", "compatibility-decisions.json"),
  path.join(repositoryRoot, "cases", "zboss-query", "compatibility-decisions.json"),
  path.join(
    repositoryRoot,
    "cases",
    "zboss-horizontal-list",
    "compatibility-decisions.json",
  ),
];
const reportPath = path.join(
  rustRoot,
  "target",
  "zboss-02",
  "compatibility-gate.json",
);

const evidence = await readJson(evidencePath);
const expectedIds = new Set(evidence.decisions.map((decision) => decision.id));
if (expectedIds.size !== 11 || evidence.decisions.length !== 11) {
  fail("ZBOSS-02 evidence must contain exactly 11 unique decisions");
}

const approved = new Map();
for (const decisionPath of decisionPaths) {
  const document = await readJson(decisionPath);
  for (const decision of document.decisions ?? []) {
    if (expectedIds.has(decision.id)) {
      if (decision.status !== "approved" || !decision.approvedBy || !decision.approvedAt) {
        fail(`${decision.id} is not fully approved`);
      }
      approved.set(decision.id, decision);
    }
  }
}
if (approved.size !== expectedIds.size) {
  const missing = [...expectedIds].filter((id) => !approved.has(id));
  fail(`approved decision records are missing: ${missing.join(", ")}`);
}

const testNames = evidence.decisions.map((decision) => decision.test);
if (new Set(testNames).size !== 11 || testNames.some((name) => !name)) {
  fail("every compatibility decision must map to one unique Rust test");
}
const testSource = await readFile(
  path.join(serviceRoot, "tests", "compatibility_decisions.rs"),
  "utf8",
);
for (const testName of testNames) {
  if (!testSource.includes(`fn ${testName}(`)) {
    fail(`mapped Rust test is missing: ${testName}`);
  }
}

const testResult = spawnSync(
  "cargo",
  [
    "test",
    "-p",
    "zboss-dynamic-engine-runtime",
    "--test",
    "compatibility_decisions",
    "--offline",
    "--",
    "--nocapture",
  ],
  {
    cwd: rustRoot,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  },
);
process.stdout.write(testResult.stdout || "");
process.stderr.write(testResult.stderr || "");
if (testResult.status !== 0) {
  fail("ZBOSS-02 Rust compatibility tests failed");
}
if (!testResult.stdout.includes("11 passed")) {
  fail("ZBOSS-02 gate did not observe all 11 passing tests");
}

const metrics = [...testResult.stdout.matchAll(/MG_COMPAT_METRIC (\{[^\r\n]+\})/g)].map(
  (match) => JSON.parse(match[1]),
);
if (metrics.length !== 2) {
  fail(`expected two 10000-row metrics, observed ${metrics.length}`);
}
for (const metric of metrics) {
  if (
    metric.returnedRows !== 10_000 ||
    metric.total !== 10_001 ||
    metric.elapsedMillis >= 10_000 ||
    metric.responseBytes >= 20_000_000 ||
    metric.payloadMemoryBudgetBytes > 40_000_000
  ) {
    fail(`10000-row compatibility budget failed: ${JSON.stringify(metric)}`);
  }
}

const profile = await readJson(
  path.join(repositoryRoot, "cases", "zboss-page", "profile.json"),
);
const sourceVerification = await verifyReferenceSource(
  profile.source.root,
  evidence.referenceSourceSnapshots,
);

const report = {
  schemaVersion: 1,
  issue: evidence.issue,
  status: "pass",
  decisionCount: expectedIds.size,
  approvedDecisionIds: [...expectedIds].sort(),
  testCount: 11,
  metrics,
  sourceVerification,
  evidenceSha256: sha256(await readFile(evidencePath)),
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`ZBOSS-02 compatibility gate passed; report=${reportPath}`);

async function verifyReferenceSource(root, snapshots) {
  if (!(await exists(root))) {
    return {
      status: "snapshot-unavailable",
      checkedFiles: 0,
      expectedFiles: snapshots.length,
    };
  }
  for (const snapshot of snapshots) {
    const file = path.join(root, ...snapshot.path.split("/"));
    const actual = sha256(await readFile(file));
    if (actual !== snapshot.sha256) {
      fail(`reference source snapshot changed: ${snapshot.path}`);
    }
  }
  return {
    status: "verified",
    checkedFiles: snapshots.length,
    expectedFiles: snapshots.length,
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(message);
}
