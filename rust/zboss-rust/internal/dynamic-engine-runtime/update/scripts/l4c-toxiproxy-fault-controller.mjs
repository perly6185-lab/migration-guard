import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "migration-guard.batch-update-l4c-fault-controller/v1";
const MECHANISM_ID = "toxiproxy-reset-peer-v1";
const ACTION_STATES = {
  apply: "applied",
  "verify-active": "active",
  revert: "reverted",
  "verify-inactive": "inactive",
};

export async function runToxiproxyFaultController({
  action = process.argv[2] ?? process.env.MG_L4C_FAULT_ACTION,
  environment = process.env,
  fetchImplementation = fetch,
} = {}) {
  const marker = requiredToken(environment.MG_L4C_MARKER, "marker", 128);
  const scenarioId = requiredToken(
    environment.MG_L4C_SCENARIO_ID,
    "scenario id",
    64,
  );
  const targetKind = requiredToken(
    environment.MG_L4C_TARGET_KIND,
    "target kind",
    16,
  );
  if (scenarioId !== "dependency-failure") {
    throw new Error("fault controller is limited to dependency-failure");
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
  const prefix = `MG_L4C_${targetKind.toUpperCase()}_TOXIPROXY_`;
  const adminUrl = validateAdminUrl(
    environment[`${prefix}URL`],
    environment.MG_L4C_ALLOWED_HOSTS,
  );
  const proxyName = requiredToken(
    environment[`${prefix}PROXY`],
    "proxy name",
    96,
  );
  const toxicName = `mg-l4c-${targetKind}-${createHash("sha256")
    .update(marker)
    .digest("hex")
    .slice(0, 20)}`;
  const client = toxiproxyClient(
    adminUrl,
    proxyName,
    toxicName,
    fetchImplementation,
  );
  await client.requireEnabledProxy();

  let artifactCount;
  if (action === "apply") {
    const existing = await client.getToxic();
    if (existing) requireExpectedToxic(existing);
    else await client.createToxic();
    requireExpectedToxic(await client.requireToxic());
    artifactCount = 1;
  } else if (action === "verify-active") {
    requireExpectedToxic(await client.requireToxic());
    artifactCount = 1;
  } else if (action === "revert") {
    const existing = await client.getToxic();
    if (existing) {
      requireExpectedToxic(existing);
      await client.deleteToxic();
    }
    await client.requireMissingToxic();
    artifactCount = 0;
  } else {
    await client.requireMissingToxic();
    artifactCount = 0;
  }

  const active = artifactCount === 1;
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    status: "passed",
    action,
    state: ACTION_STATES[action],
    scenarioId,
    marker,
    targetKind,
    mechanismId: MECHANISM_ID,
    resourceId: `toxiproxy:${targetKind}:${proxyName}:${toxicName}:${marker}`,
    restoreRequired: active,
    artifactCount,
    diagnostic: active
      ? "marker-bound reset-peer toxic is active"
      : "marker-bound reset-peer toxic is absent",
  };
}

function toxiproxyClient(
  adminUrl,
  proxyName,
  toxicName,
  fetchImplementation,
) {
  const proxyPath = `/proxies/${encodeURIComponent(proxyName)}`;
  const toxicCollectionPath = `${proxyPath}/toxics`;
  const toxicPath = `${toxicCollectionPath}/${encodeURIComponent(toxicName)}`;
  const request = async (requestPath, options = {}) => {
    let response;
    try {
      response = await fetchImplementation(new URL(requestPath, adminUrl), {
        ...options,
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("Toxiproxy control request failed");
    }
    return response;
  };
  const readJson = async (response, label) => {
    const text = await response.text();
    if (text.length > 65_536) {
      throw new Error(`Toxiproxy ${label} response exceeded limit`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Toxiproxy ${label} response is not JSON`);
    }
  };
  const getToxic = async () => {
    const response = await request(toxicPath);
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      throw new Error("Toxiproxy toxic lookup failed");
    }
    return readJson(response, "toxic lookup");
  };
  return {
    async requireEnabledProxy() {
      const response = await request(proxyPath);
      if (response.status !== 200) {
        throw new Error("Toxiproxy proxy is unavailable");
      }
      const proxy = await readJson(response, "proxy lookup");
      if (
        proxy?.name !== proxyName
        || proxy?.enabled !== true
        || typeof proxy?.listen !== "string"
        || typeof proxy?.upstream !== "string"
      ) {
        throw new Error("Toxiproxy proxy configuration is invalid");
      }
    },
    getToxic,
    async requireToxic() {
      const toxic = await getToxic();
      if (!toxic) throw new Error("Toxiproxy toxic is not active");
      return toxic;
    },
    async createToxic() {
      const response = await request(toxicCollectionPath, {
        method: "POST",
        body: JSON.stringify(expectedToxic(toxicName)),
      });
      if (![200, 201].includes(response.status)) {
        throw new Error("Toxiproxy toxic creation failed");
      }
    },
    async deleteToxic() {
      const response = await request(toxicPath, { method: "DELETE" });
      if (![200, 204, 404].includes(response.status)) {
        throw new Error("Toxiproxy toxic removal failed");
      }
    },
    async requireMissingToxic() {
      if (await getToxic()) {
        throw new Error("Toxiproxy fault artifact remains active");
      }
    },
  };
}

function expectedToxic(name) {
  return {
    name,
    type: "reset_peer",
    stream: "downstream",
    toxicity: 1,
    attributes: { timeout: 0 },
  };
}

function requireExpectedToxic(value) {
  if (
    !value
    || value.type !== "reset_peer"
    || value.stream !== "downstream"
    || value.toxicity !== 1
    || value.attributes?.timeout !== 0
  ) {
    throw new Error("Toxiproxy toxic configuration changed");
  }
}

function validateAdminUrl(rawValue, rawAllowedHosts) {
  let allowedHosts;
  try {
    allowedHosts = JSON.parse(rawAllowedHosts ?? "null");
  } catch {
    throw new Error("approved host binding is invalid");
  }
  if (
    !Array.isArray(allowedHosts)
    || allowedHosts.length === 0
    || allowedHosts.some((host) =>
      typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(host))
  ) {
    throw new Error("approved host binding is invalid");
  }
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("Toxiproxy admin URL is invalid");
  }
  if (
    url.protocol !== "http:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !allowedHosts.includes(url.hostname)
  ) {
    throw new Error("Toxiproxy admin URL escaped approved scope");
  }
  return url;
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

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runToxiproxyFaultController();
  console.log(JSON.stringify(result));
}
