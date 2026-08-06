import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deterministicResourceId,
  FAULT_PROTOCOL,
} from "./l4c-scenario-fault-controller.mjs";

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
const controllers = {
  "post-commit-effect-failure": "l4c-post-commit-effect-fault-controller.mjs",
  "schema-transition-failure": "l4c-schema-transition-fault-controller.mjs",
  "transaction-failure": "l4c-transaction-fault-controller.mjs",
  "undo-excludes-failed-rows": "l4c-undo-delivery-fault-controller.mjs",
};
const activeResources = new Map();
let tamperNextResponse = false;
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || new URL(request.url, "http://127.0.0.1").pathname !== "/") {
    return send(response, 404, { error: "not found" });
  }
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    return send(response, 400, { error: "invalid json" });
  }
  if (
    body?.schemaVersion !== 1
    || body.protocol !== FAULT_PROTOCOL
    || typeof body.marker !== "string"
  ) {
    return send(response, 400, { error: "invalid request" });
  }
  const key = `${body.targetKind}:${body.mechanismId}:${body.marker}`;
  const resourceId = deterministicResourceId(
    body.targetKind,
    body.mechanismId,
    body.marker,
  );
  if (["apply", "verify-active"].includes(body.action)) {
    activeResources.set(key, resourceId);
  } else {
    activeResources.delete(key);
  }
  const active = activeResources.has(key);
  const value = {
    schemaVersion: 1,
    protocol: FAULT_PROTOCOL,
    status: "passed",
    action: body.action,
    state: body.state,
    scenarioId: body.scenarioId,
    marker: body.marker,
    targetKind: body.targetKind,
    mechanismId: tamperNextResponse ? "foreign-mechanism" : body.mechanismId,
    resourceId,
    restoreRequired: active,
    artifactCount: active ? 1 : 0,
  };
  tamperNextResponse = false;
  return send(response, 200, value);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const controlUrl = `http://127.0.0.1:${address.port}/`;
const baseEnvironment = {
  ...process.env,
  MG_L4C_ALLOWED_HOSTS: JSON.stringify(["127.0.0.1"]),
  MG_L4C_MARKER: "mg-l4c-scenario-fault-self-test",
  MG_L4C_SOURCE_FAULT_CONTROL_URL: controlUrl,
  MG_L4C_TARGET_FAULT_CONTROL_URL: controlUrl,
};

try {
  for (const [scenarioId, file] of Object.entries(controllers)) {
    for (const targetKind of ["source", "target"]) {
      const applied = await run(file, "apply", scenarioId, targetKind);
      assert.equal(applied.state, "applied");
      assert.equal(applied.artifactCount, 1);
      const active = await run(file, "verify-active", scenarioId, targetKind);
      assert.equal(active.state, "active");
      assert.equal(active.resourceId, applied.resourceId);
      const reverted = await run(file, "revert", scenarioId, targetKind);
      assert.equal(reverted.state, "reverted");
      assert.equal(reverted.artifactCount, 0);
      const inactive = await run(file, "verify-inactive", scenarioId, targetKind);
      assert.equal(inactive.state, "inactive");
      assert.equal(inactive.artifactCount, 0);
      assert.equal(activeResources.size, 0);
    }
  }

  await assert.rejects(
    run(
      controllers["transaction-failure"],
      "apply",
      "post-commit-effect-failure",
      "source",
    ),
    /scenario binding changed/,
  );
  await assert.rejects(
    run(
      controllers["post-commit-effect-failure"],
      "apply",
      "post-commit-effect-failure",
      "source",
      { MG_L4C_SOURCE_FAULT_CONTROL_URL: "http://example.com/" },
    ),
    /escaped approved scope/,
  );
  tamperNextResponse = true;
  await assert.rejects(
    run(
      controllers["undo-excludes-failed-rows"],
      "apply",
      "undo-excludes-failed-rows",
      "target",
    ),
    /evidence is invalid/,
  );
  assert.equal(activeResources.size, 1);
  activeResources.clear();

  console.log(JSON.stringify({
    status: "pass",
    checks: 35,
    coverage: [
      "four-mechanisms-source-target-lifecycle",
      "resource-identity-is-marker-bound",
      "zero-residue-after-revert-and-inactive",
      "scenario-binding-fail-closed",
      "admin-host-scope-fail-closed",
      "foreign-mechanism-evidence-fail-closed",
    ],
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function run(file, action, scenarioId, targetKind, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(scriptDirectory, file),
      action,
    ], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        MG_L4C_FAULT_ACTION: action,
        MG_L4C_SCENARIO_ID: scenarioId,
        MG_L4C_TARGET_KIND: targetKind,
        ...overrides,
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
