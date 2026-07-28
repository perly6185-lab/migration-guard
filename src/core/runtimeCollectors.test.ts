import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  collectRuntimeEvidence,
  validateRuntimeCollectorSpec,
  validateRuntimeCollectorEvidence,
  type SafeProcessRunner
} from "./runtimeCollectors.js";

test("collector authoring dry-run reports placeholders without requiring ready status", () => {
  const findings = validateRuntimeCollectorSpec({
    version: 1,
    collector: "mysql",
    status: "draft",
    connectionEnv: "MG_TEST_MYSQL_URL",
    queries: [{ id: "snapshot", sql: "SELECT 1 AS replace_me" }]
  }, { requireReady: false });
  assert.deepEqual(findings, ["MG-COLLECTOR-MYSQL-QUERY-PLACEHOLDER:snapshot"]);
});

const runner: SafeProcessRunner = async (_executable, args) => ({
  exitCode: 0,
  stdout: args[0] === "--batch" ? "id\tstate\n1\tcommitted\n" : "value-1\nvalue-2\n",
  stderr: "",
  timedOut: false
});

test("MySQL collector accepts read-only queries and hashes normalized snapshots", async () => {
  const evidence = await collectRuntimeEvidence({
    version: 1,
    collector: "mysql",
    status: "ready",
    connectionEnv: "MG_TEST_MYSQL_URL",
    queries: [{ id: "committed-rows", sql: "SELECT id, state FROM batch_ledger ORDER BY id" }]
  }, {
    environment: { MG_TEST_MYSQL_URL: "mysql://user:pass@localhost:3306/test" },
    runner
  });
  assert.equal(evidence.status, "passed");
  assert.deepEqual(validateRuntimeCollectorEvidence(evidence), []);
  const blocked = await collectRuntimeEvidence({
    version: 1,
    collector: "mysql",
    status: "ready",
    connectionEnv: "MG_TEST_MYSQL_URL",
    queries: [{ id: "unsafe", sql: "DELETE FROM batch_ledger" }]
  }, {
    environment: { MG_TEST_MYSQL_URL: "mysql://user:pass@localhost/test" },
    runner
  });
  assert.ok(blocked.findings.includes("MG-COLLECTOR-MYSQL-QUERY-UNSAFE:unsafe"));
});

test("Redis collector rejects mutations and never passes credentials as arguments", async () => {
  let observedArgs: string[] = [];
  let observedAuth: string | undefined;
  const observingRunner: SafeProcessRunner = async (_executable, args, options) => {
    observedArgs = args;
    observedAuth = options.env.REDISCLI_AUTH;
    return { exitCode: 0, stdout: "locked\n", stderr: "", timedOut: false };
  };
  const evidence = await collectRuntimeEvidence({
    version: 1,
    collector: "redis",
    status: "ready",
    connectionEnv: "MG_TEST_REDIS_URL",
    probes: [{ id: "lease", command: ["GET", "batch:lease"] }]
  }, {
    environment: { MG_TEST_REDIS_URL: "redis://default:private@localhost:6379/2" },
    runner: observingRunner
  });
  assert.equal(evidence.status, "passed");
  assert.equal(observedArgs.includes("private"), false);
  assert.equal(observedAuth, "private");
  const blocked = await collectRuntimeEvidence({
    version: 1,
    collector: "redis",
    status: "ready",
    connectionEnv: "MG_TEST_REDIS_URL",
    probes: [{ id: "mutation", command: ["SET", "key", "value"] }]
  }, {
    environment: { MG_TEST_REDIS_URL: "redis://localhost" },
    runner
  });
  assert.ok(blocked.findings.includes("MG-COLLECTOR-REDIS-COMMAND-UNSAFE:mutation"));
});

test("event collector filters JSONL by correlation and projects approved fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-events-"));
  try {
    await writeFile(path.join(root, "events.jsonl"), [
      JSON.stringify({ requestId: "r1", type: "accepted", sequence: 1, ignored: "x" }),
      JSON.stringify({ requestId: "r2", type: "other", sequence: 2 })
    ].join("\n"));
    const evidence = await collectRuntimeEvidence({
      version: 1,
      collector: "events",
      status: "ready",
      file: "events.jsonl",
      correlationId: "r1",
      includeFields: ["requestId", "type", "sequence"]
    }, { cwd: root });
    assert.equal(evidence.status, "passed");
    assert.equal((evidence.payload as { eventCount: number }).eventCount, 1);
    assert.deepEqual(validateRuntimeCollectorEvidence(evidence), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL trace collector filters by correlation and persists only normalized metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-sql-trace-"));
  try {
    await writeFile(path.join(root, "sql.jsonl"), [
      JSON.stringify({
        scenarioId: "quality-page",
        requestId: "request-1",
        sequence: 1,
        datasource: "tenant-secret-db",
        sql: "SELECT DISTINCT o.id, SUM(o.amount) FROM orders o WHERE o.status = 'private-value' GROUP BY o.id HAVING SUM(o.amount) > 100 ORDER BY o.id",
        parameters: [{ type: "varchar", value: "private-value" }]
      }),
      JSON.stringify({
        scenarioId: "quality-page",
        requestId: "request-2",
        sequence: 2,
        sql: "SELECT * FROM ignored"
      })
    ].join("\n"));
    const evidence = await collectRuntimeEvidence({
      version: 1,
      collector: "sql-trace",
      status: "ready",
      file: "sql.jsonl",
      scenarioId: "quality-page",
      correlationEnv: "MG_TEST_REQUEST_ID",
      correlationFields: ["requestId"]
    }, {
      cwd: root,
      environment: { MG_TEST_REQUEST_ID: "request-1" }
    });
    assert.equal(evidence.status, "passed");
    assert.deepEqual(validateRuntimeCollectorEvidence(evidence), []);
    const payload = evidence.payload as {
      statementCount: number;
      statements: Array<{ whereFields: string[]; havingFields: string[]; parameterTypes: string[]; distinct: boolean }>;
    };
    assert.equal(payload.statementCount, 1);
    assert.equal(payload.statements[0]?.distinct, true);
    assert.ok(payload.statements[0]?.whereFields.includes("o.status"));
    assert.ok(payload.statements[0]?.havingFields.includes("o.amount"));
    assert.deepEqual(payload.statements[0]?.parameterTypes, ["varchar"]);
    assert.equal(JSON.stringify(payload).includes("private-value"), false);
    assert.equal(JSON.stringify(payload).includes("tenant-secret-db"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI, stream, and tool trace collectors retain ordered metadata without raw content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-structured-trace-"));
  try {
    const cases = [
      {
        collector: "ai-trace" as const,
        fields: ["sequence", "model", "finishReason", "toolCallCount", "factSourceCount"],
        record: { sequence: 2, model: "qwen-plus", finishReason: "stop", toolCallCount: 1, factSourceCount: 2 }
      },
      {
        collector: "stream-trace" as const,
        fields: ["sequence", "eventType", "terminal"],
        record: { sequence: 2, eventType: "done", terminal: true }
      },
      {
        collector: "tool-trace" as const,
        fields: ["sequence", "toolName", "status", "argumentFingerprint", "resultFingerprint"],
        record: { sequence: 2, toolName: "lookup", status: "passed", argumentFingerprint: "a".repeat(64), resultFingerprint: "b".repeat(64) }
      }
    ];
    for (const item of cases) {
      const file = `${item.collector}.jsonl`;
      await writeFile(path.join(root, file), [
        JSON.stringify({ requestId: "other", ...item.record, sequence: 1, prompt: "must-not-leak" }),
        JSON.stringify({ requestId: "request-1", ...item.record, prompt: "must-not-leak" })
      ].join("\n"));
      const evidence = await collectRuntimeEvidence({
        version: 1,
        collector: item.collector,
        status: "ready",
        file,
        correlationEnv: "MG_TEST_REQUEST_ID",
        includeFields: item.fields
      }, { cwd: root, environment: { MG_TEST_REQUEST_ID: "request-1" } });
      assert.equal(evidence.status, "passed", `${item.collector}: ${evidence.findings.join(", ")}`);
      assert.deepEqual(validateRuntimeCollectorEvidence(evidence), []);
      assert.equal((evidence.payload as { recordCount: number }).recordCount, 1);
      assert.equal(JSON.stringify(evidence.payload).includes("must-not-leak"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured trace collectors reject sensitive or incomplete projections", () => {
  assert.ok(validateRuntimeCollectorSpec({
    version: 1,
    collector: "ai-trace",
    status: "ready",
    file: "ai.jsonl",
    correlationEnv: "MG_TEST_REQUEST_ID",
    includeFields: ["sequence", "model", "prompt"]
  }).includes("MG-COLLECTOR-AI-TRACE-FIELDS-INCOMPLETE"));
  assert.ok(validateRuntimeCollectorSpec({
    version: 1,
    collector: "tool-trace",
    status: "ready",
    file: "tool.jsonl",
    correlationEnv: "MG_TEST_REQUEST_ID",
    includeFields: ["sequence", "toolName", "status", "argumentFingerprint", "resultFingerprint", "password"]
  }).includes("MG-COLLECTOR-TOOL-TRACE-FIELD-UNSAFE"));
});
