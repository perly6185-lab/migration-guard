import { spawn } from "node:child_process";
import type { CommandExecutionResult } from "../types.js";

export interface RunShellCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
}

export function runShellCommand(command: string, options: RunShellCommandOptions): Promise<CommandExecutionResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });

    const append = (chunks: Buffer[], chunk: Buffer, currentBytes: number): [number, boolean] => {
      const remaining = options.maxOutputBytes - currentBytes;
      if (remaining <= 0) {
        return [currentBytes + chunk.length, true];
      }

      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      return [currentBytes + chunk.length, chunk.length > remaining];
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const [nextBytes, truncated] = append(stdoutChunks, chunk, stdoutBytes);
      stdoutBytes = nextBytes;
      stdoutTruncated ||= truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const [nextBytes, truncated] = append(stderrChunks, chunk, stderrBytes);
      stderrBytes = nextBytes;
      stderrTruncated ||= truncated;
    });

    const timer = setTimeout(async () => {
      timedOut = true;
      const terminationError = await terminateProcessTree(child.pid);
      if (terminationError && !settled) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill();
        finish({
          exitCode: null,
          signal: null,
          error: terminationError
        });
      }
    }, options.timeoutMs);

    const finish = (result: Pick<CommandExecutionResult, "exitCode" | "signal" | "error">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        error: result.error
      });
    };

    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        error: error.message
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        error: undefined
      });
    });
  });
}

async function terminateProcessTree(pid: number | undefined): Promise<string | undefined> {
  if (pid === undefined) return "Unable to terminate command: child process id is unavailable";
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const stderrChunks: Buffer[] = [];
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let resolved = false;
      const finish = (error?: string) => {
        if (resolved) return;
        resolved = true;
        resolve(error);
      };
      killer.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      killer.on("error", (error) => {
        finish(`Unable to terminate command process tree: ${error.message}`);
      });
      killer.on("close", (exitCode) => {
        const details = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish(exitCode === 0
          ? undefined
          : `Unable to terminate command process tree (taskkill exit ${exitCode})${details ? `: ${details}` : ""}`);
      });
    });
  }

  signalProcessGroup(pid, "SIGTERM");
  const forceTimer = setTimeout(() => signalProcessGroup(pid, "SIGKILL"), 1000);
  forceTimer.unref();
  return undefined;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the group and direct kill attempts.
    }
  }
}
