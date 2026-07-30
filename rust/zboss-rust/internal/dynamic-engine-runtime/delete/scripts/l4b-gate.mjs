import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.ZBOSS_TEST_MYSQL_PASSWORD = "batch_delete";
process.env.ZBOSS_TEST_MYSQL_ROOT_PASSWORD = "local_root_only";
const testMysqlUrl =
  `mysql://batch_delete:${encodeURIComponent(process.env.ZBOSS_TEST_MYSQL_PASSWORD)}@127.0.0.1:14306/batch_delete`;
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const caseRoot = path.join(repositoryRoot, "cases", "zboss-batch-delete");
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-delete-rust");
const composeFile = path.join(serviceRoot, "docker-compose.integration.yml");
const composeProject = "migration-guard-batch-delete-l4b";
const reportPath = path.join(artifactRoot, "l4b-gate.json");
const acceptancePath = path.join(artifactRoot, "l4b-acceptance.md");
const baseUrl = "http://127.0.0.1:18088";
const route =
  "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchDelete";
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let serviceProcess;
let serviceOutput = "";
let report;

await mkdir(artifactRoot, { recursive: true });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "batch-delete-l4b-network-runtime",
  status: "running",
});

try {
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await importDist("referenceSourceGuard.js");
  const { assessMigrationCapability } = await importDist(
    "migrationCapability.js",
  );
  const { inspectRustProductionPath } = await importDist(
    "productionPathAttestation.js",
  );
  const profile = await readJson(path.join(caseRoot, "profile.json"));
  const l3 = await readJson(path.join(artifactRoot, "l3-gate.json"));
  const l4a = await readJson(
    path.join(artifactRoot, "container-adapter-gate.json"),
  );

  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  run("rust-format", "cargo", ["fmt", "--check"], engineRoot);
  const tests = run(
    "rust-tests",
    "cargo",
    ["test", "--offline"],
    engineRoot,
  );
  run(
    "rust-clippy",
    "cargo",
    ["clippy", "--all-targets", "--offline", "--", "-D", "warnings"],
    engineRoot,
  );
  run(
    "rust-service-build",
    "cargo",
    ["build", "--offline", "--bin", "zboss-batch-delete-rust"],
    engineRoot,
  );

  compose(["down", "-v", "--remove-orphans"], true);
  compose(["up", "-d"]);
  await waitForContainers();
  provisionDatabase();
  redis(["FLUSHDB"]);
  startService();
  await waitForHttpReady();

  await verifyAtomicDeleteAndWorker();
  await verifyIdempotentReplayAndConflict();
  await verifyPartialReferenceSkip();
  await verifyMissingRowRollbackAndTerminal();
  await verifyRedisMutationGate();
  await verifyHealthEndpoints();

  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  requireCheck(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    {},
  );
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
      && l3.decision === "L3-OFFLINE-ACCEPTED"
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
    stage: "batch-delete-l4b-network-runtime",
    status: "pass",
    decision: "L4-B",
    capability,
    productionPath,
    environment: {
      mysql: "mysql:8.4 over TCP",
      redis: "redis:7.4-alpine over TCP",
      http: `${baseUrl}${route}`,
      composeProject,
    },
    scope: {
      networkExecutors: ["sqlx MySQL pool", "redis async client"],
      httpRuntime: "axum",
      worker: "durable ordered compensation worker",
      realBusinessRequestExecuted: false,
      referenceJavaModified: false,
      compensationEffects:
        "protocol-bound durable effect records; external business integrations remain L4-C evidence scope",
    },
    evidence: {
      l3ReportHash: l3.reportHash,
      l4aReportHash: l4a.reportHash,
      sourceSnapshot: stableSnapshot(afterSnapshot),
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
    stage: "batch-delete-l4b-network-runtime",
    status: "blocked",
    decision: "KEEP-L4-A",
    error: error instanceof Error ? error.message : String(error),
    serviceOutput: serviceOutput.slice(-8_000),
    sourceSnapshot: afterSnapshot
      ? stableSnapshot(afterSnapshot)
      : beforeSnapshot
        ? stableSnapshot(beforeSnapshot)
        : undefined,
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
    CREATE USER IF NOT EXISTS 'batch_delete'@'%'
      IDENTIFIED BY 'batch_delete';
    ALTER USER 'batch_delete'@'%' IDENTIFIED BY 'batch_delete';
    GRANT ALL PRIVILEGES ON batch_delete.* TO 'batch_delete'@'%';
    FLUSH PRIVILEGES;
  `);
  mysql(`
    CREATE TABLE IF NOT EXISTS cust_table9001 LIKE delete_fixture_row;
    DELETE FROM delete_compensation_effect;
    DELETE FROM delete_compensation_step;
    DELETE FROM delete_compensation_outbox;
    DELETE FROM delete_undo_anchor;
    DELETE FROM delete_snapshot;
    DELETE FROM delete_idempotency;
    DELETE FROM cust_table9001;
  `);
  requireCheck("mysql-schema-ready", true, {});
}

function startService() {
  const executable = path.join(
    path.resolve(engineRoot, "..", ".."),
    "target",
    "debug",
    process.platform === "win32"
      ? "zboss-batch-delete-rust.exe"
      : "zboss-batch-delete-rust",
  );
  serviceProcess = spawn(executable, [], {
    cwd: engineRoot,
    env: {
      ...process.env,
      ZBOSS_BATCH_DELETE_MYSQL_URL:
        testMysqlUrl,
      ZBOSS_BATCH_DELETE_REDIS_URL: "redis://127.0.0.1:17379/",
      ZBOSS_BATCH_DELETE_BIND_ADDR: "127.0.0.1:18088",
      ZBOSS_BATCH_DELETE_TABLE: "cust_table9001",
      ZBOSS_BATCH_DELETE_LEASE_TTL_MS: "30000",
      ZBOSS_BATCH_DELETE_WORKER_INTERVAL_MS: "25",
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

async function waitForHttpReady() {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    if (serviceProcess?.exitCode !== null) {
      throw new Error(`HTTP service exited early\n${serviceOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok && (await response.json()).status === "UP") {
        checks.push({ id: "http-readiness", pass: true, attempt });
        return;
      }
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await delay(200);
  }
  throw new Error(`HTTP readiness timed out\n${serviceOutput}`);
}

async function verifyAtomicDeleteAndWorker() {
  seedRows([401, 402, 403]);
  const response = await postDelete("atomic-key", [401, 402, 403]);
  requireCheck(
    "http-atomic-delete-response",
    response.status === 200
      && response.body.code === 0
      && sameValues(response.body.data.deletedRowIds, [401, 402, 403])
      && response.body.data.skippedRowIds.length === 0
      && response.body.data.progressState === "MAIN_COMMITTED",
    response,
  );
  const batchId = response.body.data.batchId;
  const progress = await waitForProgress(batchId, "SUCCESS");
  requireCheck(
    "redis-terminal-progress",
    progress.sequence === "3"
      && progress.terminal === "1"
      && progress.requested === "3"
      && progress.deleted === "3"
      && progress.skipped === "0",
    progress,
  );
  const counts = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM cust_table9001 WHERE id IN (401,402,403) AND deleted=1), ',',
      (SELECT COUNT(*) FROM delete_snapshot WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT COUNT(*) FROM delete_undo_anchor WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT COUNT(*) FROM delete_compensation_step WHERE batch_id='${sqlText(batchId)}' AND state='COMPLETED'), ',',
      (SELECT COUNT(*) FROM delete_compensation_effect WHERE batch_id='${sqlText(batchId)}'), ',',
      (SELECT CONCAT(next_step, ':', state) FROM delete_compensation_outbox WHERE batch_id='${sqlText(batchId)}')
    );
  `);
  requireCheck(
    "mysql-atomic-worker-effects",
    counts === "3,3,3,9,9,9:SUCCESS",
    { counts, batchId },
  );
  globalThis.atomicResponse = response.body.data;
}

async function verifyIdempotentReplayAndConflict() {
  const first = globalThis.atomicResponse;
  const replay = await postDelete("atomic-key", [401, 402, 403]);
  requireCheck(
    "http-idempotent-replay",
    replay.status === 200
      && replay.body.data.replayed === true
      && replay.body.data.batchId === first.batchId
      && replay.body.data.progressState === "SUCCESS",
    replay,
  );
  const stable = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_snapshot WHERE batch_id='${sqlText(first.batchId)}'), ',',
      (SELECT COUNT(*) FROM delete_compensation_effect WHERE batch_id='${sqlText(first.batchId)}')
    );
  `);
  requireCheck("http-replay-side-effects-stable", stable === "3,9", { stable });
  const conflict = await postDelete("atomic-key", [401, 402]);
  requireCheck(
    "http-idempotency-conflict",
    conflict.status === 409
      && conflict.body.data?.error === "IDEMPOTENCY_CONFLICT",
    conflict,
  );
}

async function verifyPartialReferenceSkip() {
  seedRows([501, 502, 503], 502);
  const response = await postDelete("partial-key", [501, 502, 503]);
  requireCheck(
    "http-partial-reference-skip",
    response.status === 200
      && sameValues(response.body.data.deletedRowIds, [501, 503])
      && sameValues(response.body.data.skippedRowIds, [502]),
    response,
  );
  await waitForProgress(response.body.data.batchId, "SUCCESS");
  const state = mysqlScalar(`
    SELECT GROUP_CONCAT(CONCAT(id, ':', deleted) ORDER BY id)
    FROM cust_table9001 WHERE id IN (501,502,503);
  `);
  requireCheck(
    "mysql-partial-reference-state",
    state === "501:1,502:0,503:1",
    { state },
  );
}

async function verifyMissingRowRollbackAndTerminal() {
  seedRows([601, 602]);
  const response = await postDelete("missing-key", [601, 602, 699]);
  requireCheck(
    "http-missing-row-rejected",
    response.status === 409 && response.body.data?.error === "MISSING_ACTIVE_ROW",
    response,
  );
  const batchId = batchIdFor("missing-key", [601, 602, 699]);
  const progress = await waitForProgress(batchId, "FAILED");
  requireCheck(
    "redis-failure-terminal",
    progress.sequence === "2"
      && progress.terminal === "1"
      && progress.deleted === "0",
    progress,
  );
  const residue = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM cust_table9001 WHERE id IN (601,602) AND deleted=1), ',',
      (SELECT COUNT(*) FROM delete_idempotency WHERE idempotency_key='missing-key'), ',',
      (SELECT COUNT(*) FROM delete_snapshot WHERE batch_id='${batchId}')
    );
  `);
  requireCheck("mysql-failure-no-residue", residue === "0,0,0", { residue });
}

async function verifyRedisMutationGate() {
  seedRows([701]);
  const acquire = await readFile(
    path.join(serviceRoot, "scripts", "redis", "acquire.lua"),
    "utf8",
  );
  const now = Date.now();
  const key = "zboss:batch-delete:lease:tenant:1:panel:10";
  const actual = redis([
    "EVAL",
    acquire,
    "1",
    key,
    "external-update-owner",
    "update",
    String(now),
    String(now + 30_000),
  ]).stdout.trim();
  requireCheck("redis-external-update-lock-acquired", actual === "ACQUIRED", {
    actual,
  });
  const response = await postDelete("locked-key", [701]);
  requireCheck(
    "http-delete-blocked-by-shared-gate",
    response.status === 409
      && response.body.data?.error === "CONCURRENT_MUTATION",
    response,
  );
  redis(["DEL", key]);
  const afterRelease = await postDelete("locked-key", [701]);
  requireCheck(
    "http-delete-after-gate-release",
    afterRelease.status === 200
      && sameValues(afterRelease.body.data.deletedRowIds, [701]),
    afterRelease,
  );
  await waitForProgress(afterRelease.body.data.batchId, "SUCCESS");
}

async function verifyHealthEndpoints() {
  const live = await fetch(`${baseUrl}/health/live`);
  const ready = await fetch(`${baseUrl}/health/ready`);
  requireCheck(
    "http-health-contract",
    live.status === 200
      && ready.status === 200
      && (await live.json()).status === "UP"
      && (await ready.json()).status === "UP",
    {},
  );
}

function seedRows(ids, referencedId = null) {
  mysql(`
    INSERT INTO cust_table9001
      (tenant_id,panel_id,id,material_name,material_quantity,referenced_flag)
    VALUES
      ${ids.map((id, index) =>
        `(1,10,${id},'material-${id}',${index + 1},${id === referencedId ? 1 : 0})`
      ).join(",\n      ")};
  `);
}

async function postDelete(idempotencyKey, ids) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "tenant-id": "1",
      "x-user-id": "9",
      "x-request-id": `request-${idempotencyKey}`,
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(requestBody(ids)),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function requestBody(ids) {
  return {
    interId: "90001",
    httpId: "90002",
    usePageId: "90003",
    panelId: "10",
    batchPostValueList: ids.map((id) => ({ id: String(id) })),
    operationKind: "ROW_DELETE",
    operationLabel: `${ids.length} rows`,
  };
}

function batchIdFor(idempotencyKey, ids) {
  const value = {
    tenantId: 1,
    actorId: 9,
    interId: 90001,
    httpId: 90002,
    usePageId: 90003,
    panelId: 10,
    rowIds: ids,
    operationKind: "ROW_DELETE",
    operationLabel: `${ids.length} rows`,
  };
  const hash = createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
  void idempotencyKey;
  return `bd-${hash.slice(0, 24)}`;
}

async function waitForProgress(batchId, expectedState) {
  for (let attempt = 1; attempt <= 160; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/internal/progress/${encodeURIComponent(batchId)}`,
      { headers: { "tenant-id": "1" } },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.state === expectedState) return body;
    }
    await delay(25);
  }
  throw new Error(`progress ${batchId} did not reach ${expectedState}`);
}

async function waitForContainers() {
  let stableMysqlChecks = 0;
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const mysqlReady =
      compose([
        "exec",
        "-T",
        "mysql",
        "mysql",
        "-uroot",
        "-plocal_root_only",
        "--batch",
        "--skip-column-names",
        "-e",
        "SELECT 1",
      ], true).status === 0;
    stableMysqlChecks = mysqlReady ? stableMysqlChecks + 1 : 0;
    const redisReady =
      compose(["exec", "-T", "redis", "redis-cli", "PING"], true).stdout.trim()
      === "PONG";
    if (stableMysqlChecks >= 3 && redisReady) {
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
  return compose(
    [
      "exec",
      "-T",
      "mysql",
      "mysql",
      "-ubatch_delete",
      "-pbatch_delete",
      "--batch",
      "--raw",
      "--skip-column-names",
      "-h127.0.0.1",
      "batch_delete",
    ],
    allowFailure,
    sql,
  );
}

function rootMysql(sql) {
  return compose(
    [
      "exec",
      "-T",
      "mysql",
      "mysql",
      "-uroot",
      "-plocal_root_only",
      "--batch",
      "--raw",
      "--skip-column-names",
      "batch_delete",
    ],
    false,
    sql,
  );
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

function stableSnapshot(snapshot) {
  return {
    identity: snapshot.identity.identity,
    treeHash: snapshot.treeHash,
    fileCount: snapshot.fileCount,
    directories: snapshot.directories,
  };
}

function renderAcceptance(value) {
  return [
    "# `batchDelete` L4-B 验收",
    "",
    `Status: ${value.status === "pass" ? "PASS" : "BLOCKED"}`,
    "",
    `Decision: ${value.decision}`,
    `Next: ${value.capability?.next ?? "L4-B remediation"}`,
    `Network/runtime checks: ${value.evidence?.checksPassed ?? 0}/${value.evidence?.checksTotal ?? checks.length}`,
    `Rust tests: ${value.evidence?.rustTestsPassed ?? 0}`,
    `Concrete adapters: ${value.productionPath?.concreteAdapters ?? false}`,
    `Deployable HTTP service: ${value.productionPath?.deployableService ?? false}`,
    `Real business request executed: ${value.scope?.realBusinessRequestExecuted ?? false}`,
    `Reference Java modified: ${value.scope?.referenceJavaModified ?? false}`,
    "",
    value.evidence?.sourceSnapshot?.treeHash
      ? `Reference tree hash: \`${value.evidence.sourceSnapshot.treeHash}\``
      : "",
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
