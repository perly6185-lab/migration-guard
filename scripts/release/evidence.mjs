import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const RELEASE_SCHEMA_VERSION = 1;
export const PILOTS = [
  { project: "ascllcreator", env: "MG_PILOT_ASCLLCREATOR_ROOT" },
  { project: "cursormade", env: "MG_PILOT_CURSORMADE_ROOT" },
  { project: "aiway", env: "MG_PILOT_AIWAY_ROOT" }
];

export function createReleaseRunId(now = new Date()) {
  return `release-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function releaseRunDir(workspace, releaseRunId) {
  return path.join(workspace, ".migration-guard", "releases", releaseRunId);
}

export function pilotResultPath(workspace, releaseRunId, project) {
  return path.join(releaseRunDir(workspace, releaseRunId), "pilot-results", `${project}.json`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readCoreArtifactPayload(filePath, expectedKind) {
  const value = await readJson(filePath);
  if (value?.artifactSchemaVersion !== 2) return value;
  if (value.kind !== expectedKind) throw new Error(`Core artifact kind mismatch: expected ${expectedKind}, received ${String(value.kind)}`);
  if (value.sourceVersion !== 1) throw new Error(`Unsupported source artifact version: ${String(value.sourceVersion)}`);
  if (value.payloadHash !== sha256(stableStringify(value.payload))) throw new Error(`Core artifact payload hash mismatch: ${filePath}`);
  return value.payload;
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function writeTextAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, value, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function describeArtifact(filePath, baseDir) {
  const details = await stat(filePath);
  return {
    path: toPosix(path.relative(baseDir, filePath)),
    sha256: await sha256File(filePath),
    size: details.size,
    modifiedAt: details.mtime.toISOString()
  };
}

export async function verifyArtifactDescriptor(descriptor, baseDir) {
  if (!descriptor?.path || !descriptor?.sha256) return { valid: false, reason: "artifact descriptor is incomplete" };
  const filePath = path.resolve(baseDir, descriptor.path);
  if (!isWithin(baseDir, filePath)) return { valid: false, reason: `artifact path escapes base directory: ${descriptor.path}` };
  try {
    const actualHash = await sha256File(filePath);
    return actualHash === descriptor.sha256
      ? { valid: true, filePath }
      : { valid: false, reason: `artifact hash mismatch: ${descriptor.path}` };
  } catch (error) {
    return { valid: false, reason: `artifact unavailable: ${descriptor.path}: ${error.message}` };
  }
}

export async function getReleaseContext(workspace) {
  const pkgPath = path.join(workspace, "package.json");
  const lockPath = path.join(workspace, "package-lock.json");
  const git = await getGitState(workspace);
  const context = {
    version: RELEASE_SCHEMA_VERSION,
    packageVersion: JSON.parse(await readFile(pkgPath, "utf8")).version,
    packageJsonHash: await sha256File(pkgPath),
    packageLockHash: await sha256File(lockPath),
    git,
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
  return { ...context, contextHash: sha256(JSON.stringify(context)) };
}

export async function getPilotContext(workspace, pilot, rootValue = process.env[pilot.env]) {
  const configPath = path.join(workspace, "pilots", `${pilot.project}.migration-guard.json`);
  const configHash = await sha256File(configPath);
  if (!rootValue) return { project: pilot.project, env: pilot.env, configPath, configHash, available: false, reason: `${pilot.env} is not set` };
  let root;
  try {
    root = await realpath(path.resolve(rootValue));
  } catch {
    return { project: pilot.project, env: pilot.env, configPath, configHash, available: false, reason: `${pilot.env} does not reference an existing root` };
  }
  const manifests = [];
  for (const name of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "go.mod", "Cargo.toml", "pyproject.toml"]) {
    const manifestPath = path.join(root, name);
    try {
      manifests.push({ name, sha256: await sha256File(manifestPath) });
    } catch {}
  }
  const git = await getGitState(root);
  const fingerprintSource = { root: toPosix(root), configHash, manifests, git };
  return {
    project: pilot.project,
    env: pilot.env,
    configPath,
    configHash,
    available: true,
    root,
    manifests,
    git,
    fingerprint: sha256(JSON.stringify(fingerprintSource))
  };
}

export async function getGitState(cwd) {
  const commit = await runCapture("git", ["rev-parse", "HEAD"], cwd, true);
  const status = await runCapture("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd, true);
  if (commit.code !== 0) return { repository: false };
  const statusText = status.stdout.trim();
  const diff = await runCapture("git", ["diff", "--binary", "HEAD", "--"], cwd, true);
  const untrackedResult = await runCapture("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd, true);
  const untracked = [];
  for (const relativePath of untrackedResult.stdout.split("\0").filter(Boolean).sort()) {
    const filePath = path.resolve(cwd, relativePath);
    if (!isWithin(cwd, filePath)) continue;
    try {
      untracked.push({ path: toPosix(relativePath), sha256: await sha256File(filePath) });
    } catch {}
  }
  const dirtyContent = { trackedDiffHash: sha256(diff.stdout), untracked };
  return {
    repository: true,
    commit: commit.stdout.trim(),
    dirty: statusText.length > 0,
    dirtyHash: sha256(JSON.stringify(dirtyContent)),
    dirtyEntries: statusText ? statusText.split(/\r?\n/).length : 0
  };
}

export function runCapture(command, args, cwd, allowFailure = false, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: Number(code ?? 1), stdout, stderr };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed with ${result.code}\n${stderr}`));
    });
  });
}

export function parseReleaseRunId(args, env = process.env) {
  const index = args.indexOf("--release-run");
  return index >= 0 ? args[index + 1] : env.MG_RELEASE_RUN_ID;
}

export function renderReleaseEvidence(manifest) {
  const lines = [
    `# Release Evidence ${manifest.releaseRunId}`,
    "",
    `- Status: ${manifest.status}`,
    `- Package: ${manifest.packageVersion}`,
    `- Context: ${manifest.contextHash}`,
    `- Git commit: ${manifest.context?.git?.commit ?? "unavailable"}`,
    `- Git dirty: ${manifest.context?.git?.dirty ?? "unknown"}`,
    `- Started: ${manifest.startedAt}`,
    `- Finished: ${manifest.finishedAt ?? "running"}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Duration |",
    "| --- | --- | ---: |",
    ...(manifest.steps ?? []).map((step) => `| ${step.id} | ${step.status} | ${step.durationMs ?? 0} ms |`),
    ""
  ];
  if (manifest.error) lines.push("## Failure", "", manifest.error, "");
  return lines.join("\n");
}

export function isWithin(baseDir, candidate) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function stableStringify(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortJsonValue(value[key]);
      return result;
    }, {});
  }
  return value;
}
