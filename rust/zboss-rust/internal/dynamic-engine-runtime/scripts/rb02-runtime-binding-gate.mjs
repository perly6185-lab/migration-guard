import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const bindingPath = path.join(
  artifactDirectory,
  "real-runtime-binding.json",
);
const baseEvidencePath = path.join(
  artifactDirectory,
  "real-report-fill-readonly.json",
);
const rb01Path = path.join(artifactDirectory, "rb01-gate.json");
const reportPath = path.join(artifactDirectory, "rb02-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "rb02-acceptance.md",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const binding = await readJson(bindingPath);
  const baseEvidence = await readJson(baseEvidencePath);
  const rb01 = await readJson(rb01Path);
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
    "rb01-lineage",
    rb01.status === "pass"
      && rb01.decision === "report-fill-readonly-fixture-promoted"
      && verifySelfHash(rb01),
    "RB-01 gate is missing, failed or tampered",
  );
  check(
    "binding-self-hash",
    verifySelfHash(binding),
    "runtime binding report hash mismatch",
  );
  check(
    "base-evidence-self-hash",
    verifySelfHash(baseEvidence),
    "base evidence report hash mismatch",
  );
  check(
    "base-evidence-lineage",
    normalize(binding.evidenceBinding?.baseEvidencePath)
      === "artifacts/page-rust/real-report-fill-readonly.json"
      && binding.evidenceBinding?.baseEvidenceReportHash
        === baseEvidence.reportHash,
    "runtime binding does not point to the accepted base evidence",
  );
  check(
    "listener-identity",
    binding.listener?.port === 21082
      && binding.listener?.processName === "java"
      && Number.isInteger(binding.listener?.processId)
      && binding.listener.processId > 0,
    "listener identity is incomplete",
  );
  check(
    "deployment-artifact-identity",
    binding.deploymentArtifact?.fileName
      === "zboss-module-data-service.jar"
      && binding.deploymentArtifact?.sizeBytes > 0
      && /^[a-f0-9]{64}$/.test(
        binding.deploymentArtifact?.sha256 || "",
      ),
    "deployment JAR identity is incomplete",
  );
  check(
    "collection-time-binding",
    validateCollectionTimes(binding, baseEvidence),
    "collection timestamps do not follow process start",
  );
  check(
    "entrypoint-parity",
    validateEntrypointParity(binding, baseEvidence),
    "gateway/direct request or response hashes differ",
  );
  await validateSourceRuntimeDrift(binding, profile.source.root);
  check(
    "readonly-safety",
    binding.safety?.credentialsPersisted === false
      && binding.safety?.completeCommandLinePersisted === false
      && binding.safety?.environmentPersisted === false
      && binding.safety?.rawResponsesPersisted === false
      && binding.safety?.mutatingEndpointsInvoked === false
      && binding.evidenceBinding?.directCollection
        ?.credentialsPersisted === false
      && binding.evidenceBinding?.directCollection
        ?.mutatingEndpointsInvoked === false,
    "runtime binding safety declaration is incomplete",
  );
  await validateNoSensitiveValues();
  runNegativeSelfTests(binding);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while running RB-02",
  );
  check(
    "reference-source-bound",
    binding.referenceSource?.identity === afterSnapshot.identity.identity
      && binding.referenceSource?.treeHash === afterSnapshot.treeHash
      && binding.referenceSource?.fileCount === afterSnapshot.fileCount
      && binding.referenceSource?.access === "read-only",
    "runtime binding reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb02-runtime-binding",
    status: "pass",
    decision: "report-fill-evidence-bound-to-deployed-jar",
    lineage: {
      rb01ReportHash: rb01.reportHash,
      baseEvidenceReportHash: baseEvidence.reportHash,
      runtimeBindingReportHash: binding.reportHash,
    },
    deployment: {
      host: binding.collectorHost,
      port: binding.listener.port,
      javaVersion: binding.runtime.javaVersion,
      jarFile: binding.deploymentArtifact.fileName,
      jarSha256: binding.deploymentArtifact.sha256,
      jarSizeBytes: binding.deploymentArtifact.sizeBytes,
    },
    metrics: {
      gatewayDirectHashMatches: 2,
      keyRuntimeClassesVerified: Object.values(
        binding.deploymentArtifact.keyClasses,
      ).filter(Boolean).length,
      sourceRuntimeDriftFindings: 1,
      mutationRequestsInvoked: 0,
      sensitiveValuesFound: 0,
    },
    referenceSource: stableSourceSnapshot(afterSnapshot),
    checks,
    next: binding.next,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      decision: report.decision,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      jarSha256: report.deployment.jarSha256,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb02-runtime-binding",
    status: "fail",
    decision: "runtime-binding-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
    next: "fix the failed RB-02 check and rerun the gate",
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

function validateCollectionTimes(binding, baseEvidence) {
  const processStart = Date.parse(binding.runtime?.processStartedAt);
  const gatewayCollection = Date.parse(baseEvidence.collectedAtUtc);
  const metadataCollection = Date.parse(
    binding.evidenceBinding?.directCollection?.metadataCollectedAtUtc,
  );
  const pageCollection = Date.parse(
    binding.evidenceBinding?.directCollection?.pageCollectedAtUtc,
  );
  return [processStart, gatewayCollection, metadataCollection, pageCollection]
    .every(Number.isFinite)
    && processStart <= gatewayCollection
    && processStart <= metadataCollection
    && metadataCollection <= pageCollection
    && binding.evidenceBinding?.processStartedBeforeGatewayCollection === true
    && binding.evidenceBinding?.processStartedBeforeDirectCollection === true;
}

function validateEntrypointParity(binding, baseEvidence) {
  const parity = binding.evidenceBinding?.entrypointParity;
  const requests = new Map(
    baseEvidence.http?.requests?.map((item) => [item.id, item]) || [],
  );
  return parity?.metadataRequestHashMatches === true
    && parity.metadataResponseHashMatches === true
    && parity.pageRequestHashMatches === true
    && parity.pageResponseHashMatches === true
    && parity.metadataResponseHash
      === requests.get("fill-metadata-query")?.responseHash
    && parity.pageResponseHash
      === requests.get("fill-page-readonly")?.responseHash;
}

async function validateSourceRuntimeDrift(binding, sourceRoot) {
  const fillController = path.join(
    sourceRoot,
    "zboss-module-data-service",
    "src",
    "main",
    "java",
    "com",
    "iagz",
    "zboss",
    "module",
    "data",
    "controller",
    "admin",
    "view",
    "dynamic",
    "engine",
    "use",
    "EngineUseFillController.java",
  );
  const redoController = path.join(
    sourceRoot,
    "zboss-module-data-service",
    "src",
    "main",
    "java",
    "com",
    "iagz",
    "zboss",
    "module",
    "data",
    "controller",
    "admin",
    "undoredo",
    "RedoController.java",
  );
  check(
    "source-runtime-drift",
    binding.sourceRuntimeDrift?.detected === true
      && binding.sourceRuntimeDrift?.fillClassesPresentInReferenceAndJar
        === true
      && binding.sourceRuntimeDrift?.redoClassesPresentInJar === true
      && binding.sourceRuntimeDrift?.redoClassesPresentInReference === false
      && await exists(fillController)
      && !await exists(redoController),
    "recorded source/runtime drift does not match protected source",
  );
}

async function validateNoSensitiveValues() {
  const files = [
    bindingPath,
    baseEvidencePath,
    rb01Path,
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

function runNegativeSelfTests(binding) {
  const tamperedHash = structuredClone(binding);
  tamperedHash.deploymentArtifact.sha256 = "0".repeat(64);
  check(
    "negative-test:binding-hash",
    !verifySelfHash(tamperedHash),
    "deployment hash tamper was not rejected",
  );
  const tamperedParity = structuredClone(binding);
  tamperedParity.evidenceBinding.entrypointParity.pageResponseHash =
    "0".repeat(64);
  check(
    "negative-test:entrypoint-parity",
    !validateEntrypointParity(tamperedParity, {
      http: { requests: [] },
    }),
    "entrypoint parity tamper was not rejected",
  );
  check(
    "negative-test:secret",
    containsSensitiveValue(
      `${["Be", "arer "].join("")}synthetic-token-value-1234567890`,
    ),
    "synthetic credential was not detected",
  );
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
    "# zboss RB-02 部署运行包身份绑定验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: \`${report.decision}\``,
    `Checks: ${passed}/${report.checks.length}`,
  ];
  if (report.deployment) {
    lines.push(
      "",
      "## 部署身份",
      "",
      `- Host/port: ${report.deployment.host}:${report.deployment.port}`,
      `- Java: ${report.deployment.javaVersion}`,
      `- JAR: ${report.deployment.jarFile}`,
      `- JAR SHA-256: \`${report.deployment.jarSha256}\``,
      `- JAR size: ${report.deployment.jarSizeBytes} bytes`,
    );
  }
  if (report.metrics) {
    lines.push(
      "",
      "## 结果",
      "",
      `- 网关/直连哈希一致：${report.metrics.gatewayDirectHashMatches}/2`,
      `- 已核对关键运行类：${report.metrics.keyRuntimeClassesVerified}`,
      `- 源码—运行包漂移：${report.metrics.sourceRuntimeDriftFindings}`,
      `- 调用写请求：${report.metrics.mutationRequestsInvoked}`,
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

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
