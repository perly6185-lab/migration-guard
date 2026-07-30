import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const reportPath = path.join(artifactDirectory, "prp13-gate.json");
const replayPath = path.join(artifactDirectory, "prp13-replay.json");
const acceptancePath = path.join(artifactDirectory, "prp13-acceptance.md");
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp13-progress.json",
);
const tamperPath = path.join(
  repositoryRoot,
  "tmp",
  "page-rust-prp13-tamper.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await mkdir(path.dirname(tamperPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-13", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp13",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-13 阶段验收\n\nStatus: RUNNING\n",
  "utf8",
);

try {
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
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

  await validateFixtureJson();
  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  runCommand(
    "memory-driver-build",
    "cargo",
    [
      "build",
      "--bin",
      "prp13-memory-driver",
      "--all-features",
      "--offline",
    ],
    serviceRoot,
  );
  runCommand(
    "memory-driver-tests",
    "cargo",
    [
      "test",
      "--test",
      "prp13_driver",
      "--all-features",
      "--offline",
    ],
    serviceRoot,
  );
  runCommand(
    "offline-dual-replay",
    process.execPath,
    [path.join(serviceRoot, "scripts", "prp13-replay.mjs")],
    repositoryRoot,
  );
  const replay = JSON.parse(await readFile(replayPath, "utf8"));
  validateReplay(replay);
  checks.push({
    id: "replay-evidence",
    command: "validate replay hashes, classifications and report hash",
    pass: true,
  });
  await runTamperSelfTest();

  const tests = runCommand(
    "rust-tests",
    "cargo",
    ["test", "--all-features", "--offline"],
    serviceRoot,
  );
  testCount = [...tests.output.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
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

  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  checks.push({
    id: "reference-source-unchanged",
    command: "capture before/after and compare stable source snapshots",
    pass: referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
  });

  const status = checks.every((check) => check.pass) ? "pass" : "fail";
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp13",
    status,
    decision: status === "pass" ? "prp13-accepted" : "prp13-rejected",
    scope: {
      completedItems: ["PRP-13"],
      referenceSourceAccess: "read-only",
      drivers: replay.drivers,
      javaStubIsRealEvidence: false,
      unclassifiedPolicy: "fail-closed",
    },
    replay: {
      reportHash: replay.reportHash,
      fixtureHashes: replay.fixtureHashes,
      metrics: replay.metrics,
      caseDecisions: replay.cases.map((entry) => ({
        caseId: entry.caseId,
        status: entry.status,
        classification: entry.classification,
        requestHash: entry.inputHashes.requestHash,
        snapshotHash: entry.inputHashes.snapshotHash,
        contextHash: entry.inputHashes.contextHash,
        unclassifiedDifferences: entry.unclassifiedDifferences,
      })),
    },
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      replayCasesPassed: replay.metrics.casesPassed,
      replayCasesFailed: replay.metrics.casesFailed,
      classifiedDifferences: replay.metrics.classifiedDifferences,
      unclassifiedDifferences: replay.metrics.unclassifiedDifferences,
      tamperSelfTestPassed: true,
      rustTestsPassed: testCount,
    },
    hashes: {
      replayFixtures: await hashSelectedTree(serviceRoot, ["fixtures/prp13"]),
      replayImplementation: await hashSelectedTree(serviceRoot, [
        "src/bin/prp13-memory-driver.rs",
        "scripts/prp13-replay.mjs",
        "tests/prp13_driver.rs",
      ]),
      replayArtifact: sha256(await readFile(replayPath)),
    },
    checks,
    next: "PRP-14 reproducible artifacts and evidence bundle",
  };
  const reportHash = sha256(Buffer.from(JSON.stringify(payload), "utf8"));
  const report = { ...payload, reportHash };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp13",
    status: "fail",
    decision: "prp13-rejected",
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
    reportHash: sha256(Buffer.from(JSON.stringify(payload), "utf8")),
  };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.exitCode = 1;
} finally {
  await rm(progressPath, { force: true });
  await rm(tamperPath, { force: true });
}

async function validateFixtureJson() {
  const fixtureRoot = path.join(serviceRoot, "fixtures", "prp13");
  for (const file of [
    "replay-inputs.json",
    "java-reference-stub.json",
    "compatibility-decisions.json",
  ]) {
    JSON.parse(await readFile(path.join(fixtureRoot, file), "utf8"));
  }
  checks.push({
    id: "replay-fixtures",
    command: "parse versioned inputs, Java stub and compatibility decisions",
    pass: true,
  });
}

function validateReplay(replay) {
  const { reportHash, ...payload } = replay;
  if (
    replay.schemaVersion !== 1
    || replay.stage !== "page-rust-prp13-replay"
    || replay.status !== "pass"
    || replay.decision !== "offline-replay-accepted"
    || replay.metrics?.casesPassed !== 8
    || replay.metrics?.casesFailed !== 0
    || replay.metrics?.exactCompatibleCases !== 1
    || replay.metrics?.approvedCorrectionCases !== 7
    || replay.metrics?.classifiedDifferences !== 7
    || replay.metrics?.unclassifiedDifferences !== 0
    || replay.cases?.length !== 8
    || replay.cases.some(
      (entry) =>
        entry.status !== "pass"
        || !entry.contextMatches
        || !entry.inputEvidenceMatches
        || entry.unclassifiedDifferences !== 0
        || entry.hashParity.javaRequestHash
          !== entry.hashParity.rustRequestHash
        || entry.hashParity.javaSnapshotHash
          !== entry.hashParity.rustSnapshotHash
        || entry.hashParity.javaContextHash
          !== entry.hashParity.rustContextHash
        || !entry.rustObservation.lineageValid,
    )
    || reportHash !== stableHash(payload)
  ) {
    throw new Error("PRP-13 replay evidence is incomplete or invalid");
  }
}

async function runTamperSelfTest() {
  const result = spawnSync(
    process.execPath,
    [path.join(serviceRoot, "scripts", "prp13-replay.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PRP13_INJECT_UNCLASSIFIED: "1",
        PRP13_REPLAY_OUTPUT: tamperPath,
      },
    },
  );
  const evidence = JSON.parse(await readFile(tamperPath, "utf8"));
  const pass =
    result.status !== 0
    && evidence.status === "fail"
    && evidence.decision === "offline-replay-rejected"
    && evidence.metrics?.unclassifiedDifferences > 0;
  checks.push({
    id: "unclassified-tamper-self-test",
    command: "inject unapproved response drift and require replay rejection",
    pass,
  });
  if (!pass) {
    throw new Error("PRP-13 unclassified-difference self-test failed");
  }
}

function runCommand(id, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
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
      `${path.relative(root, file).replaceAll("\\", "/")}\0${sha256(await readFile(file))}`,
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
    "# `/page` Rust PRP-13 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Replay cases: ${report.metrics.replayCasesPassed}/8`,
      `Classified differences: ${report.metrics.classifiedDifferences}`,
      `Unclassified differences: ${report.metrics.unclassifiedDifferences}`,
      `Tamper self-test: ${report.metrics.tamperSelfTestPassed ? "PASS" : "FAIL"}`,
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
    );
  }
  if (report.replay?.caseDecisions) {
    lines.push("", "## Replay cases", "");
    for (const entry of report.replay.caseDecisions) {
      lines.push(
        `- [${entry.status === "pass" ? "x" : " "}] ${entry.caseId}: ${entry.classification}, unclassified=${entry.unclassifiedDifferences}`,
      );
    }
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
  if (report.hashes) {
    lines.push(
      "",
      "## Reproducible hashes",
      "",
      `- Replay fixtures: \`${report.hashes.replayFixtures}\``,
      `- Replay implementation: \`${report.hashes.replayImplementation}\``,
      `- Replay artifact: \`${report.hashes.replayArtifact}\``,
      `- Gate report: \`${report.reportHash}\``,
    );
  }
  lines.push("", "## Checks", "");
  for (const check of report.checks ?? []) {
    lines.push(`- [${check.pass ? "x" : " "}] ${check.id}`);
  }
  if (report.next) lines.push("", `Next: ${report.next}`);
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
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
