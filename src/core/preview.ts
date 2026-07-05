import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { LoadedConfig, ProposalPreviewConfig, ProposalPreviewResult } from "../types.js";
import { writeJsonFile } from "./files.js";

export type PreviewResult = ProposalPreviewResult;

export interface ManagedPreviewSession {
  result: ProposalPreviewResult;
  env: Record<string, string>;
  stop: () => Promise<ProposalPreviewResult>;
}

export interface StartManagedPreviewOptions {
  outputPath?: string;
  maxOutputBytes?: number;
}

export async function runPreviewProbe(
  loaded: LoadedConfig,
  command: string,
  url: string,
  timeoutMs: number
): Promise<PreviewResult> {
  const outputPath = path.join(loaded.artifactsDir, "preview", `${Date.now()}.json`);
  const session = await startManagedPreview(loaded, { command, url, timeoutMs }, { outputPath });
  return session.stop();
}

export async function startManagedPreview(
  loaded: LoadedConfig,
  preview: ProposalPreviewConfig,
  options: StartManagedPreviewOptions = {}
): Promise<ManagedPreviewSession> {
  const startedAt = Date.now();
  const cwd = resolvePreviewCwd(loaded.targetRoot, preview.cwd);
  const maxOutputBytes = options.maxOutputBytes ?? loaded.config.output.maxOutputBytes;
  const outputPath = options.outputPath ?? path.join(loaded.artifactsDir, "preview", `${Date.now()}.json`);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stopped = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const child = spawn(preview.command, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...preview.env
    }
  });

  const closed = new Promise<void>((resolve) => {
    child.on("close", (code, closeSignal) => {
      exitCode = code;
      signal = closeSignal;
      resolve();
    });
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    const next = appendOutput(stdoutChunks, chunk, stdoutBytes, maxOutputBytes);
    stdoutBytes = next.bytes;
    stdoutTruncated ||= next.truncated;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const next = appendOutput(stderrChunks, chunk, stderrBytes, maxOutputBytes);
    stderrBytes = next.bytes;
    stderrTruncated ||= next.truncated;
  });

  let startupError: string | undefined;
  child.on("error", (error) => {
    startupError = error.message;
  });

  const readiness = await waitForUrl(preview.url, preview.timeoutMs ?? 60000, () => ({
    exitCode,
    signal,
    startupError
  }));

  let result: ProposalPreviewResult = {
    command: preview.command,
    cwd,
    url: preview.url,
    ready: readiness.ready,
    status: readiness.status,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    stdoutTruncated,
    stderrTruncated,
    stopped: false,
    exitCode,
    signal,
    error: readiness.error,
    outputPath
  };

  async function stop(): Promise<ProposalPreviewResult> {
    if (!stopped) {
      stopped = true;
      await stopProcessTree(child.pid);
      await Promise.race([closed, delay(2000)]);
    }

    result = {
      ...result,
      durationMs: Date.now() - startedAt,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stdoutTruncated,
      stderrTruncated,
      stopped: true,
      exitCode,
      signal
    };
    await writeJsonFile(outputPath, result);
    return result;
  }

  return {
    result,
    env: {
      MG_PREVIEW_URL: preview.url
    },
    stop
  };
}

function resolvePreviewCwd(targetRoot: string, cwd?: string): string {
  if (!cwd) {
    return targetRoot;
  }
  return path.isAbsolute(cwd) ? cwd : path.resolve(targetRoot, cwd);
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxOutputBytes: number
): { bytes: number; truncated: boolean } {
  const remaining = maxOutputBytes - currentBytes;
  if (remaining <= 0) {
    return { bytes: currentBytes + chunk.length, truncated: true };
  }

  chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
  return {
    bytes: currentBytes + chunk.length,
    truncated: chunk.length > remaining
  };
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  processState: () => { exitCode: number | null; signal: NodeJS.Signals | null; startupError?: string }
): Promise<{ ready: boolean; status: number | null; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    const state = processState();
    if (state.startupError) {
      return {
        ready: false,
        status: null,
        error: state.startupError
      };
    }
    if (state.exitCode !== null || state.signal !== null) {
      return {
        ready: false,
        status: null,
        error: `Preview command exited before readiness (exitCode=${state.exitCode ?? "null"}, signal=${state.signal ?? "null"}).`
      };
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.text();
        return {
          ready: true,
          status: response.status
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1000);
  }

  return {
    ready: false,
    status: null,
    error: lastError ?? "Timed out waiting for preview URL."
  };
}

async function stopProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
