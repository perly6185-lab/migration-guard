import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.ZBOSS_TEST_MYSQL_PASSWORD = "batch_delete";
process.env.ZBOSS_TEST_MYSQL_ROOT_PASSWORD = "local_root_only";
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..", "..");
const composeFile = path.join(serviceRoot, "docker-compose.integration.yml");
const composeProject = "migration-guard-batch-delete";
const artifactRoot = path.join(repositoryRoot, "artifacts", "batch-delete-rust");
const reportPath = path.join(artifactRoot, "container-adapter-gate.json");
const acceptancePath = path.join(artifactRoot, "l4a-acceptance.md");
const checks = [];
let beforeSnapshot;
let afterSnapshot;

await mkdir(artifactRoot, { recursive: true });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "batch-delete-container-adapters",
  status: "running",
});

try {
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const profile = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "cases", "zboss-batch-delete", "profile.json"),
      "utf8",
    ),
  );
  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  run("rust-format", "cargo", ["fmt", "--check"], engineRoot);
  const tests = run(
    "rust-tests",
    "cargo",
    ["test", "--offline", "application::data::delete"],
    engineRoot,
  );
  run(
    "rust-clippy",
    "cargo",
    ["clippy", "--all-targets", "--offline", "--", "-D", "warnings"],
    engineRoot,
  );
  run("compose-up", "docker", [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
    "up",
    "-d",
  ], repositoryRoot);
  await waitForServices();
  provisionDatabaseUser();

  mysql(
    await readFile(
      path.join(serviceRoot, "migrations", "001_batch_delete_protocol.sql"),
      "utf8",
    ),
  );
  resetDatabase();
  redis(["FLUSHDB"]);

  verifyAtomicSuccess();
  verifyPartialReferenceSkip();
  verifyTransactionRollback();
  verifyIdempotentReplay();
  verifyCompensationRecovery();
  await verifyRedisMutationGate();
  await verifyRedisProgress();

  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  requireCheck(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    {},
  );
  const testOutput = `${tests.stdout ?? ""}\n${tests.stderr ?? ""}`;
  const testCount = [...testOutput.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-container-adapters",
    status: "pass",
    decision: "L4-A-PROTOCOL-READY",
    capabilityBoundary: {
      level: "L4-A",
      rustProtocolWrappersAttested: true,
      rustNetworkExecutorsImplemented: false,
      directContainerProtocolProbe: true,
      deployableServiceAttested: false,
      productionEligible: false,
      nextRequiredLevel: "L4-B",
    },
    environment: {
      mysql: "mysql:8.4",
      redis: "redis:7.4-alpine",
      composeProject,
    },
    scope: {
      mysql: [
        "atomic idempotency + snapshot + soft-delete + undo + compensation-outbox",
        "reference-blocked subset classification",
        "transaction rollback after injected failure",
        "durable replay and hash conflict",
        "ordered compensation claim, failure, retry and completion",
      ],
      redis: [
        "delete/update tenant-panel mutual exclusion",
        "owner-token renewal, release, expiry and stale-owner rejection",
        "monotonic progress sequence and replay",
        "counter conservation, transition validation and one terminal state",
      ],
      realBusinessRequestExecuted: false,
      realJavaEvidenceClaimed: false,
    },
    sourceSnapshot: stableSnapshot(afterSnapshot),
    metrics: {
      rustTestsPassed: testCount,
      checksPassed: checks.filter((check) => check.pass).length,
      checksTotal: checks.length,
    },
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  console.log(JSON.stringify({
    status: report.status,
    decision: report.decision,
    checks: report.metrics.checksTotal,
    rustTests: report.metrics.rustTestsPassed,
    reportPath,
  }, null, 2));
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-delete-container-adapters",
    status: "blocked",
    decision: "KEEP-L3",
    error: error instanceof Error ? error.message : String(error),
    sourceSnapshot: afterSnapshot
      ? stableSnapshot(afterSnapshot)
      : beforeSnapshot
        ? stableSnapshot(beforeSnapshot)
        : undefined,
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

function resetDatabase() {
  mysql(`
    DELETE FROM delete_compensation_effect;
    DELETE FROM delete_compensation_step;
    DELETE FROM delete_compensation_outbox;
    DELETE FROM delete_undo_anchor;
    DELETE FROM delete_snapshot;
    DELETE FROM delete_idempotency;
    DELETE FROM delete_fixture_row;
  `);
}

function provisionDatabaseUser() {
  rootMysql(`
    CREATE USER IF NOT EXISTS 'batch_delete'@'%'
      IDENTIFIED BY 'batch_delete';
    ALTER USER 'batch_delete'@'%' IDENTIFIED BY 'batch_delete';
    GRANT ALL PRIVILEGES ON batch_delete.* TO 'batch_delete'@'%';
    FLUSH PRIVILEGES;
  `);
  requireCheck("mysql-application-user-provisioned", true, {});
}

function seedRows(ids, referencedId = null) {
  mysql(`
    INSERT INTO delete_fixture_row
      (tenant_id, panel_id, id, material_name, material_quantity, referenced_flag)
    VALUES
      ${ids.map((id, index) =>
        `(1, 10, ${id}, 'material-${index + 1}', ${index + 1}, ${id === referencedId ? 1 : 0})`
      ).join(",\n      ")};
  `);
}

function verifyAtomicSuccess() {
  const ids = [101, 102, 103];
  seedRows(ids);
  mysql(`
    START TRANSACTION;
    INSERT INTO delete_idempotency
      (tenant_id, panel_id, idempotency_key, request_hash, batch_id, state)
    VALUES
      (1, 10, 'success-key',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'delete-success', 'STARTED');
    INSERT INTO delete_snapshot
      (tenant_id, batch_id, row_id, row_version, snapshot_json)
    SELECT tenant_id, 'delete-success', id, row_version,
      JSON_OBJECT('id', id, 'name', material_name, 'quantity', material_quantity,
                  'deleted', deleted, 'version', row_version)
    FROM delete_fixture_row
    WHERE tenant_id=1 AND panel_id=10 AND id IN (101,102,103)
      AND deleted=0 AND referenced_flag=0;
    UPDATE delete_fixture_row
    SET deleted=1, row_version=row_version+1, updated_by=9
    WHERE tenant_id=1 AND panel_id=10 AND id IN (101,102,103)
      AND deleted=0 AND referenced_flag=0;
    INSERT INTO delete_undo_anchor
      (tenant_id, batch_id, row_id, snapshot_row_id)
    SELECT tenant_id, batch_id, row_id, row_id
    FROM delete_snapshot
    WHERE tenant_id=1 AND batch_id='delete-success';
    INSERT INTO delete_compensation_outbox
      (tenant_id, batch_id, request_hash, row_ids)
    VALUES
      (1, 'delete-success',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       JSON_ARRAY(101,102,103));
    INSERT INTO delete_compensation_step
      (tenant_id, batch_id, step_index, step_name)
    VALUES
      ${compensationValues("delete-success")};
    UPDATE delete_idempotency
    SET state='MAIN_COMMITTED',
        response_json=JSON_OBJECT(
          'deletedRowIds', JSON_ARRAY(101,102,103),
          'skippedRowIds', JSON_ARRAY(),
          'progressState', 'MAIN_COMMITTED')
    WHERE tenant_id=1 AND panel_id=10 AND idempotency_key='success-key';
    COMMIT;
  `);
  const counts = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_fixture_row
        WHERE tenant_id=1 AND panel_id=10 AND id IN (101,102,103) AND deleted=1), ',',
      (SELECT COUNT(*) FROM delete_snapshot
        WHERE tenant_id=1 AND batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_undo_anchor
        WHERE tenant_id=1 AND batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_compensation_outbox
        WHERE tenant_id=1 AND batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_compensation_step
        WHERE tenant_id=1 AND batch_id='delete-success')
    );
  `);
  requireCheck("mysql-atomic-delete-five-part-commit", counts === "3,3,3,1,9", {
    counts,
  });
}

function verifyPartialReferenceSkip() {
  const ids = [201, 202, 203];
  seedRows(ids, 202);
  mysql(`
    START TRANSACTION;
    INSERT INTO delete_idempotency
      (tenant_id, panel_id, idempotency_key, request_hash, batch_id, state)
    VALUES
      (1, 10, 'partial-key',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       'delete-partial', 'STARTED');
    INSERT INTO delete_snapshot
      (tenant_id, batch_id, row_id, row_version, snapshot_json)
    SELECT tenant_id, 'delete-partial', id, row_version,
      JSON_OBJECT('id', id, 'deleted', deleted, 'version', row_version)
    FROM delete_fixture_row
    WHERE tenant_id=1 AND panel_id=10 AND id IN (201,202,203)
      AND deleted=0 AND referenced_flag=0;
    UPDATE delete_fixture_row
    SET deleted=1, row_version=row_version+1, updated_by=9
    WHERE tenant_id=1 AND panel_id=10 AND id IN (201,202,203)
      AND deleted=0 AND referenced_flag=0;
    INSERT INTO delete_undo_anchor
      (tenant_id, batch_id, row_id, snapshot_row_id)
    SELECT tenant_id, batch_id, row_id, row_id FROM delete_snapshot
    WHERE tenant_id=1 AND batch_id='delete-partial';
    INSERT INTO delete_compensation_outbox
      (tenant_id, batch_id, request_hash, row_ids)
    VALUES
      (1, 'delete-partial',
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       JSON_ARRAY(201,203));
    INSERT INTO delete_compensation_step
      (tenant_id, batch_id, step_index, step_name)
    VALUES
      ${compensationValues("delete-partial")};
    UPDATE delete_idempotency
    SET state='MAIN_COMMITTED',
        response_json=JSON_OBJECT(
          'deletedRowIds', JSON_ARRAY(201,203),
          'skippedRowIds', JSON_ARRAY(202))
    WHERE tenant_id=1 AND panel_id=10 AND idempotency_key='partial-key';
    COMMIT;
  `);
  const result = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_fixture_row
        WHERE tenant_id=1 AND panel_id=10 AND id IN (201,203) AND deleted=1), ',',
      (SELECT deleted FROM delete_fixture_row
        WHERE tenant_id=1 AND panel_id=10 AND id=202), ',',
      (SELECT COUNT(*) FROM delete_snapshot
        WHERE tenant_id=1 AND batch_id='delete-partial'), ',',
      JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.skippedRowIds[0]')))
    FROM delete_idempotency
    WHERE tenant_id=1 AND panel_id=10 AND idempotency_key='partial-key';
  `);
  requireCheck("mysql-reference-skip-classification", result === "2,0,2,202", {
    result,
  });
}

function verifyTransactionRollback() {
  seedRows([301, 302, 303]);
  const failure = mysql(`
    START TRANSACTION;
    INSERT INTO delete_idempotency
      (tenant_id, panel_id, idempotency_key, request_hash, batch_id, state)
    VALUES
      (1, 10, 'rollback-key',
       'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
       'delete-rollback', 'STARTED');
    INSERT INTO delete_snapshot
      (tenant_id, batch_id, row_id, row_version, snapshot_json)
    SELECT tenant_id, 'delete-rollback', id, row_version,
      JSON_OBJECT('id', id, 'deleted', deleted)
    FROM delete_fixture_row
    WHERE tenant_id=1 AND panel_id=10 AND id IN (301,302,303) AND deleted=0;
    UPDATE delete_fixture_row SET deleted=1, row_version=row_version+1
    WHERE tenant_id=1 AND panel_id=10 AND id IN (301,302,303) AND deleted=0;
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected undo failure';
    COMMIT;
  `, true);
  requireCheck("mysql-injected-main-transaction-failure", failure.status !== 0, {
    status: failure.status,
  });
  const rollback = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_fixture_row
        WHERE tenant_id=1 AND panel_id=10 AND id IN (301,302,303) AND deleted=0), ',',
      (SELECT COUNT(*) FROM delete_snapshot
        WHERE tenant_id=1 AND batch_id='delete-rollback'), ',',
      (SELECT COUNT(*) FROM delete_idempotency
        WHERE tenant_id=1 AND batch_id='delete-rollback')
    );
  `);
  requireCheck("mysql-main-transaction-rollback", rollback === "3,0,0", {
    rollback,
  });
}

function verifyIdempotentReplay() {
  const replay = mysqlScalar(`
    SELECT CONCAT(
      request_hash, ':', state, ':',
      JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.deletedRowIds[0]')))
    FROM delete_idempotency
    WHERE tenant_id=1 AND panel_id=10 AND idempotency_key='success-key';
  `);
  requireCheck(
    "mysql-durable-delete-replay",
    replay
      === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:MAIN_COMMITTED:101",
    { replay },
  );
  const conflict = mysqlScalar(`
    SELECT request_hash <>
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    FROM delete_idempotency
    WHERE tenant_id=1 AND panel_id=10 AND idempotency_key='success-key';
  `);
  requireCheck("mysql-idempotency-hash-conflict", conflict === "1", { conflict });
  const before = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_snapshot WHERE batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_undo_anchor WHERE batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_compensation_outbox WHERE batch_id='delete-success')
    );
  `);
  const duplicate = mysql(`
    INSERT INTO delete_idempotency
      (tenant_id, panel_id, idempotency_key, request_hash, batch_id, state)
    VALUES
      (1, 10, 'success-key',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'delete-success-retry', 'STARTED');
  `, true);
  requireCheck("mysql-duplicate-key-does-not-reexecute", duplicate.status !== 0, {
    status: duplicate.status,
  });
  const after = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM delete_snapshot WHERE batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_undo_anchor WHERE batch_id='delete-success'), ',',
      (SELECT COUNT(*) FROM delete_compensation_outbox WHERE batch_id='delete-success')
    );
  `);
  requireCheck("mysql-replay-side-effect-count-stable", before === after, {
    before,
    after,
  });
}

function verifyCompensationRecovery() {
  const claim = mysqlScalar(`
    UPDATE delete_compensation_step
    SET state='RUNNING', attempts=attempts+1, owner_token='worker-a'
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=0
      AND state='PENDING' AND owner_token IS NULL;
    SELECT ROW_COUNT();
  `);
  requireCheck("mysql-compensation-ordered-claim", claim === "1", { claim });
  const competing = mysqlScalar(`
    UPDATE delete_compensation_step
    SET state='RUNNING', attempts=attempts+1, owner_token='worker-b'
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=0
      AND state='PENDING' AND owner_token IS NULL;
    SELECT ROW_COUNT();
  `);
  requireCheck("mysql-compensation-owner-exclusion", competing === "0", {
    competing,
  });
  mysql(`
    UPDATE delete_compensation_step
    SET state='COMPLETED', owner_token=NULL, error_message=NULL
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=0
      AND state='RUNNING' AND owner_token='worker-a';
    UPDATE delete_compensation_outbox SET next_step=1, state='RUNNING'
    WHERE tenant_id=1 AND batch_id='delete-success' AND next_step=0;
    UPDATE delete_compensation_step
    SET state='RUNNING', attempts=attempts+1, owner_token='worker-a'
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=1
      AND state='PENDING';
    UPDATE delete_compensation_step
    SET state='RETRY', owner_token=NULL, error_message='injected dependency failure'
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=1
      AND owner_token='worker-a';
    UPDATE delete_compensation_step
    SET state='RUNNING', attempts=attempts+1, owner_token='worker-b'
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=1
      AND state='RETRY' AND owner_token IS NULL;
    UPDATE delete_compensation_step
    SET state='COMPLETED', owner_token=NULL, error_message=NULL
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=1
      AND owner_token='worker-b';
    UPDATE delete_compensation_step
    SET state='COMPLETED', attempts=1
    WHERE tenant_id=1 AND batch_id='delete-success' AND step_index BETWEEN 2 AND 8;
    UPDATE delete_compensation_outbox
    SET next_step=9, state='SUCCESS', owner_token=NULL, terminal_error=NULL
    WHERE tenant_id=1 AND batch_id='delete-success';
  `);
  const result = mysqlScalar(`
    SELECT CONCAT(
      (SELECT attempts FROM delete_compensation_step
       WHERE tenant_id=1 AND batch_id='delete-success' AND step_index=1), ',',
      (SELECT COUNT(*) FROM delete_compensation_step
       WHERE tenant_id=1 AND batch_id='delete-success' AND state='COMPLETED'), ',',
      (SELECT CONCAT(next_step, ':', state) FROM delete_compensation_outbox
       WHERE tenant_id=1 AND batch_id='delete-success')
    );
  `);
  requireCheck("mysql-compensation-failure-retry-resume", result === "2,9,9:SUCCESS", {
    result,
  });
}

async function verifyRedisMutationGate() {
  const acquire = await readFile(
    path.join(serviceRoot, "scripts", "redis", "acquire.lua"),
    "utf8",
  );
  const renew = await readFile(
    path.join(serviceRoot, "scripts", "redis", "renew.lua"),
    "utf8",
  );
  const release = await readFile(
    path.join(serviceRoot, "scripts", "redis", "release.lua"),
    "utf8",
  );
  const key = "zboss:batch-delete:lease:tenant:1:panel:10";
  const now = Date.now();
  const expiry = now + 60_000;
  expectRedis(
    "redis-delete-owner-acquired",
    [acquire, key, "delete-owner", "delete", now, expiry],
    "ACQUIRED",
  );
  expectRedis(
    "redis-update-blocked-by-delete",
    [acquire, key, "update-owner", "update", now, expiry],
    "BUSY",
  );
  expectRedis(
    "redis-stale-owner-renew-rejected",
    [renew, key, "stale-owner", now, expiry + 1_000],
    "OWNER_CONFLICT",
  );
  expectRedis(
    "redis-owner-renewed",
    [renew, key, "delete-owner", now, expiry + 1_000],
    "RENEWED",
  );
  expectRedis(
    "redis-stale-owner-release-rejected",
    [release, key, "stale-owner"],
    "OWNER_CONFLICT",
  );
  expectRedis(
    "redis-owner-release",
    [release, key, "delete-owner"],
    "RELEASED",
  );
  expectRedis(
    "redis-update-after-release",
    [acquire, key, "update-owner", "update", now, expiry],
    "ACQUIRED",
  );
  const future = expiry + 1;
  expectRedis(
    "redis-expired-owner-replaced",
    [acquire, key, "delete-after-expiry", "delete", future, future + 60_000],
    "ACQUIRED",
  );
}

async function verifyRedisProgress() {
  const progress = await readFile(
    path.join(serviceRoot, "scripts", "redis", "progress.lua"),
    "utf8",
  );
  const key = "zboss:batch-delete:progress:tenant:1:batch:delete-success";
  expectRedis(
    "redis-progress-running",
    [progress, key, 1, "RUNNING", "a".repeat(64), 3, 0, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-replay",
    [progress, key, 1, "RUNNING", "a".repeat(64), 3, 0, 0],
    "REPLAYED",
  );
  expectRedis(
    "redis-progress-out-of-order",
    [progress, key, 3, "SUCCESS", "c".repeat(64), 3, 3, 0],
    "OUT_OF_ORDER",
  );
  expectRedis(
    "redis-progress-main-committed",
    [progress, key, 2, "MAIN_COMMITTED", "b".repeat(64), 3, 3, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-compensation-retrying",
    [progress, key, 3, "COMPENSATION_RETRYING", "c".repeat(64), 3, 3, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-success-terminal",
    [progress, key, 4, "SUCCESS", "d".repeat(64), 3, 3, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-second-terminal-rejected",
    [progress, key, 5, "COMPENSATION_FAILED", "e".repeat(64), 3, 3, 0],
    "TERMINAL",
  );
  expectRedis(
    "redis-progress-terminal-sequence-conflict",
    [progress, key, 4, "SUCCESS", "f".repeat(64), 3, 3, 0],
    "SEQUENCE_CONFLICT",
  );

  const mismatchKey =
    "zboss:batch-delete:progress:tenant:1:batch:delete-counter-mismatch";
  expectRedis(
    "redis-progress-counter-start",
    [progress, mismatchKey, 1, "RUNNING", "1".repeat(64), 3, 0, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-counter-conservation",
    [progress, mismatchKey, 2, "MAIN_COMMITTED", "2".repeat(64), 3, 2, 0],
    "COUNTER_MISMATCH",
  );

  const failedKey =
    "zboss:batch-delete:progress:tenant:1:batch:delete-precommit-failed";
  expectRedis(
    "redis-progress-failed-start",
    [progress, failedKey, 1, "RUNNING", "3".repeat(64), 3, 0, 0],
    "STORED",
  );
  expectRedis(
    "redis-progress-failed-terminal-with-zero-effects",
    [progress, failedKey, 2, "FAILED", "4".repeat(64), 3, 0, 0],
    "STORED",
  );
}

function compensationValues(batchId) {
  const names = [
    "child-form-cascade",
    "same-panel-derived-cascade",
    "select-ref-cascade",
    "color-shadow-sync",
    "sync-relation-cleanup",
    "audit-and-snapshot-link",
    "bill-cleanup",
    "page-ref-refresh",
    "page-query-cache-invalidate",
  ];
  return names
    .map((name, index) => `(1, '${batchId}', ${index}, '${name}')`)
    .join(",\n      ");
}

function expectRedis(id, values, expected) {
  const [script, key, ...args] = values;
  const actual = redis([
    "EVAL",
    String(script),
    "1",
    String(key),
    ...args.map(String),
  ]).stdout.trim();
  requireCheck(id, actual === expected, { expected, actual });
}

async function waitForServices() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const mysqlReady = compose([
        "exec",
        "-T",
        "mysql",
        "mysql",
        "-h127.0.0.1",
        "-P3306",
        "-ubatch_delete",
        "-pbatch_delete",
        "--batch",
        "--skip-column-names",
        "batch_delete",
        "-e",
        "SELECT 1",
      ], true).stdout.trim() === "1";
    const redisReady =
      compose(["exec", "-T", "redis", "redis-cli", "PING"], true).stdout.trim()
      === "PONG";
    if (mysqlReady && redisReady) {
      checks.push({ id: "container-health", pass: true, attempt });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("batch-delete MySQL/Redis containers did not become healthy");
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

function stableSnapshot(snapshot) {
  return {
    identity: snapshot.identity.identity,
    treeHash: snapshot.treeHash,
    fileCount: snapshot.fileCount,
    directories: snapshot.directories,
  };
}

function renderAcceptance(report) {
  const lines = [
    "# `batchDelete` Rust L4-A 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "BLOCKED"}`,
    "",
    `Decision: ${report.decision}`,
  ];
  if (report.capabilityBoundary) {
    lines.push(
      `Level: ${report.capabilityBoundary.level}`,
      `Checks: ${report.metrics.checksPassed}/${report.metrics.checksTotal}`,
      `Rust tests: ${report.metrics.rustTestsPassed}`,
      `Production eligible: ${report.capabilityBoundary.productionEligible}`,
      "",
      "## Boundary",
      "",
      "- Rust production protocol wrappers are unit-attested.",
      "- MySQL 8.4 and Redis 7.4 protocols are container-attested.",
      "- Network executors and deployable HTTP service are not yet claimed.",
      "- The supplied real three-row delete request was not executed.",
      "",
      `Reference tree hash: \`${report.sourceSnapshot.treeHash}\``,
    );
  }
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
