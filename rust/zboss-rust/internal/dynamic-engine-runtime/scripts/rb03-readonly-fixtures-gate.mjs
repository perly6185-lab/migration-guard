import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const evidencePath = path.join(
  artifactDirectory,
  "real-rb03-readonly.json",
);
const rb02Path = path.join(artifactDirectory, "rb02-gate.json");
const reportPath = path.join(artifactDirectory, "rb03-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "rb03-acceptance.md",
);
const fixtureRoot = path.join(
  repositoryRoot,
  "cases",
  "zboss-page",
  "fixtures",
  "real-readonly",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const evidence = await readJson(evidencePath);
  const rb02 = await readJson(rb02Path);
  const profile = await readJson(
    path.join(repositoryRoot, "cases", "zboss-page", "profile.json"),
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
  const beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  check(
    "rb02-lineage",
    rb02.status === "pass"
      && rb02.decision === "report-fill-evidence-bound-to-deployed-jar"
      && verifySelfHash(rb02),
    "RB-02 gate is missing, failed or tampered",
  );
  check(
    "rb03-evidence-self-hash",
    verifySelfHash(evidence),
    "RB-03 evidence hash mismatch",
  );
  check(
    "rb03-scope",
    evidence.status === "partial-pass"
      && evidence.decision
        === "child-and-horizontal-accepted-three-fixtures-blocked"
      && evidence.accepted?.length === 2
      && evidence.blocked?.length === 3,
    "RB-03 accepted/blocked scope is inconsistent",
  );

  for (const scenario of evidence.accepted) {
    await validateAcceptedFixture(scenario, evidence);
  }
  validateBlockedScenarios(evidence);
  check(
    "readonly-safety",
    evidence.safety?.credentialsPersisted === false
      && evidence.safety?.rawResponsesPersisted === false
      && evidence.safety?.businessFieldValuesPersisted === false
      && evidence.safety?.mutatingEndpointsInvoked === false
      && evidence.safety?.mysqlSessionReadOnlyForced === true
      && evidence.safety?.pagePreferenceWriteSuppressed === true,
    "RB-03 read-only safety declaration is incomplete",
  );
  await validateNoSensitiveValues(evidence);
  runNegativeSelfTests(evidence);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while running RB-03",
  );
  check(
    "reference-source-bound",
    evidence.referenceSource?.identity === afterSnapshot.identity.identity
      && evidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && evidence.referenceSource?.fileCount === afterSnapshot.fileCount
      && evidence.referenceSource?.access === "read-only",
    "RB-03 reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-readonly-fixtures",
    status: "pass",
    complete: false,
    decision: "rb03-partial-accepted-with-explicit-blockers",
    lineage: {
      rb02ReportHash: rb02.reportHash,
      evidenceReportHash: evidence.reportHash,
    },
    metrics: {
      plannedFixtures: 5,
      acceptedFixtures: 2,
      blockedFixtures: 3,
      acceptedResponseGroups: evidence.accepted.reduce(
        (sum, item) => sum + item.responseGroups,
        0,
      ),
      successfulRepeatHashesMatched: evidence.accepted.filter(
        (item) => item.successfulRepeatHashMatches,
      ).length,
      noOpDiagnosticProbesRejectedAsCoverage: 1,
      mutationRequestsInvoked: 0,
      sensitiveValuesFound: 0,
    },
    accepted: evidence.accepted.map((item) => ({
      scenarioId: item.scenarioId,
      responseHash: item.responseHash,
      fixturePath: item.fixturePath,
    })),
    blockers: evidence.blocked.map((item) => ({
      scenarioId: item.scenarioId,
      reason: item.reason,
      required: item.required,
    })),
    referenceSource: stableSourceSnapshot(afterSnapshot),
    checks,
    next: evidence.next,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      complete: report.complete,
      decision: report.decision,
      accepted: `${report.metrics.acceptedFixtures}/${report.metrics.plannedFixtures}`,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-readonly-fixtures",
    status: "fail",
    complete: false,
    decision: "rb03-integrity-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
    next: "fix the failed RB-03 integrity check and rerun the gate",
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  throw error;
}

function runTypeScriptBuild() {
  const compiler = path.join(
    repositoryRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", "tsconfig.json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  check(
    "typescript-build",
    result.status === 0 && !result.error,
    result.error?.message || result.stderr || result.stdout,
  );
}

async function validateAcceptedFixture(scenario, evidence) {
  const directory = path.join(repositoryRoot, scenario.fixturePath);
  const manifest = await readJson(path.join(directory, "manifest.json"));
  const requestPath = path.join(directory, manifest.request?.file || "");
  check(
    `fixture-contract:${scenario.scenarioId}`,
    manifest.status === "accepted"
      && manifest.fixtureKind === "real-runtime-readonly"
      && manifest.realEvidenceEligible === true
      && manifest.scope === "read-only"
      && manifest.scenarioId === scenario.scenarioId
      && manifest.promotionId === "RB-03"
      && manifest.request?.effect === "read"
      && !/refresh|update|delete/i.test(manifest.request?.path || "")
      && manifest.executionSafety?.injectSkipSavePageSize === true
      && manifest.executionSafety?.mutatingEndpointsAllowed === false,
    `${scenario.scenarioId} manifest contract is invalid`,
  );
  check(
    `fixture-hash:${scenario.scenarioId}`,
    await hashFile(requestPath) === scenario.requestFileHash
      && manifest.request.fileHash === scenario.requestFileHash,
    `${scenario.scenarioId} request hash mismatch`,
  );
  check(
    `fixture-evidence-lineage:${scenario.scenarioId}`,
    normalize(manifest.evidence?.path)
      === "artifacts/page-rust/real-rb03-readonly.json"
      && manifest.evidence?.reportHash === evidence.reportHash
      && manifest.observedContract?.responseHash === scenario.responseHash
      && manifest.observedContract?.successfulRepeatHashMatches === true,
    `${scenario.scenarioId} evidence lineage mismatch`,
  );
}

function validateBlockedScenarios(evidence) {
  const blocked = new Map(
    evidence.blocked.map((item) => [item.scenarioId, item]),
  );
  check(
    "quality-noop-rejected",
    blocked.get("quality-filter")?.diagnosticProbe
      ?.matchesUnfilteredBaseline === true
      && blocked.get("quality-filter")?.diagnosticProbe
        ?.acceptedAsCoverage === false
      && blocked.get("quality-filter")?.configuration
        ?.nullSemanticFields === 0,
    "quality no-op probe was incorrectly accepted",
  );
  check(
    "temporary-table-blocked",
    blocked.get("temporary-table-page")?.acceptedAsCoverage === false
      && evidence.authorization?.temporaryTableCreationAuthorized === false,
    "temporary-table scenario lacks an explicit blocker",
  );
  check(
    "tenant-permission-blocked",
    blocked.get("tenant-permission")?.acceptedAsCoverage === false
      && evidence.authorization?.crossTenantProbeAuthorized === false,
    "tenant-permission scenario lacks an explicit blocker",
  );
}

async function validateNoSensitiveValues(evidence) {
  const files = [
    evidencePath,
    rb02Path,
    ...evidence.accepted.flatMap((scenario) => [
      path.join(repositoryRoot, scenario.fixturePath, "manifest.json"),
      path.join(repositoryRoot, scenario.fixturePath, "request.json"),
    ]),
    path.join(
      repositoryRoot,
      "scripts",
      "probes",
      "zboss-page-readonly-http.py",
    ),
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    check(
      `sensitive-scan:${relative(file)}`,
      !containsSensitiveValue(content),
      `${relative(file)} contains a sensitive value`,
    );
  }
}

function runNegativeSelfTests(evidence) {
  const tampered = structuredClone(evidence);
  tampered.accepted[0].responseHash = "0".repeat(64);
  check(
    "negative-test:evidence-hash",
    !verifySelfHash(tampered),
    "RB-03 evidence tamper was not rejected",
  );
  const falseCoverage = structuredClone(evidence);
  falseCoverage.blocked.find(
    (item) => item.scenarioId === "quality-filter",
  ).diagnosticProbe.acceptedAsCoverage = true;
  let rejected = false;
  try {
    validateBlockedScenariosForTest(falseCoverage);
  } catch {
    rejected = true;
  }
  check(
    "negative-test:no-op-coverage",
    rejected,
    "quality no-op false coverage was not rejected",
  );
  check(
    "negative-test:secret",
    containsSensitiveValue(
      `${["Be", "arer "].join("")}synthetic-token-value-1234567890`,
    ),
    "synthetic credential was not detected",
  );
}

function validateBlockedScenariosForTest(evidence) {
  const quality = evidence.blocked.find(
    (item) => item.scenarioId === "quality-filter",
  );
  if (quality?.diagnosticProbe?.acceptedAsCoverage !== false) {
    throw new Error("quality no-op accepted");
  }
}

function containsSensitiveValue(value) {
  return [
    /Bearer\s+[A-Za-z0-9._-]{12,}/i,
    /(?<!\d)1[3-9]\d{9}(?!\d)/,
    /password\s*[:=]\s*["'][^"']+["']/i,
    /jdbc:mysql:[^\s]+[?&]password=/i,
  ].some((pattern) => pattern.test(value));
}

function verifySelfHash(report) {
  if (!/^[a-f0-9]{64}$/.test(report.reportHash || "")) return false;
  const { reportHash, ...payload } = report;
  return reportHash === stableHash(payload);
}

function check(id, pass, detail = "") {
  checks.push({ id, pass, ...(pass || !detail ? {} : { detail: tail(detail) }) });
  if (!pass) throw new Error(`${id}: ${detail || "failed"}`);
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
  const passed = report.checks.filter((item) => item.pass).length;
  const lines = [
    "# zboss RB-03 剩余只读 fixture 验收",
    "",
    `Status: ${report.status === "pass" ? "PARTIAL PASS" : "FAIL"}`,
    "",
    `Complete: ${report.complete ? "YES" : "NO"}`,
    `Decision: \`${report.decision}\``,
    `Checks: ${passed}/${report.checks.length}`,
  ];
  if (report.metrics) {
    lines.push(
      "",
      "## 结果",
      "",
      `- 已验收 fixture：${report.metrics.acceptedFixtures}/${report.metrics.plannedFixtures}`,
      `- 阻塞 fixture：${report.metrics.blockedFixtures}`,
      `- 成功重复哈希一致：${report.metrics.successfulRepeatHashesMatched}/2`,
      `- 被拒绝的无效覆盖：${report.metrics.noOpDiagnosticProbesRejectedAsCoverage}`,
      `- 调用写请求：${report.metrics.mutationRequestsInvoked}`,
      `- 敏感值命中：${report.metrics.sensitiveValuesFound}`,
    );
  }
  if (report.accepted) {
    lines.push(
      "",
      "## 已验收",
      "",
      ...report.accepted.map(
        (item) => `- ${item.scenarioId}: \`${item.responseHash}\``,
      ),
    );
  }
  if (report.blockers) {
    lines.push(
      "",
      "## 明确阻塞",
      "",
      ...report.blockers.map(
        (item) =>
          `- ${item.scenarioId}: ${item.reason}; required: ${item.required}`,
      ),
    );
  }
  if (report.referenceSource) {
    lines.push(
      "",
      "## 参考源码保护",
      "",
      `- Identity: \`${report.referenceSource.identity}\``,
      `- Files: ${report.referenceSource.fileCount}`,
      `- Tree hash: \`${report.referenceSource.treeHash}\``,
    );
  }
  lines.push("", "## 门禁", "");
  for (const item of report.checks) {
    lines.push(`- [${item.pass ? "x" : " "}] ${item.id}`);
  }
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("", `Next: ${report.next}`, "");
  return lines.join("\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function stableHash(value) {
  return createHash("sha256")
    .update(Buffer.from(stableStringify(value), "utf8"))
    .digest("hex");
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

function normalize(value) {
  return String(value || "").replaceAll("\\", "/");
}

function relative(file) {
  return normalize(path.relative(repositoryRoot, file));
}

function tail(value, maximum = 2_000) {
  return value.length <= maximum ? value : value.slice(-maximum);
}
