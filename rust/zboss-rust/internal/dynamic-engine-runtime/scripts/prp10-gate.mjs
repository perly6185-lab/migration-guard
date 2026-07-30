import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const reportPath = path.join(artifactDirectory, "prp10-gate.json");
const acceptancePath = path.join(artifactDirectory, "prp10-acceptance.md");
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp10-progress.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-10", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp10",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-10 阶段验收\n\nStatus: RUNNING\n",
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

  const scenarioIndex = await validateScenarios();
  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  runCommand(
    "prp10-scenario-tests",
    "cargo",
    [
      "test",
      "--test",
      "prp10_scenarios",
      "--all-features",
      "--offline",
    ],
    serviceRoot,
  );
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
    stage: "page-rust-prp10",
    status,
    decision: status === "pass" ? "prp10-accepted" : "prp10-rejected",
    scope: {
      completedItems: ["PRP-10"],
      referenceSourceAccess: "read-only",
      scenarioAssertions: [
        "response",
        "query-plan",
        "data-snapshot",
        "event-trace",
        "fingerprint",
      ],
    },
    scenarioCoverage: scenarioIndex.scenarios.map((scenario) => ({
      caseId: scenario.caseId,
      runtimeCaseId: scenario.runtimeCaseId,
      kind: scenario.kind,
      transport: scenario.transport,
      pass: true,
    })),
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      scenariosPassed: scenarioIndex.scenarios.length,
      scenariosFailed: 0,
      rustTestsPassed: testCount,
    },
    hashes: {
      scenarioFixtures: await hashSelectedTree(serviceRoot, [
        "fixtures/scenarios",
      ]),
      implementation: await hashSelectedTree(serviceRoot, [
        "src",
        "tests/prp10_scenarios.rs",
      ]),
    },
    checks,
    next: "PRP-11 fault and concurrency matrix",
  };
  const reportHash = sha256(Buffer.from(JSON.stringify(payload), "utf8"));
  const report = { ...payload, reportHash };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp10",
    status: "fail",
    decision: "prp10-rejected",
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

async function validateScenarios() {
  const root = path.join(serviceRoot, "fixtures", "scenarios");
  const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  const expected = [
    ["standard-page", "standard-page", "runtime"],
    ["refresh-operator", "refresh", "runtime"],
    ["child-form-page", "child-table", "runtime"],
    ["horizontal-page", "horizontal-table", "runtime"],
    ["quality-text-filter", "quality-filter", "runtime"],
    ["upload-preview-page", "temporary-table", "runtime"],
    ["tenant-auth-context", "tenant-permission", "runtime"],
    ["entrypoint-parity", "entrypoint-parity", "offline-extra"],
  ];
  const actual = index.scenarios?.map((scenario) => [
    scenario.caseId,
    scenario.runtimeCaseId,
    scenario.kind,
  ]);
  if (
    index.schemaVersion !== 1
    || index.stage !== "PRP-10"
    || JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error("scenario index or stable mapping is invalid");
  }
  for (const scenario of index.scenarios) {
    JSON.parse(await readFile(path.join(root, scenario.requestFile), "utf8"));
    if (
      scenario.expected?.dataSnapshotSha256
      !== sha256(Buffer.from(JSON.stringify(scenario.expected?.data), "utf8"))
    ) {
      throw new Error(`${scenario.caseId} data snapshot hash is invalid`);
    }
  }
  checks.push({
    id: "scenario-fixtures",
    command: "validate 8 stable mappings, requests, expectations and snapshot hashes",
    pass: true,
  });
  return index;
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
    "# `/page` Rust PRP-10 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Scenarios: ${report.metrics.scenariosPassed}/8`,
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
    );
  }
  if (report.scenarioCoverage) {
    lines.push("", "## Scenario coverage", "");
    for (const scenario of report.scenarioCoverage) {
      lines.push(
        `- [${scenario.pass ? "x" : " "}] ${scenario.caseId} -> ${scenario.runtimeCaseId} (${scenario.kind}, ${scenario.transport})`,
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
      `- Scenario fixtures: \`${report.hashes.scenarioFixtures}\``,
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
