import type { ProbeNormalizeConfig } from "../types.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function normalizeText(input: string, config: ProbeNormalizeConfig = {}): string {
  let output = input;

  if (config.stripAnsi) {
    output = output.replace(ANSI_PATTERN, "");
  }

  if (config.lineEndings === "lf") {
    output = output.replace(/\r\n/g, "\n");
  }

  if (config.trimWhitespace) {
    output = output.trim();
  }

  if (config.json) {
    const parsed = JSON.parse(output);
    for (const field of config.json.ignoreFields ?? []) {
      removePath(parsed, field);
    }
    output = config.json.sortKeys ? stableStringify(parsed) : JSON.stringify(parsed);
  }

  return output;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJsonValue(record[key]);
        return acc;
      }, {});
  }

  return value;
}

export function removePath(value: unknown, dottedPath: string): void {
  if (value === null || typeof value !== "object" || dottedPath.length === 0) {
    return;
  }

  const parts = dottedPath.split(".");
  let cursor: unknown = value;

  for (const part of parts.slice(0, -1)) {
    if (cursor === null || typeof cursor !== "object") {
      return;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor !== null && typeof cursor === "object") {
    delete (cursor as Record<string, unknown>)[parts[parts.length - 1]];
  }
}
