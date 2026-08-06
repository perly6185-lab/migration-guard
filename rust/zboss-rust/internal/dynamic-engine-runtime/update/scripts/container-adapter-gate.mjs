import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
process.env.ZBOSS_TEST_MYSQL_PASSWORD = "batch_update";
process.env.ZBOSS_TEST_MYSQL_ROOT_PASSWORD = "local_root_only";
const serviceRoot = path.resolve(scriptDirectory, "..");
const engineRoot = path.resolve(serviceRoot, "..");
const repositoryRoot = path.resolve(
  serviceRoot,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const composeFile = path.join(serviceRoot, "docker-compose.integration.yml");
const artifactDirectory = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
);
const reportPath = path.join(artifactDirectory, "container-adapter-gate.json");
const checks = [];

await mkdir(artifactDirectory, { recursive: true });
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "batch-update-container-adapters",
  status: "running",
});

try {
  run("typescript-build", process.execPath, [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.json",
  ], repositoryRoot);
  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const profile = await readJson(
    path.join(
      repositoryRoot,
      "cases",
      "zboss-batch-update-with-progress",
      "profile.json",
    ),
  );
  const beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  run("compose-up", "docker", ["compose", "-f", composeFile, "up", "-d"], repositoryRoot);
  await waitForServices();
  run(
    "rust-tests",
    "cargo",
    ["test", "--offline", "application::data::update"],
    engineRoot,
  );
  run(
    "rust-clippy",
    "cargo",
    ["clippy", "--all-targets", "--offline", "--", "-D", "warnings"],
    engineRoot,
  );

  mysql(
    await readFile(
      path.join(serviceRoot, "migrations", "001_batch_update_evidence.sql"),
      "utf8",
    ),
  );
  mysql(`
    DELETE FROM batch_outbox;
    DELETE FROM batch_undo_journal;
    DELETE FROM batch_row_commit;
    DELETE FROM batch_row_projection;
    DELETE FROM batch_idempotency;
    DELETE FROM schema_transition_ledger;
    DROP TABLE IF EXISTS schema_transition_target;
    CREATE TABLE schema_transition_target (
      id BIGINT NOT NULL,
      PRIMARY KEY (id)
    );
  `);
  redis(["FLUSHDB"]);

  mysql(`
    START TRANSACTION;
    INSERT INTO batch_row_projection
      (tenant_id, panel_id, primary_key_value, values_json)
      VALUES (1, 10, 'row-0', JSON_OBJECT('name', 'committed'));
    INSERT INTO batch_row_commit
      (tenant_id, batch_id, row_index, request_hash, primary_key_value)
      VALUES (1, 'container-success', 0,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'row-0');
    INSERT INTO batch_undo_journal
      (tenant_id, batch_id, row_index, primary_key_value, before_value)
      VALUES (1, 'container-success', 0, 'row-0', JSON_OBJECT());
    INSERT INTO batch_outbox
      (tenant_id, batch_id, event_kind, dedupe_key, payload)
      VALUES
        (1, 'container-success', 'undo', 'container-success:undo:0', JSON_OBJECT('rowIndex', 0)),
        (1, 'container-success', 'downstream', 'container-success:downstream:0', JSON_OBJECT('rowIndex', 0));
    COMMIT;
  `);
  const atomicCounts = mysqlScalar(`
    SELECT CONCAT(
      (SELECT COUNT(*) FROM batch_row_projection WHERE tenant_id=1 AND primary_key_value='row-0'), ',',
      (SELECT COUNT(*) FROM batch_row_commit WHERE tenant_id=1 AND batch_id='container-success'), ',',
      (SELECT COUNT(*) FROM batch_undo_journal WHERE tenant_id=1 AND batch_id='container-success'), ',',
      (SELECT COUNT(*) FROM batch_outbox WHERE tenant_id=1 AND batch_id='container-success')
    );
  `);
  requireCheck("mysql-atomic-row-undo-outbox", atomicCounts === "1,1,1,2", {
    atomicCounts,
  });

  const rollback = mysql(`
    START TRANSACTION;
    INSERT INTO batch_row_projection
      (tenant_id, panel_id, primary_key_value, values_json)
      VALUES (1, 10, 'rollback-row', JSON_OBJECT('name', 'must-not-commit'));
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected transaction failure';
    COMMIT;
  `, true);
  requireCheck("mysql-injected-transaction-failed", rollback.status !== 0, {
    status: rollback.status,
  });
  requireCheck(
    "mysql-transaction-rollback",
    mysqlScalar(`
      SELECT COUNT(*) FROM batch_row_projection
      WHERE tenant_id=1 AND primary_key_value='rollback-row';
    `) === "0",
    {},
  );

  mysql(`
    INSERT INTO batch_idempotency
      (
        tenant_id, panel_id, session_id, chunk_no, idempotency_key,
        request_hash, batch_id, state, response_json
      )
      VALUES (
        1, 10, 'session-1', 0, 'session-1:0',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'container-chunk', 'SUCCEEDED', JSON_OBJECT('terminal', 'SUCCESS')
      );
  `);
  const replay = mysqlScalar(`
    SELECT CONCAT(request_hash, ':', JSON_UNQUOTE(JSON_EXTRACT(response_json, '$.terminal')))
    FROM batch_idempotency
    WHERE tenant_id=1 AND session_id='session-1' AND chunk_no=0;
  `);
  requireCheck(
    "mysql-chunk-durable-replay",
    replay
      === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:SUCCESS",
    { replay },
  );
  const hashConflict = mysqlScalar(`
    SELECT request_hash <>
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    FROM batch_idempotency
    WHERE tenant_id=1 AND session_id='session-1' AND chunk_no=0;
  `);
  requireCheck("mysql-chunk-hash-conflict-detected", hashConflict === "1", {
    hashConflict,
  });

  mysql(`
    INSERT INTO schema_transition_ledger
      (tenant_id, panel_id, operation_id, request_hash, attempt, state)
      VALUES (
        1, 10, 'add-status',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        1, 'STARTED'
      );
    ALTER TABLE schema_transition_target ADD COLUMN status VARCHAR(32) NULL;
    UPDATE schema_transition_ledger
      SET state='SUCCEEDED', error_message=NULL
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-status';
  `);
  requireCheck(
    "mysql-schema-transition-success",
    mysqlScalar(`
      SELECT CONCAT(
        (SELECT state FROM schema_transition_ledger
          WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-status'), ',',
        (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema=DATABASE()
            AND table_name='schema_transition_target'
            AND column_name='status')
      );
    `) === "SUCCEEDED,1",
    {},
  );

  mysql(`
    INSERT INTO schema_transition_ledger
      (tenant_id, panel_id, operation_id, request_hash, attempt, state)
      VALUES (
        1, 10, 'add-recovered-value',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        1, 'STARTED'
      );
  `);
  const ddlFailure = mysql(
    "ALTER TABLE schema_transition_target ADD COLUMN recovered_value INVALID_TYPE;",
    true,
  );
  requireCheck("mysql-ddl-failure-observed", ddlFailure.status !== 0, {
    status: ddlFailure.status,
  });
  mysql(`
    UPDATE schema_transition_ledger
      SET state='FAILED', error_message='injected invalid DDL'
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-recovered-value';
  `);
  requireCheck(
    "mysql-ddl-failure-durable",
    mysqlScalar(`
      SELECT state FROM schema_transition_ledger
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-recovered-value';
    `) === "FAILED",
    {},
  );
  mysql(`
    UPDATE schema_transition_ledger
      SET attempt=2, state='STARTED', error_message=NULL
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-recovered-value';
    ALTER TABLE schema_transition_target
      ADD COLUMN recovered_value BIGINT NULL;
    UPDATE schema_transition_ledger
      SET state='SUCCEEDED'
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-recovered-value';
  `);
  requireCheck(
    "mysql-ddl-resume",
    mysqlScalar(`
      SELECT CONCAT(attempt, ':', state)
      FROM schema_transition_ledger
      WHERE tenant_id=1 AND panel_id=10 AND operation_id='add-recovered-value';
    `) === "2:SUCCEEDED",
    {},
  );

  await verifyRedisLeaseSemantics();

  const afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  requireCheck(
    "reference-source-unchanged",
    referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
    { beforeSnapshot, afterSnapshot },
  );
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-container-adapters",
    status: "pass",
    decision: "L4-A-PROTOCOL-READY",
    capabilityBoundary: {
      level: "L4-A",
      executionPath: "direct-protocol-probe",
      rustServiceTraversed: false,
      concreteRustAdaptersAttested: false,
      productionEligible: false,
      nextRequiredLevel: "L4-B",
    },
    environment: {
      mysql: "mysql:8.4",
      redis: "redis:7.4-alpine",
      composeFile,
    },
    scope: {
      mysql: [
        "atomic row + commit marker + undo + outbox",
        "transaction rollback",
        "durable chunk replay and hash conflict",
        "schema transition success, DDL failure and resume",
      ],
      redis: [
        "shared batch lease",
        "exclusive refresh lease",
        "owner-token renewal and release",
        "expiry and stale owner rejection",
      ],
      realJavaEvidenceClaimed: false,
    },
    referenceSource: afterSnapshot,
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        decision: report.decision,
        checks: checks.length,
        reportPath,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "batch-update-container-adapters",
    status: "blocked",
    decision: "KEEP-L3",
    error: error instanceof Error ? error.message : String(error),
    checks,
  };
  const report = { ...payload, reportHash: stableHash(payload) };
  await writeJson(reportPath, report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

async function waitForServices() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const mysqlReady = compose(
      [
        "exec",
        "-T",
        "mysql",
        "mysql",
        "-h127.0.0.1",
        "-P3306",
        "-ubatch_update",
        "-pbatch_update",
        "--batch",
        "--skip-column-names",
        "batch_update",
        "-e",
        "SELECT 1",
      ],
      true,
    ).stdout.trim() === "1";
    const redisReady = compose(
      ["exec", "-T", "redis", "redis-cli", "PING"],
      true,
    ).stdout.trim() === "PONG";
    if (mysqlReady && redisReady) {
      checks.push({ id: "container-health", pass: true, attempt });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("MySQL/Redis containers did not become healthy");
}

async function verifyRedisLeaseSemantics() {
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
  const key = "zboss:batch-lease:tenant:1:panel:10";
  const now = Date.now();
  const expiry = now + 60_000;
  requireCheck(
    "redis-batch-owner-a",
    redis(["EVAL", acquire, "1", key, "batch", "batch-a", String(now), String(expiry)])
      .stdout.trim() === "ACQUIRED",
    {},
  );
  requireCheck(
    "redis-batch-owner-b",
    redis(["EVAL", acquire, "1", key, "batch", "batch-b", String(now), String(expiry)])
      .stdout.trim() === "ACQUIRED",
    {},
  );
  requireCheck(
    "redis-refresh-blocked-by-batches",
    redis(["EVAL", acquire, "1", key, "refresh", "refresh-a", String(now), String(expiry)])
      .stdout.trim() === "BUSY",
    {},
  );
  requireCheck(
    "redis-owner-renew",
    redis(["EVAL", renew, "1", key, "batch", "batch-a", String(now), String(expiry + 10_000)])
      .stdout.trim() === "RENEWED",
    {},
  );
  requireCheck(
    "redis-stale-owner-release",
    redis(["EVAL", release, "1", key, "batch", "stale-owner"]).stdout.trim()
      === "OWNER_MISSING",
    {},
  );
  redis(["EVAL", release, "1", key, "batch", "batch-a"]);
  redis(["EVAL", release, "1", key, "batch", "batch-b"]);
  requireCheck(
    "redis-refresh-exclusive",
    redis(["EVAL", acquire, "1", key, "refresh", "refresh-a", String(now), String(expiry)])
      .stdout.trim() === "ACQUIRED",
    {},
  );
  requireCheck(
    "redis-batch-blocked-by-refresh",
    redis(["EVAL", acquire, "1", key, "batch", "batch-c", String(now), String(expiry)])
      .stdout.trim() === "BUSY",
    {},
  );
  const future = expiry + 1;
  requireCheck(
    "redis-expired-owner-replaced",
    redis([
      "EVAL",
      acquire,
      "1",
      key,
      "batch",
      "batch-after-expiry",
      String(future),
      String(future + 60_000),
    ]).stdout.trim() === "ACQUIRED",
    {},
  );
}

function mysql(sql, allowFailure = false) {
  const result = compose(
    [
      "exec",
      "-T",
      "mysql",
      "mysql",
      "-ubatch_update",
      "-pbatch_update",
      "--batch",
      "--raw",
      "--skip-column-names",
      "batch_update",
    ],
    allowFailure,
    sql,
  );
  if (!allowFailure) checks.push({ id: `mysql-command-${checks.length}`, pass: true });
  return result;
}

function mysqlScalar(sql) {
  return mysql(sql).stdout.trim();
}

function redis(args) {
  const result = compose(["exec", "-T", "redis", "redis-cli", "--raw", ...args]);
  return result;
}

function compose(args, allowFailure = false, input) {
  return run(
    `compose-${args[0]}-${checks.length}`,
    "docker",
    ["compose", "-f", composeFile, ...args],
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
    checks.push({ id, pass: result.status === 0 });
    if (result.status !== 0) {
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

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
