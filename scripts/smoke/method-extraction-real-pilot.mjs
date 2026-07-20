import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repoRoot, "dist", "cli.js");
const manifestPath = option("manifest") ?? process.env.MG_METHOD_PILOT_MANIFEST;
if (!manifestPath) throw new Error("Provide --manifest <json> or MG_METHOD_PILOT_MANIFEST.");
const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
if (!Array.isArray(manifest.cases) || manifest.cases.length < 3) throw new Error("Method pilot manifest requires at least three real-repository cases.");

const releaseRun = option("release-run") ?? process.env.MG_RELEASE_RUN_ID;
const evidenceRoot = path.resolve(option("output") ?? (releaseRun
  ? path.join(repoRoot, ".migration-guard", "releases", releaseRun)
  : path.join(repoRoot, ".migration-guard", "method-pilots")));
await mkdir(evidenceRoot, { recursive: true });
const runId = `method-pilot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const results = [];
for (const item of manifest.cases) results.push(await runCase(item));
const report = {
  version: 1,
  runId,
  createdAt: new Date().toISOString(),
  manifest: path.resolve(manifestPath),
  passed: results.every((result) => result.passed),
  results
};
report.reportHash = sha256(stable(report));
const output = path.join(evidenceRoot, releaseRun ? "method-extraction-pilot.json" : `${runId}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: report.passed, cases: results.length, reportHash: report.reportHash }, null, 2));
if (!report.passed) process.exitCode = 1;

async function runCase(item) {
  if (!item.name || !item.root || !item.symbol) throw new Error("Each pilot case requires name, root and symbol.");
  const originalRoot = path.resolve(item.root);
  const temp = await mkdtemp(path.join(os.tmpdir(), `mg-method-pilot-${sanitize(item.name)}-`));
  const clone = path.join(temp, "project");
  const startedAt = new Date().toISOString();
  try {
    await run("git", ["clone", "--local", "--no-hardlinks", originalRoot, clone], repoRoot, 120_000);
    if (item.setupCommand !== false) await shell(item.setupCommand ?? "npm ci", clone, item.timeoutMs ?? 600_000);
    const configPath = path.join(clone, ".migration-guard.json");
    await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1, sourceRoot: ".", targetRoot: ".", artifactsDir: ".migration-guard" }, null, 2)}\n`);
    await run("git", ["add", ".migration-guard.json"], clone);
    await run("git", ["-c", "user.name=Migration Guard Pilot", "-c", "user.email=pilot@example.invalid", "commit", "-m", "chore: add pilot config"], clone);
    const goal = `method symbol=${item.symbol}${item.callDepth ? ` call-depth=${item.callDepth}` : ""}`;
    await run(process.execPath, [cli, "run", "--config", configPath, "--source", clone, "--target", clone, "--goal", goal, "--adapter", "method-refactor", "--auto"], clone, item.timeoutMs ?? 600_000);
    const runDir = await latestRunDir(path.join(clone, ".migration-guard", "migration-runs"));
    const migrationRunId = path.basename(runDir);
    const executeArgs = [cli, "method-extraction", "execute", "--config", configPath, "--run", migrationRunId, "--trust-tier", item.trustTier ?? "supervised"];
    if (item.candidate) executeArgs.push("--candidate", String(item.candidate));
    if (item.extractName) executeArgs.push("--extract-name", item.extractName);
    await run(process.execPath, executeArgs, clone, item.timeoutMs ?? 600_000);
    const sessionPath = path.join(runDir, "adapter", "method-extraction-session", "method-extraction-session.json");
    const qualityPath = path.join(runDir, "adapter", "method-extraction-session", "method-extraction-quality.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    const quality = await readFile(qualityPath, "utf8").then(JSON.parse).catch(() => undefined);
    const expectedState = item.expectedState ?? "completed";
    return {
      name: item.name,
      sourceRoot: originalRoot,
      sourceHead: (await run("git", ["rev-parse", "HEAD"], originalRoot)).stdout.trim(),
      symbol: item.symbol,
      startedAt,
      finishedAt: new Date().toISOString(),
      state: session.state,
      expectedState,
      passed: session.state === expectedState,
      patchHash: session.patchHash,
      sessionHash: session.sessionHash,
      qualityHash: quality?.reportHash,
      behaviorConfidence: quality?.behaviorConfidence,
      structuralImprovement: quality?.structuralImprovement,
      originalRepositoryUnchanged: (await run("git", ["status", "--porcelain"], originalRoot)).stdout.trim() === ""
    };
  } catch (error) {
    return { name: item.name, sourceRoot: originalRoot, symbol: item.symbol, startedAt, finishedAt: new Date().toISOString(), passed: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function latestRunDir(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  if (!dirs.length) throw new Error("Pilot did not create a migration run.");
  return dirs.sort().at(-1);
}

async function shell(command, cwd, timeout) {
  return process.platform === "win32" ? run("cmd.exe", ["/d", "/s", "/c", command], cwd, timeout) : run("sh", ["-lc", command], cwd, timeout);
}

async function run(file, args, cwd, timeout = 120_000) {
  try {
    return await execFileAsync(file, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    throw new Error(`${file} ${args.join(" ")} failed: ${error.stderr ?? error.stdout ?? error.message}`);
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sanitize(value) { return String(value).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) { return JSON.stringify(value, Object.keys(value).sort()); }
