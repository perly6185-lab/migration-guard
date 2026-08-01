import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAULT_PROTOCOL,
  OPERATION_PROTOCOL,
  stableHash,
} from "./l4c-replay-core.mjs";

const BINDING_PROTOCOL = "migration-guard.batch-update-l4c-bindings/v1";
const HOOK_PROTOCOL = "migration-guard.batch-update-l4c-state-hook/v1";
const EVENT_PROTOCOL =
  "migration-guard.batch-update-l4c-websocket-event/v1";
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
const operationArgument = process.argv[2] ?? process.env.MG_L4C_OPERATION;
const operation = operationArgument === "inject-fault"
  ? "injectFault"
  : operationArgument === "verify-cleanup"
    ? "verifyCleanup"
    : operationArgument;
if (!operation) throw new Error("L4-C operation is required");
const bindingFile = process.env.MG_L4C_BINDING_FILE;
if (!bindingFile) throw new Error("MG_L4C_BINDING_FILE is required");
const resolvedBinding = path.resolve(repositoryRoot, bindingFile);
ensureNested(repositoryRoot, resolvedBinding, "binding file");
const binding = JSON.parse(await readFile(resolvedBinding, "utf8"));
validateBinding(binding);

const targetKind = requiredEnvironment("MG_L4C_TARGET_KIND");
const scenarioId = process.env.MG_L4C_SCENARIO_ID ?? "";
const marker = process.env.MG_L4C_MARKER ?? "";
const phase = process.env.MG_L4C_PHASE ?? "";
const category = process.env.MG_L4C_CATEGORY ?? "";
const target = binding.targets[targetKind];
if (!target) throw new Error(`target binding is missing: ${targetKind}`);
const scenario = scenarioId ? binding.scenarios[scenarioId] : undefined;
if (scenarioId && !scenario) {
  throw new Error(`scenario binding is missing: ${scenarioId}`);
}

const scope = marker
  ? {
      marker,
      tenantId: requiredEnvironment("MG_L4C_TENANT_ID"),
      panelId: requiredEnvironment("MG_L4C_PANEL_ID"),
      table: requiredEnvironment("MG_L4C_TABLE"),
      database: requiredEnvironment("MG_L4C_DATABASE"),
      rowCount: 0,
    }
  : undefined;
const context = {
  targetKind,
  scenarioId,
  category,
  marker,
  phase,
  baseUrl: requiredEnvironment("MG_L4C_BASE_URL"),
  maxRows: Number(requiredEnvironment("MG_L4C_MAX_ROWS")),
  operation,
  scope,
  stateProfileSha256: target.stateProfileSha256,
  seedProfile: scenario?.seedProfiles?.[targetKind],
  seedBindings: parseSeedBindings(process.env.MG_L4C_SEED_BINDINGS),
  eventCollector: scenario?.eventCollectors?.[targetKind],
  outputRoot: process.env.MG_L4C_OUTPUT_ROOT,
};

let result;
if (operation === "health") {
  result = await runHealth(target, context);
} else if (operation === "invoke") {
  result = await runInvoke(target, scenario, context);
} else if (["setup", "start", "stop"].includes(operation)) {
  result = target.hooks?.[operation]
    ? await runHook(target.hooks[operation], context)
    : { status: "passed" };
} else if (operation === "injectFault") {
  const controller = faultController(target, scenario);
  if (!controller) {
    throw new Error(
      `fault controller is missing: ${targetKind}/${scenarioId}`,
    );
  }
  const applied = await runFaultController(controller, context, "apply");
  const active = await runFaultController(
    controller,
    context,
    "verify-active",
  );
  requireSameFaultResource(applied, active);
  result = {
    status: "passed",
    rowCount: 0,
    fault: {
      ...active,
      applyHash: stableHash(applied),
    },
  };
} else {
  const hook = scenario?.hooks?.[operation] ?? target.hooks?.[operation];
  if (!hook) {
    throw new Error(`state hook is missing: ${targetKind}/${scenarioId}/${operation}`);
  }
  let revertedFault;
  if (category === "fault" && operation === "cleanup") {
    const controller = faultController(target, scenario);
    if (!controller) throw new Error("fault controller is missing during cleanup");
    revertedFault = await runFaultController(
      controller,
      context,
      "revert",
    );
  }
  result = await runHook(hook, context);
  if (revertedFault) result.fault = revertedFault;
  if (operation === "verifyCleanup") {
    if (!result.cleanup || typeof result.cleanup !== "object") {
      throw new Error("state hook cleanup counters are missing");
    }
    if (category === "fault") {
      const controller = faultController(target, scenario);
      if (!controller) {
        throw new Error("fault controller is missing during cleanup verification");
      }
      const inactive = await runFaultController(
        controller,
        context,
        "verify-inactive",
      );
      result.cleanup.faultArtifacts = inactive.artifactCount;
      result.fault = inactive;
    } else if (!Number.isInteger(result.cleanup.faultArtifacts)) {
      throw new Error("state hook faultArtifacts counter is missing");
    }
  }
}

if (result.status !== "passed") {
  throw new Error(`operation reported blocked: ${operation}`);
}
const rowCount = Number(result.rowCount ?? 0);
if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > context.maxRows) {
  throw new Error(`operation row count escaped approved limit: ${operation}`);
}
if (scope) scope.rowCount = rowCount;
const output = {
  schemaVersion: 1,
  protocol: OPERATION_PROTOCOL,
  status: "passed",
  ...(scope ? { scope } : {}),
  ...(result.snapshot !== undefined ? { snapshot: result.snapshot } : {}),
  ...(result.response !== undefined ? { response: result.response } : {}),
  ...(result.observation !== undefined
    ? { observation: result.observation }
    : {}),
  ...(result.cleanup !== undefined ? { cleanup: result.cleanup } : {}),
  ...(result.fault !== undefined ? { fault: result.fault } : {}),
  ...(result.profileHash !== undefined
    ? { profileHash: result.profileHash }
    : {}),
  ...(result.seedHash !== undefined ? { seedHash: result.seedHash } : {}),
  ...(result.bindings !== undefined ? { bindings: result.bindings } : {}),
  ...(result.eventCapture !== undefined
    ? { eventCapture: result.eventCapture }
    : {}),
  bindingHash: stableHash(binding),
};
console.log(JSON.stringify(output));

async function runHealth(targetValue, contextValue) {
  const response = await fetchWithTimeout(
    new URL(targetValue.healthPath, contextValue.baseUrl),
    {
      method: targetValue.healthMethod ?? "GET",
      headers: materializeHeaders(targetValue.healthHeaders ?? {}),
    },
    targetValue.timeoutMs ?? 30_000,
  );
  const body = await readResponseBody(response);
  if (
    !targetValue.acceptedHealthStatuses.includes(response.status)
    || (
      targetValue.healthJsonPath
      && readJsonPath(body, targetValue.healthJsonPath)
        !== targetValue.healthExpectedValue
    )
  ) {
    throw new Error(`health check failed with HTTP ${response.status}`);
  }
  return {
    status: "passed",
    response: {
      httpStatus: response.status,
      body: sanitizeResponse(body, targetValue.responseFields),
    },
  };
}

async function runInvoke(targetValue, scenarioValue, contextValue) {
  if (!scenarioValue?.request) {
    throw new Error(`request binding is missing: ${contextValue.scenarioId}`);
  }
  const request = scenarioValue.request[contextValue.targetKind]
    ?? scenarioValue.request.shared;
  if (!request) {
    throw new Error(
      `request target binding is missing: ${contextValue.targetKind}/${contextValue.scenarioId}`,
    );
  }
  const replacements = replacementValues(contextValue);
  const body = materialize(request.body, replacements);
  const headers = materializeHeaders(request.headers ?? {}, replacements);
  const collector = contextValue.eventCollector
    ? await openEventCollector(contextValue.eventCollector, contextValue)
    : undefined;
  let response;
  let responseBody;
  let eventCapture;
  try {
    response = await fetchWithTimeout(
      new URL(request.path ?? targetValue.invokePath, contextValue.baseUrl),
      {
        method: request.method ?? "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      request.timeoutMs ?? targetValue.timeoutMs ?? 120_000,
    );
    responseBody = await readResponseBody(response);
    const accepted = request.acceptedStatuses ?? [200];
    if (!accepted.includes(response.status)) {
      throw new Error(`invoke failed with HTTP ${response.status}`);
    }
    if (collector) {
      eventCapture = await collector.finish(responseBody);
    }
  } finally {
    collector?.close();
  }
  return {
    status: "passed",
    rowCount: Number(
      readJsonPath(responseBody, request.rowCountPath ?? "")
      ?? request.expectedRowCount
      ?? 0,
    ),
    response: {
      httpStatus: response.status,
      body: sanitizeResponse(
        responseBody,
        request.responseFields ?? targetValue.responseFields,
      ),
    },
    ...(eventCapture ? { eventCapture } : {}),
  };
}

async function openEventCollector(configuration, contextValue) {
  validateEventCollector(configuration, contextValue);
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket runtime is unavailable");
  }
  if (!contextValue.outputRoot) {
    throw new Error("MG_L4C_OUTPUT_ROOT is required for WebSocket capture");
  }
  const replacements = replacementValues(contextValue);
  const base = new URL(contextValue.baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(new URL(configuration.path, base));
  const records = [];
  let byteCount = 0;
  let socketError;
  let opened = false;
  const openedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket subscribe timed out")),
      configuration.openTimeoutMs ?? 10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      opened = true;
      const content = materialize(configuration.subscribe.content, replacements);
      socket.send(JSON.stringify({
        type: configuration.subscribe.type,
        content: configuration.subscribe.stringifyContent === false
          ? content
          : JSON.stringify(content),
      }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    }, { once: true });
  });
  socket.addEventListener("error", () => {
    socketError = new Error("WebSocket capture failed");
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    byteCount += Buffer.byteLength(event.data);
    if (
      byteCount > (configuration.maxBytes ?? 1024 * 1024)
      || records.length >= (configuration.maxEvents ?? 1000)
    ) {
      socketError = new Error("WebSocket capture exceeded reviewed limits");
      socket.close();
      return;
    }
    try {
      const envelope = JSON.parse(event.data);
      if (envelope?.type !== configuration.messageType) return;
      const payload = configuration.contentEncoding === "json-string"
        ? JSON.parse(envelope.content)
        : envelope.content;
      if (!payload || typeof payload !== "object") return;
      const panelId = readJsonPath(payload, configuration.panelIdPath);
      const panelMatches = typeof panelId === "number"
        ? Number(contextValue.scope.panelId) === panelId
        : String(panelId) === String(contextValue.scope.panelId);
      if (!panelMatches) return;
      const batchId = readJsonPath(payload, configuration.batchIdPath);
      if (
        typeof batchId !== "string"
        || !/^[A-Za-z0-9._:-]{3,192}$/.test(batchId)
      ) {
        return;
      }
      const status = String(
        readJsonPath(payload, configuration.statusPath) ?? "",
      );
      const percentage = Number(
        readJsonPath(payload, configuration.percentagePath) ?? 0,
      );
      records.push({
        schemaVersion: 1,
        protocol: EVENT_PROTOCOL,
        scenarioId: contextValue.scenarioId,
        marker: contextValue.marker,
        panelId: String(contextValue.scope.panelId),
        type: envelope.type,
        batchId,
        status,
        percentage: Number.isFinite(percentage) ? percentage : 0,
        terminal:
          configuration.terminalStatuses.includes(status)
          || percentage >= 100,
      });
    } catch {
      // Unrelated or malformed frames are ignored; terminal evidence is required.
    }
  });
  await openedPromise;
  return {
    async finish(responseBody) {
      if (configuration.completionMode === "no-event") {
        const deadline = Date.now() + configuration.noEventWindowMs;
        while (Date.now() <= deadline) {
          if (socketError) throw socketError;
          if (records.length > 0) {
            throw new Error("WebSocket event was emitted for a no-event scenario");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const outputRoot = path.resolve(contextValue.outputRoot);
        const eventPath = path.join(
          outputRoot,
          "events",
          contextValue.targetKind,
          contextValue.scenarioId,
          `${contextValue.marker}.jsonl`,
        );
        ensureNested(outputRoot, eventPath, "WebSocket event evidence");
        await mkdir(path.dirname(eventPath), { recursive: true });
        await writeFile(eventPath, "", "utf8");
        return {
          protocol: EVENT_PROTOCOL,
          collector: "websocket",
          completionMode: "no-event",
          eventCount: 0,
        };
      }
      const deadline = Date.now()
        + (configuration.terminalTimeoutMs ?? 30_000);
      let selected;
      while (Date.now() <= deadline) {
        if (socketError) throw socketError;
        const responseBatchId = (configuration.responseBatchIdPaths ?? [])
          .map((jsonPath) => readJsonPath(responseBody, jsonPath))
          .find((value) => typeof value === "string" && value);
        const terminal = records.filter((record) => record.terminal);
        const terminalBatchIds = [...new Set(
          terminal.map((record) => record.batchId),
        )];
        const batchId = responseBatchId
          ?? (terminalBatchIds.length === 1 ? terminalBatchIds[0] : undefined);
        if (batchId && terminal.some((record) => record.batchId === batchId)) {
          selected = records.filter((record) => record.batchId === batchId);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!selected) {
        throw new Error(
          "WebSocket terminal event was missing or batch correlation was ambiguous",
        );
      }
      const outputRoot = path.resolve(contextValue.outputRoot);
      const eventPath = path.join(
        outputRoot,
        "events",
        contextValue.targetKind,
        contextValue.scenarioId,
        `${contextValue.marker}.jsonl`,
      );
      ensureNested(outputRoot, eventPath, "WebSocket event evidence");
      await mkdir(path.dirname(eventPath), { recursive: true });
      await writeFile(
        eventPath,
        `${selected.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      const terminal = selected.findLast((record) => record.terminal);
      return {
        protocol: EVENT_PROTOCOL,
        collector: "websocket",
        eventCount: selected.length,
        batchId: terminal.batchId,
        terminalStatus: terminal.status,
        terminalPercentage: terminal.percentage,
      };
    },
    close() {
      if (opened && socket.readyState === WebSocket.OPEN) {
        const content = materialize(
          configuration.subscribe.content,
          replacements,
        );
        socket.send(JSON.stringify({
          type: configuration.subscribe.type,
          content: JSON.stringify({ ...content, subscribe: false }),
        }));
      }
      if (
        socket.readyState === WebSocket.OPEN
        || socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    },
  };
}

async function runHook(definition, contextValue) {
  validateHookDefinition(definition);
  const replacements = replacementValues(contextValue);
  const args = definition.args.map((argument) =>
    replacePlaceholders(argument, replacements));
  const cwd = path.resolve(repositoryRoot, definition.cwd ?? ".");
  ensureNested(repositoryRoot, cwd, "hook cwd");
  const environment = {
    ...process.env,
    MG_L4C_HOOK_PROTOCOL: HOOK_PROTOCOL,
    ...(contextValue.operation === "seed" && contextValue.seedProfile
      ? {
          MG_L4C_SEED_PROFILE: contextValue.seedProfile.path,
          MG_L4C_SEED_PROFILE_SHA256: contextValue.seedProfile.sha256,
        }
      : {}),
  };
  const value = await spawnJson(
    definition.program,
    args,
    cwd,
    environment,
    definition.timeoutMs ?? 120_000,
  );
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== HOOK_PROTOCOL
    || value?.status !== "passed"
  ) {
    throw new Error("state hook returned an invalid document");
  }
  if (value.marker !== contextValue.marker) {
    throw new Error("state hook marker does not match");
  }
  if (
    (
      definition.requiresProfileHash === true
      || (
        contextValue.targetKind === "source"
        && [
          "doctor",
          "seed",
          "snapshot",
          "collect",
          "cleanup",
          "verifyCleanup",
        ].includes(contextValue.operation)
      )
    )
    && (
      !/^[a-f0-9]{64}$/.test(value.profileHash ?? "")
      || value.profileHash !== contextValue.stateProfileSha256
    )
  ) {
    throw new Error("state hook profile hash does not match binding");
  }
  if (
    definition.requiresSeedProfileHash === true
    && (
      contextValue.operation !== "seed"
      || !contextValue.seedProfile
      || !/^[a-f0-9]{64}$/.test(value.seedHash ?? "")
      || value.seedHash !== contextValue.seedProfile.sha256
    )
  ) {
    throw new Error("state hook seed profile hash does not match binding");
  }
  if (
    contextValue.operation === "seed"
    && definition.requiresSeedProfileHash === true
  ) {
    validateSeedBindings(value.bindings, Number(value.rowCount ?? 0));
  }
  return value;
}

async function runFaultController(definition, contextValue, action) {
  validateHookDefinition(definition);
  const replacements = {
    ...replacementValues(contextValue),
    faultAction: action,
  };
  const args = definition.args.map((argument) =>
    replacePlaceholders(argument, replacements));
  const cwd = path.resolve(repositoryRoot, definition.cwd ?? ".");
  ensureNested(repositoryRoot, cwd, "fault controller cwd");
  const value = await spawnJson(
    definition.program,
    args,
    cwd,
    {
      ...process.env,
      MG_L4C_FAULT_ACTION: action,
      MG_L4C_FAULT_PROTOCOL: FAULT_PROTOCOL,
    },
    definition.timeoutMs ?? 120_000,
  );
  if (
    value?.schemaVersion !== 1
    || value?.protocol !== FAULT_PROTOCOL
    || value?.status !== "passed"
    || value?.action !== action
    || value?.marker !== contextValue.marker
    || value?.scenarioId !== contextValue.scenarioId
    || typeof value?.mechanismId !== "string"
    || !/^[A-Za-z0-9._:-]{3,128}$/.test(value.mechanismId)
    || typeof value?.resourceId !== "string"
    || !value.resourceId.includes(contextValue.marker)
    || !Number.isInteger(value?.artifactCount)
    || value.artifactCount < 0
  ) {
    throw new Error(`fault controller returned invalid ${action} evidence`);
  }
  const expectedState = {
    apply: "applied",
    "verify-active": "active",
    revert: "reverted",
    "verify-inactive": "inactive",
  }[action];
  if (
    value.state !== expectedState
    || (
      ["apply", "verify-active"].includes(action)
      && (
        value.restoreRequired !== true
        || value.artifactCount < 1
      )
    )
    || (
      ["revert", "verify-inactive"].includes(action)
      && (
        value.restoreRequired !== false
        || value.artifactCount !== 0
      )
    )
  ) {
    throw new Error(`fault controller state is invalid for ${action}`);
  }
  return value;
}

function faultController(targetValue, scenarioValue) {
  return scenarioValue?.hooks?.faultController
    ?? targetValue.hooks?.faultController;
}

function requireSameFaultResource(left, right) {
  if (
    left.mechanismId !== right.mechanismId
    || left.resourceId !== right.resourceId
  ) {
    throw new Error("fault controller verification changed resource identity");
  }
}

function validateBinding(value) {
  const findings = [];
  if (
    !value
    || value.schemaVersion !== 1
    || value.protocol !== BINDING_PROTOCOL
  ) {
    findings.push("MG-L4C-BINDING-PROTOCOL-INVALID");
  }
  if (value.status !== "approved") {
    findings.push("MG-L4C-BINDING-NOT-APPROVED");
  }
  if (typeof value.projectId !== "string" || !value.projectId) {
    findings.push("MG-L4C-BINDING-PROJECT-MISSING");
  }
  for (const [kind, runtime] of [["source", "java"], ["target", "rust"]]) {
    const targetValue = value.targets?.[kind];
    if (
      !targetValue
      || targetValue.kind !== runtime
      || typeof targetValue.healthPath !== "string"
      || !targetValue.healthPath.startsWith("/")
      || typeof targetValue.invokePath !== "string"
      || !targetValue.invokePath.startsWith("/")
      || !Array.isArray(targetValue.acceptedHealthStatuses)
      || targetValue.acceptedHealthStatuses.some((status) =>
        !Number.isInteger(status) || status < 100 || status > 599)
    ) {
      findings.push(`MG-L4C-BINDING-TARGET-INVALID:${kind}`);
    }
    if (
      kind === "source"
      && !/^[a-f0-9]{64}$/.test(targetValue?.stateProfileSha256 ?? "")
    ) {
      findings.push("MG-L4C-BINDING-STATE-PROFILE-HASH-INVALID");
    }
  }
  if (
    !value.scenarios
    || typeof value.scenarios !== "object"
    || Object.keys(value.scenarios).length === 0
  ) {
    findings.push("MG-L4C-BINDING-SCENARIOS-MISSING");
  } else {
    for (const [scenarioId, scenarioValue] of Object.entries(value.scenarios)) {
      for (const targetKind of ["source", "target"]) {
        if (
          value.targets?.[targetKind]?.hooks?.seed
            ?.requiresSeedProfileHash !== true
        ) {
          continue;
        }
        const seed = scenarioValue?.seedProfiles?.[targetKind];
        if (
          typeof seed?.path !== "string"
          || !seed.path.endsWith(".json")
          || path.isAbsolute(seed.path)
          || seed.path.split(/[\\/]/).includes("..")
          || !/^[a-f0-9]{64}$/.test(seed?.sha256 ?? "")
        ) {
          findings.push(
            `MG-L4C-BINDING-SEED-PROFILE-INVALID:${targetKind}:${scenarioId}`,
          );
        }
      }
      for (const [targetKind, collector] of Object.entries(
        scenarioValue?.eventCollectors ?? {},
      )) {
        try {
          if (!["source", "target"].includes(targetKind)) {
            throw new Error("event collector target is invalid");
          }
          validateEventCollector(collector, { scenarioId, targetKind });
        } catch {
          findings.push(
            `MG-L4C-BINDING-EVENT-COLLECTOR-INVALID:${targetKind}:${scenarioId}`,
          );
        }
      }
    }
  }
  if (findings.length > 0) throw new Error(findings.sort().join(", "));
}

function validateEventCollector(value, contextValue = {}) {
  const completionMode = value?.completionMode ?? "terminal-event";
  if (
    !value
    || value.kind !== "websocket"
    || typeof value.path !== "string"
    || !value.path.startsWith("/")
    || value.path.includes("..")
    || value.messageType !== "panel-data-update"
    || value.contentEncoding !== "json-string"
    || !value.subscribe
    || value.subscribe.type !== "panel-subscribe"
    || !value.subscribe.content
    || typeof value.subscribe.content !== "object"
    || value.subscribe.content.subscribe !== true
    || !["panelId", "batchId", "status", "percentage"].every((name) =>
      typeof value[`${name}Path`] === "string"
      && /^[A-Za-z0-9_.-]+$/.test(value[`${name}Path`]))
    || !Array.isArray(value.terminalStatuses)
    || value.terminalStatuses.length < 1
    || value.terminalStatuses.length > 16
    || value.terminalStatuses.some((status) =>
      typeof status !== "string" || !/^[A-Z_]{2,32}$/.test(status))
    || !["terminal-event", "no-event"].includes(completionMode)
    || (
      completionMode === "no-event"
      && (
        contextValue.scenarioId !== "validation-failure"
        || contextValue.targetKind !== "source"
        || !Number.isInteger(value.noEventWindowMs)
        || value.noEventWindowMs < 100
        || value.noEventWindowMs > 5_000
      )
    )
    || (
      completionMode === "terminal-event"
      && value.noEventWindowMs !== undefined
    )
    || (
      value.responseBatchIdPaths !== undefined
      && (
        !Array.isArray(value.responseBatchIdPaths)
        || value.responseBatchIdPaths.length > 8
        || value.responseBatchIdPaths.some((jsonPath) =>
          typeof jsonPath !== "string"
          || !/^[A-Za-z0-9_.-]+$/.test(jsonPath))
      )
    )
    || !validBoundedInteger(value.openTimeoutMs, 100, 30_000)
    || !validBoundedInteger(value.terminalTimeoutMs, 100, 120_000)
    || !validBoundedInteger(value.maxEvents, 1, 1000)
    || !validBoundedInteger(value.maxBytes, 1024, 1024 * 1024)
  ) {
    throw new Error("WebSocket event collector binding is invalid");
  }
}

function validBoundedInteger(value, minimum, maximum) {
  return value === undefined
    || (Number.isInteger(value) && value >= minimum && value <= maximum);
}

function validateHookDefinition(definition) {
  if (
    !definition
    || typeof definition.program !== "string"
    || !definition.program.trim()
    || /[\r\n\0]/.test(definition.program)
    || !Array.isArray(definition.args)
    || definition.args.some((argument) =>
      typeof argument !== "string" || /[\r\n\0]/.test(argument))
    || ["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
      "bash", "sh", "zsh"].includes(
        path.basename(definition.program).toLowerCase(),
      )
  ) {
    throw new Error("state hook definition is unsafe");
  }
}

function materializeHeaders(headers, replacements = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new Error(`unsafe request header name: ${name}`);
    }
    return [name, materialize(value, replacements)];
  }));
}

function materialize(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      materialize(item, replacements),
    ]));
  }
  if (typeof value !== "string") return value;
  const environmentMatch = /^\$\{([A-Z][A-Z0-9_]{2,127})\}$/.exec(value);
  if (environmentMatch) {
    return requiredEnvironment(environmentMatch[1]);
  }
  return replacePlaceholders(value, replacements);
}

function replacementValues(contextValue) {
  const replacements = {
    baseUrl: contextValue.baseUrl,
    marker: contextValue.marker,
    phase: contextValue.phase,
    scenarioId: contextValue.scenarioId,
    targetKind: contextValue.targetKind,
    tenantId: requiredEnvironment("MG_L4C_TENANT_ID"),
    panelId: requiredEnvironment("MG_L4C_PANEL_ID"),
    table: requiredEnvironment("MG_L4C_TABLE"),
  };
  for (const [suffix, values] of Object.entries(
    contextValue.seedBindings ?? {},
  )) {
    for (const [name, value] of Object.entries(values)) {
      replacements[`seed.${suffix}.${name}`] = value;
    }
  }
  return replacements;
}

function replacePlaceholders(value, replacements) {
  return value.replace(/\{([A-Za-z0-9._:-]+)\}/g, (full, name) => {
    if (!(name in replacements)) {
      throw new Error(`unknown binding placeholder: ${full}`);
    }
    return String(replacements[name]);
  });
}

function parseSeedBindings(raw) {
  if (!raw) return {};
  if (Buffer.byteLength(raw) > 64 * 1024) {
    throw new Error("seed bindings exceed 64 KiB");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("seed bindings are not valid JSON");
  }
  validateSeedBindings(value);
  return value;
}

function validateSeedBindings(value, expectedCount) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length < 1
    || Object.keys(value).length > 100
    || (
      expectedCount !== undefined
      && Object.keys(value).length !== expectedCount
    )
  ) {
    throw new Error("seed bindings have an invalid row count");
  }
  for (const [suffix, fields] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9._:-]{1,64}$/.test(suffix)
      || !fields
      || typeof fields !== "object"
      || Array.isArray(fields)
      || typeof fields.generatedId !== "string"
      || fields.generatedId.length < 1
      || fields.generatedId.length > 128
      || !/^[A-Za-z0-9._:-]+$/.test(fields.generatedId)
      || typeof fields.marker !== "string"
      || fields.marker.length < 1
      || fields.marker.length > 192
      || !/^[A-Za-z0-9._:-]+$/.test(fields.marker)
    ) {
      throw new Error(`seed binding is invalid: ${suffix}`);
    }
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  const content = await response.text();
  if (Buffer.byteLength(content) > 1024 * 1024) {
    throw new Error("HTTP response exceeded 1 MiB");
  }
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return { text: content.slice(0, 4_096) };
  }
}

function sanitizeResponse(value, fields) {
  if (
    (!Array.isArray(fields) || fields.length === 0)
    && (!fields || typeof fields !== "object" || Object.keys(fields).length === 0)
  ) {
    throw new Error("responseFields must explicitly allow persisted fields");
  }
  const mappings = Array.isArray(fields)
    ? fields.map((field) => [field, field])
    : Object.entries(fields);
  return Object.fromEntries(mappings.map(([alias, field]) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(alias)) {
      throw new Error(`unsafe response field alias: ${alias}`);
    }
    return [alias, readJsonPath(value, field)];
  }));
}

function readJsonPath(value, jsonPath) {
  if (!jsonPath) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(jsonPath)) {
    throw new Error(`unsafe JSON path: ${jsonPath}`);
  }
  return jsonPath.split(".").reduce(
    (current, segment) =>
      current && typeof current === "object" ? current[segment] : undefined,
    value,
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ensureNested(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes repository root`);
  }
}

function spawnJson(program, args, cwd, environment, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`state hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        child.kill();
        finish(new Error("state hook stdout exceeded 1 MiB"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 256 * 1024) {
        child.kill();
        finish(new Error("state hook stderr exceeded 256 KiB"));
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(
          `state hook exited ${code}: ${stderr.trim().slice(-2_000)}`,
        ));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(new Error("state hook stdout is not one JSON document"));
      }
    });
  });
}
