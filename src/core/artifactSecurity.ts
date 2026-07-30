import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./files.js";

export interface SensitiveArtifactFinding {
  file: string;
  rule: string;
  location: string;
}

const SENSITIVE_KEY = /authorization|token|cookie|password|phone|mobile|secret|api[-_]?key/i;
const SAFE_SENSITIVE_METADATA_KEY =
  /(?:bound|binding|persisted|includedInEvidence|allowed|required|present|configured|redacted|complete)$/i;
const SAFE_PLACEHOLDER =
  /^(?:|<redacted>|<masked>|<configured>|<[^>]+>|\$\{[A-Z0-9_]+\}|Bearer\s+<[^>]+>|Bearer\s+\$\{[A-Z0-9_]+\})$/i;
const VALUE_PATTERNS: Array<[string, RegExp]> = [
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];
const CONFIG_FILE = /(?:^|[\\/])\.env(?:\.[^\\/]*)?$|\.(?:ya?ml|properties|toml|ini|conf)$/i;
const CONFIG_SENSITIVE_ASSIGNMENT =
  /^[\t ]*(?:export[\t ]+)?([A-Za-z0-9_.-]*(?:authorization|token|cookie|password|phone|mobile|secret|api[-_]?key)[A-Za-z0-9_.-]*)[\t ]*[:=][\t ]*(.*?)[\t ]*$/gim;

export async function scanArtifactFiles(roots: string[]): Promise<SensitiveArtifactFinding[]> {
  const findings: SensitiveArtifactFinding[] = [];
  for (const root of roots) {
    for (const file of await listArtifactFiles(path.resolve(root))) {
      const content = await fs.readFile(file, "utf8");
      findings.push(...scanArtifactText(content, file));
    }
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.location.localeCompare(right.location)
  );
}

export function scanArtifactText(content: string, file = "<memory>"): SensitiveArtifactFinding[] {
  const findings: SensitiveArtifactFinding[] = [];
  for (const [rule, pattern] of VALUE_PATTERNS) {
    const match = pattern.exec(content);
    if (match) findings.push({
      file,
      rule,
      location: `offset:${match.index}`
    });
  }
  if (CONFIG_FILE.test(file)) {
    for (const match of content.matchAll(CONFIG_SENSITIVE_ASSIGNMENT)) {
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (safeSensitiveValue(value)) continue;
      findings.push({
        file,
        rule: "sensitive-config-value",
        location: `key:${match[1]}`
      });
    }
  }
  if (file.endsWith(".json") || content.trimStart().startsWith("{") || content.trimStart().startsWith("[")) {
    try {
      findings.push(...scanJsonValue(JSON.parse(content), file));
    } catch {
      // Malformed JSON belongs to schema validation; the text rules still apply.
    }
  }
  return dedupeFindings(findings);
}

export function scanJsonValue(
  value: unknown,
  file = "<memory>",
  currentPath = "$"
): SensitiveArtifactFinding[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scanJsonValue(item, file, `${currentPath}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const childPath = `${currentPath}.${key}`;
    const ownFinding = SENSITIVE_KEY.test(key)
      && !SAFE_SENSITIVE_METADATA_KEY.test(key)
      && !safeSensitiveValue(item)
      ? [{ file, rule: "sensitive-key-value", location: childPath }]
      : [];
    return [...ownFinding, ...scanJsonValue(item, file, childPath)];
  });
}

function safeSensitiveValue(value: unknown): boolean {
  if (value === null || value === false) return true;
  if (typeof value === "string") return SAFE_PLACEHOLDER.test(value.trim());
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 0) return true;
    return record.policy === "environment-only" && record.persistedValuesAllowed === false;
  }
  return false;
}

async function listArtifactFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) return [];
  const stat = await fs.stat(root);
  if (stat.isFile()) return supported(root) ? [root] : [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listArtifactFiles(child));
    else if (entry.isFile() && supported(child)) files.push(child);
  }
  return files;
}

function supported(file: string): boolean {
  return CONFIG_FILE.test(file) || [
    ".json", ".jsonl", ".md", ".txt", ".log", ".yaml", ".yml",
    ".properties", ".toml", ".ini", ".conf"
  ].includes(path.extname(file).toLowerCase());
}

function dedupeFindings(findings: SensitiveArtifactFinding[]): SensitiveArtifactFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.file}\u001f${finding.rule}\u001f${finding.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
