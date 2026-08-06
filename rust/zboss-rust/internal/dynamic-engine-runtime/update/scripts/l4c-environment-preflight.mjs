import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_PROTOCOL,
  validateReplayPlan,
} from "./l4c-replay-core.mjs";

const BINDING_PROTOCOL = "migration-guard.batch-update-l4c-bindings/v1";
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
const defaultPlanPath = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
  "evidence",
  "runtime",
  "l4c",
  "replay-plan.json",
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
const driverPath = path.join(scriptDirectory, "l4c-operation-driver.mjs");

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(renderHelp());
  process.exit(0);
}

const findings = [];
const planPath = nestedPath(options.plan ?? defaultPlanPath, "replay plan");
const contract = await readJson(contractPath);
const plan = await readJson(planPath);
const scenarioFilter = options.scenarios.length > 0
  ? options.scenarios
  : undefined;
const validation = validateReplayPlan(plan, contract, {
  repositoryRoot,
  scenarioFilter,
  allowPartialScenarios: Boolean(scenarioFilter),
});
const selectedScenarioIds = validation.scenarios.map((scenario) => scenario.id);
findings.push(...validation.findings);

const bindingEnvironment = process.env.MG_L4C_BINDING_FILE;
if (!bindingEnvironment) {
  findings.push("MG-L4C-ENV-MISSING:MG_L4C_BINDING_FILE");
}
let binding;
let bindingPath;
let javaProfilePath;
let javaProfileHash;
let javaProfile;
let javaSeedProfileCount = 0;
let rustSeedProfileCount = 0;
if (bindingEnvironment) {
  try {
    bindingPath = nestedPath(bindingEnvironment, "binding file");
    binding = await readJson(bindingPath);
  } catch (error) {
    findings.push(`MG-L4C-BINDING-READ:${safeMessage(error)}`);
  }
}
if (binding) validateBinding(binding, plan, contract, findings);
validateEnvironment(plan, findings);
if ((plan.requiredEnvironment ?? []).includes("MG_L4C_JAVA_STATE_PROFILE")) {
  const configuredProfile = process.env.MG_L4C_JAVA_STATE_PROFILE;
  if (configuredProfile) {
    try {
      javaProfilePath = nestedPath(
        configuredProfile,
        "Java state profile",
      );
      const content = await readFile(javaProfilePath);
      javaProfileHash = canonicalFileHash(content);
      javaProfile = JSON.parse(content.toString("utf8"));
      validateJavaStateProfile(
        javaProfile,
        plan,
        selectedScenarioIds,
        findings,
      );
      if (
        binding?.targets?.source?.stateProfileSha256 !== javaProfileHash
      ) {
        findings.push("MG-L4C-JAVA-PROFILE-HASH-MISMATCH");
      }
      if ((javaProfile.semantics ?? []).some((item) =>
        item.role === "progress" && item.storage === "volatile-event")) {
        for (const scenarioId of selectedScenarioIds) {
          if (!validWebSocketCollector(
            binding?.scenarios?.[scenarioId]?.eventCollectors?.source,
            scenarioId,
          )) {
            findings.push(
              `MG-L4C-WEBSOCKET-COLLECTOR-INVALID:${scenarioId}`,
            );
          }
        }
      }
    } catch (error) {
      findings.push(`MG-L4C-JAVA-PROFILE-READ:${safeMessage(error)}`);
    }
  }
}
if (
  binding?.targets?.source?.hooks?.seed?.requiresSeedProfileHash === true
  && javaProfileHash
) {
  for (const scenarioId of selectedScenarioIds) {
    const configuredSeed = binding.scenarios?.[scenarioId]?.seedProfiles?.source;
    if (!configuredSeed) {
      findings.push(`MG-L4C-JAVA-SEED-MISSING:${scenarioId}`);
      continue;
    }
    try {
      const seedPath = nestedPath(configuredSeed.path, "Java seed profile");
      const content = await readFile(seedPath);
      const seedHash = canonicalFileHash(content);
      validateJavaSeedProfile(
        JSON.parse(content.toString("utf8")),
        scenarioId,
        javaProfileHash,
        javaProfile,
        plan,
        findings,
      );
      if (configuredSeed.sha256 !== seedHash) {
        findings.push(`MG-L4C-JAVA-SEED-HASH-MISMATCH:${scenarioId}`);
      } else {
        javaSeedProfileCount += 1;
      }
    } catch (error) {
      findings.push(`MG-L4C-JAVA-SEED-READ:${scenarioId}:${safeMessage(error)}`);
    }
  }
}
if (binding?.targets?.target?.hooks?.seed?.requiresSeedProfileHash === true) {
  for (const scenarioId of selectedScenarioIds) {
    const configuredSeed = binding.scenarios?.[scenarioId]?.seedProfiles?.target;
    if (!configuredSeed) {
      findings.push(`MG-L4C-RUST-SEED-MISSING:${scenarioId}`);
      continue;
    }
    try {
      const seedPath = nestedPath(configuredSeed.path, "Rust seed profile");
      const content = await readFile(seedPath);
      const seedHash = canonicalFileHash(content);
      validateRustSeedProfile(
        JSON.parse(content.toString("utf8")),
        scenarioId,
        plan,
        findings,
      );
      if (configuredSeed.sha256 !== seedHash) {
        findings.push(`MG-L4C-RUST-SEED-HASH-MISMATCH:${scenarioId}`);
      } else {
        rustSeedProfileCount += 1;
      }
    } catch (error) {
      findings.push(`MG-L4C-RUST-SEED-READ:${scenarioId}:${safeMessage(error)}`);
    }
  }
}

let probes = [];
if (findings.length === 0 && options.connect) {
  try {
    probes = await connectProbes(plan, validation.scenarios);
  } catch (error) {
    findings.push(`MG-L4C-CONNECTIVITY:${redactMessage(
      safeMessage(error),
      plan,
    )}`);
  }
}
const result = {
  schemaVersion: 1,
  stage: "batch-update-l4c-environment-preflight",
  status: findings.length === 0 ? (options.connect ? "connected" : "ready") : "blocked",
  planPath: path.relative(repositoryRoot, planPath),
  bindingPath: bindingPath
    ? path.relative(repositoryRoot, bindingPath)
    : undefined,
  javaProfilePath: javaProfilePath
    ? path.relative(repositoryRoot, javaProfilePath)
    : undefined,
  javaProfileHash,
  javaSeedProfileCount,
  rustSeedProfileCount,
  selectedScenarioCount: validation.scenarios.length,
  checks: {
    plan: validation.findings.length === 0,
    binding: Boolean(binding) && !findings.some((finding) =>
      finding.startsWith("MG-L4C-BINDING")),
    javaProfile:
      !(plan.requiredEnvironment ?? []).includes("MG_L4C_JAVA_STATE_PROFILE")
      || (
        Boolean(javaProfileHash)
        && !findings.some((finding) =>
          finding.startsWith("MG-L4C-JAVA-PROFILE"))
      ),
    javaSeeds:
      binding?.targets?.source?.hooks?.seed?.requiresSeedProfileHash !== true
      || (
        javaSeedProfileCount === selectedScenarioIds.length
        && !findings.some((finding) =>
          finding.startsWith("MG-L4C-JAVA-SEED"))
      ),
    rustSeeds:
      binding?.targets?.target?.hooks?.seed?.requiresSeedProfileHash !== true
      || (
        rustSeedProfileCount === selectedScenarioIds.length
        && !findings.some((finding) =>
          finding.startsWith("MG-L4C-RUST-SEED"))
      ),
    environment: !findings.some((finding) =>
      finding.startsWith("MG-L4C-ENV")
      || finding.startsWith("MG-L4C-URL")),
    connectivity: options.connect ? probes.length === 4 : "not-requested",
  },
  probes,
  findings: [...new Set(findings)].sort(),
};
console.log(JSON.stringify(result, null, 2));
if (result.status === "blocked") process.exitCode = 1;

function validateBinding(value, planValue, contractValue, targetFindings) {
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== BINDING_PROTOCOL
  ) {
    targetFindings.push("MG-L4C-BINDING-PROTOCOL-INVALID");
    return;
  }
  if (value.status !== "approved") {
    targetFindings.push("MG-L4C-BINDING-NOT-APPROVED");
  }
  if (value.projectId !== contractValue.projectId) {
    targetFindings.push("MG-L4C-BINDING-PROJECT-MISMATCH");
  }
  const configuredScenarios = new Set(Object.keys(value.scenarios ?? {}));
  for (const scenarioId of selectedScenarioIds) {
    const scenario = value.scenarios?.[scenarioId];
    if (!configuredScenarios.has(scenarioId) || !scenario?.request) {
      targetFindings.push(
        `MG-L4C-BINDING-SCENARIO-MISSING:${scenarioId}`,
      );
    }
    if (
      scenarioId === "concurrent-write"
      && !validConcurrencyPlan(scenario?.concurrencyPlan)
    ) {
      targetFindings.push(
        `MG-L4C-CONCURRENCY-PLAN-INVALID:${scenarioId}`,
      );
    }
  }
  for (const [targetKind, runtime] of [
    ["source", "java"],
    ["target", "rust"],
  ]) {
    const target = value.targets?.[targetKind];
    if (
      !target
      || target.kind !== runtime
      || !isSafePath(target.healthPath)
      || !isSafePath(target.invokePath)
    ) {
      targetFindings.push(`MG-L4C-BINDING-TARGET-INVALID:${targetKind}`);
      continue;
    }
    if (
      targetKind === "source"
      && !/^[a-f0-9]{64}$/.test(target.stateProfileSha256 ?? "")
    ) {
      targetFindings.push("MG-L4C-BINDING-STATE-PROFILE-HASH-INVALID");
    }
    for (const operation of [
      "doctor",
      "seed",
      "snapshot",
      "collect",
      "cleanup",
      "verifyCleanup",
    ]) {
      validateHook(
        target.hooks?.[operation],
        `${targetKind}:${operation}`,
        targetFindings,
      );
    }
    if (selectedScenarioIds.some((scenarioId) =>
      contractScenario(contractValue, scenarioId)?.category === "fault")) {
      validateHook(
        target.hooks?.faultController,
        `${targetKind}:faultController`,
        targetFindings,
      );
    }
  }
}

function validConcurrencyPlan(value) {
  return value?.driver === "built-in-barrier-v1"
    && value?.startMode === "barrier"
    && value?.writerCount === 2
    && value?.sharedSeedBinding === "row-001"
    && Array.isArray(value?.writers)
    && value.writers.length === value.writerCount
    && new Set(value.writers.map((writer) => writer?.id)).size
      === value.writerCount
    && value.writers.every((writer) =>
      typeof writer?.id === "string"
      && /^writer-[a-z0-9-]{1,32}$/.test(writer.id)
      && typeof writer?.value === "string"
      && writer.value.length >= 1
      && writer.value.length <= 256);
}

function validateHook(hook, label, targetFindings) {
  if (
    !hook
    || typeof hook.program !== "string"
    || !hook.program
    || /<[^>]+>|[\r\n\0]/.test(hook.program)
    || !Array.isArray(hook.args)
    || hook.args.some((argument) =>
      typeof argument !== "string" || /<[^>]+>|[\r\n\0]/.test(argument))
  ) {
    targetFindings.push(`MG-L4C-BINDING-HOOK-INVALID:${label}`);
  }
}

function validWebSocketCollector(value, scenarioId) {
  const completionMode = value?.completionMode ?? "terminal-event";
  return value?.kind === "websocket"
    && value.path === "/ws/zboss"
    && value.messageType === "panel-data-update"
    && value.contentEncoding === "json-string"
    && value.subscribe?.type === "panel-subscribe"
    && value.subscribe?.content?.subscribe === true
    && Array.isArray(value.terminalStatuses)
    && value.terminalStatuses.length > 0
    && ["terminal-event", "no-event"].includes(completionMode)
    && (
      completionMode !== "no-event"
      || (
        scenarioId === "validation-failure"
        && Number.isInteger(value.noEventWindowMs)
        && value.noEventWindowMs >= 100
        && value.noEventWindowMs <= 5_000
      )
    )
    && (
      completionMode !== "terminal-event"
      || value.noEventWindowMs === undefined
    );
}

function validateEnvironment(planValue, targetFindings) {
  for (const name of planValue.requiredEnvironment ?? []) {
    if (!process.env[name]) {
      targetFindings.push(`MG-L4C-ENV-MISSING:${name}`);
    }
  }
  const allowedHosts = new Set(planValue.scope?.allowedHosts ?? []);
  for (const [label, rawUrl, requireDatabase, protocols] of [
    ["source-http", planValue.targets?.source?.baseUrl, false, ["http:", "https:"]],
    ["target-http", planValue.targets?.target?.baseUrl, false, ["http:", "https:"]],
    ["source-mysql", process.env.MG_JAVA_DATABASE_URL, true, ["mysql:"]],
    ["source-redis", process.env.MG_JAVA_REDIS_URL, false, ["redis:"]],
    ["target-mysql", process.env.ZBOSS_BATCH_UPDATE_MYSQL_URL, true, ["mysql:"]],
    ["target-redis", process.env.ZBOSS_BATCH_UPDATE_REDIS_URL, false, ["redis:"]],
  ]) {
    if (!rawUrl) continue;
    try {
      const normalized = rawUrl.startsWith("jdbc:")
        ? rawUrl.slice("jdbc:".length)
        : rawUrl;
      const url = new URL(normalized);
      if (!protocols.includes(url.protocol)) {
        targetFindings.push(`MG-L4C-URL-SCHEME-INVALID:${label}`);
      }
      if (!allowedHosts.has(url.hostname)) {
        targetFindings.push(`MG-L4C-URL-HOST-OUTSIDE-SCOPE:${label}`);
      }
      if (
        requireDatabase
        && decodeURIComponent(url.pathname.replace(/^\/+/, ""))
          !== planValue.scope.database
      ) {
        targetFindings.push(`MG-L4C-URL-DATABASE-OUTSIDE-SCOPE:${label}`);
      }
    } catch {
      targetFindings.push(`MG-L4C-URL-INVALID:${label}`);
    }
  }
}

function validateJavaStateProfile(
  value,
  planValue,
  selectedScenarios,
  targetFindings,
) {
  const invalidIdentity =
    value?.schemaVersion !== 1
    || value?.protocol
      !== "migration-guard.batch-update-l4c-java-state-profile/v1"
    || value?.status !== "approved"
    || value?.projectId !== "zboss-batch-update-with-progress"
    || value?.targetKind !== "source"
    || value?.adapter !== "java-deployed-v1"
    || value?.connections?.mysqlUrlEnv !== "MG_JAVA_DATABASE_URL"
    || (
      value?.connections?.redisUrlEnv !== undefined
      && value.connections.redisUrlEnv !== "MG_JAVA_REDIS_URL"
    );
  if (invalidIdentity) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-IDENTITY-INVALID");
    return;
  }
  if (/<[^>]+>/.test(JSON.stringify(value))) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-PLACEHOLDER");
  }
  const applicableScenarios = value.applicableScenarios ?? [];
  if (
    !Array.isArray(value.applicableScenarios)
    || applicableScenarios.length < 1
    || applicableScenarios.length > 19
    || new Set(applicableScenarios).size !== applicableScenarios.length
    || applicableScenarios.some((scenario) =>
      typeof scenario !== "string"
      || !/^[a-z][a-z0-9-]{2,63}$/.test(scenario))
  ) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-SCENARIOS-INVALID");
  } else {
    for (const scenario of selectedScenarios) {
      if (!applicableScenarios.includes(scenario)) {
        targetFindings.push(
          `MG-L4C-JAVA-PROFILE-SCENARIO-NOT-APPROVED:${scenario}`,
        );
      }
    }
  }
  const mysqlResources = value.mysql?.resources ?? [];
  const redisResources = value.redis?.resources ?? [];
  if (
    mysqlResources.length < 1
    || mysqlResources.some((resource) =>
      resource.cleanup !== true
      || !isIdentifier(resource.table)
      || !isIdentifier(resource.tenantColumn)
      || !isIdentifier(resource.markerColumn)
      || !["exact", "prefix", "json-path-exact"].includes(
        resource.markerMatch,
      )
      || (
        resource.markerMatch === "json-path-exact"
        ? !/^\$\.[A-Za-z][A-Za-z0-9_]{0,63}$/.test(
            resource.markerJsonPath ?? "",
          )
        : resource.markerJsonPath !== undefined
      ))
  ) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-MYSQL-INVALID");
  }
  if (
    mysqlResources.find((resource) =>
      resource.role === "projection")?.table !== planValue.scope.table
  ) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-SCOPE-MISMATCH");
  }
  if (
    redisResources.some((resource) =>
      typeof resource.keyTemplate !== "string"
      || /[*?[\]]/.test(resource.keyTemplate))
    || (
      redisResources.length > 0
      && value.connections.redisUrlEnv !== "MG_JAVA_REDIS_URL"
    )
  ) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-REDIS-INVALID");
  }
  const expectedRoles = [
    "batch-lease",
    "commit",
    "idempotency",
    "outbox",
    "progress",
    "projection",
    "schema-lease",
    "schema-ledger",
    "undo",
  ];
  const semantics = value.semantics ?? [];
  const actualRoles = semantics.map((item) => item.role).sort();
  const mysqlById = new Map(mysqlResources.map((item) => [item.id, item]));
  const redisById = new Map(redisResources.map((item) => [item.id, item]));
  const references = new Set();
  const invalidSemantic = semantics.some((item) => {
    const ids = item.resourceIds ?? [];
    if (item.storage === "mysql" || item.storage === "redis") {
      const resources = item.storage === "mysql" ? mysqlById : redisById;
      return ids.length === 0 || ids.some((id) => {
        const key = `${item.storage}:${id}`;
        const resource = resources.get(id);
        if (!resource || resource.role !== item.role || references.has(key)) {
          return true;
        }
        references.add(key);
        return false;
      });
    }
    if (item.storage === "volatile-event") {
      return item.role !== "progress"
        || item.collector !== "websocket"
        || ids.length !== 0
        || typeof item.rationale !== "string"
        || item.rationale.length < 12;
    }
    return item.storage !== "absent"
      || item.role === "projection"
      || ids.length !== 0
      || typeof item.rationale !== "string"
      || item.rationale.length < 12;
  });
  if (
    JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)
    || invalidSemantic
    || references.size !== mysqlResources.length + redisResources.length
  ) {
    targetFindings.push("MG-L4C-JAVA-PROFILE-SEMANTICS-INVALID");
  }
}

function validateJavaSeedProfile(
  value,
  scenarioId,
  stateProfileHash,
  stateProfile,
  planValue,
  targetFindings,
) {
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== "migration-guard.batch-update-l4c-java-seed/v1"
    || value?.status !== "approved"
    || value?.projectId !== "zboss-batch-update-with-progress"
    || value?.targetKind !== "source"
    || value?.scenarioId !== scenarioId
    || value?.stateProfileSha256 !== stateProfileHash
  ) {
    targetFindings.push(`MG-L4C-JAVA-SEED-IDENTITY-INVALID:${scenarioId}`);
    return;
  }
  const resources = value.resources ?? [];
  const reviewedResources = new Map(
    (stateProfile?.mysql?.resources ?? [])
      .map((resource) => [resource.id, resource]),
  );
  const seenResources = new Set();
  const rowCount = resources.reduce(
    (total, resource) => total + (resource.rows?.length ?? 0),
    0,
  );
  if (
    resources.length === 0
    || rowCount < 1
    || rowCount > planValue.scope.maxRowsPerScenario
    || resources.some((resource) =>
      typeof resource.resourceId !== "string"
      || seenResources.has(resource.resourceId)
      || !reviewedResources.has(resource.resourceId)
      || reviewedResources.get(resource.resourceId).role !== "projection"
      || !Array.isArray(resource.rows)
      || resource.rows.length === 0
      || resource.rows.some((row) =>
        typeof row.markerSuffix !== "string"
        || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.markerSuffix)
        || !row.values
        || typeof row.values !== "object"
        || Array.isArray(row.values)
        || !sameSeedAliases(
          row.values,
          reviewedResources.get(resource.resourceId),
        ))
      || (seenResources.add(resource.resourceId), false))
  ) {
    targetFindings.push(`MG-L4C-JAVA-SEED-CONTENT-INVALID:${scenarioId}`);
  }
}

function validateRustSeedProfile(
  value,
  scenarioId,
  planValue,
  targetFindings,
) {
  const rows = value?.rows ?? [];
  const suffixes = new Set();
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== "migration-guard.batch-update-l4c-target-seed/v1"
    || value?.status !== "approved"
    || value?.projectId !== "zboss-batch-update-with-progress"
    || value?.targetKind !== "target"
    || value?.scenarioId !== scenarioId
    || !Array.isArray(rows)
    || rows.length < 1
    || rows.length > planValue.scope.maxRowsPerScenario
    || rows.some((row) =>
      typeof row?.markerSuffix !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(row.markerSuffix)
      || suffixes.has(row.markerSuffix)
      || !row.values
      || typeof row.values !== "object"
      || Array.isArray(row.values)
      || Object.keys(row.values).length < 1
      || Object.keys(row.values).length > 64
      || Object.keys(row.values).some((key) =>
        !/^[A-Za-z0-9_]{1,64}$/.test(key)
        || ["primaryKey", "values"].includes(key))
      || (suffixes.add(row.markerSuffix), false))
  ) {
    targetFindings.push(`MG-L4C-RUST-SEED-CONTENT-INVALID:${scenarioId}`);
  }
}

function sameSeedAliases(values, resource) {
  const scopeColumns = new Set([
    resource.tenantColumn,
    resource.panelColumn,
    resource.markerColumn,
  ].filter(Boolean));
  const expected = resource.columns
    .filter((column) => !scopeColumns.has(column.name))
    .map((column) => column.alias)
    .sort();
  return JSON.stringify(Object.keys(values).sort()) === JSON.stringify(expected);
}

function isIdentifier(value) {
  return typeof value === "string"
    && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
}

function canonicalFileHash(content) {
  return createHash("sha256")
    .update(content.toString("utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
}

async function connectProbes(planValue, scenarios) {
  const scenario = scenarios[0];
  if (!scenario) throw new Error("no selected scenario is available for probes");
  const marker = `${planValue.scope.markerPrefix}preflight-${process.pid}`;
  const results = [];
  for (const targetKind of ["source", "target"]) {
    for (const operation of ["health", "doctor"]) {
      const output = await spawnJson(
        process.execPath,
        [driverPath, operation],
        {
          ...process.env,
          MG_L4C_TARGET_KIND: targetKind,
          MG_L4C_SCENARIO_ID: scenario.id,
          MG_L4C_MARKER: marker,
          MG_L4C_PHASE: "preflight",
          MG_L4C_BASE_URL: planValue.targets[targetKind].baseUrl,
          MG_L4C_EVENT_BASE_URL:
            planValue.targets[targetKind].eventBaseUrl
            ?? planValue.targets[targetKind].baseUrl,
          MG_L4C_MAX_ROWS: String(planValue.scope.maxRowsPerScenario),
          MG_L4C_DATABASE: planValue.scope.database,
          MG_L4C_TENANT_ID: String(planValue.scope.tenantId),
          MG_L4C_PANEL_ID: String(planValue.scope.panelId),
          MG_L4C_TABLE: planValue.scope.table,
        },
      );
      if (
        output?.schemaVersion !== 1
        || output?.protocol !== OPERATION_PROTOCOL
        || output?.status !== "passed"
      ) {
        throw new Error(`invalid ${targetKind}/${operation} probe response`);
      }
      results.push({
        targetKind,
        operation,
        status: "passed",
        bindingHash: output.bindingHash,
      });
    }
  }
  return results;
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
      if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 256 * 1024) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(
          `environment probe exited ${code}: ${stderr.slice(-2_000)}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("environment probe did not return one JSON document"));
      }
    });
  });
}

function contractScenario(contractValue, scenarioId) {
  return contractValue.entries
    .flatMap((entry) => entry.scenarios)
    .find((scenario) => scenario.id === scenarioId);
}

function isSafePath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/[\r\n\0]/.test(value);
}

function nestedPath(value, label) {
  const candidate = path.resolve(repositoryRoot, value);
  const relative = path.relative(repositoryRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes repository root`);
  }
  return candidate;
}

async function readJson(file) {
  await access(file);
  return JSON.parse(await readFile(file, "utf8"));
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactMessage(message, planValue) {
  let redacted = message;
  for (const name of planValue.environmentValueBindings ?? []) {
    const value = process.env[name];
    if (value) redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

function parseArguments(arguments_) {
  const parsed = {
    connect: false,
    help: false,
    plan: undefined,
    scenarios: [],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--connect") parsed.connect = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--plan") {
      parsed.plan = requiredArgument(arguments_, ++index, argument);
    } else if (argument === "--scenario") {
      parsed.scenarios.push(requiredArgument(arguments_, ++index, argument));
    }
    else throw new Error(`unknown argument: ${argument}`);
  }
  return parsed;
}

function requiredArgument(arguments_, index, option) {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function renderHelp() {
  return [
    "Usage: node l4c-environment-preflight.mjs [options]",
    "",
    "  --plan <path>  Approved replay plan (default: project replay-plan.json)",
    "  --scenario <id>  Validate one promoted scenario (repeatable)",
    "  --connect      Run read-only HTTP health and MySQL/Redis doctor probes",
    "  --help         Show this help",
  ].join("\n");
}
