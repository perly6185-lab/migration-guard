import { spawn } from "node:child_process";
import type { CommandExecutionResult } from "../types.js";

export interface RunShellCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
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
      windowsHide: true
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

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
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
