import { createHash } from "node:crypto";

export const FAULT_PROTOCOL =
  "migration-guard.batch-update-l4c-fault-controller/v1";

export const SCENARIO_FAULT_DEFINITIONS = Object.freeze({
  "post-commit-effect-failure": Object.freeze({
    mechanismId: "fault-post-commit-effect-v1",
    operation: "post-commit-effect",
  }),
  "schema-transition-failure": Object.freeze({
    mechanismId: "fault-schema-transition-v1",
    operation: "schema-transition",
  }),
  "transaction-failure": Object.freeze({
    mechanismId: "fault-transaction-rollback-v1",
    operation: "transaction-rollback",
  }),
  "undo-excludes-failed-rows": Object.freeze({
    mechanismId: "fault-undo-delivery-v1",
    operation: "undo-delivery",
  }),
});

const ACTION_STATES = Object.freeze({
  apply: "applied",
  "verify-active": "active",
  revert: "reverted",
  "verify-inactive": "inactive",
});

export async function runScenarioFaultController({
  definition,
  action = process.argv[2] ?? process.env.MG_L4C_FAULT_ACTION,
  scenarioId = process.argv[3] ?? process.env.MG_L4C_SCENARIO_ID,
  targetKind = process.env.MG_L4C_TARGET_KIND,
  environment = process.env,
  fetchImplementation = fetch,
} = {}) {
  if (!definition || typeof definition.mechanismId !== "string") {
    throw new Error("fault mechanism definition is missing");
  }
  const expectedScenarioId = Object.entries(SCENARIO_FAULT_DEFINITIONS)
    .find(([, value]) => value.mechanismId === definition.mechanismId)?.[0];
  if (!expectedScenarioId || scenarioId !== expectedScenarioId) {
    throw new Error("fault controller scenario binding changed");
  }
  if (!Object.hasOwn(ACTION_STATES, action)) {
    throw new Error("fault controller action is invalid");
  }
  if (
    environment.MG_L4C_FAULT_ACTION
    && environment.MG_L4C_FAULT_ACTION !== action
  ) {
    throw new Error("fault controller action binding changed");
  }
  if (targetKind !== "source" && targetKind !== "target") {
    throw new Error("fault controller target kind is invalid");
  }
  const marker = requiredToken(environment.MG_L4C_MARKER, "marker", 128);
  const allowedHosts = parseAllowedHosts(environment.MG_L4C_ALLOWED_HOSTS);
  const controlUrl = validateControlUrl(
    environment[`MG_L4C_${targetKind.toUpperCase()}_FAULT_CONTROL_URL`],
    allowedHosts,
  );
  const requestBody = {
    schemaVersion: 1,
    protocol: FAULT_PROTOCOL,
    action,
    state: ACTION_STATES[action],
    scenarioId,
    marker,
    targetKind,
    mechanismId: definition.mechanismId,
    operation: definition.operation,
    restoreRequired: ["apply", "verify-active"].includes(action),
  };
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (environment.MG_L4C_FAULT_CONTROL_TOKEN) {
    headers.authorization = `Bearer ${environment.MG_L4C_FAULT_CONTROL_TOKEN}`;
  }
  let response;
  try {
    response = await fetchImplementation(controlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("fault control request failed");
  }
  const text = await response.text();
  if (text.length > 65_536) {
    throw new Error("fault control response exceeded limit");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("fault control response is not JSON");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error("fault control request was rejected");
  }
  validateEvidence(value, requestBody);
  return value;
}

export function validateScenarioFaultEvidence(value, requestBody) {
  try {
    validateEvidence(value, requestBody);
    return [];
  } catch (error) {
    return [error.message];
  }
}

function validateEvidence(value, requestBody) {
  if (
    !value
    || value.schemaVersion !== 1
    || value.protocol !== FAULT_PROTOCOL
    || value.status !== "passed"
    || value.action !== requestBody.action
    || value.state !== requestBody.state
    || value.scenarioId !== requestBody.scenarioId
    || value.marker !== requestBody.marker
    || value.targetKind !== requestBody.targetKind
    || value.mechanismId !== requestBody.mechanismId
    || typeof value.resourceId !== "string"
    || !value.resourceId.startsWith(
      `failpoint:${requestBody.targetKind}:${requestBody.mechanismId}:`,
    )
    || !value.resourceId.includes(`:${requestBody.marker}`)
    || !Number.isInteger(value.artifactCount)
    || value.artifactCount < 0
  ) {
    throw new Error("fault control evidence is invalid");
  }
  const active = ["apply", "verify-active"].includes(requestBody.action);
  if (
    value.restoreRequired !== active
    || (active && value.artifactCount < 1)
    || (!active && value.artifactCount !== 0)
  ) {
    throw new Error("fault control cleanup state is invalid");
  }
}

function parseAllowedHosts(rawValue) {
  let value;
  try {
    value = JSON.parse(rawValue ?? "null");
  } catch {
    throw new Error("approved host binding is invalid");
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((host) =>
      typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(host))
  ) {
    throw new Error("approved host binding is invalid");
  }
  return value;
}

function validateControlUrl(rawValue, allowedHosts) {
  let value;
  try {
    value = new URL(rawValue);
  } catch {
    throw new Error("fault control URL is invalid");
  }
  if (
    !["http:", "https:"].includes(value.protocol)
    || value.username
    || value.password
    || !value.pathname.startsWith("/")
    || value.pathname.includes("..")
    || value.pathname.length > 256
    || value.search
    || value.hash
    || !allowedHosts.includes(value.hostname)
  ) {
    throw new Error("fault control URL escaped approved scope");
  }
  return value;
}

function requiredToken(value, label, maximumLength) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function deterministicResourceId(targetKind, mechanismId, marker) {
  const digest = createHash("sha256")
    .update(`${targetKind}:${mechanismId}:${marker}`)
    .digest("hex")
    .slice(0, 20);
  return `failpoint:${targetKind}:${mechanismId}:${digest}:${marker}`;
}
