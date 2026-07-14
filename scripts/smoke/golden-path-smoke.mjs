import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workspace = process.cwd();
const runId = `golden-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const evidenceDir = path.join(workspace, ".migration-guard", "golden-path", runId);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "migration-guard-golden-path-"));
let tarball;

try {
  const pack = JSON.parse((await run("npm", ["pack", "--json", "--ignore-scripts"], workspace)).stdout)[0];
  assert.ok(pack?.filename, "npm pack did not return a tarball filename");
  tarball = path.join(workspace, pack.filename);
  const tarballHash = await sha256File(tarball);
  const installRoot = path.join(tempRoot, "installed");
  await mkdir(installRoot, { recursive: true });
  await run("npm", ["init", "-y"], installRoot);
  await run("npm", ["install", "--ignore-scripts", tarball], installRoot);
  const bin = process.platform === "win32"
    ? path.join(installRoot, "node_modules", ".bin", "migration-guard.cmd")
    : path.join(installRoot, "node_modules", ".bin", "migration-guard");

  const fixturesRoot = path.join(tempRoot, "fixtures");
  const fixtures = [
    await createSingleTypeScriptFixture(fixturesRoot),
    await createPnpmWorkspaceFixture(fixturesRoot),
    await createGoFixture(fixturesRoot),
    await createPythonFixture(fixturesRoot)
  ];
  const results = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(bin, fixture));
  }
  const report = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    package: {
      filename: pack.filename,
      size: pack.size,
      unpackedSize: pack.unpackedSize,
      sha256: tarballHash
    },
    tempRoot,
    fixtures: results,
    metrics: {
      fixtureCount: results.length,
      passedFixtures: results.filter((fixture) => fixture.status === "passed").length,
      manualModificationCount: results.reduce((sum, fixture) => sum + fixture.manualModificationCount, 0)
    },
    status: results.every((fixture) => fixture.status === "passed") ? "passed" : "failed"
  };
  await writeJson(path.join(evidenceDir, "golden-path.json"), report);
  await writeFile(path.join(evidenceDir, "golden-path.md"), renderReport(report), "utf8");
  assert.equal(report.status, "passed");
  console.log(`golden path smoke passed: ${runId}, ${report.metrics.fixtureCount} fixtures`);
  console.log(`golden evidence: ${path.relative(workspace, path.join(evidenceDir, "golden-path.json"))}`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}

async function runFixture(bin, fixture) {
  const before = await snapshotBusinessFiles(fixture.root);
  const steps = [];
  const preview = await runStep(steps, bin, ["init", "--detect", "--json"], fixture.root);
  assert.equal(await exists(path.join(fixture.root, ".migration-guard.json")), false, `${fixture.name} preview wrote config`);
  const previewPlan = JSON.parse(preview.stdout);
  assert.equal(previewPlan.applied, false);
  assert.equal(previewPlan.confidence, fixture.expectedConfidence ?? "high");
  assert.ok(previewPlan.detected.includes(fixture.expectedDetection), `${fixture.name} detection missed ${fixture.expectedDetection}`);

  const apply = await runStep(steps, bin, ["init", "--detect", "--apply", "--json"], fixture.root);
  const applyPlan = JSON.parse(apply.stdout);
  assert.equal(applyPlan.applied, true);
  const configPath = path.join(fixture.root, ".migration-guard.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config, applyPlan.config);
  assert.deepEqual(config, previewPlan.config);

  await runStep(steps, bin, ["config", "validate", "--json"], fixture.root);
  const doctor = JSON.parse((await runStep(steps, bin, ["doctor", "--json"], fixture.root)).stdout);
  assert.equal(doctor.valid, true, `${fixture.name} doctor should be valid`);
  await runStep(steps, bin, ["scan", "--json"], fixture.root);
  await runStep(steps, bin, ["baseline"], fixture.root);
  await runStep(steps, bin, ["verify"], fixture.root, fixture.env);
  const behaviorReport = JSON.parse((await runStep(steps, bin, ["report", "--json"], fixture.root)).stdout);
  assert.equal(behaviorReport.status, "passed");
  assert.equal(behaviorReport.compare.differences, 0);

  const after = await snapshotBusinessFiles(fixture.root);
  assert.deepEqual(after, before, `${fixture.name} business files changed`);
  return {
    name: fixture.name,
    status: "passed",
    root: fixture.root,
    detected: previewPlan.detected,
    confidence: previewPlan.confidence,
    packageManager: previewPlan.packageManager,
    recommendedChecks: previewPlan.recommendedChecks.map((check) => check.name),
    manualModificationCount: 0,
    behaviorReportPath: behaviorReport.outputPath,
    steps
  };
}

async function runStep(steps, command, args, cwd, env = {}) {
  const started = Date.now();
  const result = await run(command, args, cwd, env);
  steps.push({
    command: [command, ...args],
    cwd,
    durationMs: Date.now() - started,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr)
  });
  return result;
}

async function createSingleTypeScriptFixture(root) {
  const dir = path.join(root, "single-typescript");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeJson(path.join(dir, "package.json"), {
    name: "single-typescript-fixture",
    version: "1.0.0",
    scripts: {
      typecheck: "node scripts/pass.mjs",
      test: "node scripts/pass.mjs",
      build: "node scripts/pass.mjs"
    },
    devDependencies: {
      typescript: "0.0.0"
    }
  });
  await writeFile(path.join(dir, "scripts", "pass.mjs"), "console.log('ok')\n", "utf8");
  await writeFile(path.join(dir, "src", "index.ts"), "export const value: string = 'ok';\n", "utf8");
  return { name: "single-typescript", root: dir, expectedDetection: "typescript" };
}

async function createPnpmWorkspaceFixture(root) {
  const dir = path.join(root, "pnpm-workspace");
  await mkdir(path.join(dir, "packages", "app", "src"), { recursive: true });
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeJson(path.join(dir, "package.json"), {
    name: "pnpm-workspace-fixture",
    version: "1.0.0",
    workspaces: ["packages/*"],
    scripts: {
      typecheck: "node scripts/pass.mjs",
      test: "node scripts/pass.mjs",
      build: "node scripts/pass.mjs"
    },
    devDependencies: {
      typescript: "0.0.0",
      vitest: "0.0.0",
      vite: "0.0.0"
    }
  });
  await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeJson(path.join(dir, "packages", "app", "package.json"), { name: "@fixture/app", version: "1.0.0" });
  await writeFile(path.join(dir, "packages", "app", "src", "index.ts"), "export const workspace = true;\n", "utf8");
  await writeFile(path.join(dir, "scripts", "pass.mjs"), "console.log('workspace ok')\n", "utf8");
  return { name: "pnpm-workspace", root: dir, expectedDetection: "workspace" };
}

async function createGoFixture(root) {
  const dir = path.join(root, "go-module");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "go.mod"), "module example.com/golden\n\ngo 1.22\n", "utf8");
  await writeFile(path.join(dir, "main.go"), "package golden\n\nfunc Value() string { return \"ok\" }\n", "utf8");
  await writeFile(path.join(dir, "main_test.go"), "package golden\n\nimport \"testing\"\n\nfunc TestValue(t *testing.T) { if Value() != \"ok\" { t.Fatal(\"bad value\") } }\n", "utf8");
  return { name: "go-module", root: dir, expectedDetection: "go" };
}

async function createPythonFixture(root) {
  const dir = path.join(root, "python-package");
  await mkdir(path.join(dir, "pkg"), { recursive: true });
  await writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"golden-python\"\nversion = \"1.0.0\"\n", "utf8");
  await writeFile(path.join(dir, "pkg", "__init__.py"), "VALUE = 'ok'\n", "utf8");
  return { name: "python-package", root: dir, expectedDetection: "python" };
}

async function snapshotBusinessFiles(root) {
  const files = await listFiles(root);
  const result = {};
  for (const filePath of files) {
    const relative = toPosix(path.relative(root, filePath));
    if (relative === ".migration-guard.json" || relative.startsWith(".migration-guard/")) continue;
    if (relative.includes("__pycache__/") || relative.endsWith(".pyc")) continue;
    result[relative] = await sha256File(filePath);
  }
  return result;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".migration-guard", "node_modules", "dist", "build", "target", "__pycache__"].includes(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files.sort();
}

function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function renderReport(report) {
  return [
    `# Golden Path ${report.runId}`,
    "",
    `- Status: ${report.status}`,
    `- Package: ${report.package.filename}`,
    `- Package sha256: ${report.package.sha256}`,
    `- Fixtures: ${report.metrics.passedFixtures}/${report.metrics.fixtureCount}`,
    `- Manual modifications: ${report.metrics.manualModificationCount}`,
    "",
    "| Fixture | Status | Detection | Checks |",
    "| --- | --- | --- | --- |",
    ...report.fixtures.map((fixture) => `| ${fixture.name} | ${fixture.status} | ${fixture.detected.join(", ")} | ${fixture.recommendedChecks.join(", ")} |`),
    ""
  ].join("\n");
}

function truncate(value) {
  return value.length <= 2000 ? value : `${value.slice(0, 2000)}\n<truncated>`;
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}
