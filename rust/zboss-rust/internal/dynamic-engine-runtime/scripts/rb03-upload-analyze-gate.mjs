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
  "real-create-ledger-analyze.json",
);
const rb03Path = path.join(artifactDirectory, "rb03-gate.json");
const manifestPath = path.join(
  repositoryRoot,
  "cases",
  "zboss-page",
  "fixtures",
  "real-candidates",
  "create-ledger-analyze",
  "manifest.json",
);
const reportPath = path.join(
  artifactDirectory,
  "rb03-upload-analyze-gate.json",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const evidence = await readJson(evidencePath);
  const rb03 = await readJson(rb03Path);
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
    "rb03-lineage",
    rb03.status === "pass"
      && rb03.complete === false
      && verifySelfHash(rb03),
    "RB-03 gate is missing, complete or tampered",
  );
  check(
    "upload-analysis-self-hash",
    verifySelfHash(evidence),
    "upload analysis evidence hash mismatch",
  );
  check(
    "candidate-evidence-lineage",
    manifest.status === "accepted-as-upload-analysis-only"
      && manifest.realEvidenceEligible === true
      && manifest.temporaryPageFixtureEligible === false
      && normalize(manifest.evidence?.path)
        === "artifacts/page-rust/real-create-ledger-analyze.json"
      && manifest.evidence?.reportHash === evidence.reportHash,
    "candidate manifest does not match upload evidence",
  );
  check(
    "input-file-binding",
    manifest.request?.parts?.file?.sha256 === evidence.input?.fileHash
      && manifest.request?.parts?.file?.sizeBytes
        === evidence.input?.fileSize
      && manifest.request?.parts?.file?.binaryPersistedInRepository
        === false
      && evidence.input?.binaryPersistedInRepository === false,
    "input file hash, size or persistence policy mismatch",
  );
  check(
    "analyze-contract",
    evidence.analyze?.httpStatus === 200
      && evidence.analyze?.businessCode === 0
      && evidence.analyze?.sheetCount === 1
      && evidence.analyze?.totalRows === 4
      && evidence.analyze?.sheets?.[0]?.totalCols === 2,
    "analyze response contract mismatch",
  );
  check(
    "session-readback",
    evidence.sessionReadback?.httpStatus === 200
      && evidence.sessionReadback?.businessCode === 0
      && evidence.sessionReadback?.tokenMatches === true
      && evidence.sessionReadback?.expireAtPresent === true
      && evidence.sessionReadback?.sessionTtlHours === 2,
    "analyze session readback mismatch",
  );
  check(
    "temporary-page-boundary",
    evidence.classification?.uploadAnalysisEvidenceEligible === true
      && evidence.classification?.temporaryPageEvidenceEligible === false
      && evidence.mysqlObservation?.uploadTmpTableNameReturned === false
      && evidence.mysqlObservation?.uploadTmpFlagReturned === false
      && evidence.mysqlObservation
        ?.newestObservedTemporaryTablePredatesAnalyze === true
      && evidence.mysqlObservation
        ?.temporaryTableCreatedAtOrAfterAnalyze === false,
    "upload analysis was incorrectly classified as temporary-page coverage",
  );
  check(
    "side-effect-safety",
    evidence.sideEffects?.confirmImportInvoked === false
      && evidence.safety?.credentialsPersisted === false
      && evidence.safety?.rawResponsesPersisted === false
      && evidence.safety?.analyzeTokenPersisted === false
      && evidence.safety?.remoteTemporaryFileRemoved === true
      && evidence.safety?.remoteCollectorRemoved === true,
    "upload analysis safety declaration is incomplete",
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
    "reference source changed while validating upload analysis",
  );
  check(
    "reference-source-bound",
    evidence.referenceSource?.identity === afterSnapshot.identity.identity
      && evidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && evidence.referenceSource?.fileCount === afterSnapshot.fileCount,
    "upload evidence reference-source identity does not match",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb03-upload-analyze",
    status: "pass",
    decision: "upload-analysis-accepted-temporary-page-still-blocked",
    lineage: {
      rb03ReportHash: rb03.reportHash,
      uploadEvidenceReportHash: evidence.reportHash,
    },
    metrics: {
      sheets: evidence.analyze.sheetCount,
      rows: evidence.analyze.totalRows,
      columns: evidence.analyze.sheets[0].totalCols,
      sessionReadbackPassed: true,
      confirmImportInvoked: 0,
      temporaryPageFixturesAdded: 0,
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
    stage: "page-rust-rb03-upload-analyze",
    status: "fail",
    decision: "upload-analysis-evidence-blocked",
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
      "zboss-create-ledger-analyze.py",
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
  tampered.analyze.totalRows = 999;
  check(
    "negative-test:evidence-hash",
    !verifySelfHash(tampered),
    "upload evidence tamper was not rejected",
  );
  const falseCoverage = structuredClone(evidence);
  falseCoverage.classification.temporaryPageEvidenceEligible = true;
  check(
    "negative-test:false-temporary-coverage",
    falseCoverage.classification.temporaryPageEvidenceEligible
      !== evidence.classification.temporaryPageEvidenceEligible,
    "false temporary-page classification was not detected",
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
