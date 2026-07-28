import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { containsSensitiveKey } from "./migrationFixture.js";

export type RuntimeCollectorKind =
  | "mysql"
  | "redis"
  | "events"
  | "sql-trace"
  | "ai-trace"
  | "stream-trace"
  | "tool-trace";

export interface RuntimeCollectorEvidence {
  version: 1;
  collector: RuntimeCollectorKind;
  status: "passed" | "blocked";
  capturedAt: string;
  specHash: string;
  payload: unknown;
  payloadHash: string;
  findings: string[];
  evidenceHash: string;
}

export interface MySqlCollectorSpec {
  version: 1;
  collector: "mysql";
  status: "template" | "draft" | "ready";
  connectionEnv: string;
  executable?: string;
  includeRows?: boolean;
  queries: Array<{ id: string; sql: string }>;
}

export interface RedisCollectorSpec {
  version: 1;
  collector: "redis";
  status: "template" | "draft" | "ready";
  connectionEnv: string;
  executable?: string;
  includeValues?: boolean;
  probes: Array<{ id: string; command: string[] }>;
}

export interface EventCollectorSpec {
  version: 1;
  collector: "events";
  status: "template" | "draft" | "ready";
  file: string;
  scenarioId?: string;
  correlationId?: string;
  correlationFields?: string[];
  includeFields: string[];
}

export interface SqlTraceCollectorSpec {
  version: 1;
  collector: "sql-trace";
  status: "template" | "draft" | "ready";
  file: string;
  scenarioId?: string;
  correlationEnv: string;
  correlationFields?: string[];
}

export interface StructuredTraceCollectorSpec {
  version: 1;
  collector: "ai-trace" | "stream-trace" | "tool-trace";
  status: "template" | "draft" | "ready";
  file: string;
  scenarioId?: string;
  correlationEnv: string;
  correlationFields?: string[];
  includeFields: string[];
  sequenceField?: string;
}

export interface NormalizedSqlTraceStatement {
  sequence: number;
  operation: "select" | "insert" | "update" | "delete" | "other";
  statementFingerprint: string;
  whereFields: string[];
  havingFields: string[];
  groupByFields: string[];
  orderByFields: string[];
  distinct: boolean;
  parameterTypes: string[];
  datasourceFingerprint?: string;
  correlationFingerprint: string;
}

export type RuntimeCollectorSpec =
  | MySqlCollectorSpec
  | RedisCollectorSpec
  | EventCollectorSpec
  | SqlTraceCollectorSpec
  | StructuredTraceCollectorSpec;

export interface SafeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type SafeProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
) => Promise<SafeProcessResult>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ENV = /^[A-Z][A-Z0-9_]{2,127}$/;
const READ_ONLY_SQL = /^\s*(?:select|show|describe|desc|explain|with)\b/i;
const SQL_MUTATION = /\b(?:insert|update|delete|replace|merge|alter|drop|truncate|create|grant|revoke|call|load\s+data|into\s+outfile)\b/i;
const REDIS_READ_COMMANDS = new Set([
  "GET", "MGET", "HGET", "HMGET", "HGETALL", "LRANGE", "ZRANGE", "ZRANGEBYSCORE",
  "SMEMBERS", "SCARD", "TTL", "PTTL", "EXISTS", "TYPE", "SCAN", "SSCAN", "HSCAN", "ZSCAN"
]);

export async function collectRuntimeEvidence(
  spec: RuntimeCollectorSpec,
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    runner?: SafeProcessRunner;
  } = {}
): Promise<RuntimeCollectorEvidence> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? runSafeProcess;
  if (spec.collector === "mysql") return collectMySql(spec, cwd, environment, runner, options);
  if (spec.collector === "redis") return collectRedis(spec, cwd, environment, runner, options);
  if (spec.collector === "sql-trace") return collectSqlTrace(spec, cwd, environment);
  if (spec.collector === "ai-trace" || spec.collector === "stream-trace" || spec.collector === "tool-trace") {
    return collectStructuredTrace(spec, cwd, environment);
  }
  if (spec.collector === "events") return collectEvents(spec, cwd);
  throw new Error(`Unsupported runtime collector: ${(spec as { collector?: string }).collector ?? "unknown"}`);
}

export function validateRuntimeCollectorSpec(
  spec: RuntimeCollectorSpec,
  options: { requireReady?: boolean } = {}
): string[] {
  const findings: string[] = [];
  if (!spec || typeof spec !== "object") return ["MG-COLLECTOR-SPEC-OBJECT-REQUIRED"];
  if (spec.version !== 1) findings.push("MG-COLLECTOR-SPEC-VERSION-UNSUPPORTED");
  if (options.requireReady !== false && spec.status !== "ready") findings.push("MG-COLLECTOR-SPEC-NOT-READY");
  if (spec.collector === "mysql") {
    const queries = Array.isArray(spec.queries) ? spec.queries : [];
    if (!Array.isArray(spec.queries)) findings.push("MG-COLLECTOR-PROBES-MISSING");
    findings.push(...validateBaseSpec(spec.connectionEnv, queries.map((item) => item.id)));
    for (const query of queries) {
      if (typeof query.sql !== "string"
        || !READ_ONLY_SQL.test(query.sql)
        || SQL_MUTATION.test(query.sql)
        || query.sql.includes(";")) {
        findings.push(`MG-COLLECTOR-MYSQL-QUERY-UNSAFE:${query.id}`);
      }
      if (containsRuntimeAuthoringPlaceholder(query.sql)) findings.push(`MG-COLLECTOR-MYSQL-QUERY-PLACEHOLDER:${query.id}`);
    }
  } else if (spec.collector === "redis") {
    const probes = Array.isArray(spec.probes) ? spec.probes : [];
    if (!Array.isArray(spec.probes)) findings.push("MG-COLLECTOR-PROBES-MISSING");
    findings.push(...validateBaseSpec(spec.connectionEnv, probes.map((item) => item.id)));
    for (const probe of probes) {
      if (!Array.isArray(probe.command)
        || !probe.command.length
        || typeof probe.command[0] !== "string"
        || !REDIS_READ_COMMANDS.has(probe.command[0].toUpperCase())) {
        findings.push(`MG-COLLECTOR-REDIS-COMMAND-UNSAFE:${probe.id}`);
      }
      if (Array.isArray(probe.command) && probe.command.some(containsRuntimeAuthoringPlaceholder)) {
        findings.push(`MG-COLLECTOR-REDIS-PLACEHOLDER:${probe.id}`);
      }
    }
  } else if (spec.collector === "events") {
    const fields = Array.isArray(spec.includeFields) ? spec.includeFields : [];
    if (!fields.length) findings.push("MG-COLLECTOR-EVENT-FIELDS-MISSING");
    if (fields.some((field) => !/^[A-Za-z0-9_.-]+$/.test(field))) findings.push("MG-COLLECTOR-EVENT-FIELD-UNSAFE");
    if (typeof spec.file === "string" && (path.isAbsolute(spec.file) || spec.file.split(/[\\/]/).includes(".."))) {
      findings.push("MG-COLLECTOR-EVENT-FILE-UNSAFE");
    }
    if (typeof spec.file !== "string" || !spec.file || containsRuntimeAuthoringPlaceholder(spec.file)) {
      findings.push("MG-COLLECTOR-EVENT-FILE-PLACEHOLDER");
    }
  } else if (spec.collector === "sql-trace") {
    if (typeof spec.file !== "string" || !spec.file || containsRuntimeAuthoringPlaceholder(spec.file)) {
      findings.push("MG-COLLECTOR-SQL-TRACE-FILE-PLACEHOLDER");
    } else if (path.isAbsolute(spec.file) || spec.file.split(/[\\/]/).includes("..")) {
      findings.push("MG-COLLECTOR-SQL-TRACE-FILE-UNSAFE");
    }
    if (typeof spec.correlationEnv !== "string" || !SAFE_ENV.test(spec.correlationEnv)) {
      findings.push("MG-COLLECTOR-SQL-TRACE-CORRELATION-ENV-UNSAFE");
    }
    if ((spec.correlationFields ?? ["requestId", "correlationId"])
      .some((field) => !/^[A-Za-z0-9_.-]+$/.test(field))) {
      findings.push("MG-COLLECTOR-SQL-TRACE-CORRELATION-FIELD-UNSAFE");
    }
  } else if (spec.collector === "ai-trace" || spec.collector === "stream-trace" || spec.collector === "tool-trace") {
    const prefix = `MG-COLLECTOR-${spec.collector.toUpperCase()}`;
    const fields = Array.isArray(spec.includeFields) ? spec.includeFields : [];
    const requiredFields = requiredStructuredTraceFields(spec.collector);
    if (typeof spec.file !== "string" || !spec.file || containsRuntimeAuthoringPlaceholder(spec.file)) {
      findings.push(`${prefix}-FILE-PLACEHOLDER`);
    } else if (path.isAbsolute(spec.file) || spec.file.split(/[\\/]/).includes("..")) {
      findings.push(`${prefix}-FILE-UNSAFE`);
    }
    if (typeof spec.correlationEnv !== "string" || !SAFE_ENV.test(spec.correlationEnv)) {
      findings.push(`${prefix}-CORRELATION-ENV-UNSAFE`);
    }
    if (!fields.length || requiredFields.some((field) => !fields.includes(field))) {
      findings.push(`${prefix}-FIELDS-INCOMPLETE`);
    }
    if (fields.some((field) => !/^[A-Za-z0-9_.-]+$/.test(field)) || containsSensitiveKey(Object.fromEntries(fields.map((field) => [field, true])))) {
      findings.push(`${prefix}-FIELD-UNSAFE`);
    }
    if ((spec.correlationFields ?? ["requestId", "correlationId"])
      .some((field) => !/^[A-Za-z0-9_.-]+$/.test(field))) {
      findings.push(`${prefix}-CORRELATION-FIELD-UNSAFE`);
    }
    if (spec.sequenceField !== undefined && !/^[A-Za-z0-9_.-]+$/.test(spec.sequenceField)) {
      findings.push(`${prefix}-SEQUENCE-FIELD-UNSAFE`);
    }
  } else {
    findings.push("MG-COLLECTOR-KIND-UNSUPPORTED");
  }
  return [...new Set(findings)].sort();
}

export function containsRuntimeAuthoringPlaceholder(value: unknown): boolean {
  if (typeof value === "string") {
    return /<[^>]+>|\b(?:replace[-_ ]?me|todo|tbd)\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsRuntimeAuthoringPlaceholder);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsRuntimeAuthoringPlaceholder);
}

export function validateRuntimeCollectorEvidence(value: RuntimeCollectorEvidence): string[] {
  const findings: string[] = [];
  if (value.version !== 1) findings.push("MG-COLLECTOR-VERSION-UNSUPPORTED");
  if (!["mysql", "redis", "events", "sql-trace", "ai-trace", "stream-trace", "tool-trace"].includes(value.collector)) findings.push("MG-COLLECTOR-KIND-UNSUPPORTED");
  if (value.status !== "passed") findings.push(`MG-COLLECTOR-BLOCKED:${value.collector}`);
  if (!value.specHash || !value.payloadHash) findings.push(`MG-COLLECTOR-LINEAGE-MISSING:${value.collector}`);
  if (value.payloadHash !== sha256(stableStringify(value.payload))) findings.push(`MG-COLLECTOR-PAYLOAD-HASH-MISMATCH:${value.collector}`);
  if (value.evidenceHash !== runtimeCollectorEvidenceHash(value)) findings.push(`MG-COLLECTOR-EVIDENCE-HASH-MISMATCH:${value.collector}`);
  if (containsSensitiveKey(value.payload)) findings.push(`MG-COLLECTOR-SENSITIVE-CONTENT:${value.collector}`);
  return [...new Set(findings)].sort();
}

export function runtimeCollectorEvidenceHash(value: RuntimeCollectorEvidence): string {
  return sha256(stableStringify({ ...value, evidenceHash: undefined }));
}

async function collectMySql(
  spec: MySqlCollectorSpec,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  runner: SafeProcessRunner,
  options: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<RuntimeCollectorEvidence> {
  const findings = validateRuntimeCollectorSpec(spec);
  const rawUrl = environment[spec.connectionEnv];
  if (!rawUrl) findings.push(`MG-COLLECTOR-ENV-MISSING:${spec.connectionEnv}`);
  const connection = rawUrl ? parseConnectionUrl(rawUrl, "mysql:") : undefined;
  if (rawUrl && !connection) findings.push("MG-COLLECTOR-MYSQL-URL-INVALID");
  const snapshots: unknown[] = [];
  if (!findings.length && connection) {
    for (const query of spec.queries) {
      const result = await runner(spec.executable ?? "mysql", [
        "--batch", "--raw",
        "--host", connection.hostname,
        "--port", connection.port || "3306",
        "--user", decodeURIComponent(connection.username),
        "--database", connection.database,
        "--execute", query.sql
      ], {
        cwd,
        env: { ...environment, MYSQL_PWD: decodeURIComponent(connection.password) },
        timeoutMs: options.timeoutMs ?? 30_000,
        maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024
      });
      if (result.exitCode !== 0 || result.timedOut || result.error) {
        findings.push(`MG-COLLECTOR-MYSQL-QUERY-FAILED:${query.id}`);
        continue;
      }
      const parsed = parseTabularOutput(result.stdout);
      snapshots.push({
        id: query.id,
        queryHash: sha256(query.sql),
        columns: parsed.columns,
        rowCount: parsed.rows.length,
        rowsHash: sha256(stableStringify(parsed.rows)),
        ...(spec.includeRows ? { rows: parsed.rows } : {})
      });
    }
  }
  return finishCollector("mysql", spec, { snapshots }, findings);
}

async function collectRedis(
  spec: RedisCollectorSpec,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  runner: SafeProcessRunner,
  options: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<RuntimeCollectorEvidence> {
  const findings = validateRuntimeCollectorSpec(spec);
  const rawUrl = environment[spec.connectionEnv];
  if (!rawUrl) findings.push(`MG-COLLECTOR-ENV-MISSING:${spec.connectionEnv}`);
  const connection = rawUrl ? parseConnectionUrl(rawUrl, "redis:", "rediss:") : undefined;
  if (rawUrl && !connection) findings.push("MG-COLLECTOR-REDIS-URL-INVALID");
  const probes: unknown[] = [];
  if (!findings.length && connection) {
    for (const probe of spec.probes) {
      const args = [
        "--raw", "-h", connection.hostname, "-p", connection.port || "6379",
        "-n", connection.database || "0",
        ...(connection.username ? ["--user", decodeURIComponent(connection.username)] : []),
        ...(connection.protocol === "rediss:" ? ["--tls"] : []),
        ...probe.command
      ];
      const result = await runner(spec.executable ?? "redis-cli", args, {
        cwd,
        env: { ...environment, REDISCLI_AUTH: decodeURIComponent(connection.password) },
        timeoutMs: options.timeoutMs ?? 15_000,
        maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024
      });
      if (result.exitCode !== 0 || result.timedOut || result.error) {
        findings.push(`MG-COLLECTOR-REDIS-PROBE-FAILED:${probe.id}`);
        continue;
      }
      const values = normalizeLines(result.stdout);
      probes.push({
        id: probe.id,
        commandHash: sha256(stableStringify(probe.command)),
        itemCount: values.length,
        valuesHash: sha256(stableStringify(values)),
        ...(spec.includeValues ? { values } : {})
      });
    }
  }
  return finishCollector("redis", spec, { probes }, findings);
}

async function collectEvents(spec: EventCollectorSpec, cwd: string): Promise<RuntimeCollectorEvidence> {
  const findings = validateRuntimeCollectorSpec(spec);
  const file = path.resolve(cwd, spec.file);
  let events: Record<string, unknown>[] = [];
  try {
    const lines = normalizeLines(await fs.readFile(file, "utf8"));
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (spec.scenarioId && value.scenarioId !== spec.scenarioId) continue;
        if (spec.correlationId && !(spec.correlationFields ?? ["correlationId", "requestId", "batchId"])
          .some((field) => readField(value, field) === spec.correlationId)) continue;
        events.push(Object.fromEntries(spec.includeFields.map((field) => [field, readField(value, field)])));
      } catch {
        findings.push("MG-COLLECTOR-EVENT-LINE-MALFORMED");
      }
    }
  } catch {
    findings.push("MG-COLLECTOR-EVENT-FILE-UNREADABLE");
  }
  if (events.some(containsSensitiveKey)) findings.push("MG-COLLECTOR-EVENT-SENSITIVE-CONTENT");
  events = events.map(sortRecord);
  return finishCollector("events", spec, {
    eventCount: events.length,
    events,
    eventsHash: sha256(stableStringify(events))
  }, findings);
}

async function collectSqlTrace(
  spec: SqlTraceCollectorSpec,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<RuntimeCollectorEvidence> {
  const findings = validateRuntimeCollectorSpec(spec);
  const correlationId = environment[spec.correlationEnv];
  if (!correlationId) findings.push(`MG-COLLECTOR-ENV-MISSING:${spec.correlationEnv}`);
  const correlationFingerprint = correlationId ? sha256(correlationId) : "";
  const file = path.resolve(cwd, spec.file);
  const statements: NormalizedSqlTraceStatement[] = [];
  if (!findings.length) {
    try {
      const lines = normalizeLines(await fs.readFile(file, "utf8"));
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (spec.scenarioId && value.scenarioId !== spec.scenarioId) continue;
          const observedCorrelation = (spec.correlationFields ?? ["requestId", "correlationId"])
            .map((field) => readField(value, field))
            .find((item) => typeof item === "string");
          if (correlationId && observedCorrelation !== correlationId) continue;
          const sql = typeof value.sql === "string" ? value.sql : undefined;
          if (!sql) {
            findings.push("MG-COLLECTOR-SQL-TRACE-SQL-MISSING");
            continue;
          }
          const sequence = Number(value.sequence);
          if (!Number.isInteger(sequence) || sequence < 0) {
            findings.push("MG-COLLECTOR-SQL-TRACE-SEQUENCE-INVALID");
            continue;
          }
          statements.push(normalizeSqlTraceStatement({
            sql,
            sequence,
            parameterTypes: normalizeParameterTypes(value),
            datasource: typeof value.datasource === "string" ? value.datasource : undefined,
            correlationFingerprint
          }));
        } catch {
          findings.push("MG-COLLECTOR-SQL-TRACE-LINE-MALFORMED");
        }
      }
    } catch {
      findings.push("MG-COLLECTOR-SQL-TRACE-FILE-UNREADABLE");
    }
  }
  statements.sort((left, right) => left.sequence - right.sequence);
  if (!statements.length) findings.push("MG-COLLECTOR-SQL-TRACE-EMPTY");
  if (new Set(statements.map((item) => item.sequence)).size !== statements.length) {
    findings.push("MG-COLLECTOR-SQL-TRACE-SEQUENCE-DUPLICATE");
  }
  return finishCollector("sql-trace", spec, {
    correlationFingerprint,
    statementCount: statements.length,
    statements,
    statementsHash: sha256(stableStringify(statements))
  }, findings);
}

async function collectStructuredTrace(
  spec: StructuredTraceCollectorSpec,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<RuntimeCollectorEvidence> {
  const findings = validateRuntimeCollectorSpec(spec);
  const prefix = `MG-COLLECTOR-${spec.collector.toUpperCase()}`;
  const correlationId = environment[spec.correlationEnv];
  if (!correlationId) findings.push(`MG-COLLECTOR-ENV-MISSING:${spec.correlationEnv}`);
  const correlationFingerprint = correlationId ? sha256(correlationId) : "";
  const records: Array<Record<string, unknown> & { sequence: number }> = [];
  if (!findings.length) {
    try {
      const lines = normalizeLines(await fs.readFile(path.resolve(cwd, spec.file), "utf8"));
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (spec.scenarioId && value.scenarioId !== spec.scenarioId) continue;
          const observedCorrelation = (spec.correlationFields ?? ["requestId", "correlationId"])
            .map((field) => readField(value, field))
            .find((item) => typeof item === "string");
          if (correlationId && observedCorrelation !== correlationId) continue;
          const sequence = Number(readField(value, spec.sequenceField ?? "sequence"));
          if (!Number.isInteger(sequence) || sequence < 0) {
            findings.push(`${prefix}-SEQUENCE-INVALID`);
            continue;
          }
          const projected = Object.fromEntries(spec.includeFields.map((field) => [field, readField(value, field)]));
          if (requiredStructuredTraceFields(spec.collector).some((field) => projected[field] === undefined)) {
            findings.push(`${prefix}-RECORD-INCOMPLETE`);
            continue;
          }
          records.push({ ...sortRecord(projected), sequence });
        } catch {
          findings.push(`${prefix}-LINE-MALFORMED`);
        }
      }
    } catch {
      findings.push(`${prefix}-FILE-UNREADABLE`);
    }
  }
  records.sort((left, right) => left.sequence - right.sequence);
  if (!records.length) findings.push(`${prefix}-EMPTY`);
  if (new Set(records.map((item) => item.sequence)).size !== records.length) {
    findings.push(`${prefix}-SEQUENCE-DUPLICATE`);
  }
  if (records.some(containsSensitiveKey)) findings.push(`${prefix}-SENSITIVE-CONTENT`);
  return finishCollector(spec.collector, spec, {
    correlationFingerprint,
    recordCount: records.length,
    records,
    recordsHash: sha256(stableStringify(records))
  }, findings);
}

function requiredStructuredTraceFields(
  collector: StructuredTraceCollectorSpec["collector"]
): string[] {
  if (collector === "ai-trace") {
    return ["sequence", "model", "finishReason", "toolCallCount", "factSourceCount"];
  }
  if (collector === "stream-trace") return ["sequence", "eventType", "terminal"];
  return ["sequence", "toolName", "status", "argumentFingerprint", "resultFingerprint"];
}

export function normalizeSqlTraceStatement(input: {
  sql: string;
  sequence: number;
  parameterTypes?: string[];
  datasource?: string;
  correlationFingerprint: string;
}): NormalizedSqlTraceStatement {
  const normalized = normalizeSql(input.sql);
  const operation = (/^\s*(select|insert|update|delete)\b/i.exec(normalized)?.[1]?.toLowerCase()
    ?? "other") as NormalizedSqlTraceStatement["operation"];
  return {
    sequence: input.sequence,
    operation,
    statementFingerprint: sha256(normalized),
    whereFields: clauseFields(normalized, "where", ["group by", "having", "order by", "limit"]),
    havingFields: clauseFields(normalized, "having", ["order by", "limit"]),
    groupByFields: clauseFields(normalized, "group by", ["having", "order by", "limit"]),
    orderByFields: clauseFields(normalized, "order by", ["limit"]),
    distinct: /\bselect\s+distinct\b/i.test(normalized),
    parameterTypes: [...(input.parameterTypes ?? [])],
    ...(input.datasource ? { datasourceFingerprint: sha256(input.datasource) } : {}),
    correlationFingerprint: input.correlationFingerprint
  };
}

function finishCollector(
  collector: RuntimeCollectorKind,
  spec: RuntimeCollectorSpec,
  payload: unknown,
  findings: string[]
): RuntimeCollectorEvidence {
  const base = {
    version: 1 as const,
    collector,
    status: findings.length ? "blocked" as const : "passed" as const,
    capturedAt: new Date().toISOString(),
    specHash: sha256(stableStringify(spec)),
    payload,
    payloadHash: sha256(stableStringify(payload)),
    findings: [...new Set(findings)].sort()
  };
  return { ...base, evidenceHash: sha256(stableStringify(base)) };
}

function validateBaseSpec(environmentName: string, ids: string[]): string[] {
  const findings: string[] = [];
  if (typeof environmentName !== "string" || !SAFE_ENV.test(environmentName)) findings.push("MG-COLLECTOR-ENV-NAME-UNSAFE");
  if (!ids.length) findings.push("MG-COLLECTOR-PROBES-MISSING");
  if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== ids.length) findings.push("MG-COLLECTOR-PROBE-ID-INVALID");
  return findings;
}

function parseConnectionUrl(value: string, ...protocols: string[]): {
  protocol: string; hostname: string; port: string; username: string; password: string; database: string;
} | undefined {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) return undefined;
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      database: parsed.pathname.replace(/^\/+/, "")
    };
  } catch {
    return undefined;
  }
}

function parseTabularOutput(value: string): { columns: string[]; rows: string[][] } {
  const lines = normalizeLines(value);
  if (!lines.length) return { columns: [], rows: [] };
  return { columns: lines[0]!.split("\t"), rows: lines.slice(1).map((line) => line.split("\t")) };
}

function normalizeParameterTypes(value: Record<string, unknown>): string[] {
  if (Array.isArray(value.parameterTypes)) {
    return value.parameterTypes.map((item) => String(item).toLowerCase());
  }
  if (!Array.isArray(value.parameters)) return [];
  return value.parameters.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).type === "string") {
      return String((item as Record<string, unknown>).type).toLowerCase();
    }
    if (item === null) return "null";
    if (Array.isArray(item)) return "array";
    return typeof item;
  });
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/'(?:''|\\'|[^'])*'/g, "?")
    .replace(/"(?:\"\"|\\\"|[^"])*"/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function clauseFields(sql: string, clause: string, stops: string[]): string[] {
  const start = sql.search(new RegExp(`\\b${clause.replace(" ", "\\s+")}\\b`, "i"));
  if (start < 0) return [];
  const bodyStart = start + clause.length;
  const tail = sql.slice(bodyStart);
  const stopIndexes = stops
    .map((stop) => tail.search(new RegExp(`\\b${stop.replace(" ", "\\s+")}\\b`, "i")))
    .filter((index) => index >= 0);
  const body = tail.slice(0, stopIndexes.length ? Math.min(...stopIndexes) : undefined);
  const keywords = new Set([
    "and", "or", "not", "null", "is", "in", "like", "between", "asc", "desc",
    "case", "when", "then", "else", "end", "true", "false", "as", "on",
    "sum", "count", "avg", "min", "max", "coalesce", "ifnull", "cast", "distinct"
  ]);
  return [...new Set((body.match(/[a-z_][a-z0-9_$.]*/gi) ?? [])
    .map((item) => item.toLowerCase())
    .filter((item) => !keywords.has(item) && !item.startsWith("$")))].sort();
}

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0);
}

function readField(value: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((current, segment) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined, value);
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

async function runSafeProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
): Promise<SafeProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const append = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current + chunk.length > options.maxOutputBytes) {
        outputExceeded = true;
        return current + chunk.length;
      }
      target.push(chunk);
      return current + chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut, error: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        error: outputExceeded ? "collector output exceeded limit" : undefined
      });
    });
  });
}
