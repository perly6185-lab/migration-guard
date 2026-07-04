import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { LoadedConfig } from "../types.js";
import { writeJsonFile } from "./files.js";

export interface PreviewResult {
  command: string;
  cwd: string;
  url: string;
  ready: boolean;
  status: number | null;
  durationMs: number;
  error?: string;
  outputPath?: string;
}

export async function runPreviewProbe(
  loaded: LoadedConfig,
  command: string,
  url: string,
  timeoutMs: number
): Promise<PreviewResult> {
  const startedAt = Date.now();
  const child = spawn(command, {
    cwd: loaded.targetRoot,
    shell: true,
    windowsHide: true,
    stdio: "ignore"
  });

  let preview: PreviewResult | undefined;
  try {
    const result = await waitForUrl(url, timeoutMs);
    preview = {
      command,
      cwd: loaded.targetRoot,
      url,
      ready: result.ready,
      status: result.status,
      durationMs: Date.now() - startedAt,
      error: result.error
    };
  } finally {
    await stopProcessTree(child.pid);
  }

  if (!preview) {
    throw new Error("Preview probe did not produce a result.");
  }

  const outputPath = path.join(loaded.artifactsDir, "preview", `${Date.now()}.json`);
  preview.outputPath = outputPath;
  await writeJsonFile(outputPath, preview);
  return preview;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<{ ready: boolean; status: number | null; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}
