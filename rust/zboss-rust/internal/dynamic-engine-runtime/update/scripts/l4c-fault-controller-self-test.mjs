import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(
  scriptDirectory,
  "l4c-toxiproxy-fault-controller.mjs",
);
const proxies = new Map([
  ["java-mysql", proxy("java-mysql", 13306)],
  ["rust-mysql", proxy("rust-mysql", 23306)],
]);
const server = createServer(async (request, response) => {
  const segments = new URL(request.url, "http://127.0.0.1")
    .pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const configured = segments[0] === "proxies" ? proxies.get(segments[1]) : undefined;
  if (!configured) return send(response, 404, { error: "not found" });
  if (segments.length === 2 && request.method === "GET") {
    return send(response, 200, {
      ...configured,
      toxics: [...configured.toxics.values()],
    });
  }
  if (segments[2] !== "toxics") return send(response, 404, { error: "not found" });
  if (segments.length === 3 && request.method === "POST") {
    const toxic = JSON.parse(await readBody(request));
    configured.toxics.set(toxic.name, toxic);
    return send(response, 200, toxic);
  }
  const toxic = configured.toxics.get(segments[3]);
  if (request.method === "GET") {
    return toxic
      ? send(response, 200, toxic)
      : send(response, 404, { error: "not found" });
  }
  if (request.method === "DELETE") {
    configured.toxics.delete(segments[3]);
    response.writeHead(toxic ? 204 : 404);
    return response.end();
  }
  return send(response, 405, { error: "method" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const adminUrl = `http://127.0.0.1:${address.port}/`;
const baseEnvironment = {
  ...process.env,
  MG_L4C_ALLOWED_HOSTS: JSON.stringify(["127.0.0.1"]),
  MG_L4C_MARKER: "mg-l4c-fault-self-test",
  MG_L4C_SCENARIO_ID: "dependency-failure",
  MG_L4C_SOURCE_TOXIPROXY_URL: adminUrl,
  MG_L4C_SOURCE_TOXIPROXY_PROXY: "java-mysql",
  MG_L4C_TARGET_TOXIPROXY_URL: adminUrl,
  MG_L4C_TARGET_TOXIPROXY_PROXY: "rust-mysql",
};

try {
  const sourceApplied = await run("apply", "source");
  assert.equal(sourceApplied.state, "applied");
  assert.equal(sourceApplied.mechanismId, "toxiproxy-reset-peer-v1");
  assert.equal(sourceApplied.artifactCount, 1);
  assert.match(sourceApplied.resourceId, /mg-l4c-fault-self-test/);
  const sourceActive = await run("verify-active", "source");
  assert.equal(sourceActive.state, "active");
  assert.equal(proxies.get("java-mysql").toxics.size, 1);

  const targetApplied = await run("apply", "target");
  assert.equal(targetApplied.targetKind, "target");
  assert.equal(proxies.get("rust-mysql").toxics.size, 1);

  const sourceReverted = await run("revert", "source");
  assert.equal(sourceReverted.state, "reverted");
  assert.equal(sourceReverted.artifactCount, 0);
  assert.equal(proxies.get("java-mysql").toxics.size, 0);
  assert.equal(proxies.get("rust-mysql").toxics.size, 1);
  const sourceInactive = await run("verify-inactive", "source");
  assert.equal(sourceInactive.state, "inactive");

  await run("revert", "target");
  const targetInactive = await run("verify-inactive", "target");
  assert.equal(targetInactive.artifactCount, 0);
  assert.equal(proxies.get("rust-mysql").toxics.size, 0);

  await run("apply", "source");
  const sourceToxic = [...proxies.get("java-mysql").toxics.values()][0];
  sourceToxic.type = "latency";
  await assert.rejects(run("verify-active", "source"), /configuration changed/);
  proxies.get("java-mysql").toxics.clear();

  await assert.rejects(
    run("verify-inactive", "source", {
      MG_L4C_SOURCE_TOXIPROXY_URL: "http://example.com:8474/",
    }),
    /escaped approved scope/,
  );
  await assert.rejects(
    run("apply", "source", { MG_L4C_SCENARIO_ID: "primary-success" }),
    /limited to dependency-failure/,
  );

  console.log(JSON.stringify({
    status: "pass",
    checks: 18,
    coverage: [
      "source-reset-peer-apply-active",
      "target-reset-peer-apply-active",
      "source-target-resource-isolation",
      "source-revert-inactive-zero-residue",
      "target-revert-inactive-zero-residue",
      "foreign-toxic-configuration-fail-closed",
      "admin-host-scope-fail-closed",
      "scenario-scope-fail-closed",
    ],
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function proxy(name, port) {
  return {
    name,
    listen: `127.0.0.1:${port}`,
    upstream: "127.0.0.1:3306",
    enabled: true,
    toxics: new Map(),
  };
}

function run(action, targetKind, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [controllerPath, action], {
      cwd: path.resolve(scriptDirectory, "..", "..", "..", "..", "..", ".."),
      env: {
        ...baseEnvironment,
        MG_L4C_FAULT_ACTION: action,
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
