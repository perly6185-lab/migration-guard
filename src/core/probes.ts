import path from "node:path";
import { runShellCommand } from "./exec.js";
import { sha256 } from "./hash.js";
import { normalizeText } from "./normalize.js";
import type {
  BehaviorProbeConfig,
  CheckConfig,
  CheckResult,
  CommandProbeConfig,
  HttpProbeConfig,
  LoadedConfig,
  ProbeResult
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 60000;

export async function runChecks(loaded: LoadedConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of loaded.config.checks) {
    results.push(await runCheck(loaded, check));
  }

  return results;
}

export async function runProbes(loaded: LoadedConfig): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const probe of loaded.config.probes) {
    results.push(await runProbe(loaded, probe));
  }

  return results;
}

async function runCheck(loaded: LoadedConfig, check: CheckConfig): Promise<CheckResult> {
  if (check.enabled === false) {
    return {
      name: check.name,
      command: check.command,
      status: "skipped",
      critical: check.critical ?? true,
      exitCode: null,
      durationMs: 0,
      stdoutHash: sha256(""),
      stderrHash: sha256(""),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }

  const result = await runShellCommand(check.command, {
    cwd: resolveCwd(loaded.targetRoot, check.cwd),
    timeoutMs: check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });

  return {
    name: check.name,
    command: check.command,
    status: result.timedOut ? "timed_out" : result.error ? "error" : result.exitCode === 0 ? "passed" : "failed",
    critical: check.critical ?? true,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutHash: sha256(result.stdout),
    stderrHash: sha256(result.stderr),
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    error: result.error
  };
}

async function runProbe(loaded: LoadedConfig, probe: BehaviorProbeConfig): Promise<ProbeResult> {
  if (probe.enabled === false) {
    return {
      name: probe.name,
      type: probe.type,
      status: "skipped",
      durationMs: 0,
      outputHash: sha256(""),
      normalizedOutput: ""
    };
  }

  if (probe.type === "command") {
    return runCommandProbe(loaded, probe);
  }

  return runHttpProbe(probe);
}

async function runCommandProbe(loaded: LoadedConfig, probe: CommandProbeConfig): Promise<ProbeResult> {
  const result = await runShellCommand(probe.command, {
    cwd: resolveCwd(loaded.targetRoot, probe.cwd),
    timeoutMs: probe.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const rawOutput = `${result.stdout}${result.stderr}`;
  const normalizedOutput = safeNormalize(rawOutput, probe.normalize);

  return {
    name: probe.name,
    type: "command",
    command: probe.command,
    status: result.timedOut ? "timed_out" : result.error ? "error" : result.exitCode === 0 ? "passed" : "failed",
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    outputHash: sha256(normalizedOutput),
    normalizedOutput,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    error: result.error
  };
}

async function runHttpProbe(probe: HttpProbeConfig): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probe.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(probe.url, {
      method: probe.method ?? "GET",
      headers: probe.headers,
      body: probe.body,
      signal: controller.signal
    });
    const body = await response.text();
    const normalizedBody = safeNormalize(body, probe.normalize);
    const normalizedOutput = `${response.status}\n${normalizedBody}`;

    return {
      name: probe.name,
      type: "http",
      url: probe.url,
      method: probe.method ?? "GET",
      status: response.ok ? "passed" : "failed",
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      body,
      outputHash: sha256(normalizedOutput),
      normalizedOutput
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = message.includes("aborted") || message.includes("AbortError");
    return {
      name: probe.name,
      type: "http",
      url: probe.url,
      method: probe.method ?? "GET",
      status: timedOut ? "timed_out" : "error",
      durationMs: Date.now() - startedAt,
      httpStatus: null,
      responseHeaders: {},
      body: "",
      outputHash: sha256(""),
      normalizedOutput: "",
      error: message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeNormalize(input: string, config: BehaviorProbeConfig["normalize"]): string {
  try {
    return normalizeText(input, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `__NORMALIZE_ERROR__\n${message}\n__RAW__\n${input}`;
  }
}

function resolveCwd(root: string, cwd: string | undefined): string {
  return cwd ? path.resolve(root, cwd) : root;
}
