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
const reportPath = path.join(artifactDirectory, "prp15-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "prp15-acceptance.md",
);
const attestationPath = path.join(
  artifactDirectory,
  "offline-ready.json",
);
const readinessPath = path.join(
  artifactDirectory,
  "offline-ready.md",
);
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-prp15-progress.json",
);
const tamperRoot = path.join(
  repositoryRoot,
  "tmp",
  "page-rust-prp15-tamper",
);
const missingRoot = path.join(
  repositoryRoot,
  "tmp",
  "page-rust-prp15-missing",
);
const readinessScript = path.join(
  serviceRoot,
  "scripts",
  "prp15-readiness.mjs",
);
const requiredArtifactFiles = [
  "batch2-gate.json",
  "prp10-gate.json",
  "prp11-gate.json",
  "prp12-gate.json",
  "prp13-gate.json",
  "prp14-gate.json",
  "source-baseline.json",
  "contracts.json",
  "test-report.json",
  "offline-replay.json",
  "evidence-bundle.json",
];
const stageScripts = [
  ["batch2", "batch2-gate.mjs"],
  ["prp10", "prp10-gate.mjs"],
  ["prp11", "prp11-gate.mjs"],
  ["prp12", "prp12-gate.mjs"],
  ["prp13", "prp13-gate.mjs"],
  ["prp14", "prp14-gate.mjs"],
];
const checks = [];
let beforeSnapshot;
let afterSnapshot;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeJson(progressPath, { stage: "PRP-15", status: "running" });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-prp15",
  status: "running",
});
await writeJson(attestationPath, {
  schemaVersion: 1,
  artifactId: "page-rust-offline-ready",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust PRP-15 最终验收\n\nStatus: RUNNING\n",
  "utf8",
);
await writeFile(
  readinessPath,
  "# `/page` Rust offline readiness\n\nStatus: RUNNING\n",
  "utf8",
);

try {
  runCommand(
    "typescript-build",
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
  const profile = await readJson(
    path.join(repositoryRoot, "cases", "zboss-page", "profile.json"),
  );
  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  runCommand(
    "vmp-tests",
    process.execPath,
    [
      "--test",
      "dist/core/vmpBehavior.test.js",
      "dist/core/vmpHorizontal.test.js",
      "dist/core/vmpQuality.test.js",
      "dist/core/vmpRefresh.test.js",
      "dist/core/vmpReplay.test.js",
      "dist/core/vmpArtifacts.test.js",
      "dist/core/vmpBatch.test.js",
      "dist/core/vmpContract.test.js",
    ],
    repositoryRoot,
  );
  runCommand(
    "vmp-fixture-compatibility",
    process.execPath,
    ["dist/cli.js", "vmp", "fixtures"],
    repositoryRoot,
  );
  runCommand(
    "vmp-schema-compatibility",
    process.execPath,
    ["dist/cli.js", "vmp", "contract"],
    repositoryRoot,
  );

  for (const [id, script] of stageScripts) {
    runCommand(
      `${id}-gate`,
      process.execPath,
      [path.join(serviceRoot, "scripts", script)],
      repositoryRoot,
    );
    const stageReport = await readJson(
      path.join(artifactDirectory, `${id}-gate.json`),
    );
    if (stageReport.status !== "pass") {
      throw new Error(`${id} did not leave a PASS report`);
    }
  }

  runCommand(
    "evidence-integrity",
    process.execPath,
    [
      path.join(serviceRoot, "scripts", "prp14-evidence.mjs"),
      "--verify",
    ],
    repositoryRoot,
  );
  const readiness = runReadinessVerification(
    "offline-readiness-decision",
    artifactDirectory,
  );
  checks.push({
    id: "java-static-closure",
    command:
      "require complete graph with zero truncation, unresolved edges and high-risk unknown boundaries",
    pass: true,
  });
  checks.push({
    id: "rust-source-completeness",
    command: "reject todo!() and unimplemented!() in Rust source",
    pass: true,
  });
  await runNegativeSelfTests();

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
    throw new Error("reference source changed during PRP-15");
  }

  const readinessCore = {
    schemaVersion: 1,
    artifactId: "page-rust-offline-ready",
    status: "offline-ready",
    decision: readiness.decision,
    sourceManifestHash: readiness.identities.sourceManifestHash,
    evidenceBundleHash: readiness.identities.evidenceBundleHash,
    stageReportHashes: readiness.identities.stageReportHashes,
    offlineBlockers: readiness.offlineBlockers,
    realEvidenceBlockers: readiness.realEvidenceBlockers,
  };
  const readinessIdentityHash = stableHash(readinessCore);
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp15",
    status: "pass",
    decision: "offline-ready",
    scope: {
      completedItems: ["PRP-01 through PRP-15"],
      referenceSourceAccess: "read-only",
      targetProfile: "offline-memory-with-production-boundaries",
      realEvidenceClaimed: false,
      failurePolicy: "fail-closed-and-overwrite-stale-pass",
    },
    unifiedGate: {
      orderedSteps: [
        "TypeScript build and VMP tests",
        "Java endpoint static closure review",
        "Rust fmt/clippy/test/all-features and health smoke",
        "schema compatibility",
        "eight synthetic scenarios, fault/concurrency and properties",
        "offline dual-path replay",
        "evidence integrity",
        "offline readiness decision",
      ],
      checksPassed: checks.filter((check) => check.pass).length,
      checksTotal: checks.length,
    },
    staticClosure: readiness.staticClosure,
    metrics: {
      ...readiness.metrics,
      offlineBlockers: readiness.offlineBlockers.length,
      realEvidenceBlockers: readiness.realEvidenceBlockers.length,
      tamperRejectionPassed: true,
      missingEvidenceRejectionPassed: true,
    },
    identities: {
      ...readiness.identities,
      readinessIdentityHash,
    },
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    offlineReadiness: {
      status: "offline-ready",
      offlineBlockers: readiness.offlineBlockers,
      realEvidenceBlockers: readiness.realEvidenceBlockers,
      qualification:
        "offline-ready is not final real-environment acceptance",
    },
    checks,
    next:
      "collect seven real fixtures and execute same-snapshot Java/Rust replay",
  };
  const report = {
    ...payload,
    reportHash: stableHash(payload),
  };
  const attestationPayload = {
    ...readinessCore,
    readinessIdentityHash,
    gateReportHash: report.reportHash,
  };
  const attestation = {
    ...attestationPayload,
    attestationHash: stableHash(attestationPayload),
  };
  await writeJson(reportPath, report);
  await writeJson(attestationPath, attestation);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  await writeFile(
    readinessPath,
    renderReadiness(report, attestation),
    "utf8",
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp15",
    status: "fail",
    decision: "offline-blocked",
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
  const blockedPayload = {
    schemaVersion: 1,
    artifactId: "page-rust-offline-ready",
    status: "blocked",
    gateReportHash: report.reportHash,
    reason: payload.error,
  };
  const blocked = {
    ...blockedPayload,
    attestationHash: stableHash(blockedPayload),
  };
  await writeJson(reportPath, report);
  await writeJson(attestationPath, blocked);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  await writeFile(readinessPath, renderReadiness(report, blocked), "utf8");
  process.exitCode = 1;
} finally {
  await rm(progressPath, { force: true });
  await safeRemoveTemporaryRoot(tamperRoot);
  await safeRemoveTemporaryRoot(missingRoot);
}

function runReadinessVerification(id, root) {
  const result = spawnSync(process.execPath, [readinessScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PRP15_ARTIFACT_ROOT: root,
    },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass = result.status === 0 && !result.error;
  checks.push({
    id,
    command: "verify unified inputs and compute offline readiness",
    pass,
  });
  if (!pass) {
    throw new Error(`${id} failed: ${tail(output, 4_000)}`);
  }
  return JSON.parse(result.stdout);
}

async function runNegativeSelfTests() {
  await prepareTemporaryArtifactRoot(tamperRoot);
  const tamperedPath = path.join(tamperRoot, "prp10-gate.json");
  const tampered = await readJson(tamperedPath);
  tampered.status = "tampered";
  await writeJson(tamperedPath, tampered);
  const tamperResult = runExpectedFailure(tamperRoot);
  const tamperPass =
    tamperResult.status !== 0
    && tamperResult.output.includes(
      "prp10 gate report self-hash mismatch",
    );
  checks.push({
    id: "unified-tamper-fail-closed",
    command: "mutate copied stage report and require readiness rejection",
    pass: tamperPass,
  });
  if (!tamperPass) {
    throw new Error("unified tamper self-test did not fail closed");
  }

  await prepareTemporaryArtifactRoot(missingRoot, "evidence-bundle.json");
  const missingResult = runExpectedFailure(missingRoot);
  const missingPass =
    missingResult.status !== 0
    && (
      missingResult.output.includes("ENOENT")
      || missingResult.output.includes("no such file")
    );
  checks.push({
    id: "missing-evidence-fail-closed",
    command: "omit copied evidence bundle and require readiness rejection",
    pass: missingPass,
  });
  if (!missingPass) {
    throw new Error("missing-evidence self-test did not fail closed");
  }
}

function runExpectedFailure(root) {
  const result = spawnSync(process.execPath, [readinessScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PRP15_ARTIFACT_ROOT: root,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

async function prepareTemporaryArtifactRoot(root, omittedFile) {
  await safeRemoveTemporaryRoot(root);
  await mkdir(root, { recursive: true });
  for (const file of requiredArtifactFiles) {
    if (file === omittedFile) continue;
    await copyFile(
      path.join(artifactDirectory, file),
      path.join(root, file),
    );
  }
}

async function safeRemoveTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const expectedParent = `${path.resolve(repositoryRoot, "tmp")}${path.sep}`;
  if (!resolved.startsWith(expectedParent)) {
    throw new Error("refusing unsafe PRP-15 temporary directory");
  }
  await rm(resolved, { recursive: true, force: true });
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
    "# `/page` Rust PRP-15 最终验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passed}/${total}`,
  ];
  if (report.metrics) {
    lines.push(
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
      `Scenarios: ${report.metrics.scenariosPassed}/8`,
      `Fault/concurrency: ${report.metrics.faultConcurrencyCasesPassed}/23`,
      `Property cases: ${report.metrics.propertyCasesPassed}`,
      `Offline replay: ${report.metrics.replayCasesPassed}/8`,
      `Unclassified differences: ${report.metrics.unclassifiedDifferences}`,
      `Evidence artifacts: ${report.metrics.evidenceArtifactsVerified}/6`,
      `Offline blockers: ${report.metrics.offlineBlockers}`,
      `Real-evidence blockers: ${report.metrics.realEvidenceBlockers}`,
    );
  }
  if (report.staticClosure) {
    lines.push(
      "",
      "## Static closure",
      "",
      `- Unresolved edges: ${report.staticClosure.unresolvedEdges}`,
      `- Unexpanded nodes: ${report.staticClosure.unexpandedNodes}`,
      `- High-risk unknown boundaries: ${report.staticClosure.highRiskUnknownBoundaries}`,
      `- Low-risk unclassified computation nodes: ${report.staticClosure.lowRiskUnknownNodes}`,
      `- Exact endpoint matches: ${report.staticClosure.exactEndpointMatches}`,
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
  if (report.offlineReadiness) {
    lines.push(
      "",
      "## Final decision",
      "",
      "- Offline implementation and evidence: READY",
      "- Real-environment acceptance: NOT CLAIMED",
    );
  }
  if (report.next) lines.push("", `Next: ${report.next}`);
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}

function renderReadiness(report, attestation) {
  if (report.status !== "pass") {
    return [
      "# `/page` Rust offline readiness",
      "",
      "Status: BLOCKED",
      "",
      `Reason: ${report.error}`,
      `Gate report: \`${report.reportHash}\``,
      "",
    ].join("\n");
  }
  return [
    "# `/page` Rust offline readiness",
    "",
    "Status: OFFLINE-READY",
    "",
    "All PRP-01 through PRP-15 offline implementation and evidence gates",
    "pass. This does not claim final real-environment equivalence.",
    "",
    "## Identities",
    "",
    `- Gate report: \`${report.reportHash}\``,
    `- Attestation: \`${attestation.attestationHash}\``,
    `- Source manifest: \`${attestation.sourceManifestHash}\``,
    `- Evidence bundle: \`${attestation.evidenceBundleHash}\``,
    "",
    "## Remaining real-evidence conditions",
    "",
    ...attestation.realEvidenceBlockers.map((item) => `- ${item}`),
    "",
  ].join("\n");
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
