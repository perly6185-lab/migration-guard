import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAN_PROTOCOL,
  runReplayPlan,
  stableHash,
} from "./l4c-replay-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(
  scriptDirectory,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);
const artifactRoot = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
);
await mkdir(artifactRoot, { recursive: true });
const testRoot = await mkdtemp(path.join(artifactRoot, "l4c-process-test-"));
const driverPath = path.join(scriptDirectory, "l4c-operation-driver.mjs");
const hookPath = path.join(testRoot, "state-hook.mjs");
const faultControllerPath = path.join(testRoot, "fault-controller.mjs");
const bindingPath = path.join(testRoot, "bindings.json");
const route =
  "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress";
let server;

try {
  await writeFile(hookPath, stateHookSource(), "utf8");
  await writeFile(
    faultControllerPath,
    faultControllerSource(),
    "utf8",
  );
  server = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      sendJson(response, 200, { status: "UP" });
      return;
    }
    if (request.url === route && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      sendJson(response, 200, {
        code: 0,
        message: "ok",
        data: {
          committed: 2,
          requestMarker: body.reqId,
        },
      });
      return;
    }
    sendJson(response, 404, { message: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hook = (operation) => ({
    program: process.execPath,
    args: [relative(hookPath), operation],
    timeoutMs: 10_000,
  });
  const faultController = {
    program: process.execPath,
    args: [relative(faultControllerPath), "{faultAction}"],
    timeoutMs: 10_000,
  };
  const sourceBinding = targetBinding("java");
  const targetRuntimeBinding = targetBinding("rust");
  sourceBinding.stateProfileSha256 = "f".repeat(64);
  sourceBinding.hooks.seed = {
    ...hook("seed"),
    requiresProfileHash: true,
    requiresSeedProfileHash: true,
  };
  targetRuntimeBinding.hooks.seed = hook("seed");
  sourceBinding.hooks.faultController = faultController;
  targetRuntimeBinding.hooks.faultController = faultController;
  const scenarioBinding = () => ({
    seedProfiles: {
      source: {
        path: "cases/zboss-batch-update-with-progress/evidence/runtime/l4c/java-seed-profile.template.json",
        sha256: "a".repeat(64),
      },
    },
    request: {
      shared: {
        method: "POST",
        path: route,
        headers: {
          "content-type": "application/json",
          authorization: "${MG_L4C_TEST_AUTH}",
          "x-request-id": "{marker}",
          "x-tenant-id": "{tenantId}",
        },
        body: {
          reqId: "{marker}",
          panelId: "{panelId}",
        },
        acceptedStatuses: [200],
        rowCountPath: "data.committed",
        responseFields: {
          code: "code",
          message: "message",
          data: "data",
        },
      },
    },
    hooks: {
      snapshot: hook("snapshot"),
      collect: hook("collect"),
      cleanup: hook("cleanup"),
      verifyCleanup: hook("verifyCleanup"),
    },
  });
  const binding = {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-bindings/v1",
    status: "approved",
    projectId: "zboss-batch-update-with-progress",
    targets: {
      source: sourceBinding,
      target: targetRuntimeBinding,
    },
    scenarios: {
      "primary-success": scenarioBinding(),
      "dependency-failure": scenarioBinding(),
    },
  };
  await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");

  const priorBinding = process.env.MG_L4C_BINDING_FILE;
  const priorAuth = process.env.MG_L4C_TEST_AUTH;
  process.env.MG_L4C_BINDING_FILE = relative(bindingPath);
  process.env.MG_L4C_TEST_AUTH = "self-test-only";
  try {
    const directHealth = await runDriver("health", baseUrl);
    assert.equal(directHealth.status, "passed");
    assert.equal(directHealth.response.httpStatus, 200);
    const directSeed = await runDriver("seed", baseUrl);
    assert.equal(directSeed.status, "passed");
    assert.equal(directSeed.scope.marker, "mg-l4c-process-marker");
    assert.equal(directSeed.seedHash, "a".repeat(64));

    const contract = {
      projectId: "zboss-batch-update-with-progress",
      projectHash: "c".repeat(64),
      contractHash: "d".repeat(64),
      sourceIdentity: {
        revision: "process-self-test",
        dirty: false,
        dirtyFingerprint: "0".repeat(64),
        identity: "process-self-test",
      },
      entries: [{
        id: "batch-update",
        scenarios: [
          scenarioContract("primary-success", "success"),
          scenarioContract("dependency-failure", "fault"),
        ],
      }],
    };
    const operation = (name) => ({
      program: process.execPath,
      args: [relative(driverPath), name],
      timeoutMs: 10_000,
    });
    const operations = {
      health: operation("health"),
      seed: operation("seed"),
      snapshot: operation("snapshot"),
      invoke: operation("invoke"),
      injectFault: operation("injectFault"),
      collect: operation("collect"),
      cleanup: operation("cleanup"),
      verifyCleanup: operation("verifyCleanup"),
    };
    const now = Date.now();
    const plan = {
      schemaVersion: 1,
      protocol: PLAN_PROTOCOL,
      status: "approved",
      projectId: contract.projectId,
      projectHash: contract.projectHash,
      runtimeContractHash: contract.contractHash,
      approval: {
        mode: "disposable-test-write",
        approvedBy: "process-self-test",
        ticket: "PROCESS-SELF-TEST",
        approvedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        executionNonceSha256: stableHash("process-self-test"),
      },
      scope: {
        environment: "test",
        allowedHosts: ["127.0.0.1"],
        database: "migration_guard_test",
        tenantId: "process-tenant",
        panelId: "process-panel",
        table: "cust_table9002",
        markerPrefix: "mg-l4c-process-",
        maxRowsPerScenario: 10,
        schemaChangesAllowed: false,
      },
      environmentValueBindings: ["MG_L4C_TEST_AUTH"],
      requiredEnvironment: ["MG_L4C_BINDING_FILE", "MG_L4C_TEST_AUTH"],
      targets: {
        source: { kind: "java", baseUrl, operations },
        target: { kind: "rust", baseUrl, operations },
      },
      normalization: { ignorePaths: [] },
    };
    const report = await runReplayPlan(plan, contract, {
      repositoryRoot,
      outputRoot: testRoot,
      runId: "process-self-test-run",
      synthetic: true,
      now,
    });
    assert.equal(report.status, "pass");
    assert.equal(report.dualReplayPassed, true);
    assert.equal(report.cleanupVerified, true);
    assert.equal(report.comparisons[0].differenceCount, 0);
    assert.equal(report.comparisons[1].differenceCount, 0);
    for (const target of Object.values(report.targets)) {
      const faultScenario = target.scenarios.find(
        (scenario) => scenario.scenarioId === "dependency-failure",
      );
      assert.equal(faultScenario.operations.injectFault.fault.state, "active");
      assert.equal(
        faultScenario.operations.verifyCleanup.cleanup.faultArtifacts,
        0,
      );
      assert.equal(faultScenario.operations.verifyCleanup.fault.state, "inactive");
    }
    const checkpoint = JSON.parse(await readFile(
      path.join(testRoot, "process-self-test-run", "checkpoint.json"),
      "utf8",
    ));
    assert.equal(checkpoint.status, "completed");
    assert.ok(checkpoint.operations.length >= 30);
  } finally {
    restoreEnvironment("MG_L4C_BINDING_FILE", priorBinding);
    restoreEnvironment("MG_L4C_TEST_AUTH", priorAuth);
  }

  console.log(JSON.stringify({
    status: "pass",
    checks: 20,
    coverage: [
      "real-child-process-spawn",
      "built-in-http-health",
      "built-in-http-invoke",
      "state-hook-protocol",
      "scenario-seed-hash-binding",
      "seed-hash-report-evidence",
      "source-target-dual-replay",
      "checkpoint-from-child-processes",
      "zero-residue-verification",
      "fault-controller-apply",
      "fault-controller-active-verification",
      "fault-controller-revert",
      "fault-controller-inactive-verification",
      "fault-artifact-zero-residue",
    ],
  }, null, 2));
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const resolved = path.resolve(testRoot);
  if (
    path.dirname(resolved) === path.resolve(artifactRoot)
    && path.basename(resolved).startsWith("l4c-process-test-")
  ) {
    await rm(resolved, { recursive: true, force: true });
  }
}

function targetBinding(kind) {
  return {
    kind,
    healthPath: "/health",
    healthMethod: "GET",
    acceptedHealthStatuses: [200],
    healthJsonPath: "status",
    healthExpectedValue: "UP",
    invokePath: route,
    responseFields: {
      code: "code",
      message: "message",
      data: "data",
    },
    timeoutMs: 10_000,
    hooks: {},
  };
}

async function runDriver(operation, baseUrl) {
  const environment = {
    ...process.env,
    MG_L4C_BASE_URL: baseUrl,
    MG_L4C_DATABASE: "migration_guard_test",
    MG_L4C_MARKER: operation === "health" ? "" : "mg-l4c-process-marker",
    MG_L4C_MAX_ROWS: "10",
    MG_L4C_OPERATION: operation,
    MG_L4C_PANEL_ID: "process-panel",
    MG_L4C_PHASE: operation === "snapshot" ? "before" : "",
    MG_L4C_RUN_ID: "process-self-test",
    MG_L4C_SCENARIO_ID: operation === "health" ? "" : "primary-success",
    MG_L4C_TABLE: "cust_table9002",
    MG_L4C_TARGET_KIND: "source",
    MG_L4C_TENANT_ID: "process-tenant",
  };
  return spawnJson(process.execPath, [relative(driverPath), operation], environment);
}

function spawnJson(program, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`driver exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function stateHookSource() {
  return `const operation = process.argv[2];
const marker = process.env.MG_L4C_MARKER;
const base = {
  schemaVersion: 1,
  protocol: "migration-guard.batch-update-l4c-state-hook/v1",
  status: "passed",
  marker,
  rowCount: 2,
  profileHash: "f".repeat(64),
};
if (operation === "seed") {
  base.seedHash = "a".repeat(64);
  base.bindings = {
    "row-001": {
      generatedId: "seed-row-001",
      marker: marker + "-row-001",
    },
    "row-002": {
      generatedId: "seed-row-002",
      marker: marker + "-row-002",
    },
  };
}
if (operation === "snapshot") {
  base.snapshot = {
    phase: process.env.MG_L4C_PHASE,
    rows: [{ id: "row-1", value: process.env.MG_L4C_PHASE }],
  };
}
if (operation === "collect") {
  base.observation = {
    dimensions: {
      http: { verified: true, collector: "operation-driver" },
      context: {
        verified: true,
        tenantId: process.env.MG_L4C_TENANT_ID,
        panelId: process.env.MG_L4C_PANEL_ID,
        database: process.env.MG_L4C_DATABASE,
        table: process.env.MG_L4C_TABLE,
      },
      decisions: {
        verified: true,
        scenarioId: process.env.MG_L4C_SCENARIO_ID,
      },
      effects: {
        verified: true,
        fixtureRows: 2,
        commitRows: 2,
        undoRows: 2,
        outboxRows: 4,
      },
      state: { verified: true, mysql: {} },
      events: {
        verified: true,
        redis: {
          progress: {
            state: "SUCCESS",
            terminal: "1",
            total: "1",
            committed: "1",
            failed: "0",
          },
        },
      },
      failures: { verified: true, markerScoped: true },
      performance: {
        verified: true,
        rowCount: 2,
        withinBudget: true,
      },
    },
  };
}
if (operation === "verifyCleanup") {
  base.cleanup = {
    fixtureRows: 0,
    undoRows: 0,
    outboxRows: 0,
    commitRows: 0,
    redisKeys: 0,
    leaseKeys: 0,
    schemaArtifacts: 0,
    faultArtifacts: 0,
  };
}
console.log(JSON.stringify(base));
`;
}

function faultControllerSource() {
  return `import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
const marker = process.env.MG_L4C_MARKER;
const scenarioId = process.env.MG_L4C_SCENARIO_ID;
const targetKind = process.env.MG_L4C_TARGET_KIND;
const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(root, "fault-" + targetKind + "-" + marker + ".json");
if (action === "apply") {
  await writeFile(stateFile, JSON.stringify({ marker, scenarioId }), "utf8");
} else if (action === "verify-active") {
  await access(stateFile);
} else if (action === "revert") {
  await rm(stateFile, { force: true });
} else if (action === "verify-inactive") {
  try {
    await access(stateFile);
    throw new Error("fault artifact remains active");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
} else {
  throw new Error("unknown fault action");
}
const active = action === "apply" || action === "verify-active";
console.log(JSON.stringify({
  schemaVersion: 1,
  protocol: "migration-guard.batch-update-l4c-fault-controller/v1",
  status: "passed",
  action,
  state: {
    apply: "applied",
    "verify-active": "active",
    revert: "reverted",
    "verify-inactive": "inactive",
  }[action],
  scenarioId,
  marker,
  mechanismId: "process-self-test-fault",
  resourceId: "fault:" + targetKind + ":" + marker,
  restoreRequired: active,
  artifactCount: active ? 1 : 0,
}));
`;
}

function scenarioContract(id, category) {
  return {
    id,
    category,
    requiredDimensions: [
      "http",
      "context",
      "decisions",
      "effects",
      "state",
      "events",
      "failures",
    ],
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        request.destroy();
        reject(new Error("request exceeded 1 MiB"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
