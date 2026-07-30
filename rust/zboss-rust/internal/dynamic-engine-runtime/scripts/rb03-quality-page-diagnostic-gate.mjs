import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..", "..");
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const evidencePath = path.join(
  artifactDirectory,
  "real-quality-page-diagnostic.json",
);
const fixtureDirectory = path.join(
  repositoryRoot,
  "cases",
  "zboss-page",
  "fixtures",
  "real-candidates",
  "quality-filter-diagnostic",
);
const manifestPath = path.join(fixtureDirectory, "manifest.json");
const requestPath = path.join(fixtureDirectory, "request.json");
const reportPath = path.join(
  artifactDirectory,
  "rb03-quality-page-diagnostic-gate.json",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const evidence = await readJson(evidencePath);
  const manifest = await readJson(manifestPath);
  const request = await readJson(requestPath);
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
    "diagnostic-evidence-self-hash",
    verifySelfHash(evidence),
    "quality diagnostic evidence hash mismatch",
  );
  check(
    "diagnostic-classification",
    isRejectedUnfilteredBaseline(evidence),
    "the unfiltered request was incorrectly accepted as quality coverage",
  );
  check(
    "manifest-classification",
    manifest.status === "rejected-as-unfiltered-baseline"
      && manifest.fixtureKind === "real-runtime-readonly-diagnostic"
      && manifest.realEvidenceEligible === false
      && manifest.classification?.acceptedAsQualityCoverage === false,
    "diagnostic manifest classification is invalid",
  );
  check(
    "fixture-request-hash",
    await hashFile(requestPath) === manifest.request?.fileHash,
    "diagnostic request hash mismatch",
  );
  check(
    "fixture-evidence-lineage",
    normalize(manifest.evidence?.path)
      === "artifacts/page-rust/real-quality-page-diagnostic.json"
      && manifest.evidence?.reportHash === evidence.reportHash,
    "diagnostic manifest is not bound to the evidence",
  );
  check(
    "request-is-readonly-baseline",
    request.skipSavePageSize === true
      && !Object.hasOwn(request, "qualityValues")
      && manifest.request?.effect === "read"
      && manifest.request?.qualityValuesPresent === false,
    "request is not a safe unfiltered baseline",
  );
  check(
    "metadata-has-no-null-semantics",
    evidence.metadata?.httpStatus === 200
      && evidence.metadata?.businessCode === 0
      && evidence.metadata?.nullSemanticConditionCount === 0
      && evidence.metadata?.rawNullSemanticPatternCount === 0
      && evidence.metadata?.whereExpDistribution?.["1"] === 45
      && evidence.metadata?.whereExpDistribution?.null === 9
      && !Object.keys(
        evidence.metadata?.whereExpDistribution || {},
      ).some((value) => value === "13" || value === "14"),
    "runtime metadata unexpectedly contains IS NULL/IS NOT NULL semantics",
  );
  check(
    "page-repeat-contract",
    evidence.page?.httpStatus === 200
      && evidence.page?.businessCode === 0
      && evidence.page?.repeatCount === 2
      && evidence.page?.rawResponseHashesMatch === true
      && evidence.page?.semanticHashesMatch === true
      && evidence.page?.responseGroups === 2
      && sameArray(evidence.page?.rowsPerGroup, [244, 244]),
    "repeated page responses are not structurally stable",
  );
  check(
    "mysql-readonly-contract",
    evidence.mysql?.sessionTransactionReadOnly === true,
    "MySQL evidence was not collected in a read-only transaction",
  );
  check(
    "mysql-has-no-null-semantics",
    evidence.mysql?.tenantNullSemanticConfiguration?.totalRows === 0
      && evidence.mysql?.selectedFieldMatchCount === 16
      && evidence.mysql?.selectedFieldsWithWhereExp1 === 16
      && evidence.mysql?.selectedFieldsWithWhereExp13Or14 === 0,
    "MySQL configuration unexpectedly contains whereExp 13/14",
  );
  check(
    "unfiltered-row-count-cross-check",
    evidence.mysql?.mainPhysicalTableActiveRows === 244
      && evidence.crossCheck?.pageRowsMatchMainPhysicalTableActiveRows
        === true
      && evidence.crossCheck?.unfilteredBaselineConfirmed === true
      && evidence.crossCheck?.isNullOrIsNotNullPredicateConfirmed === false,
    "page result does not prove an unfiltered physical-table baseline",
  );
  check(
    "collection-safety",
    evidence.safety?.credentialsPersisted === false
      && evidence.safety?.rawResponsesPersisted === false
      && evidence.safety?.businessFieldValuesPersisted === false
      && evidence.safety?.mutatingEndpointsInvoked === false
      && evidence.safety?.pagePreferenceWriteSuppressed === true
      && evidence.safety?.referenceCaseModified === false,
    "quality diagnostic safety declaration is incomplete",
  );
  await validateSourceSemantics(profile.source.root);
  await validateNoSensitiveValues();
  runNegativeSelfTests(evidence);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while validating the diagnostic",
  );
  check(
    "reference-source-bound",
    evidence.referenceSource?.identity === afterSnapshot.identity.identity
      && evidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && evidence.referenceSource?.fileCount === afterSnapshot.fileCount
      && evidence.referenceSource?.access === "read-only",
    "quality diagnostic reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-quality-page-diagnostic",
    status: "pass",
    complete: false,
    decision:
      "quality-baseline-diagnostic-accepted-fixture-still-blocked",
    lineage: {
      evidenceReportHash: evidence.reportHash,
      requestFileHash: manifest.request.fileHash,
    },
    metrics: {
      pageRuns: evidence.page.repeatCount,
      responseGroups: evidence.page.responseGroups,
      rowsPerGroup: evidence.page.rowsPerGroup,
      selectedFieldsChecked: evidence.mysql.selectedFieldMatchCount,
      nullSemanticMetadataConditions:
        evidence.metadata.nullSemanticConditionCount,
      nullSemanticDatabaseRows:
        evidence.mysql.tenantNullSemanticConfiguration.totalRows,
      acceptedQualityFixtures: 0,
      mutationRequestsInvoked: 0,
      sensitiveValuesFound: 0,
    },
    blocker: {
      reason: evidence.classification.reason,
      required: evidence.required,
    },
    referenceSource: stableSourceSnapshot(afterSnapshot),
    checks,
    next: evidence.next,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      complete: report.complete,
      decision: report.decision,
      acceptedQualityFixtures:
        report.metrics.acceptedQualityFixtures,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-quality-page-diagnostic",
    status: "fail",
    complete: false,
    decision: "quality-diagnostic-integrity-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
    next: "fix the failed diagnostic integrity check and rerun the gate",
  };
  await writeJson(reportPath, {
    ...payload,
    reportHash: stableHash(payload),
  });
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

async function validateSourceSemantics(sourceRoot) {
  const servicePath = path.join(
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
    "viewmeta",
    "domain",
    "service",
    "ViewMetaPageQueryPlanDomainServiceImpl.java",
  );
  const enumPath = path.join(
    sourceRoot,
    "zboss-module-data-type",
    "src",
    "main",
    "java",
    "com",
    "iagz",
    "zboss",
    "module",
    "data",
    "enums",
    "ViewFieldWhereExpEnum.java",
  );
  const service = await readFile(servicePath, "utf8");
  const whereEnum = await readFile(enumPath, "utf8");
  check(
    "source-quality-values-branch",
    service.includes("appendQualityWhereFields")
      && /ObjectUtil\.isEmpty\s*\(\s*qualityValues\s*\)/.test(service)
      && /for\s*\(\s*String\s+key\s*:\s*qualityValues\.keySet\(\)\s*\)/.test(
        service,
      )
      && /setWhereExp\s*\(\s*resolveWhereExpCode\s*\(\s*resolvedField\.getWhereExp\(\)\s*\)\s*\)/.test(
        service,
      ),
    "reference source qualityValues branch changed or is missing",
  );
  check(
    "source-null-semantic-enum",
    /IS_NULL\s*\(\s*13\s*,\s*"is null"/.test(whereEnum)
      && /IS_NOT_NULL\s*\(\s*14\s*,\s*"is not null"/.test(whereEnum),
    "reference source no longer maps IS NULL/IS NOT NULL to 13/14",
  );
}

async function validateNoSensitiveValues() {
  for (const file of [
    evidencePath,
    manifestPath,
    requestPath,
    path.join(
      repositoryRoot,
      "scripts",
      "probes",
      "zboss-quality-page-readonly.py",
    ),
    path.join(
      repositoryRoot,
      "scripts",
      "probes",
      "mysql-quality-page-snapshot.py",
    ),
  ]) {
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
  tampered.page.rowsPerGroup[0] = 999;
  check(
    "negative-test:evidence-hash",
    !verifySelfHash(tampered),
    "quality diagnostic evidence tamper was not rejected",
  );

  const falseCoverage = structuredClone(evidence);
  falseCoverage.classification.acceptedAsQualityCoverage = true;
  check(
    "negative-test:false-quality-coverage",
    !isRejectedUnfilteredBaseline(falseCoverage),
    "unfiltered baseline could be relabeled as quality coverage",
  );

  check(
    "negative-test:secret",
    containsSensitiveValue(
      `${["Be", "arer "].join("")}synthetic-token-value-1234567890`,
    ),
    "synthetic credential was not detected",
  );
}

function isRejectedUnfilteredBaseline(evidence) {
  return evidence.status === "diagnostic-pass"
    && evidence.decision === "quality-fixture-rejected-unfiltered-baseline"
    && evidence.request?.qualityValuesPresent === false
    && evidence.classification?.realReadonlyDiagnosticEligible === true
    && evidence.classification?.realQualityFixtureEligible === false
    && evidence.classification?.acceptedAsQualityCoverage === false;
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
  checks.push({ id, pass, ...(pass || !detail ? {} : { detail }) });
  if (!pass) throw new Error(`${id}: ${detail || "failed"}`);
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
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
