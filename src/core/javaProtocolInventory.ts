import { promises as fs } from "node:fs";
import path from "node:path";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export type JavaProtocolKind =
  | "http-sse"
  | "websocket"
  | "scheduled-job"
  | "async-method"
  | "message-listener"
  | "mcp-tool"
  | "feign-client"
  | "lifecycle-hook"
  | "servlet-filter"
  | "storage-provider";

export interface JavaProtocolEntrypoint {
  kind: JavaProtocolKind;
  file: string;
  line: number;
  symbol: string;
  evidence: string;
  path?: string;
}

export interface JavaProtocolInventoryReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  summary: {
    total: number;
    kinds: Record<JavaProtocolKind, number>;
    files: number;
  };
  entries: JavaProtocolEntrypoint[];
  reportHash: string;
}

const SKIP_DIRS = new Set([".git", ".idea", ".mvn", ".gradle", "target", "build", "node_modules"]);
const ANNOTATION_KINDS: Array<[RegExp, JavaProtocolKind]> = [
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?(?:Scheduled|XxlJob)\b/, "scheduled-job"],
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?Async\b/, "async-method"],
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?(?:KafkaListener|RabbitListener|RocketMQMessageListener|EventListener|TransactionalEventListener)\b/, "message-listener"],
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?Tool(?:\s*\(|\s*$)/, "mcp-tool"],
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?FeignClient\b/, "feign-client"],
  [/^\s*@(?:[A-Za-z0-9_$.]+\.)?PostConstruct\b/, "lifecycle-hook"]
];

export async function inventoryJavaProtocolEntrypoints(
  root: string,
  includeTests = false
): Promise<JavaProtocolInventoryReport> {
  const resolvedRoot = path.resolve(root);
  const sourceIdentity = await captureAssessmentSourceIdentity(resolvedRoot);
  const files = await walkJavaFiles(resolvedRoot, includeTests);
  const entries: JavaProtocolEntrypoint[] = [];
  for (const file of files) {
    const relative = path.relative(resolvedRoot, file).replaceAll("\\", "/");
    const content = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const lines = stripJavaCommentsPreserveLines(content).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const evidence = line.trim();
      for (const [pattern, kind] of ANNOTATION_KINDS) {
        if (!pattern.test(line)) continue;
        const declaration = nextDeclaration(lines, index, kind === "feign-client");
        entries.push({
          kind,
          file: relative,
          line: index + 1,
          symbol: declaration.symbol,
          evidence,
          ...(annotationPath(line) ? { path: annotationPath(line) } : {})
        });
      }
      if (/\b(?:class\s+\w+\s+extends\s+(?:TextWebSocketHandler|BinaryWebSocketHandler)|implements\s+WebSocketHandler)\b/.test(line)) {
        entries.push({ kind: "websocket", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence });
      }
      if (/\bimplements\s+[^{;]*\bWebSocketMessageListener\s*</.test(line)) {
        entries.push({ kind: "websocket", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence });
      }
      if (/\bimplements\s+[^{;]*\b(?:ApplicationRunner|CommandLineRunner)\b/.test(line)) {
        entries.push({ kind: "lifecycle-hook", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence });
      }
      if (/\bclass\s+\w+\s+extends\s+(?:OncePerRequestFilter|GenericFilterBean)\b/.test(line)
        || /\bimplements\s+[^{;]*\b(?:jakarta\.servlet\.)?Filter\b/.test(line)) {
        entries.push({ kind: "servlet-filter", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence });
      }
      if (/\bclass\s+\w+\s+extends\s+AbstractFileClient\s*</.test(line)) {
        entries.push({ kind: "storage-provider", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence });
      }
      const websocketPath = /\baddHandler\s*\([^,]+,\s*"([^"]+)"/.exec(line)?.[1];
      if (websocketPath) {
        entries.push({ kind: "websocket", file: relative, line: index + 1, symbol: declarationSymbol(line), evidence, path: websocketPath });
      }
      if (/\b(?:public|protected)\b[^;{}]*\bSseEmitter\s+\w+\s*\(/.test(line)
        || /TEXT_EVENT_STREAM_VALUE/.test(line)) {
        const declaration = nextDeclaration(lines, index, false);
        entries.push({
          kind: "http-sse",
          file: relative,
          line: index + 1,
          symbol: /\bSseEmitter\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1] ?? declaration.symbol,
          evidence,
          ...(annotationPath(line) ? { path: annotationPath(line) } : {})
        });
      }
    }
  }
  const entryMap = new Map<string, JavaProtocolEntrypoint>();
  for (const entry of entries) {
    const key = `${entry.kind}|${entry.file}|${entry.symbol}${entry.symbol === "<unresolved>" ? `|${entry.line}` : ""}`;
    const existing = entryMap.get(key);
    if (!existing || (!existing.path && entry.path)) entryMap.set(key, entry);
  }
  const uniqueEntries = [...entryMap.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.file.localeCompare(right.file)
    || left.line - right.line
  );
  const kinds = Object.fromEntries([
    "http-sse", "websocket", "scheduled-job", "async-method", "message-listener", "mcp-tool", "feign-client",
    "lifecycle-hook", "servlet-filter", "storage-provider"
  ].map((kind) => [kind, uniqueEntries.filter((entry) => entry.kind === kind).length])) as Record<JavaProtocolKind, number>;
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root: resolvedRoot,
    sourceIdentity,
    summary: {
      total: uniqueEntries.length,
      kinds,
      files: new Set(uniqueEntries.map((entry) => entry.file)).size
    },
    entries: uniqueEntries
  };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

async function walkJavaFiles(root: string, includeTests: boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || (!includeTests && entry.name === "test"))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort();
}

function nextDeclaration(lines: string[], annotationIndex: number, typeDeclaration: boolean): { symbol: string } {
  for (let index = annotationIndex; index < Math.min(lines.length, annotationIndex + 160); index += 1) {
    const line = lines[index] ?? "";
    if (typeDeclaration) {
      const type = /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1];
      if (type) return { symbol: type };
    } else {
      const method = /^\s*(?:(?:public|protected|private|static|final|default|synchronized|abstract)\s+)+(?:<[^>]+>\s+)?[A-Za-z0-9_.$<>,?\[\]\s]+\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1];
      if (method) return { symbol: method };
    }
  }
  return { symbol: "<unresolved>" };
}

function stripJavaCommentsPreserveLines(value: string): string {
  let result = "";
  let mode: "code" | "string" | "char" | "line" | "block" | "text-block" = "code";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    const third = value[index + 2];
    if (mode === "line") {
      if (char === "\r" || char === "\n") {
        result += char;
        mode = "code";
      } else result += " ";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        mode = "code";
      } else result += char === "\r" || char === "\n" ? char : " ";
      continue;
    }
    if (mode === "text-block") {
      result += char;
      if (char === '"' && next === '"' && third === '"') {
        result += '""';
        index += 2;
        mode = "code";
      } else if (char === "\\" && next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    if (mode === "string" || mode === "char") {
      result += char;
      if (char === "\\" && next !== undefined) {
        result += next;
        index += 1;
      } else if (char === (mode === "string" ? '"' : "'")) mode = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      index += 1;
      mode = "line";
    } else if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      mode = "block";
    } else {
      result += char;
      if (char === '"' && next === '"' && third === '"') {
        result += '""';
        index += 2;
        mode = "text-block";
      } else if (char === '"') mode = "string";
      else if (char === "'") mode = "char";
    }
  }
  return result;
}

function declarationSymbol(line: string): string {
  return /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]
    ?? /\b([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1]
    ?? "<unresolved>";
}

function annotationPath(line: string): string | undefined {
  return /["']([^"']*\/[^"']*)["']/.exec(line)?.[1];
}
