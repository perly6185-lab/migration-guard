import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const reportPath = path.join(artifactDirectory, "prp14-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "prp14-acceptance.md",
);
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp14-progress.json",
);
const tamperRoot = path.join(
  repositoryRoot,
  "tmp",
  "page-rust-prp14-tamper",
);
const evidenceScript = path.join(
  serviceRoot,
  "scripts",
  "prp14-evidence.mjs",
);
const artifactFiles = [
  "source-baseline.json",
  "contracts.json",
  "test-report.json",
  "offline-replay.json",
  "evidence-bundle.json",
  "offline-readiness.md",
];
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-14", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp14",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-14 阶段验收\n\nStatus: RUNNING\n",
  "utf8",
);

try {
  runCommand(
    "reference-guard-build",
    process.execPath,
    [
      path.join(
        repositoryRoot,
        "node_modules",
        "typescript",
        "bin",
        "tsc",
      ),
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
      path.join(
        repositoryRoot,
        "dist",
        "core",
        "referenceSourceGuard.js",
      ),
    ).href
  );
  const profile = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "cases", "zboss-page", "profile.json"),
      "utf8",
    ),
  );
  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  const tests = runCommand(
    "rust-tests",
    "cargo",
    ["test", "--all-features", "--offline"],
    serviceRoot,
  );
  testCount = [...tests.output.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
  if (testCount <= 0) {
    throw new Error("Rust test count was not detected");
  }
  runCommand(
    "rust-clippy",
    "cargo",
    [
      "clippy",
      "--all-targets",
      "--all-features",
      "--offline",
      "--",
      "-D",
      "warnings",
    ],
    serviceRoot,
  );
  runCommand(
    "production-feature-check",
    "cargo",
    [
      "check",
      "--lib",
      "--no-default-features",
      "--features",
      "mysql,redis",
      "--offline",
    ],
    serviceRoot,
  );
  runCommand(
    "release-build",
    "cargo",
    ["build", "--release", "--all-features", "--offline"],
    serviceRoot,
  );

  const evidenceEnvironment = {
    ...process.env,
    PRP14_RUST_TESTS_PASSED: String(testCount),
  };
  runCommand(
    "evidence-generation-first",
    process.execPath,
    [evidenceScript],
    repositoryRoot,
    evidenceEnvironment,
  );
  const firstHashes = await artifactHashMap(artifactDirectory);
  runCommand(
    "evidence-generation-second",
    process.execPath,
    [evidenceScript],
    repositoryRoot,
    evidenceEnvironment,
  );
  const secondHashes = await artifactHashMap(artifactDirectory);
  const reproducible =
    JSON.stringify(firstHashes) === JSON.stringify(secondHashes);
  checks.push({
    id: "byte-reproducibility",
    command: "generate all six artifacts twice and compare SHA-256",
    pass: reproducible,
  });
  if (!reproducible) {
    throw new Error("PRP-14 artifacts are not byte reproducible");
  }
  runCommand(
    "evidence-verification",
    process.execPath,
    [evidenceScript, "--verify"],
    repositoryRoot,
    evidenceEnvironment,
  );
  await runTamperSelfTest();

  const sourceBaseline = await readJson(
    path.join(artifactDirectory, "source-baseline.json"),
  );
  const contracts = await readJson(
    path.join(artifactDirectory, "contracts.json"),
  );
  const testReport = await readJson(
    path.join(artifactDirectory, "test-report.json"),
  );
  const replay = await readJson(
    path.join(artifactDirectory, "offline-replay.json"),
  );
  const bundle = await readJson(
    path.join(artifactDirectory, "evidence-bundle.json"),
  );
  if (
    sourceBaseline.testReportHash !== testReport.artifactHash
    || sourceBaseline.offlineReplayHash !== replay.reportHash
    || sourceBaseline.evidenceBundleHash !== bundle.bundleHash
    || bundle.contractsArtifactHash !== contracts.artifactHash
  ) {
    throw new Error("PRP-14 cross-artifact linkage is incomplete");
  }
  checks.push({
    id: "cross-artifact-linkage",
    command: "validate manifest, reports, replay, contracts and bundle links",
    pass: true,
  });

  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  const sourceUnchanged = referenceSourceSnapshotsEqual(
    beforeSnapshot,
    afterSnapshot,
  );
  checks.push({
    id: "reference-source-unchanged",
    command: "capture before/after and compare stable source snapshots",
    pass: sourceUnchanged,
  });
  if (!sourceUnchanged) {
    throw new Error("reference source changed during PRP-14");
  }

  const status = checks.every((check) => check.pass) ? "pass" : "fail";
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp14",
    status,
    decision: status === "pass" ? "prp14-accepted" : "prp14-rejected",
    scope: {
      completedItems: ["PRP-14"],
      referenceSourceAccess: "read-only",
      artifactIdentity: "stable-sha256",
      volatileIdentityFields: "forbidden",
      tamperPolicy: "fail-closed",
    },
    artifacts: {
      files: secondHashes,
      manifestHash: sourceBaseline.manifestHash,
      baselineIdentityHash: sourceBaseline.baselineIdentityHash,
      contractsArtifactHash: contracts.artifactHash,
      testReportArtifactHash: testReport.artifactHash,
      offlineReplayReportHash: replay.reportHash,
      evidenceBundleHash: bundle.bundleHash,
    },
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      artifactsVerified: artifactFiles.length,
      reproducibleArtifacts: artifactFiles.length,
      reproducibilityRuns: 2,
      tamperSelfTestPassed: true,
      rustTestsPassed: testCount,
      rustTestsFailed: 0,
      replayCasesPassed: replay.metrics.casesPassed,
      unclassifiedDifferences: replay.metrics.unclassifiedDifferences,
    },
    checks,
    readiness: {
      status: "candidate",
      offlineEvidenceComplete: true,
      unifiedGatePending: true,
      realRuntimeEvidencePresent: false,
    },
    next: "PRP-15 unified gate and offline-ready decision",
  };
  const report = {
    ...payload,
    reportHash: stableHash(payload),
  };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp14",
    status: "fail",
    decision: "prp14-rejected",
    error: error instanceof Error ? error.message : String(error),
    checks,
    sourceSnapshot: afterSnapshot
      ? stableSourceSnapshot(afterSnapshot)
      : beforeSnapshot
        ? stableSourceSnapshot(beforeSnapshot)
        : undefined,
  };
  const report = {
    ...payload,
    reportHash: stableHash(payload),
  };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.exitCode = 1;
} finally {
  await rm(progressPath, { force: true });
  await rm(tamperRoot, { recursive: true, force: true });
}

async function runTamperSelfTest() {
  const resolvedTamperRoot = path.resolve(tamperRoot);
  const expectedParent = `${path.resolve(repositoryRoot, "tmp")}${path.sep}`;
  if (!resolvedTamperRoot.startsWith(expectedParent)) {
    throw new Error("refusing unsafe tamper directory");
  }
  await rm(resolvedTamperRoot, { recursive: true, force: true });
  await mkdir(resolvedTamperRoot, { recursive: true });
  for (const file of artifactFiles) {
    await copyFile(
      path.join(artifactDirectory, file),
      path.join(resolvedTamperRoot, file),
    );
  }
  const contractsPath = path.join(resolvedTamperRoot, "contracts.json");
  const contracts = await readJson(contractsPath);
  contracts.status = "tampered";
  await writeJson(contractsPath, contracts);
  const result = spawnSync(
    process.execPath,
    [evidenceScript, "--verify"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PRP14_ARTIFACT_ROOT: resolvedTamperRoot,
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass =
    result.status !== 0 && output.includes("contracts self-hash mismatch");
  checks.push({
    id: "tamper-fail-closed",
    command: "mutate copied contracts artifact and require verification failure",
    pass,
  });
  if (!pass) {
    throw new Error("PRP-14 tamper self-test did not fail closed");
  }
}

function runCommand(id, command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass = result.status === 0 && !result.error;
  checks.push({
    id,
    command: stableCommand(command, args),
    pass,
  });
  if (!pass) {
    throw new Error(
      `${id} failed: ${result.error?.message ?? tail(output, 4_000)}`,
    );
  }
  return { output };
}

async function artifactHashMap(root) {
  return Object.fromEntries(
    await Promise.all(
      artifactFiles.map(async (file) => [
        file,
        sha256(await readFile(path.join(root, file))),
      ]),
    ),
  );
}

function stableSourceSnapshot(snapshot) {
  return {
    identity: snapshot.identity.identity,
    revision: snapshot.identity.revision,
    dirtyFingerprint: snapshot.identity.dirtyFingerprint,
    treeHash: snapshot.treeHash,
    fileCount: snapshot.fileCount,
    directories: snapshot.directories,
  };
}

function renderAcceptance(report) {
  const passed = report.checks?.filter((check) => check.pass).length ?? 0;
  const total = report.checks?.length ?? 0;
  const lines = [
    "# `/page` Rust PRP-14 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Artifacts: ${report.metrics.artifactsVerified}/6 verified`,
      `Reproducibility: ${report.metrics.reproducibleArtifacts}/6 across ${report.metrics.reproducibilityRuns} runs`,
      `Tamper self-test: ${report.metrics.tamperSelfTestPassed ? "PASS" : "FAIL"}`,
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
      `Offline replay: ${report.metrics.replayCasesPassed}/8`,
      `Unclassified differences: ${report.metrics.unclassifiedDifferences}`,
    );
  }
  if (report.artifacts) {
    lines.push(
      "",
      "## Reproducible identities",
      "",
      `- Source manifest: \`${report.artifacts.manifestHash}\``,
      `- Evidence bundle: \`${report.artifacts.evidenceBundleHash}\``,
      `- Contracts: \`${report.artifacts.contractsArtifactHash}\``,
      `- Tests: \`${report.artifacts.testReportArtifactHash}\``,
      `- Offline replay: \`${report.artifacts.offlineReplayReportHash}\``,
      `- Gate report: \`${report.reportHash}\``,
    );
  }
  if (report.sourceSnapshot) {
    lines.push(
      "",
      "## Reference source guard",
      "",
      `- Identity: \`${report.sourceSnapshot.identity}\``,
      `- Files: ${report.sourceSnapshot.fileCount}`,
      `- Tree hash: \`${report.sourceSnapshot.treeHash}\``,
    );
  }
  lines.push("", "## Checks", "");
  for (const check of report.checks ?? []) {
    lines.push(`- [${check.pass ? "x" : " "}] ${check.id}`);
  }
  if (report.readiness) {
    lines.push(
      "",
      "## Readiness",
      "",
      "- PRP-14 offline evidence: complete",
      "- Overall status: CANDIDATE",
      "- PRP-15 unified gate: pending",
      "- Real Java/MySQL/Redis evidence: not present",
    );
  }
  if (report.next) lines.push("", `Next: ${report.next}`);
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function tail(value, maximum) {
  return value.length <= maximum ? value : value.slice(-maximum);
}

function stableCommand(command, args) {
  const executable = command === process.execPath ? "node" : command;
  return [executable, ...args]
    .join(" ")
    .replaceAll(repositoryRoot, "<repo>")
    .replaceAll(repositoryRoot.replaceAll("\\", "/"), "<repo>")
    .replaceAll("\\", "/");
}
