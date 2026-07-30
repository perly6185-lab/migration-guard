import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const reportPath = path.join(artifactDirectory, "prp11-gate.json");
const acceptancePath = path.join(artifactDirectory, "prp11-acceptance.md");
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp11-progress.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-11", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp11",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-11 阶段验收\n\nStatus: RUNNING\n",
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

  const matrix = await validateMatrix();
  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  const matrixTests = runCommand(
    "prp11-matrix-tests",
    "cargo",
    [
      "test",
      "--test",
      "prp11_fault_concurrency",
      "--all-features",
      "--offline",
    ],
    serviceRoot,
  );
  if (!/test result: ok\. 24 passed/.test(matrixTests.output)) {
    throw new Error("PRP-11 matrix did not execute all 23 cases plus index test");
  }
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
  const coverage = matrix.cases.map((entry) => ({
    caseId: entry.caseId,
    category: entry.category,
    requirement: entry.requirement,
    pass: true,
  }));
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp11",
    status,
    decision: status === "pass" ? "prp11-accepted" : "prp11-rejected",
    scope: {
      completedItems: ["PRP-11"],
      referenceSourceAccess: "read-only",
      executionProfile: "deterministic-memory-with-mysql-redis-boundary-harnesses",
    },
    matrixCoverage: coverage,
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      matrixPassed: coverage.length,
      matrixFailed: 0,
      faultsPassed: coverage.filter((entry) => entry.category === "fault").length,
      interruptionsPassed: coverage.filter(
        (entry) => entry.category === "interruption",
      ).length,
      concurrencyPassed: coverage.filter(
        (entry) => entry.category === "concurrency",
      ).length,
      rustTestsPassed: testCount,
    },
    hashes: {
      matrixFixture: await hashSelectedTree(serviceRoot, ["fixtures/prp11"]),
      implementation: await hashSelectedTree(serviceRoot, [
        "src",
        "tests/prp11_fault_concurrency.rs",
      ]),
    },
    checks,
    next: "PRP-12 fixed-seed property tests",
  };
  const reportHash = sha256(Buffer.from(JSON.stringify(payload), "utf8"));
  const report = { ...payload, reportHash };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp11",
    status: "fail",
    decision: "prp11-rejected",
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
}

async function validateMatrix() {
  const matrix = JSON.parse(
    await readFile(
      path.join(serviceRoot, "fixtures", "prp11", "matrix.json"),
      "utf8",
    ),
  );
  const expectedIds = [
    "fault-metadata",
    "fault-permission",
    "fault-query",
    "fault-sql-timeout",
    "fault-sql-deadlock",
    "fault-invalid-identifier",
    "fault-redis-acquire",
    "fault-redis-release",
    "fault-redis-lease-expiry",
    "fault-refresh-sync",
    "fault-refresh-timestamp",
    "fault-refresh-undo",
    "fault-refresh-reconcile",
    "fault-refresh-query",
    "interrupt-acquire",
    "interrupt-sync",
    "interrupt-query",
    "interrupt-release",
    "concurrent-same-scope",
    "concurrent-tenant-isolation",
    "concurrent-column-granularity",
    "concurrent-expired-new-owner",
    "concurrent-stale-owner-release",
  ];
  if (
    matrix.schemaVersion !== 1
    || matrix.stage !== "PRP-11"
    || JSON.stringify(matrix.cases?.map((entry) => entry.caseId))
      !== JSON.stringify(expectedIds)
    || new Set(expectedIds).size !== expectedIds.length
    || matrix.cases.some(
      (entry) => !entry.category?.trim() || !entry.requirement?.trim(),
    )
  ) {
    throw new Error("PRP-11 matrix is incomplete, reordered, or invalid");
  }
  const categories = Object.groupBy(
    matrix.cases,
    (entry) => entry.category,
  );
  if (
    categories.fault?.length !== 14
    || categories.interruption?.length !== 4
    || categories.concurrency?.length !== 5
  ) {
    throw new Error("PRP-11 matrix category coverage is invalid");
  }
  checks.push({
    id: "matrix-fixture",
    command: "validate 14 fault, 4 interruption and 5 concurrency cases",
    pass: true,
  });
  return matrix;
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
    "# `/page` Rust PRP-11 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Matrix: ${report.metrics.matrixPassed}/23`,
      `Faults: ${report.metrics.faultsPassed}/14`,
      `Interruptions: ${report.metrics.interruptionsPassed}/4`,
      `Concurrency: ${report.metrics.concurrencyPassed}/5`,
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
    );
  }
  for (const category of ["fault", "interruption", "concurrency"]) {
    const entries = report.matrixCoverage?.filter(
      (entry) => entry.category === category,
    );
    if (!entries?.length) continue;
    lines.push("", `## ${category}`, "");
    for (const entry of entries) {
      lines.push(
        `- [${entry.pass ? "x" : " "}] ${entry.caseId}: ${entry.requirement}`,
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
      `- Matrix fixture: \`${report.hashes.matrixFixture}\``,
      `- Implementation: \`${report.hashes.implementation}\``,
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
