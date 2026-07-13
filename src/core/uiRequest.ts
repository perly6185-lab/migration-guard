import http from "node:http";
import { randomBytes } from "node:crypto";
import { UiHttpError } from "./uiHttpError.js";

export function sendJson(response: http.ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data, null, 2));
}

export function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

export function sendText(response: http.ServerResponse, text: string, contentType: string): void {
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(text);
}

export function trimmedParam(searchParams: URLSearchParams, name: string): string | undefined {
  const value = searchParams.get(name)?.trim();
  return value || undefined;
}

export function requiredParam(searchParams: URLSearchParams, name: string): string {
  const value = trimmedParam(searchParams, name);
  if (!value) {
    throw new UiHttpError(`${name} is required`, 400);
  }
  return value;
}

export function booleanParam(searchParams: URLSearchParams, name: string): boolean {
  const value = trimmedParam(searchParams, name);
  return value === "true" || value === "1" || value === "yes";
}

export function positiveIntegerParam(searchParams: URLSearchParams, name: string): number | undefined {
  const value = trimmedParam(searchParams, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function boundedIntegerParam(
  searchParams: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = trimmedParam(searchParams, name);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UiHttpError(`${name} must be an integer from ${min} to ${max}.`, 400);
  }
  return parsed;
}

export function createUiCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function requireCsrfToken(request: http.IncomingMessage, expectedToken: string): void {
  const token = request.headers["x-migration-guard-csrf"];
  if (token !== expectedToken) {
    throw new UiHttpError("Invalid or missing UI CSRF token.", 403);
  }
}

export async function readUiPostParams(
  request: http.IncomingMessage,
  searchParams: URLSearchParams
): Promise<URLSearchParams> {
  const params = new URLSearchParams(searchParams);
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.includes("application/json")) {
    return params;
  }
  const body = await readRequestBody(request);
  if (!body.trim()) {
    return params;
  }
  const jsonBody = JSON.parse(body) as Record<string, unknown>;
  for (const [key, value] of Object.entries(jsonBody)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      params.set(key, value.map((item) => String(item)).join(","));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
