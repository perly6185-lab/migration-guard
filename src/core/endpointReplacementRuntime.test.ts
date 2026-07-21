import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runEndpointRuntimeDriver, type EndpointRuntimeDriverConfig } from "./endpointReplacementRuntime.js";
import type { ReplacementScenario } from "./endpointReplacementModel.js";

test("generic endpoint driver executes lifecycle and validates generated dimensions", async () => {
  const fixture = await driverFixture();
  try {
    const result = await runEndpointRuntimeDriver(fixture.config, fixture.scenario, { fault: "database-write" });
    assert.equal(result.status, "passed", result.findings.join(", "));
    assert.equal(result.observation?.scenarioId, fixture.scenario.id);
    assert.deepEqual(result.evidence.map((item) => item.operation), [
      "setup", "start", "health", "seed", "invoke", "inject-fault", "snapshot", "collect", "cleanup", "stop"
    ]);
    const operations = await readFile(path.join(fixture.dir, "operations.log"), "utf8");
    assert.match(operations, /collect create-record database-write[\s\S]*cleanup create-record database-write[\s\S]*stop create-record database-write/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("generic endpoint driver always cleans up and stops after a failed operation", async () => {
  const fixture = await driverFixture();
  try {
    fixture.config.operations.invoke = "node -e \"process.exit(3)\"";
    const result = await runEndpointRuntimeDriver(fixture.config, fixture.scenario);
    assert.equal(result.status, "blocked");
    assert.ok(result.findings.includes("RP-DRIVER-OPERATION-FAILED:invoke"));
    assert.deepEqual(result.evidence.slice(-2).map((item) => item.operation), ["cleanup", "stop"]);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("generic endpoint driver rejects unsafe ids and incomplete protocols before execution", async () => {
  const fixture = await driverFixture();
  try {
    const unsafe = await runEndpointRuntimeDriver(fixture.config, { ...fixture.scenario, id: "case && injected" });
    assert.deepEqual(unsafe.findings, ["RP-DRIVER-SCENARIO-ID-UNSAFE"]);
    delete fixture.config.operations.seed;
    const incomplete = await runEndpointRuntimeDriver(fixture.config, fixture.scenario);
    assert.ok(incomplete.findings.includes("RP-DRIVER-OPERATION-MISSING:seed"));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function driverFixture(): Promise<{ dir: string; config: EndpointRuntimeDriverConfig; scenario: ReplacementScenario }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-endpoint-runtime-"));
  await writeFile(path.join(dir, "driver.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "const [operation, scenarioId, fault] = process.argv.slice(2);",
    "appendFileSync('operations.log', `${operation} ${scenarioId} ${fault}\\n`);",
    "if (operation === 'collect') console.log(JSON.stringify({",
    "  scenarioId, fixtureHash: 'fixture-hash', cleanup: { passed: true },",
    "  dimensions: { http: { status: 200 }, context: {}, decisions: [], effects: [], state: {}, events: [], failures: {} }",
    "}));"
  ].join("\n"));
  const operations = Object.fromEntries(
    ["setup", "start", "health", "seed", "invoke", "inject-fault", "snapshot", "collect", "cleanup", "stop"]
      .map((operation) => [operation, `node driver.mjs ${operation} {scenarioId} {fault}`])
  ) as EndpointRuntimeDriverConfig["operations"];
  return {
    dir,
    config: { id: "fixture", root: dir, timeoutMs: 5_000, operations },
    scenario: {
      id: "create-record",
      title: "Create record",
      category: "success",
      sourceNodes: ["Controller.create"],
      requiredDimensions: ["http", "context", "decisions", "effects", "state", "events", "failures"],
      reason: "fixture"
    }
  };
}
