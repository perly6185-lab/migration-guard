import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..", "..");
const serviceRoot = path.join(
  repositoryRoot,
  "rust",
  "zboss-rust",
  "components",
  "page",
);
const artifactDirectory = path.join(repositoryRoot, "artifacts", "page-rust");
const fixturePath = path.join(
  serviceRoot,
  "fixtures",
  "rb04",
  "create-ledger-confirm-contracts.json",
);
const testPath = path.join(
  serviceRoot,
  "tests",
  "rb04_create_ledger_contracts.rs",
);
const realEvidencePath = path.join(
  artifactDirectory,
  "real-create-ledger-confirm.json",
);
const reportPath = path.join(
  artifactDirectory,
  "rb04-create-ledger-contract-gate.json",
);
const acceptancePath = path.join(
  artifactDirectory,
  "rb04-create-ledger-contract-acceptance.md",
);
const checks = [];

await mkdir(artifactDirectory, { recursive: true });

try {
  runTypeScriptBuild();
  const fixture = await readJson(fixturePath);
  const realEvidence = await readJson(realEvidencePath);
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

  validateFixture(fixture);
  check(
    "real-confirm-evidence-lineage",
    verifySelfHash(realEvidence)
      && realEvidence.status === "pass"
      && realEvidence.duplicatePrevention?.duplicateSubmitPrevented === true
      && realEvidence.batch?.taskStatus === "SUCCESS",
    "real confirm evidence is missing or tampered",
  );
  await validateReferenceSemantics(profile.source.root);
  const cargo = runCargoContracts();
  check(
    "cargo-contract-tests",
    cargo.status === 0
      && /test result: ok\. 7 passed; 0 failed;/.test(
        `${cargo.stdout}\n${cargo.stderr}`,
      ),
    cargo.error?.message || cargo.stderr || cargo.stdout,
  );
  await validateNoSensitiveValues();
  runNegativeSelfTests(fixture);

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  check(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    "reference source changed while running RB-04",
  );
  check(
    "reference-source-bound",
    realEvidence.referenceSource?.identity
        === afterSnapshot.identity.identity
      && realEvidence.referenceSource?.treeHash === afterSnapshot.treeHash
      && realEvidence.referenceSource?.fileCount === afterSnapshot.fileCount,
    "RB-04 real evidence is not bound to the current reference source",
  );

  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb04-create-ledger-contracts",
    status: "pass",
    decision: "failure-residue-compensation-duplicate-contracts-accepted",
    coverage: {
      contractKind: fixture.contractKind,
      liveDestructiveFaultInjectionPerformed:
        fixture.liveDestructiveFaultInjectionPerformed,
      totalCases: fixture.cases.length,
      failureResidueCases: countCategory(fixture, "failure-residue"),
      compensationCases: countCategory(fixture, "compensation"),
      duplicateSubmitCases: countCategory(fixture, "duplicate-submit"),
      realSuccessBatchObserved: true,
      liveFailureBatchObserved: false,
      liveCancellationBatchObserved: false,
    },
    findings: {
      ordinaryFailureMayLeaveRegisteredPageResidue: true,
      cancellationCleansBeforeTerminalStatus: true,
      partialCleanupFailureMayLeaveOrphanAfterRegistryClear: true,
      legacyConfirmAllowsDuplicateBatchCreation: true,
      externalPreflightGuardPreventsDuplicateInvocation: true,
    },
    lineage: {
      realConfirmEvidenceReportHash: realEvidence.reportHash,
      fixtureHash: await hashFile(fixturePath),
      testHash: await hashFile(testPath),
    },
    referenceSource: stableSourceSnapshot(afterSnapshot),
    checks,
    next:
      "run controlled live failure/cancellation injection only in an isolated disposable tenant before promoting these offline contracts to real-runtime failure evidence",
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeAcceptance(report);
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      decision: report.decision,
      cases: report.coverage.totalCases,
      checks: `${checks.filter((item) => item.pass).length}/${checks.length}`,
      reportHash: report.reportHash,
    }, null, 2)}\n`,
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-rb04-create-ledger-contracts",
    status: "fail",
    decision: "create-ledger-contracts-blocked",
    checks,
    error: error instanceof Error ? error.message : String(error),
  };
  await writeJson(reportPath, {
    ...payload,
    reportHash: stableHash(payload),
  });
  throw error;
}

function validateFixture(fixture) {
  const errors = fixtureErrors(fixture);
  check(
    "fixture-schema",
    errors.length === 0,
    errors.join(", "),
  );
  const caseById = new Map(
    fixture.cases.map((item) => [item.caseId, item]),
  );
  check(
    "ordinary-failure-residue",
    caseById.get("ordinary-failure-after-page-registration")
      ?.expected?.batchStatuses?.[0] === "FAILED"
      && caseById.get("ordinary-failure-after-page-registration")
        ?.expected?.resourceCount === 1
      && caseById.get("ordinary-failure-after-page-registration")
        ?.expected?.registrationCount === 1
      && caseById.get("ordinary-failure-after-page-registration")
        ?.expected?.cleanupAttempts === 0,
    "ordinary failure residue contract mismatch",
  );
  check(
    "cancel-compensation-order",
    eventOrder(
      caseById.get("cancel-after-page-registration")?.expected?.events,
      [
        "cancel.observed",
        "cleanup.attempt:page-a",
        "cleanup.success:page-a",
        "cleanup.registry-clear",
        "batch.mark-cancelled",
      ],
    ),
    "cancel cleanup must finish before CANCELLED",
  );
  check(
    "partial-compensation-residue",
    caseById.get("cancel-cleanup-partial-failure")
      ?.expected?.batchStatuses?.[0] === "CANCELLED"
      && caseById.get("cancel-cleanup-partial-failure")
        ?.expected?.cleanupAttempts === 2
      && caseById.get("cancel-cleanup-partial-failure")
        ?.expected?.cleanupSuccesses === 1
      && caseById.get("cancel-cleanup-partial-failure")
        ?.expected?.registryClearCalls === 1
      && caseById.get("cancel-cleanup-partial-failure")
        ?.expected?.residualResources?.join(",") === "page-a",
    "partial cleanup orphan contract mismatch",
  );
  check(
    "legacy-duplicate-contract",
    caseById.get("legacy-duplicate-confirm")
      ?.expected?.confirmAttempts === 2
      && caseById.get("legacy-duplicate-confirm")
        ?.expected?.confirmInvocations === 2
      && caseById.get("legacy-duplicate-confirm")
        ?.expected?.batchStatuses?.join(",") === "SUCCESS,SUCCESS",
    "legacy duplicate contract mismatch",
  );
  check(
    "guarded-duplicate-contract",
    caseById.get("guarded-duplicate-confirm")
      ?.expected?.confirmAttempts === 2
      && caseById.get("guarded-duplicate-confirm")
        ?.expected?.confirmInvocations === 1
      && caseById.get("guarded-duplicate-confirm")
        ?.expected?.batchStatuses?.join(",") === "SUCCESS"
      && caseById.get("guarded-duplicate-confirm")
        ?.expected?.events?.at(-1)
          === "guard.duplicate-success-detected",
    "external duplicate guard contract mismatch",
  );
}

function fixtureErrors(fixture) {
  const errors = [];
  if (fixture?.schemaVersion !== 1) errors.push("schemaVersion");
  if (fixture?.stage !== "RB-04") errors.push("stage");
  if (
    fixture?.contractKind
      !== "offline-source-derived-create-ledger-confirm"
  ) {
    errors.push("contractKind");
  }
  if (fixture?.liveDestructiveFaultInjectionPerformed !== false) {
    errors.push("liveDestructiveFaultInjectionPerformed");
  }
  if (fixture?.sourceSemantics?.confirmIdempotencyKeyPresent !== false) {
    errors.push("confirmIdempotencyKeyPresent");
  }
  if (!Array.isArray(fixture?.cases) || fixture.cases.length !== 6) {
    errors.push("cases");
    return errors;
  }
  const ids = new Set(fixture.cases.map((item) => item.caseId));
  if (ids.size !== 6) errors.push("uniqueCases");
  for (const category of [
    "failure-residue",
    "compensation",
    "duplicate-submit",
  ]) {
    if (countCategory(fixture, category) !== 2) {
      errors.push(`category:${category}`);
    }
  }
  return errors;
}

async function validateReferenceSemantics(sourceRoot) {
  const packageRoot = path.join(
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
    "excelImport",
  );
  const confirm = await readFile(
    path.join(
      packageRoot,
      "application",
      "ViewMetaExcelImportConfirmApplicationServiceImpl.java",
    ),
    "utf8",
  );
  const task = await readFile(
    path.join(
      packageRoot,
      "application",
      "support",
      "ViewMetaExcelImportBatchTaskSupport.java",
    ),
    "utf8",
  );
  const cleanup = await readFile(
    path.join(
      packageRoot,
      "application",
      "support",
      "ViewMetaExcelImportBatchCleanupSupport.java",
    ),
    "utf8",
  );

  const createIndex = confirm.indexOf(
    "Long batchId = batchPort.create(batch);",
  );
  const submitIndex = confirm.indexOf(
    "batchTaskSupport.submitBatch(batch, executeCommand);",
  );
  check(
    "source-confirm-no-idempotency-gate",
    createIndex >= 0
      && submitIndex > createIndex
      && !/idempoten|deduplic|duplicate/i.test(confirm),
    "confirm source no longer matches create-then-submit without dedupe",
  );

  const cancelledCatch = task.indexOf(
    "catch (ViewMetaExcelImportBatchCancelledException ex)",
  );
  const cleanupCall = task.indexOf(
    "safeCleanupCreatedPages(batch.getBatchId());",
    cancelledCatch,
  );
  const cancelledMark = task.indexOf(
    "safeMarkBatchCancelled(batch.getBatchId(), ex.getMessage(), ex);",
    cleanupCall,
  );
  const failureCatch = task.indexOf(
    "} catch (Exception ex) {",
    cancelledMark,
  );
  const ensureMethod = task.indexOf(
    "private void ensureNotCancelled",
    failureCatch,
  );
  const ordinaryFailureBranch = task.slice(failureCatch, ensureMethod);
  check(
    "source-cancel-cleanup-before-terminal",
    cancelledCatch >= 0
      && cleanupCall > cancelledCatch
      && cancelledMark > cleanupCall,
    "cancel branch no longer cleans before terminal status",
  );
  check(
    "source-ordinary-failure-no-cleanup",
    ordinaryFailureBranch.includes(
      "safeMarkBatchFailed(batch.getBatchId(), ex);",
    )
      && !ordinaryFailureBranch.includes("safeCleanupCreatedPages"),
    "ordinary failure branch cleanup semantics changed",
  );

  const recycle = cleanup.indexOf(
    "pagePort.recycleCreatedPage(pageRef);",
  );
  const clearRegistry = cleanup.indexOf(
    "batchRuntimePort.clearCreatedPages(batchId);",
  );
  check(
    "source-best-effort-clears-registry",
    recycle >= 0
      && clearRegistry > recycle
      && cleanup.includes("catch (Exception ex)")
      && cleanup.includes("绝不抛出"),
    "best-effort cleanup registry semantics changed",
  );
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

function runCargoContracts() {
  return spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      path.join(serviceRoot, "Cargo.toml"),
      "--test",
      "rb04_create_ledger_contracts",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
}

async function validateNoSensitiveValues() {
  for (const file of [
    fixturePath,
    testPath,
    realEvidencePath,
    fileURLToPath(import.meta.url),
  ]) {
    const content = await readFile(file, "utf8");
    check(
      `sensitive-scan:${normalize(path.relative(repositoryRoot, file))}`,
      !containsSensitiveValue(content),
      `${file} contains a sensitive value`,
    );
  }
}

function runNegativeSelfTests(fixture) {
  const liveClaim = structuredClone(fixture);
  liveClaim.liveDestructiveFaultInjectionPerformed = true;
  check(
    "negative-test:false-live-claim",
    fixtureErrors(liveClaim).includes(
      "liveDestructiveFaultInjectionPerformed",
    ),
    "false live failure claim was not rejected",
  );

  const missingCase = structuredClone(fixture);
  missingCase.cases.pop();
  check(
    "negative-test:missing-case",
    fixtureErrors(missingCase).includes("cases"),
    "missing contract case was not rejected",
  );

  check(
    "negative-test:secret",
    containsSensitiveValue(
      `${["Be", "arer "].join("")}synthetic-token-value-1234567890`,
    ),
    "synthetic credential was not detected",
  );
}

async function writeAcceptance(report) {
  const lines = [
    "# zboss 创建台账失败/补偿/防重契约验收",
    "",
    `Status: ${report.status.toUpperCase()}`,
    "",
    `Decision: \`${report.decision}\``,
    "",
    "## 覆盖",
    "",
    `- 失败残留：${report.coverage.failureResidueCases} 个场景。`,
    `- 取消补偿：${report.coverage.compensationCases} 个场景。`,
    `- 重复提交：${report.coverage.duplicateSubmitCases} 个场景。`,
    `- Rust 契约测试：7/7 通过。`,
    "",
    "## 已锁定语义",
    "",
    "- 普通失败在页面登记后不会触发页面清理，允许残留。",
    "- 取消路径先 best-effort 清理，再写 CANCELLED 终态。",
    "- 单页清理失败不会阻断后续页面，但登记仍整体清空，可能留下孤儿资源。",
    "- 遗留 confirm 没有幂等门禁；外部写前查重可以阻止第二次调用。",
    "",
    "## 证据边界",
    "",
    "- 已有真实成功批次作为成功路径锚点。",
    "- 本批故障与取消场景是源码派生的离线契约，没有在真实租户执行破坏性故障注入。",
    "- 参考案例目录全程只读。",
    "",
    `Gate hash: \`${report.reportHash}\``,
    "",
  ];
  await writeFile(acceptancePath, lines.join("\n"), "utf8");
}

function eventOrder(events, expected) {
  if (!Array.isArray(events)) return false;
  let cursor = -1;
  for (const event of expected) {
    const next = events.indexOf(event, cursor + 1);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

function countCategory(fixture, category) {
  return fixture.cases.filter((item) => item.category === category).length;
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
  return report.reportHash === stableHash(payload);
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

async function hashFile(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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
