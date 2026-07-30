import path from "node:path";
import { promises as fs } from "node:fs";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";
import { createJavaEndpointAnalyzer, type JavaEndpointHttpMethod } from "./javaEndpointAnalysis.js";
import {
  inventoryJavaProtocolEntrypoints,
  type JavaProtocolEntrypoint,
  type JavaProtocolKind
} from "./javaProtocolInventory.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface InfraRustAssessmentOptions {
  root: string;
  includeTests?: boolean;
}

export interface InfraRpcEndpointContract {
  client: string;
  method: string;
  httpMethod?: JavaEndpointHttpMethod;
  path?: string;
  implementation?: string;
  file: string;
  line: number;
  identityHeaders: string[];
  status: "ready" | "blocked";
  findings: string[];
}

export interface InfraEntrypointContract {
  kind: JavaProtocolKind;
  symbol: string;
  file: string;
  line: number;
  evidence: string;
  status: "ready" | "blocked";
  findings: string[];
}

export interface InfraStorageProviderContract {
  storage: string;
  storageCode: number;
  configClass: string;
  clientClass: string;
  file?: string;
  capabilities: {
    upload: boolean;
    delete: boolean;
    getContent: boolean;
    presignedUpload: boolean;
  };
  status: "ready" | "blocked";
  findings: string[];
}

export interface InfraConcurrencyRisk {
  kind:
    | "multipart-session"
    | "cache-snapshot"
    | "cache-check-then-put"
    | "provider-inplace-refresh";
  symbol: string;
  file: string;
  line: number;
  finding: string;
}

export interface InfraRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: InfraRustAssessmentOptions;
  status: "ready" | "blocked";
  summary: {
    ready: number;
    blocked: number;
    rpcEndpoints: number;
    entrypoints: number;
    storageProviders: number;
    concurrencyRisks: number;
    findings: Record<string, number>;
  };
  rpcEndpoints: InfraRpcEndpointContract[];
  entrypoints: InfraEntrypointContract[];
  storageProviders: InfraStorageProviderContract[];
  providerRegistryResolved: boolean;
  concurrencyRisks: InfraConcurrencyRisk[];
  reportHash: string;
}

interface JavaInput {
  file: string;
  content: string;
  stripped: string;
}

const ASSESSED_ENTRY_KINDS = new Set<JavaProtocolKind>([
  "scheduled-job",
  "async-method",
  "message-listener",
  "websocket",
  "lifecycle-hook",
  "servlet-filter"
]);

export async function assessJavaInfraForRust(
  options: InfraRustAssessmentOptions
): Promise<InfraRustAssessmentReport> {
  const root = path.resolve(options.root);
  const [sourceIdentity, analyzer, protocolInventory, javaFiles] = await Promise.all([
    captureAssessmentSourceIdentity(root),
    createJavaEndpointAnalyzer(root, Boolean(options.includeTests)),
    inventoryJavaProtocolEntrypoints(root, Boolean(options.includeTests)),
    collectJavaFiles(root, Boolean(options.includeTests))
  ]);
  const inputs = await Promise.all(javaFiles.map(async (file): Promise<JavaInput> => {
    const content = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
    return {
      file: relativePath(root, file),
      content,
      stripped: stripJavaCommentsAndStrings(content)
    };
  }));
  const byFile = new Map(inputs.map((input) => [input.file, input]));
  const permitAllRpcPrefix = inputs.some((input) =>
    /requestMatchers\s*\([^)]*(?:ApiConstants\.)?PREFIX[^)]*\)\s*\.permitAll\s*\(/s.test(input.stripped));

  const rpcEndpoints = analyzer.feignClients.flatMap((client) =>
    client.methods.filter((method) => method.httpMethod && method.path).map((method): InfraRpcEndpointContract => {
      const route = analyzer.routes.find((candidate) =>
        candidate.declaration?.className === client.className
        && candidate.declaration.methodName === method.methodName
        && candidate.method === method.httpMethod
        && candidate.path === method.path);
      const identityHeaders = unique(method.headers
        .filter((header) => header.identity)
        .map((header) => header.header.toLowerCase())).sort();
      const findings: string[] = [];
      if (!route || route.implementationResolution !== "bound") {
        findings.push("IR-FEIGN-IMPLEMENTATION-UNRESOLVED");
      }
      if (permitAllRpcPrefix && identityHeaders.length === 0) {
        findings.push("IR-FEIGN-IDENTITY-PROTECTION-UNPROVEN");
      }
      if (client.fallbackCompatible === false) {
        findings.push("IR-FEIGN-FALLBACK-INCOMPATIBLE");
      }
      return {
        client: client.className,
        method: method.methodName,
        httpMethod: method.httpMethod,
        path: method.path,
        implementation: route ? `${route.className}.${route.methodName}` : undefined,
        file: client.file,
        line: method.line,
        identityHeaders,
        status: findings.length === 0 ? "ready" : "blocked",
        findings
      };
    }));

  const entrypoints = protocolInventory.entries
    .filter((entry) => ASSESSED_ENTRY_KINDS.has(entry.kind))
    .map((entry) => assessEntrypoint(entry, byFile, inputs))
    .sort(compareEntrypoints);
  const storageProviders = extractStorageProviders(inputs);
  const providerRegistryResolved = inputs.some((input) =>
    /ReflectUtil\s*\.\s*newInstance\s*\([^)]*getClientClass\s*\(/s.test(input.stripped));
  if (!providerRegistryResolved) {
    for (const provider of storageProviders) {
      provider.findings.push("IR-STORAGE-PROVIDER-REGISTRY-UNRESOLVED");
      provider.status = "blocked";
    }
  }
  const concurrencyRisks = extractConcurrencyRisks(inputs);
  const contracts = [...rpcEndpoints, ...entrypoints, ...storageProviders];
  const blockingFindings = [
    ...contracts.flatMap((contract) => contract.findings),
    ...concurrencyRisks.map((risk) => risk.finding)
  ];
  const ready = contracts.filter((contract) => contract.status === "ready").length;
  const blocked = contracts.length - ready;
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root,
    sourceIdentity,
    assessmentScope: {
      root,
      includeTests: Boolean(options.includeTests)
    },
    status: blocked > 0 || concurrencyRisks.length > 0 ? "blocked" as const : "ready" as const,
    summary: {
      ready,
      blocked,
      rpcEndpoints: rpcEndpoints.length,
      entrypoints: entrypoints.length,
      storageProviders: storageProviders.length,
      concurrencyRisks: concurrencyRisks.length,
      findings: countValues(blockingFindings)
    },
    rpcEndpoints,
    entrypoints,
    storageProviders,
    providerRegistryResolved,
    concurrencyRisks
  };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function renderInfraRustAssessment(report: InfraRustAssessmentReport): string {
  return [
    "# Infrastructure Rust Assessment", "",
    `- Root: ${report.root}`,
    `- Status: ${report.status}`,
    `- Contracts ready: ${report.summary.ready}`,
    `- Contracts blocked: ${report.summary.blocked}`,
    `- RPC endpoints: ${report.summary.rpcEndpoints}`,
    `- Non-HTTP/lifecycle entrypoints: ${report.summary.entrypoints}`,
    `- Storage providers: ${report.summary.storageProviders}`,
    `- Provider registry resolved: ${report.providerRegistryResolved}`,
    `- Concurrency risks: ${report.summary.concurrencyRisks}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Findings", "",
    ...Object.entries(report.summary.findings)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([finding, count]) => `- ${finding}: ${count}`), "",
    "## Feign RPC endpoints", "",
    "| Client.method | HTTP | Path | Implementation | Identity headers | Status | Findings |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.rpcEndpoints.map((item) =>
      `| ${escapeTable(`${item.client}.${item.method}`)} | ${item.httpMethod ?? "-"} | ${escapeTable(item.path ?? "-")} | ${escapeTable(item.implementation ?? "-")} | ${escapeTable(item.identityHeaders.join(", ") || "-")} | ${item.status} | ${escapeTable(item.findings.join("<br>"))} |`), "",
    "## Non-HTTP and lifecycle entrypoints", "",
    "| Kind | Symbol | Status | Findings | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...report.entrypoints.map((item) =>
      `| ${item.kind} | ${escapeTable(item.symbol)} | ${item.status} | ${escapeTable(item.findings.join("<br>"))} | ${escapeTable(`${item.file}:${item.line}`)} |`), "",
    "## Storage provider capability matrix", "",
    "| Storage | Code | Config | Client | Upload | Delete | Read | Presigned | Status | Findings |",
    "| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.storageProviders.map((item) =>
      `| ${item.storage} | ${item.storageCode} | ${item.configClass} | ${item.clientClass} | ${yesNo(item.capabilities.upload)} | ${yesNo(item.capabilities.delete)} | ${yesNo(item.capabilities.getContent)} | ${yesNo(item.capabilities.presignedUpload)} | ${item.status} | ${escapeTable(item.findings.join("<br>"))} |`), "",
    "## Concurrency and state-machine risks", "",
    "| Kind | Symbol | Finding | Evidence |",
    "| --- | --- | --- | --- |",
    ...report.concurrencyRisks.map((item) =>
      `| ${item.kind} | ${escapeTable(item.symbol)} | ${item.finding} | ${escapeTable(`${item.file}:${item.line}`)} |`), ""
  ].join("\n");
}

function assessEntrypoint(
  entry: JavaProtocolEntrypoint,
  byFile: Map<string, JavaInput>,
  inputs: JavaInput[]
): InfraEntrypointContract {
  const input = byFile.get(entry.file);
  const source = input?.stripped ?? "";
  const originalSource = input?.content ?? "";
  const findings: string[] = [];
  if (entry.kind === "websocket") {
    if (!/\bgetType\s*\(\s*\)[\s\S]*?return\s+"[^"]+"/.test(originalSource)) {
      findings.push("IR-WEBSOCKET-MESSAGE-TYPE-UNRESOLVED");
    }
    if (!/\bgetLoginUser(?:Id|Type)\s*\(\s*session\s*\)/.test(source)) {
      findings.push("IR-WEBSOCKET-IDENTITY-UNPROVEN");
    }
  } else if (entry.kind === "scheduled-job") {
    if (/\b(?:delete|update|save|insert|clear)\w*\s*\(/i.test(source)) {
      findings.push("IR-JOB-RETRY-IDEMPOTENCY-UNPROVEN");
    }
  } else if (entry.kind === "async-method") {
    if (!/\b(?:Future|CompletableFuture|ListenableFuture)\s*</.test(source)) {
      findings.push("IR-ASYNC-FAILURE-VISIBILITY-UNPROVEN");
    }
    if (!/\b(?:Tenant|Security|MDC|Context)\w*\b/.test(source)) {
      findings.push("IR-ASYNC-CONTEXT-PROPAGATION-UNPROVEN");
    }
  } else if (entry.kind === "message-listener") {
    if (!/\b(?:idempot|dedup|unique|messageId|eventId)\w*\b/i.test(source)) {
      findings.push("IR-MESSAGE-RETRY-IDEMPOTENCY-UNPROVEN");
    }
  } else if (entry.kind === "lifecycle-hook") {
    if (/\b(?:save|insert|update|delete|clear|put)\w*\s*\(/i.test(source)
      || /\bFiles\s*\.\s*(?:write|move|delete|create)/.test(source)) {
      findings.push("IR-LIFECYCLE-IDEMPOTENCY-UNPROVEN");
    }
  } else if (entry.kind === "servlet-filter") {
    const registration = inputs.find((candidate) =>
      new RegExp(`FilterRegistrationBean\\s*<\\s*${escapeRegex(entry.symbol)}\\s*>`).test(candidate.stripped));
    if (!registration || !/\.setOrder\s*\(\s*[-+]?\d+\s*\)/.test(registration.stripped)) {
      findings.push("IR-SERVLET-FILTER-ORDER-UNRESOLVED");
    }
  }
  return {
    kind: entry.kind,
    symbol: entry.symbol,
    file: entry.file,
    line: entry.line,
    evidence: entry.evidence,
    status: findings.length === 0 ? "ready" : "blocked",
    findings
  };
}

function extractStorageProviders(inputs: JavaInput[]): InfraStorageProviderContract[] {
  const enumInput = inputs.find((input) => /\benum\s+FileStorageEnum\b/.test(input.stripped));
  if (!enumInput) return [];
  const declaration = /\benum\s+FileStorageEnum\b[\s\S]*?\{([\s\S]*?);/.exec(enumInput.stripped)?.[1] ?? "";
  const providers: InfraStorageProviderContract[] = [];
  const pattern = /\b([A-Z][A-Z0-9_]*)\s*\(\s*(\d+)\s*,\s*([A-Za-z_$][\w$]*)\.class\s*,\s*([A-Za-z_$][\w$]*)\.class\s*\)/g;
  for (const match of declaration.matchAll(pattern)) {
    const clientClass = match[4] as string;
    const implementation = inputs.find((input) =>
      new RegExp(`\\bclass\\s+${escapeRegex(clientClass)}\\b`).test(input.stripped));
    const source = implementation?.stripped ?? "";
    const capabilities = {
      upload: hasMethod(source, "upload"),
      delete: hasMethod(source, "delete"),
      getContent: hasMethod(source, "getContent"),
      presignedUpload: hasMethod(source, "getPresignedObjectUrl")
    };
    const findings: string[] = [];
    if (!implementation) findings.push("IR-STORAGE-PROVIDER-IMPLEMENTATION-UNRESOLVED");
    if (!capabilities.upload || !capabilities.delete || !capabilities.getContent) {
      findings.push("IR-STORAGE-PROVIDER-BASE-CAPABILITY-INCOMPLETE");
    }
    providers.push({
      storage: match[1] as string,
      storageCode: Number(match[2]),
      configClass: match[3] as string,
      clientClass,
      file: implementation?.file,
      capabilities,
      status: findings.length === 0 ? "ready" : "blocked",
      findings
    });
  }
  return providers.sort((left, right) => left.storageCode - right.storageCode);
}

function extractConcurrencyRisks(inputs: JavaInput[]): InfraConcurrencyRisk[] {
  const risks: InfraConcurrencyRisk[] = [];
  for (const input of inputs) {
    const concurrentMaps = [...input.stripped.matchAll(
      /\b(?:ConcurrentMap|Map)\s*<[^;=]+>\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+ConcurrentHashMap\s*</g
    )].map((match) => match[1] as string);
    for (const map of concurrentMaps) {
      const clear = new RegExp(`\\b${escapeRegex(map)}\\s*\\.\\s*clear\\s*\\(`).exec(input.stripped);
      const puts = [...input.stripped.matchAll(
        new RegExp(`\\b${escapeRegex(map)}\\s*\\.\\s*put\\s*\\(`, "g")
      )];
      const firstPut = puts[0];
      if (clear && firstPut) {
        risks.push({
          kind: "cache-snapshot",
          symbol: map,
          file: input.file,
          line: lineNumberAt(input.stripped, clear.index),
          finding: "IR-CACHE-CLEAR-THEN-REFILL-NONATOMIC"
        });
      }
      const get = new RegExp(`\\b${escapeRegex(map)}\\s*\\.\\s*get\\s*\\(`).exec(input.stripped);
      const putAfterGet = get ? puts.find((candidate) => (candidate.index ?? -1) > get.index) : undefined;
      if (get && putAfterGet
        && /\bif\s*\([^)]*==\s*null[^)]*\)/.test(
          input.stripped.slice(get.index, (putAfterGet.index ?? get.index) + putAfterGet[0].length)
        )) {
        risks.push({
          kind: "cache-check-then-put",
          symbol: map,
          file: input.file,
          line: lineNumberAt(input.stripped, get.index),
          finding: "IR-CACHE-CHECK-THEN-PUT-NONATOMIC"
        });
      }
    }
    for (const methodName of ["initializeMultipartUpload", "uploadMultipartPart", "completeMultipartUpload"]) {
      const method = extractMethodBody(input.stripped, methodName);
      if (!method) continue;
      if (!/\b(?:synchronized|Lock|tryLock|putIfAbsent|computeIfAbsent|compareAndSet)\b/.test(method.body)) {
        risks.push({
          kind: "multipart-session",
          symbol: methodName,
          file: input.file,
          line: lineNumberAt(input.stripped, method.index),
          finding: `IR-MULTIPART-${multipartPhase(methodName)}-CONCURRENCY-UNPROVEN`
        });
      }
    }
    const refresh = extractMethodBody(input.stripped, "refresh");
    if (refresh && /\bthis\s*\.\s*config\s*=/.test(refresh.body)
      && !/\b(?:volatile|synchronized|Lock|AtomicReference)\b/.test(input.stripped)) {
      risks.push({
        kind: "provider-inplace-refresh",
        symbol: "refresh",
        file: input.file,
        line: lineNumberAt(input.stripped, refresh.index),
        finding: "IR-PROVIDER-INPLACE-REFRESH-VISIBILITY-UNPROVEN"
      });
    }
  }
  return uniqueBy(risks, (risk) => `${risk.finding}|${risk.file}|${risk.symbol}`)
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function extractMethodBody(
  source: string,
  methodName: string
): { body: string; index: number } | undefined {
  const signature = new RegExp(`\\b${escapeRegex(methodName)}\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[^{}]+)?\\{`, "g");
  const match = signature.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open, index + 1), index: match.index };
    }
  }
  return undefined;
}

function multipartPhase(methodName: string): string {
  if (methodName.startsWith("initialize")) return "INIT";
  if (methodName.startsWith("upload")) return "PART";
  return "COMPLETE";
}

function hasMethod(source: string, methodName: string): boolean {
  return new RegExp(`\\b${escapeRegex(methodName)}\\s*\\(`).test(source);
}

async function collectJavaFiles(root: string, includeTests: boolean): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && [".git", "target", "build", "out", "node_modules", ".migration-guard"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const relative = relativePath(root, fullPath);
      if (entry.isDirectory()) {
        if (!includeTests && /(?:^|\/)src\/test(?:\/|$)/.test(relative)) continue;
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".java")) result.push(fullPath);
    }
  };
  await visit(root);
  return result.sort();
}

function stripJavaCommentsAndStrings(value: string): string {
  let output = "";
  let mode: "code" | "line" | "block" | "string" | "char" = "code";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (mode === "line") {
      if (char === "\n" || char === "\r") {
        output += char;
        mode = "code";
      } else output += " ";
    } else if (mode === "block") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        mode = "code";
      } else output += char === "\n" || char === "\r" ? char : " ";
    } else if (mode === "string" || mode === "char") {
      if (char === "\\" && next !== undefined) {
        output += "  ";
        index += 1;
      } else if (char === (mode === "string" ? "\"" : "'")) {
        output += " ";
        mode = "code";
      } else output += char === "\n" || char === "\r" ? char : " ";
    } else if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      mode = "line";
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      mode = "block";
    } else if (char === "\"") {
      output += " ";
      mode = "string";
    } else if (char === "'") {
      output += " ";
      mode = "char";
    } else output += char;
  }
  return output;
}

function compareEntrypoints(left: InfraEntrypointContract, right: InfraEntrypointContract): number {
  return left.kind.localeCompare(right.kind)
    || left.file.localeCompare(right.file)
    || left.line - right.line;
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function relativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? path.resolve(filePath).replaceAll("\\", "/") : relative;
}

function lineNumberAt(value: string, index: number): number {
  return value.slice(0, Math.max(0, index)).split("\n").length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
