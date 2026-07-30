import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const caseDirectory = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const artifactDirectory = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
);
const reportPath = path.join(artifactDirectory, "l3-gate.json");
const acceptancePath = path.join(artifactDirectory, "l3-acceptance.md");
const checks = [];

await mkdir(artifactDirectory, { recursive: true });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "batch-update-rust-l3",
  status: "running",
});

try {
  run(
    "typescript-build",
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.json",
    ],
    repositoryRoot,
  );
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const { evaluateMigrationOfflineGate } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "migrationWorkflow.js"),
    ).href
  );
  const { preflightJavaRuntimeEvidence } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "javaRuntimeEvidence.js"),
    ).href
  );
  const profile = await readJson(path.join(caseDirectory, "profile.json"));
  const beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  run(
    "typescript-contract-tests",
    process.execPath,
    [
      "--test",
      "dist/core/endpointReplacementPlanner.test.js",
      "dist/core/migrationProject.test.js",
      "dist/core/migrationWorkflow.test.js",
      "dist/core/javaEndpointAnalysis.test.js",
      "dist/core/referenceSourceGuard.test.js",
    ],
    repositoryRoot,
  );
  run(
    "deep-static-analysis",
    process.execPath,
    [
      "dist/cli.js",
      "migrate",
      "analyze",
      "--project",
      "zboss-batch-update-with-progress",
      "--max-depth",
      "64",
      "--max-edges",
      "50000",
      "--strict",
    ],
    repositoryRoot,
  );
  run(
    "runtime-contract-refresh",
    process.execPath,
    [
      "dist/cli.js",
      "migrate",
      "runtime-prepare",
      "--project",
      "zboss-batch-update-with-progress",
    ],
    repositoryRoot,
  );
  run(
    "runtime-authoring-refresh",
    process.execPath,
    [
      "dist/cli.js",
      "migrate",
      "runtime-authoring-prepare",
      "--project",
      "zboss-batch-update-with-progress",
    ],
    repositoryRoot,
  );

  const offlineGate = await evaluateMigrationOfflineGate(caseDirectory);
  requireCondition(
    "offline-gate",
    offlineGate.status === "passed" && offlineGate.findings.length === 0,
    offlineGate,
  );
  const runtimePreflight = await preflightJavaRuntimeEvidence(caseDirectory);
  const nonExternalBlocks = runtimePreflight.checks.filter(
    (check) =>
      check.status === "blocked"
      && !check.id.startsWith("environment:")
      && !check.id.startsWith("fixture:")
      && check.id !== "real-evidence",
  );
  requireCondition(
    "runtime-authoring",
    runtimePreflight.staticReady
      && runtimePreflight.authoringReady
      && nonExternalBlocks.length === 0,
    {
      staticReady: runtimePreflight.staticReady,
      authoringReady: runtimePreflight.authoringReady,
      nonExternalBlocks,
    },
  );

  run("rust-fmt", "cargo", ["fmt", "--check"], engineRoot);
  const rustTests = run(
    "rust-tests",
    "cargo",
    ["test", "--offline", "application::data::update"],
    engineRoot,
  );
  run(
    "rust-clippy",
    "cargo",
    ["clippy", "--all-targets", "--offline", "--", "-D", "warnings"],
    engineRoot,
  );
  run(
    "rust-release",
    "cargo",
    ["build", "--release", "--offline", "--bin", "zboss-batch-update"],
    engineRoot,
  );
  const manifestOutput = run(
    "rust-scenario-manifest",
    "cargo",
    [
      "run",
      "--offline",
      "--quiet",
      "--bin",
      "zboss-batch-update",
      "--",
      "--scenario-manifest",
    ],
    engineRoot,
  ).stdout;
  const rustManifest = parseRustManifest(manifestOutput);
  const runtimeContract = await readJson(
    path.join(
      caseDirectory,
      "evidence",
      "runtime",
      "java",
      "runtime-contract.json",
    ),
  );
  const contractManifest = runtimeContract.entries
    .flatMap((entry) => entry.scenarios)
    .map((scenario) => ({
      id: scenario.id,
      decisions: [...(scenario.decisionIds ?? [])].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  requireCondition(
    "scenario-contract-match",
    stableJson(rustManifest) === stableJson(contractManifest)
      && rustManifest.length === 19,
    { rustManifest, contractManifest },
  );

  const rustFiles = await collectFiles(
    path.join(engineRoot, "src", "application", "data", "update"),
    ".rs",
  );
  const incomplete = [];
  for (const file of rustFiles) {
    const source = await readFile(file, "utf8");
    if (/\b(?:todo|unimplemented)!\s*\(/u.test(source)) {
      incomplete.push(path.relative(engineRoot, file).replaceAll("\\", "/"));
    }
  }
  requireCondition("rust-source-completeness", incomplete.length === 0, {
    incomplete,
  });

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  requireCondition(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    { beforeSnapshot, afterSnapshot },
  );

  const sourceHash = await hashFiles([
    ...rustFiles,
    path.join(caseDirectory, "compatibility-decisions.json"),
    path.join(caseDirectory, "semantic-rules.json"),
    path.join(
      caseDirectory,
      "evidence",
      "runtime",
      "java",
      "runtime-contract.json",
    ),
  ]);
  const testCount = Number(
    /running (\d+) tests/u.exec(`${rustTests.stdout}\n${rustTests.stderr}`)?.[1]
      ?? 0,
  );
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-rust-l3",
    status: "pass",
    decision: "L3",
    scope: {
      endpoint:
        "POST /zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress",
      runtimeScenarios: 19,
      executionProfile: "offline-memory-with-production-boundaries",
      realEvidenceClaimed: false,
    },
    capabilities: [
      "row-atomic partial commit",
      "durable undo and downstream outbox intents",
      "monotonic conserved single-terminal progress",
      "chunk request-hash idempotency and final replay",
      "tenant-panel shared batch and exclusive refresh lease",
      "structured resumable schema transition",
      "HTTP RPC and Web-RPC parity",
      "tenant panel datasource actor and trace context isolation",
    ],
    evidence: {
      rustTestCount: testCount,
      scenarioCount: rustManifest.length,
      runtimeContractHash: runtimePreflight.contractHash,
      sourceHash,
      sourceSnapshot: afterSnapshot,
      offlineGate: offlineGate.status,
      runtimeStaticReady: runtimePreflight.staticReady,
      runtimeAuthoringReady: runtimePreflight.authoringReady,
      externalRuntimeBlockers: runtimePreflight.findings,
    },
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(
    acceptancePath,
    [
      "# `batchUpdateWithProgress` L3 验收",
      "",
      "Status: PASS",
      "",
      "- Decision: L3",
      `- Runtime scenarios: ${rustManifest.length}/19`,
      `- Rust tests: ${testCount}`,
      `- Runtime contract: ${runtimePreflight.contractHash}`,
      `- Source hash: ${sourceHash}`,
      "- Reference source: unchanged",
      "- Real runtime evidence: not claimed; external fixtures/environment remain fail-closed",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        decision: report.decision,
        scenarioCount: report.evidence.scenarioCount,
        rustTestCount: report.evidence.rustTestCount,
        checks: checks.length,
        reportPath,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-rust-l3",
    status: "blocked",
    decision: "L2",
    error: error instanceof Error ? error.message : String(error),
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

function run(id, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const pass = result.status === 0;
  checks.push({
    id,
    pass,
    command: [command, ...args].join(" "),
  });
  if (!pass) {
    throw new Error(
      `${id} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

function requireCondition(id, pass, details) {
  checks.push({ id, pass, details });
  if (!pass) {
    throw new Error(`${id} failed: ${JSON.stringify(details)}`);
  }
}

function parseRustManifest(output) {
  const records = output
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("|");
      if (separator < 0) throw new Error(`invalid scenario manifest line: ${line}`);
      return {
        id: line.slice(0, separator),
        decisions: line
          .slice(separator + 1)
          .split(",")
          .filter(Boolean)
          .sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("duplicate Rust scenario id");
  }
  return records;
}

async function collectFiles(root, extension) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(absolute, extension)));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      result.push(absolute);
    }
  }
  return result.sort();
}

async function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(path.relative(repositoryRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
