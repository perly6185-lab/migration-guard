import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.resolve(serviceRoot, "..");
const rustRoot = path.resolve(engineRoot, "..", "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const caseRoot = path.join(repositoryRoot, "cases", "zboss-batch-update-with-progress");
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-update-rust");
const composeFile = path.join(serviceRoot, "docker-compose.integration.yml");
const composeProject = "migration-guard-batch-update-l4b";
const reportPath = path.join(artifactRoot, "l4b-gate.json");
const acceptancePath = path.join(artifactRoot, "l4b-acceptance.md");
const baseUrl = "http://127.0.0.1:18089";
const route =
  "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress";
const checks = [];
let serviceProcess;
let serviceOutput = "";
let report;

process.env.ZBOSS_TEST_MYSQL_PASSWORD = "batch_update";
process.env.ZBOSS_TEST_MYSQL_ROOT_PASSWORD = "local_root_only";

await mkdir(artifactRoot, { recursive: true });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "batch-update-l4b-network-runtime",
  status: "running",
});

try {
  const { assessMigrationCapability } = await importDist("migrationCapability.js");
  const { inspectRustProductionPath } = await importDist(
    "productionPathAttestation.js",
  );
  const profile = await readJson(path.join(caseRoot, "profile.json"));
  const l3 = await readJson(path.join(artifactRoot, "l3-gate.json"));
  const l4a = await readJson(
    path.join(artifactRoot, "container-adapter-gate.json"),
  );

  run("rust-format", "cargo", [
    "fmt",
    "--manifest-path",
    path.join(rustRoot, "Cargo.toml"),
    "--all",
    "--",
    "--check",
  ], repositoryRoot);
  const tests = run("rust-tests", "cargo", [
    "test",
    "--manifest-path",
    path.join(rustRoot, "Cargo.toml"),
    "--workspace",
    "--all-features",
  ], repositoryRoot);
  run("rust-clippy", "cargo", [
    "clippy",
    "--manifest-path",
    path.join(rustRoot, "Cargo.toml"),
    "--workspace",
    "--all-features",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ], repositoryRoot);
  run("unified-service-build", "cargo", [
    "build",
    "--manifest-path",
    path.join(rustRoot, "Cargo.toml"),
    "--all-features",
    "--bin",
    "zboss",
  ], repositoryRoot);

  compose(["down", "-v", "--remove-orphans"], true);
  compose(["up", "-d"]);
  await waitForContainers();
  provisionDatabase();
  redis(["FLUSHDB"]);
  startService();
  await waitForReady();

  const atomic = await verifyAtomicUpdate();
  await verifyReplayAndConflict(atomic);
  await verifyPartialFailure();
  await verifyOutOfOrderChunk();
  await verifyTransactionFailure();
  await verifyRestartReplay(atomic);
  await verifyDependencyReadiness();

  const productionPath = await inspectRustProductionPath(
    engineRoot,
    profile.target.productionPath,
  );
  requireCheck(
    "production-path-concrete-and-deployable",
    productionPath.concreteAdapters
      && productionPath.deployableService
      && productionPath.productionEligible,
    productionPath,
  );
  requireCheck(
    "prior-gates-valid",
    l3.status === "pass"
      && validReportHash(l3)
      && l4a.status === "pass"
      && l4a.decision === "L4-A-PROTOCOL-READY"
      && validReportHash(l4a),
    {},
  );
  const capability = assessMigrationCapability({
    sourceReadOnlyGuardPassed: true,
    analysisComplete: true,
    offlineContractPassed: true,
    implementationChecksPassed: true,
    scenarioContractPassed: true,
    dependencyProtocolChecksPassed: true,
    concreteAdaptersAttested: productionPath.concreteAdapters,
    deployableServiceAttested: productionPath.deployableService,
    realEvidencePassed: false,
    dualReplayPassed: false,
    unifiedRealGatePassed: false,
  });
  requireCheck(
    "capability-l4b",
    capability.achieved === "L4-B" && capability.next === "L4-C",
    capability,
  );
  const testOutput = `${tests.stdout ?? ""}\n${tests.stderr ?? ""}`;
  const testCount = [...testOutput.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-l4b-network-runtime",
    status: "pass",
    decision: "L4-B",
    capability,
    productionPath,
    environment: {
      mysql: "mysql:8.4 over TCP",
      redis: "redis:7.4-alpine over TCP",
      http: `${baseUrl}${route}`,
      process: "unified zboss binary",
      composeProject,
    },
    scope: {
      networkExecutors: ["sqlx MySQL pool", "redis async client"],
      atomicEffects: ["row", "commit marker", "undo", "outbox"],
      progress: "Redis atomic monotonic terminal script",
      restartReplayVerified: true,
      realBusinessRequestExecuted: false,
      referenceJavaModified: false,
    },
    evidence: {
      l3ReportHash: l3.reportHash,
      l4aReportHash: l4a.reportHash,
      rustTestsPassed: testCount,
      checksPassed: checks.filter((check) => check.pass).length,
      checksTotal: checks.length,
    },
    checks,
  };
  report = { ...payload, reportHash: stableHash(payload) };
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-l4b-network-runtime",
    status: "blocked",
    decision: "KEEP-L4-A",
    error: error instanceof Error ? error.message : String(error),
    serviceOutput: serviceOutput.slice(-8_000),
    checks,
  };
  report = { ...payload, reportHash: stableHash(payload) };
  process.exitCode = 1;
} finally {
  await stopService();
  compose(["down", "-v", "--remove-orphans"], true);
}

await writeJson(reportPath, report);
await writeFile(acceptancePath, renderAcceptance(report), "utf8");
console.log(JSON.stringify({
  status: report.status,
  decision: report.decision,
  checks: report.evidence?.checksTotal ?? checks.length,
  rustTests: report.evidence?.rustTestsPassed,
  reportPath,
}, null, 2));

function provisionDatabase() {
  rootMysql(`
    CREATE USER IF NOT EXISTS 'batch_update'@'%' IDENTIFIED BY 'batch_update';
    ALTER USER 'batch_update'@'%' IDENTIFIED BY 'batch_update';
    GRANT ALL PRIVILEGES ON batch_update.* TO 'batch_update'@'%';
    FLUSH PRIVILEGES;
  `);
  mysql(`
    CREATE TABLE IF NOT EXISTS cust_table9001 LIKE batch_update_fixture_row;
    DELETE FROM batch_outbox;
    DELETE FROM batch_undo_journal;
    DELETE FROM batch_row_commit;
    DELETE FROM batch_idempotency;
    DELETE FROM cust_table9001;
  `);
  requireCheck("mysql-schema-ready", true, {});
}

function startService() {
  const executable = path.join(
    rustRoot,
    "target",
    "debug",
    process.platform === "win32" ? "zboss.exe" : "zboss",
  );
  serviceProcess = spawn(executable, [], {
    cwd: rustRoot,
    env: {
      ...process.env,
      ZBOSS_UNIFIED_BIND: "127.0.0.1:18089",
      ZBOSS_PAGE_PROFILE: "memory",
      ZBOSS_UNIFIED_BATCH_DELETE_MODE: "disabled",
      ZBOSS_UNIFIED_BATCH_UPDATE_MODE: "production",
      ZBOSS_BATCH_UPDATE_MYSQL_URL:
        "mysql://batch_update:batch_update@127.0.0.1:13306/batch_update",
      ZBOSS_BATCH_UPDATE_REDIS_URL: "redis://127.0.0.1:16379/",
      ZBOSS_BATCH_UPDATE_TABLE: "cust_table9001",
      ZBOSS_BATCH_UPDATE_LEASE_TTL_MS: "30000",
      ZBOSS_BATCH_UPDATE_WORKER_INTERVAL_MS: "25",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serviceProcess.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  serviceProcess.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
}

async function waitForReady() {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (serviceProcess?.exitCode !== null) {
      throw new Error(`unified service exited early\n${serviceOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/internal/ready`);
      const body = await response.json();
      if (
        response.ok
        && body.ready === true
        && body.batchUpdate?.enabled === true
        && body.batchUpdate?.ready === true
      ) {
        checks.push({ id: "unified-http-readiness", pass: true, attempt });
        return;
      }
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await delay(200);
  }
  throw new Error(`unified HTTP readiness timed out\n${serviceOutput}`);
}

async function verifyAtomicUpdate() {
  const request = requestBody("atomic-session", 0, true, [
    { id: "401", values: { materialName: "alpha", quantity: 1 } },
    { id: "402", values: { materialName: "beta", quantity: 2 } },
  ]);
  const response = await postUpdate(request, "request-atomic");
  requireCheck(
    "http-atomic-update-response",
    response.status === 200
      && response.body.code === 0
      && sameValues(response.body.data.committedRows, [0, 1])
      && response.body.data.failedRows.length === 0
      && response.body.data.status === "SUCCESS",
    response,
  );
  const batchId = response.body.data.batchId;
  const progress = await waitForProgress(batchId, "SUCCESS");
  requireCheck(
    "redis-terminal-progress",
    progress.state === "SUCCESS"
      && progress.terminal === "1"
      && progress.total === "2"
      && progress.committed === "2"
      && progress.failed === "0",
    progress,
  );
  await waitForOutbox(batchId, 5);
  const counts = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM cust_table9001 WHERE primary_key_value IN ('401','402')), ',',
      (SELECT COUNT(*) FROM batch_row_commit WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT COUNT(*) FROM batch_undo_journal WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT COUNT(*) FROM batch_outbox WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT COUNT(*) FROM batch_outbox WHERE batch_id='${sqlText(batchId)}' AND state='DELIVERED')
    );
  `);
  requireCheck("mysql-atomic-row-undo-outbox", counts === "2,2,2,5,5", {
    counts,
    batchId,
  });
  return { request, response: response.body.data };
}

async function verifyReplayAndConflict(atomic) {
  const replay = await postUpdate(atomic.request, "request-atomic-replay");
  requireCheck(
    "http-idempotent-replay",
    replay.status === 200
      && replay.body.data.replayed === true
      && replay.body.data.batchId === atomic.response.batchId,
    replay,
  );
  const stable = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM batch_row_commit WHERE batch_id='${sqlText(atomic.response.batchId)}'), ',',
      (SELECT COUNT(*) FROM batch_undo_journal WHERE batch_id='${sqlText(atomic.response.batchId)}'), ',',
      (SELECT COUNT(*) FROM batch_outbox WHERE batch_id='${sqlText(atomic.response.batchId)}')
    );
  `);
  requireCheck("http-replay-side-effects-stable", stable === "2,2,5", { stable });
  const changed = structuredClone(atomic.request);
  changed.batchPostValueList[0].values.materialName = "changed";
  const conflict = await postUpdate(changed, "request-atomic-conflict");
  requireCheck(
    "http-idempotency-conflict",
    conflict.status === 409
      && conflict.body.data?.error === "IDEMPOTENCY_CONFLICT",
    conflict,
  );
}

async function verifyPartialFailure() {
  const request = requestBody("partial-session", 0, true, [
    { id: "501", values: { materialName: "valid" } },
    {
      id: "502",
      values: { materialName: "invalid" },
      validationError: "fixture validation failure",
    },
  ]);
  const response = await postUpdate(request, "request-partial");
  requireCheck(
    "http-partial-failure",
    response.status === 200
      && response.body.data.status === "PARTIAL_FAILED"
      && sameValues(response.body.data.committedRows, [0])
      && sameValues(response.body.data.failedRows, [1]),
    response,
  );
  const progress = await waitForProgress(response.body.data.batchId, "PARTIAL_FAILED");
  requireCheck(
    "redis-partial-terminal-conserved",
    progress.committed === "1"
      && progress.failed === "1"
      && progress.total === "2",
    progress,
  );
}

async function verifyOutOfOrderChunk() {
  const response = await postUpdate(
    requestBody("order-session", 1, false, [
      { id: "601", values: { materialName: "late" } },
    ]),
    "request-order",
  );
  requireCheck(
    "http-out-of-order-chunk",
    response.status === 409
      && response.body.data?.error === "OUT_OF_ORDER_CHUNK",
    response,
  );
}

async function verifyTransactionFailure() {
  mysql("RENAME TABLE cust_table9001 TO cust_table9001_unavailable;");
  const response = await postUpdate(
    requestBody("failure-session", 0, true, [
      { id: "701", values: { materialName: "not-written" } },
    ]),
    "request-failure",
  );
  mysql("RENAME TABLE cust_table9001_unavailable TO cust_table9001;");
  requireCheck(
    "mysql-transaction-failure-terminal",
    response.status === 200
      && response.body.data.status === "FAILED"
      && response.body.data.committedRows.length === 0
      && sameValues(response.body.data.failedRows, [0]),
    response,
  );
  const residue = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM cust_table9001 WHERE primary_key_value='701'), ',',
      (SELECT COUNT(*) FROM batch_undo_journal WHERE batch_id='${sqlText(response.body.data.batchId)}')
    );
  `);
  requireCheck("mysql-failure-no-row-or-undo", residue === "0,0", { residue });
}

async function verifyRestartReplay(atomic) {
  await stopService();
  serviceProcess = undefined;
  startService();
  await waitForReady();
  const replay = await postUpdate(atomic.request, "request-after-restart");
  requireCheck(
    "process-restart-durable-replay",
    replay.status === 200
      && replay.body.data.replayed === true
      && replay.body.data.batchId === atomic.response.batchId,
    replay,
  );
}

async function verifyDependencyReadiness() {
  compose(["stop", "redis"]);
  let observedUnavailable = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await fetch(`${baseUrl}/internal/ready`);
    if (response.status === 503) {
      observedUnavailable = true;
      break;
    }
    await delay(100);
  }
  requireCheck("redis-loss-fails-readiness", observedUnavailable, {});
  compose(["start", "redis"]);
  await waitForContainers();
  await waitForReady();
}

async function postUpdate(body, requestId) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "1",
      "x-user-id": "9",
      "x-request-id": requestId,
      "x-datasource": "primary",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function requestBody(session, chunkNo, finalChunk, rows) {
  return {
    interId: "90001",
    httpId: "90002",
    usePageId: "90003",
    panelId: "10",
    batchPostValueList: rows,
    batchHeaderValueList: [],
    clientSessionId: session,
    chunkNo,
    isLastChunk: finalChunk,
  };
}

async function waitForProgress(batchId, expectedState) {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/internal/batch-update/progress/${encodeURIComponent(batchId)}`,
      { headers: { "x-tenant-id": "1" } },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.progress?.state === expectedState) return body.progress;
    }
    await delay(25);
  }
  throw new Error(`progress ${batchId} did not reach ${expectedState}`);
}

async function waitForOutbox(batchId, expectedCount) {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const delivered = Number(mysqlScalar(`
      SELECT COUNT(*) FROM batch_outbox
      WHERE batch_id='${sqlText(batchId)}' AND state='DELIVERED';
    `));
    if (delivered === expectedCount) return;
    await delay(25);
  }
  throw new Error(`outbox ${batchId} did not deliver ${expectedCount} records`);
}

async function waitForContainers() {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const mysqlReady = compose([
      "exec",
      "-T",
      "mysql",
      "mysql",
      "-ubatch_update",
      "-pbatch_update",
      "--protocol=TCP",
      "--connect-timeout=1",
      "-h127.0.0.1",
      "--batch",
      "--skip-column-names",
      "batch_update",
      "-e",
      "SELECT 1",
    ], true).status === 0;
    const redisReady =
      compose(["exec", "-T", "redis", "redis-cli", "PING"], true).stdout.trim()
      === "PONG";
    if (mysqlReady && redisReady) {
      checks.push({ id: "container-health", pass: true, attempt });
      return;
    }
    await delay(1_000);
  }
  throw new Error("MySQL/Redis containers did not become healthy");
}

async function stopService() {
  if (!serviceProcess || serviceProcess.exitCode !== null) return;
  serviceProcess.kill("SIGINT");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (serviceProcess.exitCode !== null) return;
    await delay(100);
  }
  serviceProcess.kill();
}

function mysql(sql, allowFailure = false) {
  return compose([
    "exec",
    "-T",
    "mysql",
    "mysql",
    "-ubatch_update",
    "-pbatch_update",
    "--batch",
    "--raw",
    "--skip-column-names",
    "-h127.0.0.1",
    "batch_update",
  ], allowFailure, sql);
}

function rootMysql(sql) {
  return compose([
    "exec",
    "-T",
    "mysql",
    "mysql",
    "-uroot",
    "-plocal_root_only",
    "--batch",
    "--raw",
    "--skip-column-names",
    "batch_update",
  ], false, sql);
}

function mysqlScalar(sql) {
  return mysql(sql).stdout.trim();
}

function redis(args) {
  return compose(["exec", "-T", "redis", "redis-cli", "--raw", ...args]);
}

function compose(args, allowFailure = false, input) {
  return run(
    `compose-${args[0]}-${checks.length}`,
    "docker",
    ["compose", "-p", composeProject, "-f", composeFile, ...args],
    repositoryRoot,
    allowFailure,
    input,
  );
}

function run(id, command, args, cwd, allowFailure = false, input) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure) {
    const pass = result.status === 0 && !result.error;
    checks.push({ id, pass });
    if (!pass) {
      throw new Error(
        `${id} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
      );
    }
  }
  return result;
}

function requireCheck(id, pass, details) {
  checks.push({ id, pass, details });
  if (!pass) throw new Error(`${id} failed: ${JSON.stringify(details)}`);
}

function sameValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sqlText(value) {
  return String(value).replaceAll("'", "''");
}

function validReportHash(value) {
  const { reportHash, ...payload } = value;
  return reportHash === stableHash(payload);
}

function renderAcceptance(value) {
  return [
    "# `batchUpdateWithProgress` L4-B 验收",
    "",
    `Status: ${value.status === "pass" ? "PASS" : "BLOCKED"}`,
    "",
    `Decision: ${value.decision}`,
    `Next: ${value.capability?.next ?? "L4-B remediation"}`,
    `Network/runtime checks: ${value.evidence?.checksPassed ?? 0}/${value.evidence?.checksTotal ?? checks.length}`,
    `Rust tests: ${value.evidence?.rustTestsPassed ?? 0}`,
    `Concrete adapters: ${value.productionPath?.concreteAdapters ?? false}`,
    `Deployable HTTP service: ${value.productionPath?.deployableService ?? false}`,
    `Unified process exercised: ${value.environment?.process === "unified zboss binary"}`,
    `Reference Java modified: ${value.scope?.referenceJavaModified ?? false}`,
    "",
  ].join("\n");
}

async function importDist(file) {
  return import(
    pathToFileURL(path.join(repositoryRoot, "dist", "core", file)).href
  );
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
