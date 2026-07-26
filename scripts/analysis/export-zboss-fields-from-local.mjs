import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import net from "node:net";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const pipeline = promisify((await import("node:stream")).pipeline);
const [javaRootValue, logValue, outputValue] = process.argv.slice(2);
if (!javaRootValue || !logValue || !outputValue) {
  throw new Error("Usage: node scripts/analysis/export-zboss-fields-from-local.mjs <java-root> <runtime-log.gz> <output.tsv>");
}
const javaRoot = path.resolve(javaRootValue);
const logFile = path.resolve(logValue);
const output = path.resolve(outputValue);
const config = fs.readFileSync(path.join(
  javaRoot,
  "zboss-module-data/zboss-module-data-service/src/main/resources/application-local.yaml"
), "utf8");
const candidates = datasourceCandidates(config);
const datasource = await firstReachable(candidates);
if (!datasource) throw new Error(`No configured local datasource is reachable (${candidates.length} resolved candidates checked).`);
const tenantIds = new Set();
const input = fs.createReadStream(logFile).pipe(zlib.createGunzip());
let pending = "";
for await (const chunk of input) {
  const text = pending + chunk.toString("utf8");
  const lines = text.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) for (const match of line.matchAll(/tenantId[=:](\d{10,})/g)) tenantIds.add(match[1]);
}
if (tenantIds.size !== 1) throw new Error(`Expected exactly one tenant in the runtime log, found ${tenantIds.size}.`);
const tenantId = [...tenantIds][0];
const jdkHome = findJdk25();
const source = path.join(process.cwd(), "scripts/analysis/ZbossFieldJdbcExport.java");
const classDir = path.join("/tmp", `zboss-field-export-${process.pid}`);
fs.mkdirSync(classDir, { recursive: true });
await run(path.join(jdkHome, "bin", "javac"), [
  "-cp", "/Users/psy/.local/tools/jdbc/mysql-connector-j-9.7.0.jar",
  "-d", classDir,
  source
]);
await run(path.join(jdkHome, "bin", "java"), [
  "-cp", `${classDir}:/Users/psy/.local/tools/jdbc/mysql-connector-j-9.7.0.jar`,
  "ZbossFieldJdbcExport",
  tenantId,
  output
], {
  ZBOSS_JDBC_URL: datasource.url,
  ZBOSS_JDBC_USER: datasource.username,
  ZBOSS_JDBC_PASSWORD: datasource.password
});
const rows = fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean);
process.stdout.write(`${JSON.stringify({ output, tenantCount: 1, rows: rows.length, readOnly: true })}\n`);

function datasourceCandidates(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].match(/^(\s+)(master|slave):(?:\s*#.*)?\s*$/);
    if (!start) continue;
    const indent = start[1].length;
    const values = {};
    const documentedLocalUrls = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (!line.trim()) continue;
      const currentIndent = line.match(/^\s*/)[0].length;
      if (currentIndent <= indent) break;
      const commentedUrl = line.match(/^\s*#\s*url:\s*(jdbc:mysql:\/\/\S+)/);
      if (commentedUrl) documentedLocalUrls.push(commentedUrl[1]);
      if (line.trimStart().startsWith("#")) continue;
      const entry = line.trim().match(/^(url|username|password):\s*(.+)$/);
      if (entry) values[entry[1]] = resolveSpringValue(entry[2]);
    }
    if (values.url && values.username && values.password && !values.url.includes("${")) result.push(values);
    if (values.url?.includes("${") && values.username && values.password) {
      for (const url of documentedLocalUrls) result.push({ ...values, url });
    }
  }
  return result;
}

function resolveSpringValue(value) {
  const uncommented = value.replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "").trim();
  return uncommented.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_match, name, fallback) =>
    process.env[name] ?? fallback ?? _match);
}

async function firstReachable(candidates) {
  for (const candidate of candidates) {
    const match = candidate.url.match(/^jdbc:mysql:\/\/([^:/]+):(\d+)\//);
    if (!match) continue;
    if (await reachable(match[1], Number(match[2]))) return candidate;
  }
}

function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function findJdk25() {
  const roots = fs.readdirSync("/Users/psy/.local/jdks")
    .map((name) => path.join("/Users/psy/.local/jdks", name, "Contents", "Home"))
    .filter((home) => fs.existsSync(path.join(home, "bin", "javac")));
  if (roots.length !== 1) throw new Error("Expected exactly one user-local JDK.");
  return roots[0];
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed: ${stderr.slice(-2000)}`)));
  });
}
