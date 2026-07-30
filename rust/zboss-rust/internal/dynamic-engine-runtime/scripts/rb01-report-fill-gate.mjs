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
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const fixtureDirectory = path.join(
  repositoryRoot,
  "cases",
  "zboss-page",
  "fixtures",
  "real-readonly",
  "report-fill",
);
const evidencePath = path.join(
  repositoryRoot,
  "artifacts",
  "page-rust",
  "real-report-fill-readonly.json",
);
const artifactDirectory = path.join(
  repositoryRoot,
  "artifacts",
  "page-rust",
);
const reportPath = path.join(artifactDirectory, "rb01-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "rb01-acceptance.md",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const manifest = await readJson(path.join(fixtureDirectory, "manifest.json"));
  const evidence = await readJson(evidencePath);
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
    "fixture-contract",
    validateManifest(manifest).length === 0,
    validateManifest(manifest).join("; "),
  );
  await validateFixtureFiles(manifest);
  check(
    "evidence-self-hash",
    verifySelfHash(evidence),
    "real evidence report hash mismatch",
  );
  check(
    "fixture-evidence-lineage",
    manifest.evidence?.reportHash === evidence.reportHash
      && normalize(manifest.evidence?.path)
        === "artifacts/page-rust/real-report-fill-readonly.json"
      && evidence.fixture?.status === "accepted"
      && normalize(evidence.fixture?.path)
        === "cases/zboss-page/fixtures/real-readonly/report-fill",
    "fixture and evidence lineage do not match",
  );
  check(
    "observed-contract",
    validateObservedContract(manifest, evidence),
    "observed response hashes or response shape do not match",
  );
  check(
    "readonly-safety",
    evidence.authorization?.httpReadOnly === true
      && evidence.authorization?.mysqlReadOnly === true
      && evidence.authorization?.refreshAuthorized === false
      && evidence.safety?.mutatingEndpointsInvoked === false
      && evidence.safety?.mysqlSessionReadOnlyForced === true
      && evidence.safety?.credentialsPersisted === false
      && evidence.safety?.rawResponsesPersisted === false
      && evidence.safety?.businessFieldValuesPersisted === false,
    "read-only safety attestation is incomplete",
  );
  await validateNoSensitiveValues();
  runNegativeSelfTests(manifest, evidence);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while running RB-01",
  );
  check(
    "reference-source-bound",
    manifest.referenceSourcePolicy?.identity
      === afterSnapshot.identity.identity
      && manifest.referenceSourcePolicy?.treeHash === afterSnapshot.treeHash
      && manifest.referenceSourcePolicy?.fileCount === afterSnapshot.fileCount
      && evidence.referenceSource?.identity
        === afterSnapshot.identity.identity
      && evidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && evidence.referenceSource?.fileCount === afterSnapshot.fileCount,
    "fixture/evidence reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb01-report-fill",
    status: "pass",
    decision: "report-fill-readonly-fixture-promoted",
    fixture: {
      path: relative(fixtureDirectory),
      manifestHash: await hashFile(
        path.join(fixtureDirectory, "manifest.json"),
      ),
      queryHash: await hashFile(path.join(fixtureDirectory, "query.json")),
      pageHash: await hashFile(path.join(fixtureDirectory, "page.json")),
      evidenceReportHash: evidence.reportHash,
    },
    metrics: {
      acceptedReadRequests: manifest.requests.length,
      observedResponseGroups:
        manifest.observedContract.responseKeys.length,
      observedRows: manifest.observedContract.rowsPerGroup.reduce(
        (sum, count) => sum + count,
        0,
      ),
      successfulRepeatHashesMatched: 2,
      mutationRequestsPromoted: 0,
      sensitiveValuesFound: 0,
    },
    referenceSource: stableSourceSnapshot(afterSnapshot),
    checks,
    next: "RB-02: bind the real evidence to the deployed service JAR identity",
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      decision: report.decision,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb01-report-fill",
    status: "fail",
    decision: "report-fill-readonly-fixture-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
    next: "fix the failed RB-01 check and rerun the gate",
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

function validateManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion");
  if (manifest.status !== "accepted") errors.push("status");
  if (manifest.fixtureKind !== "real-runtime-readonly") {
    errors.push("fixtureKind");
  }
  if (manifest.realEvidenceEligible !== true) {
    errors.push("realEvidenceEligible");
  }
  if (manifest.scope !== "read-only") errors.push("scope");
  if (manifest.promotionId !== "RB-01") errors.push("promotionId");
  if (!Array.isArray(manifest.requests) || manifest.requests.length !== 2) {
    errors.push("request-count");
  }
  const allowedPaths = new Set([
    "/zboss/data/view/dynamic/engine/use/engine-use-fill/query",
    "/zboss/data/view/dynamic/engine/use/engine-use-fill/page",
  ]);
  for (const request of manifest.requests || []) {
    if (request.method !== "POST") errors.push(`${request.id}:method`);
    if (request.effect !== "read") errors.push(`${request.id}:effect`);
    if (!allowedPaths.has(request.path)) errors.push(`${request.id}:path`);
    if (/refresh|update|delete/i.test(request.path)) {
      errors.push(`${request.id}:mutation-path`);
    }
    if (!/^[a-f0-9]{64}$/.test(request.fileHash || "")) {
      errors.push(`${request.id}:fileHash`);
    }
  }
  if (manifest.executionSafety?.injectSkipSavePageSize !== true) {
    errors.push("skipSavePageSize");
  }
  if (manifest.executionSafety?.mysqlSessionReadOnly !== true) {
    errors.push("mysqlSessionReadOnly");
  }
  if (manifest.executionSafety?.mutatingEndpointsAllowed !== false) {
    errors.push("mutatingEndpointsAllowed");
  }
  return errors;
}

async function validateFixtureFiles(manifest) {
  for (const request of manifest.requests) {
    const file = path.join(fixtureDirectory, request.file);
    check(
      `fixture-hash:${request.id}`,
      await hashFile(file) === request.fileHash,
      `${request.file} hash mismatch`,
    );
    const body = await readJson(file);
    check(
      `fixture-body-safety:${request.id}`,
      !containsMutationInstruction(body)
        && !containsSensitiveValue(JSON.stringify(body)),
      `${request.file} contains a mutation instruction or sensitive value`,
    );
  }
}

function validateObservedContract(manifest, evidence) {
  const requests = new Map(
    (evidence.http?.requests || []).map((request) => [request.id, request]),
  );
  const metadata = requests.get("fill-metadata-query");
  const page = requests.get("fill-page-readonly");
  const contract = manifest.observedContract;
  return metadata?.status === 200
    && metadata.businessCode === 0
    && metadata.responseHash === contract.metadataResponseHash
    && metadata.successfulRepeatHashMatches === true
    && metadata.summary?.panels === contract.panelCount
    && page?.status === 200
    && page.businessCode === 0
    && page.responseHash === contract.pageResponseHash
    && page.successfulRepeatHashMatches === true
    && stableStringify(page.summary?.responseKeys)
      === stableStringify(contract.responseKeys)
    && stableStringify(page.summary?.rowsPerGroup)
      === stableStringify(contract.rowsPerGroup);
}

async function validateNoSensitiveValues() {
  const files = [
    path.join(fixtureDirectory, "manifest.json"),
    path.join(fixtureDirectory, "query.json"),
    path.join(fixtureDirectory, "page.json"),
    evidencePath,
    path.join(
      repositoryRoot,
      "artifacts",
      "page-rust",
      "real-report-fill-acceptance.md",
    ),
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

function runNegativeSelfTests(manifest, evidence) {
  const mutationManifest = structuredClone(manifest);
  mutationManifest.requests[0].path =
    "/zboss/data/view/dynamic/engine/use/engine-use-page/refreshSync";
  check(
    "negative-test:mutation-path",
    validateManifest(mutationManifest).length > 0,
    "mutation path tamper was not rejected",
  );
  const tamperedEvidence = structuredClone(evidence);
  tamperedEvidence.http.requests[0].responseHash = "0".repeat(64);
  check(
    "negative-test:evidence-hash",
    !verifySelfHash(tamperedEvidence),
    "evidence tamper was not rejected",
  );
  check(
    "negative-test:secret",
    containsSensitiveValue(
      `Authorization: ${["Be", "arer "].join("")}`
        + "synthetic-token-value-1234567890",
    ),
    "synthetic bearer token was not detected",
  );
}

function containsMutationInstruction(value) {
  if (Array.isArray(value)) return value.some(containsMutationInstruction);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        (/operator/i.test(key) && /refresh|update|delete/i.test(String(item)))
        || containsMutationInstruction(item),
    );
  }
  return false;
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
    "# zboss 报表 Fill RB-01 只读 fixture 晋级验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: \`${report.decision}\``,
    `Checks: ${passed}/${report.checks.length}`,
  ];
  if (report.metrics) {
    lines.push(
      "",
      "## 结果",
      "",
      `- 正式只读请求：${report.metrics.acceptedReadRequests}`,
      `- 响应分组：${report.metrics.observedResponseGroups}`,
      `- 已观测行数：${report.metrics.observedRows}`,
      `- 成功重复哈希一致：${report.metrics.successfulRepeatHashesMatched}/2`,
      `- 晋级写请求：${report.metrics.mutationRequestsPromoted}`,
      `- 敏感值命中：${report.metrics.sensitiveValuesFound}`,
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
  return sha256(await readFile(file));
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
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
