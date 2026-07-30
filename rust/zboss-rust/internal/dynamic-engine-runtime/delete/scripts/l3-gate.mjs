import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-delete-rust");
const reportPath = path.join(artifactRoot, "l3-gate.json");
const replayPath = path.join(artifactRoot, "offline-replay.json");
const acceptancePath = path.join(artifactRoot, "l3-acceptance.md");
const tamperPath = path.join(repositoryRoot, "tmp", "batch-delete-tamper.json");
const profilePath = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-delete",
  "profile.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;

await mkdir(artifactRoot, { recursive: true });
await mkdir(path.dirname(tamperPath), { recursive: true });

try {
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  validateRealFixture();
  run("rust-format", "cargo", ["fmt", "--check"]);
  const tests = run("rust-tests", "cargo", [
    "test",
    "--offline",
    "application::data::delete",
  ]);
  run("rust-clippy", "cargo", [
    "clippy",
    "--all-targets",
    "--offline",
    "--",
    "-D",
    "warnings",
  ]);
  run("memory-driver-build", "cargo", [
    "build",
    "--bin",
    "batch-delete-offline-driver",
    "--offline",
  ]);
  run(
    "offline-dual-replay",
    process.execPath,
    [path.join(serviceRoot, "scripts", "offline-replay.mjs")],
    repositoryRoot,
  );
  const replay = JSON.parse(await readFile(replayPath, "utf8"));
  validateReplay(replay);
  checks.push({ id: "replay-contract", pass: true });
  runTamperTest();

  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  const sourceUnchanged = referenceSourceSnapshotsEqual(
    beforeSnapshot,
    afterSnapshot,
  );
  checks.push({ id: "reference-source-unchanged", pass: sourceUnchanged });
  if (!sourceUnchanged) {
    throw new Error("reference Java source changed during batch-delete gate");
  }

  const testCount = [...tests.output.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-rust-l3",
    status: "pass",
    decision: "L3-OFFLINE-ACCEPTED",
    capability: {
      achieved: "L3",
      blockedNext: "L4-A",
      blockers: [
        "No approved disposable real-write replay has been executed.",
        "Production MySQL, Redis, WebSocket and compensation-worker adapters are not bound.",
        "The Java side of dual replay is a frozen semantic stub rather than fresh runtime evidence.",
      ],
    },
    scope: {
      endpoint: "POST /zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchDelete",
      referenceSourceAccess: "read-only",
      realRequestStatus: "candidate-not-executed",
    },
    sourceSnapshot: stableSnapshot(afterSnapshot),
    metrics: {
      rustTestsPassed: testCount,
      dualReplayCasesPassed: replay.metrics.casesPassed,
      exactCompatibleCases: replay.metrics.exactCompatibleCases,
      approvedCorrectionCases: replay.metrics.approvedCorrectionCases,
      classifiedDifferences: replay.metrics.classifiedDifferences,
      unclassifiedDifferences: replay.metrics.unclassifiedDifferences,
      tamperSelfTestPassed: true,
    },
    replayReportHash: replay.reportHash,
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-rust-l3",
    status: "fail",
    decision: "L3-OFFLINE-REJECTED",
    error: error instanceof Error ? error.message : String(error),
    sourceSnapshot: afterSnapshot
      ? stableSnapshot(afterSnapshot)
      : beforeSnapshot
        ? stableSnapshot(beforeSnapshot)
        : undefined,
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.exitCode = 1;
} finally {
  await rm(tamperPath, { force: true });
}

async function validateRealFixture() {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "cases",
        "zboss-batch-delete",
        "fixtures",
        "real-runtime-candidates",
        "ledger-three-row-delete.json",
      ),
      "utf8",
    ),
  );
  const ids = fixture.request?.batchPostValueList?.map((row) => row.id);
  const pass =
    fixture.fixtureKind === "draft-runtime"
    && fixture.status === "draft"
    && fixture.candidateStatus === "candidate-not-executed-by-migration-guard"
    && fixture.mutationPolicy === "requires-explicit-disposable-write-approval"
    && fixture.request?.operationKind === "ROW_DELETE"
    && fixture.request?.operationLabel === "3 行"
    && stableStringify(ids) === stableStringify([
      "2082397610825953281",
      "2082397610809176066",
      "2082397610804981762",
    ]);
  checks.push({ id: "real-request-fixture", pass });
  if (!pass) throw new Error("real batch-delete request fixture is invalid");
}

function validateReplay(replay) {
  const { reportHash, ...payload } = replay;
  if (
    replay.status !== "pass"
    || replay.decision !== "offline-replay-accepted"
    || replay.metrics?.casesPassed !== 8
    || replay.metrics?.casesFailed !== 0
    || replay.metrics?.exactCompatibleCases !== 6
    || replay.metrics?.approvedCorrectionCases !== 2
    || replay.metrics?.unclassifiedDifferences !== 0
    || replay.cases?.some((item) => item.status !== "pass")
    || reportHash !== stableHash(payload)
  ) {
    throw new Error("offline replay evidence is incomplete or invalid");
  }
}

function runTamperTest() {
  const result = spawnSync(
    process.execPath,
    [path.join(serviceRoot, "scripts", "offline-replay.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        BATCH_DELETE_INJECT_UNCLASSIFIED: "1",
        BATCH_DELETE_REPLAY_OUTPUT: tamperPath,
      },
    },
  );
  const evidence = JSON.parse(
    spawnSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(tamperPath)}, 'utf8'))`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout,
  );
  const pass =
    result.status !== 0
    && evidence.status === "fail"
    && evidence.metrics?.unclassifiedDifferences > 0;
  checks.push({ id: "unclassified-tamper-self-test", pass });
  if (!pass) throw new Error("unclassified drift tamper self-test failed");
}

function run(id, command, args, cwd = engineRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass = result.status === 0 && !result.error;
  checks.push({ id, pass, command: [command, ...args].join(" ") });
  if (!pass) {
    throw new Error(`${id} failed: ${result.error?.message ?? output.slice(-4000)}`);
  }
  return { output };
}

function stableSnapshot(snapshot) {
  return {
    identity: snapshot.identity.identity,
    treeHash: snapshot.treeHash,
    fileCount: snapshot.fileCount,
    directories: snapshot.directories,
  };
}

function renderAcceptance(report) {
  const lines = [
    "# `batchDelete` Rust L3 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
  ];
  if (report.capability) {
    lines.push(
      `Achieved: ${report.capability.achieved}`,
      `Next: ${report.capability.blockedNext}`,
      "",
      "## Evidence",
      "",
      `- Rust tests: ${report.metrics.rustTestsPassed}`,
      `- Dual replay: ${report.metrics.dualReplayCasesPassed}/8`,
      `- Exact-compatible cases: ${report.metrics.exactCompatibleCases}`,
      `- Approved-correction cases: ${report.metrics.approvedCorrectionCases}`,
      `- Unclassified differences: ${report.metrics.unclassifiedDifferences}`,
      `- Tamper rejection: ${report.metrics.tamperSelfTestPassed ? "PASS" : "FAIL"}`,
      `- Reference source files: ${report.sourceSnapshot.fileCount}`,
      `- Reference tree hash: \`${report.sourceSnapshot.treeHash}\``,
      "",
      "## L4-A blockers",
      "",
      ...report.capability.blockers.map((blocker) => `- ${blocker}`),
    );
  }
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
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
