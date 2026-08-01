import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableHash } from "./l4c-replay-core.mjs";

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
const contractPath = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const planTemplatePath = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
  "evidence",
  "runtime",
  "l4c",
  "replay-plan.template.json",
);
const preflightPath = path.join(
  scriptDirectory,
  "l4c-environment-preflight.mjs",
);
await mkdir(artifactRoot, { recursive: true });
const testRoot = await mkdtemp(path.join(
  artifactRoot,
  "l4c-environment-test-",
));

try {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const plan = JSON.parse(await readFile(planTemplatePath, "utf8"));
  const now = Date.now();
  Object.assign(plan, {
    status: "approved",
    projectHash: contract.projectHash,
    runtimeContractHash: contract.contractHash,
    approval: {
      mode: "disposable-test-write",
      approvedBy: "environment-self-test",
      ticket: "ENVIRONMENT-SELF-TEST",
      approvedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      executionNonceSha256: stableHash("environment-self-test"),
    },
    scope: {
      environment: "test",
      allowedHosts: ["127.0.0.1"],
      database: "migration_guard_test",
      tenantId: "9001",
      panelId: "9002",
      table: "cust_table9003",
      markerPrefix: "mg-l4c-env-",
      maxRowsPerScenario: 10,
      schemaChangesAllowed: false,
    },
    environmentValueBindings: [],
    requiredEnvironment: [
      "MG_L4C_BINDING_FILE",
      "MG_L4C_JAVA_STATE_PROFILE",
    ],
    normalization: {
      ignorePaths: [],
    },
  });
  plan.targets.source.baseUrl = "http://127.0.0.1:18001";
  plan.targets.target.baseUrl = "http://127.0.0.1:18002";
  const scenarioIds = contract.entries.flatMap((entry) =>
    entry.scenarios.map((scenario) => scenario.id));

  const hook = {
    program: process.execPath,
    args: ["approved-state-hook.mjs"],
  };
  const target = (kind) => ({
    kind,
    healthPath: "/health",
    invokePath:
      "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress",
    acceptedHealthStatuses: [200],
    hooks: {
      doctor: hook,
      seed: hook,
      snapshot: hook,
      faultController: hook,
      collect: hook,
      cleanup: hook,
      verifyCleanup: hook,
    },
  });
  const request = {
    shared: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { reqId: "{marker}" },
      acceptedStatuses: [200],
      responseFields: ["code"],
    },
  };
  const binding = {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-bindings/v1",
    status: "approved",
    projectId: contract.projectId,
    targets: {
      source: target("java"),
      target: target("rust"),
    },
    scenarios: Object.fromEntries(
      contract.entries
        .flatMap((entry) => entry.scenarios)
        .map((scenario) => [scenario.id, { request, hooks: {} }]),
    ),
  };
  const planPath = path.join(testRoot, "plan.json");
  const bindingPath = path.join(testRoot, "bindings.json");
  const profilePath = path.join(testRoot, "java-state-profile.json");
  const profile = javaStateProfile();
  await writeJson(planPath, plan);
  await writeJson(profilePath, profile);
  binding.targets.source.stateProfileSha256 = createHash("sha256")
    .update(await readFile(profilePath))
    .digest("hex");
  binding.targets.source.hooks.seed = {
    ...binding.targets.source.hooks.seed,
    requiresSeedProfileHash: true,
  };
  binding.targets.target.hooks.seed = {
    ...binding.targets.target.hooks.seed,
    requiresSeedProfileHash: true,
  };
  const seedPaths = new Map();
  const targetSeedPaths = new Map();
  for (const scenarioId of scenarioIds) {
    const seedPath = path.join(testRoot, `${scenarioId}.java-seed.json`);
    const seed = javaSeedProfile(
      scenarioId,
      binding.targets.source.stateProfileSha256,
    );
    await writeJson(seedPath, seed);
    const sha256 = createHash("sha256")
      .update(await readFile(seedPath))
      .digest("hex");
    const targetSeedPath = path.join(
      testRoot,
      `${scenarioId}.rust-seed.json`,
    );
    const targetSeed = rustSeedProfile(scenarioId);
    await writeJson(targetSeedPath, targetSeed);
    const targetSha256 = createHash("sha256")
      .update(await readFile(targetSeedPath))
      .digest("hex");
    binding.scenarios[scenarioId].seedProfiles = {
      source: { path: relative(seedPath), sha256 },
      target: { path: relative(targetSeedPath), sha256: targetSha256 },
    };
    seedPaths.set(scenarioId, { path: seedPath, seed, sha256 });
    targetSeedPaths.set(scenarioId, {
      path: targetSeedPath,
      seed: targetSeed,
      sha256: targetSha256,
    });
  }
  await writeJson(bindingPath, binding);

  const ready = await runPreflight(planPath, bindingPath, profilePath);
  assert.equal(ready.code, 0);
  assert.equal(ready.output.status, "ready");
  assert.equal(ready.output.checks.plan, true);
  assert.equal(ready.output.checks.binding, true);
  assert.equal(ready.output.checks.javaProfile, true);
  assert.equal(ready.output.checks.javaSeeds, true);
  assert.equal(ready.output.javaSeedProfileCount, scenarioIds.length);
  assert.equal(ready.output.checks.rustSeeds, true);
  assert.equal(ready.output.rustSeedProfileCount, scenarioIds.length);
  assert.equal(ready.output.checks.environment, true);
  assert.match(ready.output.javaProfileHash, /^[a-f0-9]{64}$/);

  const primaryBindingPath = path.join(
    testRoot,
    "bindings.primary-success.json",
  );
  const primaryBinding = structuredClone(binding);
  primaryBinding.scenarios = {
    [scenarioIds[0]]: primaryBinding.scenarios[scenarioIds[0]],
  };
  await writeJson(primaryBindingPath, primaryBinding);
  const primaryReady = await runPreflight(
    planPath,
    primaryBindingPath,
    profilePath,
    [scenarioIds[0]],
  );
  assert.equal(primaryReady.code, 0);
  assert.equal(primaryReady.output.status, "ready");
  assert.equal(primaryReady.output.selectedScenarioCount, 1);

  profile.status = "template";
  await writeJson(profilePath, profile);
  const profileBlocked = await runPreflight(
    planPath,
    bindingPath,
    profilePath,
  );
  assert.equal(profileBlocked.code, 1);
  assert.ok(profileBlocked.output.findings.includes(
    "MG-L4C-JAVA-PROFILE-IDENTITY-INVALID",
  ));
  profile.status = "approved";
  await writeJson(profilePath, profile);

  profile.mysql.resources[0].cleanupOrder = 11;
  await writeJson(profilePath, profile);
  const hashBlocked = await runPreflight(
    planPath,
    bindingPath,
    profilePath,
  );
  assert.equal(hashBlocked.code, 1);
  assert.ok(hashBlocked.output.findings.includes(
    "MG-L4C-JAVA-PROFILE-HASH-MISMATCH",
  ));
  profile.mysql.resources[0].cleanupOrder = 10;
  await writeJson(profilePath, profile);

  const firstSeed = seedPaths.get(scenarioIds[0]);
  firstSeed.seed.resources[0].rows[0].values.value = "drifted";
  await writeJson(firstSeed.path, firstSeed.seed);
  const seedHashBlocked = await runPreflight(
    planPath,
    bindingPath,
    profilePath,
  );
  assert.equal(seedHashBlocked.code, 1);
  assert.ok(seedHashBlocked.output.findings.includes(
    `MG-L4C-JAVA-SEED-HASH-MISMATCH:${scenarioIds[0]}`,
  ));
  firstSeed.seed.resources[0].rows[0].values.value = "fixture";
  await writeJson(firstSeed.path, firstSeed.seed);

  firstSeed.seed.resources[0].rows[0].values = { unknownAlias: "fixture" };
  await writeJson(firstSeed.path, firstSeed.seed);
  binding.scenarios[scenarioIds[0]].seedProfiles.source.sha256 =
    createHash("sha256").update(await readFile(firstSeed.path)).digest("hex");
  await writeJson(bindingPath, binding);
  const seedAliasBlocked = await runPreflight(
    planPath,
    bindingPath,
    profilePath,
  );
  assert.equal(seedAliasBlocked.code, 1);
  assert.ok(seedAliasBlocked.output.findings.includes(
    `MG-L4C-JAVA-SEED-CONTENT-INVALID:${scenarioIds[0]}`,
  ));
  firstSeed.seed.resources[0].rows[0].values = { value: "fixture" };
  await writeJson(firstSeed.path, firstSeed.seed);
  binding.scenarios[scenarioIds[0]].seedProfiles.source.sha256 = firstSeed.sha256;
  await writeJson(bindingPath, binding);

  const firstTargetSeed = targetSeedPaths.get(scenarioIds[0]);
  firstTargetSeed.seed.rows[0].values.primaryKey = "spoofed";
  await writeJson(firstTargetSeed.path, firstTargetSeed.seed);
  binding.scenarios[scenarioIds[0]].seedProfiles.target.sha256 =
    createHash("sha256")
      .update(await readFile(firstTargetSeed.path))
      .digest("hex");
  await writeJson(bindingPath, binding);
  const targetSeedReservedBlocked = await runPreflight(
    planPath,
    bindingPath,
    profilePath,
  );
  assert.equal(targetSeedReservedBlocked.code, 1);
  assert.ok(targetSeedReservedBlocked.output.findings.includes(
    `MG-L4C-RUST-SEED-CONTENT-INVALID:${scenarioIds[0]}`,
  ));
  delete firstTargetSeed.seed.rows[0].values.primaryKey;
  await writeJson(firstTargetSeed.path, firstTargetSeed.seed);
  binding.scenarios[scenarioIds[0]].seedProfiles.target.sha256 =
    firstTargetSeed.sha256;
  await writeJson(bindingPath, binding);

  binding.targets.source.hooks.cleanup.program = "<unapproved-hook>";
  await writeJson(bindingPath, binding);
  const blocked = await runPreflight(planPath, bindingPath, profilePath);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.output.status, "blocked");
  assert.ok(blocked.output.findings.includes(
    "MG-L4C-BINDING-HOOK-INVALID:source:cleanup",
  ));

  console.log(JSON.stringify({
    status: "pass",
    checks: 22,
    coverage: [
      "approved-plan-binding-static-preflight",
      "required-environment-present",
      "scoped-url-validation",
      "all-contract-scenarios-bound",
      "single-promoted-scenario-preflight",
      "placeholder-hook-fail-closed",
      "approved-java-state-profile",
      "java-state-profile-hash",
      "unapproved-java-state-profile-rejected",
      "java-state-profile-hash-drift-rejected",
      "scenario-seed-profile-validation",
      "scenario-seed-profile-hash-drift-rejected",
      "scenario-seed-alias-escape-rejected",
      "target-seed-profile-validation",
      "target-seed-reserved-key-rejected",
    ],
  }, null, 2));
} finally {
  const resolved = path.resolve(testRoot);
  if (
    path.dirname(resolved) === path.resolve(artifactRoot)
    && path.basename(resolved).startsWith("l4c-environment-test-")
  ) {
    await rm(resolved, { recursive: true, force: true });
  }
}

async function runPreflight(
  planPath,
  bindingPath,
  profilePath,
  scenarios = [],
) {
  const result = await spawnProcess(
    process.execPath,
    [
      preflightPath,
      "--plan",
      relative(planPath),
      ...scenarios.flatMap((scenario) => ["--scenario", scenario]),
    ],
    {
      ...process.env,
      MG_L4C_BINDING_FILE: relative(bindingPath),
      MG_L4C_JAVA_STATE_PROFILE: relative(profilePath),
    },
  );
  return {
    code: result.code,
    output: JSON.parse(result.stdout),
  };
}

function javaStateProfile() {
  const mysql = (id, role, panel = false) => ({
    id,
    role,
    table: role === "projection"
      ? "cust_table9003"
      : `fixture_${id.replaceAll("-", "_")}`,
    tenantColumn: "tenant_id",
    ...(panel ? { panelColumn: "panel_id" } : {}),
    markerColumn: "batch_id",
    markerMatch: role === "projection" ? "prefix" : "exact",
    orderColumn: "batch_id",
    columns: [
      {
        name: "batch_id",
        alias: "primaryKey",
        kind: "scalar",
      },
      ...(role === "projection"
        ? [{
            name: "seed_value",
            alias: "value",
            kind: "scalar",
          }]
        : []),
    ],
    cleanup: true,
    cleanupOrder: 10,
  });
  const redis = (id, role, markerLocation) => ({
    id,
    role,
    dataType: "hash",
    keyTemplate: markerLocation === "key"
      ? "progress:{tenantId}:{marker}"
      : `${id}:{tenantId}:{panelId}`,
    markerLocation,
    fields: [],
    cleanup: markerLocation === "key"
      ? "exact-key"
      : "matching-hash-fields",
  });
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-java-state-profile/v1",
    status: "approved",
    projectId: "zboss-batch-update-with-progress",
    targetKind: "source",
    adapter: "java-deployed-v1",
    connections: {
      mysqlUrlEnv: "MG_JAVA_DATABASE_URL",
      redisUrlEnv: "MG_JAVA_REDIS_URL",
    },
    semantics: [
      semantic("projection", "mysql", ["projection"]),
      semantic("idempotency", "mysql", ["idempotency"]),
      semantic("commit", "mysql", ["commit"]),
      semantic("undo", "mysql", ["undo"]),
      semantic("outbox", "mysql", ["outbox"]),
      semantic("schema-ledger", "mysql", ["schema-ledger"]),
      semantic("progress", "redis", ["progress"]),
      semantic("batch-lease", "redis", ["batch-lease"]),
      semantic("schema-lease", "redis", ["schema-lease"]),
    ],
    mysql: {
      resources: [
        mysql("projection", "projection", true),
        mysql("idempotency", "idempotency", true),
        mysql("commit", "commit"),
        mysql("undo", "undo"),
        mysql("outbox", "outbox"),
        mysql("schema-ledger", "schema-ledger", true),
      ],
    },
    redis: {
      resources: [
        redis("progress", "progress", "key"),
        redis("batch-lease", "batch-lease", "hash-field"),
        redis("schema-lease", "schema-lease", "hash-field"),
      ],
    },
  };
}

function semantic(role, storage, resourceIds) {
  return { role, storage, resourceIds };
}

function javaSeedProfile(scenarioId, stateProfileSha256) {
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-java-seed/v1",
    status: "approved",
    projectId: "zboss-batch-update-with-progress",
    targetKind: "source",
    scenarioId,
    stateProfileSha256,
    resources: [{
      resourceId: "projection",
      rows: [{
        markerSuffix: "row-001",
        values: { value: "fixture" },
      }],
    }],
  };
}

function rustSeedProfile(scenarioId) {
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-target-seed/v1",
    status: "approved",
    projectId: "zboss-batch-update-with-progress",
    targetKind: "target",
    scenarioId,
    rows: [{
      markerSuffix: "row-001",
      values: { value: "fixture" },
    }],
  };
}

function spawnProcess(program, args, environment) {
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
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}
