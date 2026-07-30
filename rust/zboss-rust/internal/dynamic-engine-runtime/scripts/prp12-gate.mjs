import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const reportPath = path.join(artifactDirectory, "prp12-gate.json");
const acceptancePath = path.join(artifactDirectory, "prp12-acceptance.md");
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp12-progress.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;
let failedReplay;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-12", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp12",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-12 阶段验收\n\nStatus: RUNNING\n",
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

  const { config, replays } = await validateProperties();
  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  const propertyTests = runCommand(
    "prp12-property-tests",
    "cargo",
    [
      "test",
      "--test",
      "prp12_properties",
      "--all-features",
      "--offline",
    ],
    serviceRoot,
  );
  if (!/test result: ok\. 8 passed/.test(propertyTests.output)) {
    throw new Error("PRP-12 did not execute all 7 properties plus config test");
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
  const propertyCoverage = config.properties.map((property) => ({
    ...property,
    pass: true,
  }));
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp12",
    status,
    decision: status === "pass" ? "prp12-accepted" : "prp12-rejected",
    scope: {
      completedItems: ["PRP-12"],
      referenceSourceAccess: "read-only",
      generator: config.generator,
      failureMarker:
        "PROPERTY_FAILURE property=<id> seed=<u64> iteration=<n>",
    },
    propertyCoverage,
    replayedFailureSeeds: replays.replays,
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      propertiesPassed: propertyCoverage.length,
      propertiesFailed: 0,
      generatedCases: propertyCoverage.reduce(
        (total, property) => total + property.iterations,
        0,
      ),
      replayedFailuresPassed: replays.replays.length,
      rustTestsPassed: testCount,
    },
    hashes: {
      propertyFixtures: await hashSelectedTree(serviceRoot, ["fixtures/prp12"]),
      implementation: await hashSelectedTree(serviceRoot, [
        "src",
        "tests/prp12_properties.rs",
      ]),
    },
    checks,
    next: "PRP-13 offline dual-path replay",
  };
  const reportHash = sha256(Buffer.from(JSON.stringify(payload), "utf8"));
  const report = { ...payload, reportHash };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp12",
    status: "fail",
    decision: "prp12-rejected",
    error: error instanceof Error ? error.message : String(error),
    failedSeed: failedReplay,
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

async function validateProperties() {
  const root = path.join(serviceRoot, "fixtures", "prp12");
  const config = JSON.parse(
    await readFile(path.join(root, "property-config.json"), "utf8"),
  );
  const replays = JSON.parse(
    await readFile(path.join(root, "replay-regressions.json"), "utf8"),
  );
  const expectedIds = [
    "where-before-having",
    "horizontal-pages-exact",
    "having-survivor-union",
    "average-full-sum-count",
    "composite-key-collision-free",
    "terminal-effect-unique",
    "failure-path-eventual-unlock",
  ];
  if (
    config.schemaVersion !== 1
    || config.stage !== "PRP-12"
    || config.generator !== "lcg64-v1"
    || JSON.stringify(config.properties?.map((entry) => entry.propertyId))
      !== JSON.stringify(expectedIds)
    || new Set(config.properties?.map((entry) => entry.seed)).size !== 7
    || config.properties.some(
      (entry) => !Number.isSafeInteger(entry.seed)
        || entry.seed === 0
        || !Number.isInteger(entry.iterations)
        || entry.iterations < 64,
    )
  ) {
    throw new Error("PRP-12 fixed-seed property configuration is invalid");
  }
  if (
    replays.schemaVersion !== 1
    || replays.stage !== "PRP-12"
    || !Array.isArray(replays.replays)
    || replays.replays.some(
      (entry) => !expectedIds.includes(entry.propertyId)
        || !Number.isSafeInteger(entry.seed)
        || entry.seed <= 0
        || !Number.isInteger(entry.iteration)
        || !entry.observedFailure?.trim()
        || !entry.resolution?.trim()
        || entry.status !== "replayed-pass",
    )
  ) {
    throw new Error("PRP-12 failure-seed replay evidence is invalid");
  }
  checks.push({
    id: "property-fixtures",
    command: "validate 7 fixed seeds, iterations and replay evidence",
    pass: true,
  });
  return { config, replays };
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
    const replay = output.match(
      /PROPERTY_FAILURE property=(\S+) seed=(\S+) iteration=(\d+)/,
    );
    if (replay) {
      failedReplay = {
        propertyId: replay[1],
        seed: replay[2],
        iteration: Number(replay[3]),
      };
    }
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
    "# `/page` Rust PRP-12 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Properties: ${report.metrics.propertiesPassed}/7`,
      `Generated cases: ${report.metrics.generatedCases}`,
      `Failure seeds replayed: ${report.metrics.replayedFailuresPassed}`,
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
    );
  }
  if (report.propertyCoverage) {
    lines.push("", "## Fixed-seed properties", "");
    for (const property of report.propertyCoverage) {
      lines.push(
        `- [${property.pass ? "x" : " "}] ${property.propertyId}: seed=\`${property.seed}\`, iterations=${property.iterations}`,
      );
    }
  }
  if (report.replayedFailureSeeds?.length) {
    lines.push("", "## Replayed failure seeds", "");
    for (const replay of report.replayedFailureSeeds) {
      lines.push(
        `- [x] ${replay.propertyId}: seed=\`${replay.seed}\`, iteration=${replay.iteration}, status=${replay.status}`,
      );
    }
  }
  if (report.failedSeed) {
    lines.push(
      "",
      "## Failed seed",
      "",
      `- Property: ${report.failedSeed.propertyId}`,
      `- Seed: \`${report.failedSeed.seed}\``,
      `- Iteration: ${report.failedSeed.iteration}`,
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
  if (report.hashes) {
    lines.push(
      "",
      "## Reproducible hashes",
      "",
      `- Property fixtures: \`${report.hashes.propertyFixtures}\``,
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
