import path from "node:path";
import { promises as fs } from "node:fs";
import { UiHttpError } from "./uiHttpError.js";
import type { LoadedConfig } from "../types.js";

export async function readArtifactText(
  loaded: LoadedConfig,
  requestedPath: string | null
): Promise<{ content: string; contentType: string }> {
  if (!requestedPath) {
    throw new UiHttpError("artifact path is required", 400);
  }
  if (isSensitiveArtifactPath(requestedPath)) {
    throw new UiHttpError("sensitive artifact paths cannot be displayed", 403);
  }
  const filePath = resolveArtifactPath(loaded, requestedPath);
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new UiHttpError("artifact file not found", 404);
  }
  const maxBytes = loaded.config.output.maxOutputBytes;
  if (stats.size > maxBytes) {
    throw new UiHttpError(`artifact is too large to display (${stats.size} bytes; limit ${maxBytes})`, 413);
  }
  const root = await fs.realpath(loaded.artifactsDir).catch(() => path.resolve(loaded.artifactsDir));
  const realFilePath = await fs.realpath(filePath);
  const realRelative = path.relative(root, realFilePath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new UiHttpError("artifact symlink must resolve inside artifactsDir", 403);
  }
  return {
    content: await fs.readFile(realFilePath, "utf8"),
    contentType: contentTypeForArtifact(realFilePath)
  };
}

function isSensitiveArtifactPath(requestedPath: string): boolean {
  const normalized = requestedPath.replace(/\\/g, "/").toLowerCase();
  const name = path.posix.basename(normalized);
  return name === ".env"
    || name.startsWith(".env.")
    || /\.(pem|key|p12|pfx|crt|cer)$/.test(name)
    || normalized.split("/").some((part) => part === "secrets" || part === ".ssh");
}

export function resolveArtifactPath(loaded: LoadedConfig, requestedPath: string): string {
  const root = path.resolve(loaded.artifactsDir);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UiHttpError("artifact path must be inside artifactsDir", 403);
  }
  return candidate;
}

function contentTypeForArtifact(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".jsonl") {
    return "application/x-ndjson; charset=utf-8";
  }
  if (extension === ".md") {
    return "text/markdown; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}
