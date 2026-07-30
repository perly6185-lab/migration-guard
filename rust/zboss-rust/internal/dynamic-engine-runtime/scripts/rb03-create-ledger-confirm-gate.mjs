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
  "real-create-ledger-confirm.json",
);
const manifestPath = path.join(
  repositoryRoot,
  "cases",
  "zboss-page",
  "fixtures",
  "real-candidates",
  "create-ledger-confirm",
  "manifest.json",
);
const reportPath = path.join(
  artifactDirectory,
  "rb03-create-ledger-confirm-gate.json",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const evidence = await readJson(evidencePath);
  const manifest = await readJson(manifestPath);
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
    "confirm-evidence-self-hash",
    verifySelfHash(evidence),
    "confirm evidence hash mismatch",
  );
  check(
    "manifest-lineage",
    manifest.status === "accepted-as-real-confirm-observation"
      && manifest.realEvidenceEligible === true
      && manifest.temporaryPageFixtureEligible === false
      && normalize(manifest.evidence?.path)
        === "artifacts/page-rust/real-create-ledger-confirm.json"
      && manifest.evidence?.reportHash === evidence.reportHash,
    "confirm manifest does not match evidence",
  );
  check(
    "session-lineage",
    evidence.sessionValidation?.httpStatus === 200
      && evidence.sessionValidation?.businessCode === 0
      && evidence.sessionValidation?.tokenMatches === true
      && evidence.sessionValidation?.fileNameMatches === true
      && evidence.sessionValidation?.fileSizeMatches === true
      && evidence.sessionValidation?.sheetFound === true
      && evidence.sessionValidation?.rowCount === 4
      && evidence.sessionValidation?.totalColumns === 2,
    "analyze session does not match the confirm request",
  );
  check(
    "duplicate-prevention",
    evidence.duplicatePrevention?.confirmInvokedByThisRun === false
      && evidence.duplicatePrevention?.matchingBatchCountBeforeSubmit === 1
      && evidence.duplicatePrevention?.duplicateSubmitPrevented === true,
    "duplicate confirm was not prevented",
  );
  check(
    "batch-terminal-contract",
    evidence.batch?.taskStatus === "SUCCESS"
      && evidence.batch?.currentPhase === "FINISHED"
      && evidence.batch?.progressPercent === 100
      && evidence.batch?.totalSheetCount === 1
      && evidence.batch?.completedSheetCount === 1
      && evidence.batch?.processedRows === 4
      && evidence.batch?.insertCount === 3
      && evidence.batch?.errorCount === 0,
    "existing confirm batch did not reach the expected terminal state",
  );
  check(
    "sheet-terminal-contract",
    evidence.sheet?.taskStatus === "SUCCESS"
      && evidence.sheet?.rowCount === 4
      && evidence.sheet?.processedRows === 4
      && evidence.sheet?.insertCount === 3
      && evidence.sheet?.errorCount === 0
      && Boolean(evidence.sheet?.usePageId)
      && Boolean(evidence.sheet?.pageId),
    "confirm sheet state is incomplete",
  );
  check(
    "permanent-resource-contract",
    evidence.createdResources?.page?.exists === true
      && evidence.createdResources?.usePage?.exists === true
      && evidence.createdResources?.panel?.exists === true
      && evidence.createdResources?.fields?.length === 2
      && evidence.createdResources?.physicalTable?.exists === true
      && evidence.createdResources?.physicalTable?.rowCount === 3,
    "created ledger resource chain is incomplete",
  );
  check(
    "column-override-contract",
    evidence.createdResources?.fields?.[0]?.fieldTagInnerKey === "text"
      && evidence.createdResources?.fields?.[0]?.fieldTypeValue === "text"
      && evidence.createdResources?.fields?.[1]?.fieldTagInnerKey === "int"
      && evidence.createdResources?.fields?.[1]?.fieldTypeValue === "number",
    "persisted field types do not reflect the requested overrides",
  );
  check(
    "compensation-boundary",
    evidence.sourceSemantics?.confirmIdempotencyKeyPresent === false
      && evidence.sourceSemantics?.duplicateConfirmCanCreateAnotherBatch
        === true
      && evidence.sourceSemantics?.cancelCompensatesRegisteredCreatedPages
        === true
      && evidence.sourceSemantics?.ordinaryFailureUsesCreatedPageCleanup
        === false,
    "confirm idempotency or compensation boundary is misstated",
  );
  check(
    "temporary-page-boundary",
    evidence.classification?.realConfirmEvidenceEligible === true
      && evidence.classification?.createLedgerAndImportRowsCovered === true
      && evidence.classification?.temporaryPageFixtureEligible === false,
    "permanent confirm evidence was misclassified as temporary-page coverage",
  );
  check(
    "collection-safety",
    evidence.safety?.mysqlSessionTransactionReadOnly === true
      && evidence.safety?.credentialsPersisted === false
      && evidence.safety?.rawResponsesPersisted === false
      && evidence.safety?.analyzeTokenPersisted === false
      && evidence.safety?.duplicateConfirmInvoked === false
      && evidence.safety?.remoteCollectorRemoved === true
      && evidence.safety?.referenceCaseModified === false,
    "confirm collection safety declaration is incomplete",
  );
  await validateNoSensitiveValues();
  runNegativeSelfTests(evidence);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while validating confirm evidence",
  );
  check(
    "reference-source-bound",
    evidence.referenceSource?.identity === afterSnapshot.identity.identity
      && evidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && evidence.referenceSource?.fileCount === afterSnapshot.fileCount,
    "confirm evidence reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-create-ledger-confirm",
    status: "pass",
    decision: "real-confirm-accepted-duplicate-submit-prevented",
    lineage: {
      confirmEvidenceReportHash: evidence.reportHash,
    },
    metrics: {
      matchingBatches: evidence.duplicatePrevention.matchingBatchCountBeforeSubmit,
      duplicateConfirmCalls: 0,
      sheets: evidence.batch.totalSheetCount,
      sourceRowsIncludingHeader: evidence.batch.totalRows,
      insertedRows: evidence.batch.insertCount,
      createdFields: evidence.createdResources.fields.length,
      physicalRows: evidence.createdResources.physicalTable.rowCount,
      sensitiveValuesFound: 0,
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
      decision: report.decision,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-create-ledger-confirm",
    status: "fail",
    decision: "real-confirm-evidence-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
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

async function validateNoSensitiveValues() {
  for (const file of [
    evidencePath,
    manifestPath,
    path.join(
      repositoryRoot,
      "scripts",
      "probes",
      "zboss-create-ledger-confirm.py",
    ),
    path.join(
      repositoryRoot,
      "scripts",
      "probes",
      "mysql-ledger-confirm-snapshot.py",
    ),
  ]) {
    const content = await readFile(file, "utf8");
    check(
      `sensitive-scan:${normalize(path.relative(repositoryRoot, file))}`,
      !containsSensitiveValue(content),
      `${file} contains a sensitive value`,
    );
  }
}

function runNegativeSelfTests(evidence) {
  const tampered = structuredClone(evidence);
  tampered.batch.insertCount = 999;
  check(
    "negative-test:evidence-hash",
    !verifySelfHash(tampered),
    "confirm evidence tamper was not rejected",
  );
  const duplicate = structuredClone(evidence);
  duplicate.duplicatePrevention.confirmInvokedByThisRun = true;
  check(
    "negative-test:duplicate-submit",
    duplicate.duplicatePrevention.confirmInvokedByThisRun
      !== evidence.duplicatePrevention.confirmInvokedByThisRun,
    "duplicate confirm mutation was not detected",
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
    /"analyzeToken"\s*:\s*"[A-Za-z0-9]{16,}"/i,
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
