import path from "node:path";
import { promises as fs } from "node:fs";
import { createDefaultConfig } from "./config.js";
import { pathExists, readJsonFile } from "./files.js";
import type { CheckConfig, CheckNormalizeConfig, LoadedConfig, MigrationGuardConfig } from "../types.js";

export interface ConfigDoctorFinding {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
  check?: string;
  fix?: string;
}

export interface ConfigDoctorReport {
  version: 1;
  targetRoot: string;
  detected: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "go" | "cargo" | "python" | "unknown";
  recommendedChecks: CheckConfig[];
  findings: ConfigDoctorFinding[];
  valid: boolean;
}

export async function detectConfig(targetRoot: string): Promise<MigrationGuardConfig> {
  const resolvedRoot = path.resolve(targetRoot);
  const report = await inspectTarget(resolvedRoot);
  return {
    ...createDefaultConfig(targetRoot),
    checks: report.recommendedChecks,
    probes: []
  };
}

export async function diagnoseConfig(loaded: LoadedConfig): Promise<ConfigDoctorReport> {
  const report = await inspectTarget(loaded.targetRoot);
  const findings = [...report.findings];
  for (const check of loaded.config.checks) {
    const cwd = check.cwd ? path.resolve(loaded.targetRoot, check.cwd) : loaded.targetRoot;
    if (!await pathExists(cwd)) {
      findings.push({ severity: "error", code: "check-cwd-missing", check: check.name, message: `Check cwd does not exist: ${cwd}`, fix: "Correct or remove the check cwd." });
    }
    if ((check.timeoutMs ?? 60000) < 1000) {
      findings.push({ severity: "warn", code: "check-timeout-short", check: check.name, message: `Check timeout is unusually short: ${check.timeoutMs}ms`, fix: "Use at least 1000ms for process startup." });
    }
    if (/npm\s+(?:run\s+)?[^\s]+\s+--if-present/.test(check.command) && !await scriptExists(loaded.targetRoot, npmScriptName(check.command))) {
      findings.push({ severity: "warn", code: "check-no-op", check: check.name, message: `Check may be a no-op because its npm script is missing: ${check.command}`, fix: "Remove the check or add the referenced script." });
    }
  }
  return { ...report, findings, valid: !findings.some((finding) => finding.severity === "error") };
}

export function explainConfig(loaded: LoadedConfig): Record<string, unknown> {
  return {
    version: 1,
    configPath: loaded.path,
    profile: loaded.profile,
    baseDir: loaded.baseDir,
    targetRoot: loaded.targetRoot,
    artifactsDir: loaded.artifactsDir,
    checks: loaded.config.checks.map((check) => ({ name: check.name, command: check.command, cwd: check.cwd ? path.resolve(loaded.targetRoot, check.cwd) : loaded.targetRoot, timeoutMs: check.timeoutMs, normalization: check.normalize?.presets ?? [] })),
    probes: loaded.config.probes.map((probe) => ({ name: probe.name, type: probe.type, cwd: "cwd" in probe && probe.cwd ? path.resolve(loaded.targetRoot, probe.cwd) : loaded.targetRoot })),
    compare: loaded.config.compare,
    variables: Object.keys(loaded.config.variables ?? {}).sort()
  };
}

export async function diagnoseUpgrade(loaded: LoadedConfig): Promise<Record<string, unknown>> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const findings: ConfigDoctorFinding[] = [];
  if (nodeMajor < 20) findings.push({ severity: "error", code: "node-version", message: `Node ${process.versions.node} is unsupported.`, fix: "Upgrade to Node 20 or newer." });
  if (loaded.config.schemaVersion !== 1) findings.push({ severity: "error", code: "config-schema", message: `Unsupported config schema: ${loaded.config.schemaVersion}` });
  const artifactWritable = await fs.access(loaded.artifactsDir, fs.constants.W_OK).then(() => true).catch(async () => {
    const parent = path.dirname(loaded.artifactsDir);
    return await fs.access(parent, fs.constants.W_OK).then(() => true).catch(() => false);
  });
  if (!artifactWritable) findings.push({ severity: "error", code: "artifacts-permission", message: `Artifacts directory is not writable: ${loaded.artifactsDir}` });
  const unresolvedVariables = JSON.stringify(loaded.config).match(/\$\{?[A-Z0-9_]+\}?/g) ?? [];
  if (unresolvedVariables.length > 0) findings.push({ severity: "error", code: "unresolved-variable", message: `Unresolved config variables: ${[...new Set(unresolvedVariables)].join(", ")}` });
  return { version: 1, currentVersion: "0.2.0-rc.1", targetVersion: "0.2.0", nodeVersion: process.versions.node, configSchemaVersion: loaded.config.schemaVersion, artifactsDir: loaded.artifactsDir, findings, ready: !findings.some((finding) => finding.severity === "error") };
}

async function inspectTarget(targetRoot: string): Promise<Omit<ConfigDoctorReport, "valid">> {
  const detected: string[] = [];
  const findings: ConfigDoctorFinding[] = [];
  const recommendedChecks: CheckConfig[] = [];
  let packageManager: ConfigDoctorReport["packageManager"] = "unknown";
  const packagePath = path.join(targetRoot, "package.json");
  if (await pathExists(packagePath)) {
    const pkg = await readJsonFile<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown }>(packagePath);
    const scripts = pkg.scripts ?? {};
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    packageManager = await jsPackageManager(targetRoot);
    detected.push("javascript");
    if (pkg.workspaces || await pathExists(path.join(targetRoot, "pnpm-workspace.yaml"))) detected.push("workspace");
    for (const framework of ["typescript", "vite", "webpack", "jest", "vitest", "react", "vue", "svelte"]) if (dependencies[framework]) detected.push(framework);
    for (const name of ["typecheck", "test", "build", "lint"]) {
      if (!scripts[name]) continue;
      recommendedChecks.push({ name, command: `${packageManager === "unknown" ? "npm" : packageManager} run ${name}`, timeoutMs: name === "build" ? 180000 : 120000, critical: name !== "lint", normalize: normalizationFor(name, dependencies, packageManager) });
    }
    if (recommendedChecks.length === 0) findings.push({ severity: "warn", code: "no-js-checks", message: "No typecheck, test, build, or lint scripts were detected.", fix: "Add explicit checks to .migration-guard.json." });
  } else if (await pathExists(path.join(targetRoot, "go.mod"))) {
    packageManager = "go"; detected.push("go");
    recommendedChecks.push(check("go-vet", "go vet ./...", ["go", "paths", "timing"]), check("go-test", "go test ./...", ["go", "paths", "timing"]));
  } else if (await pathExists(path.join(targetRoot, "Cargo.toml"))) {
    packageManager = "cargo"; detected.push("rust");
    recommendedChecks.push(check("cargo-check", "cargo check --all-targets", ["paths", "timing"]), check("cargo-test", "cargo test --all-targets", ["paths", "timing"]));
  } else if (await pathExists(path.join(targetRoot, "pyproject.toml")) || await pathExists(path.join(targetRoot, "requirements.txt"))) {
    packageManager = "python"; detected.push("python");
    recommendedChecks.push(check("python-compile", "python -m compileall .", ["paths", "timing"]));
    if (await pathExists(path.join(targetRoot, "pytest.ini")) || await pathExists(path.join(targetRoot, "tests"))) recommendedChecks.push(check("pytest", "python -m pytest", ["paths", "timing"]));
  } else {
    findings.push({ severity: "error", code: "unsupported-project", message: `No supported project manifest found under ${targetRoot}.`, fix: "Pass the correct --target or configure checks manually." });
  }
  return { version: 1, targetRoot, detected: [...new Set(detected)].sort(), packageManager, recommendedChecks, findings };
}

function check(name: string, command: string, presets: NonNullable<CheckNormalizeConfig["presets"]>): CheckConfig { return { name, command, timeoutMs: 180000, critical: true, normalize: { stripAnsi: true, trimWhitespace: true, lineEndings: "lf", presets } }; }
function normalizationFor(name: string, dependencies: Record<string, string>, packageManager: ConfigDoctorReport["packageManager"]): CheckNormalizeConfig { const presets: NonNullable<CheckNormalizeConfig["presets"]> = ["paths", "timing"]; if (packageManager === "pnpm") presets.push("pnpm"); if (name === "test" && dependencies.vitest) presets.push("vitest"); if (name === "test" && dependencies.jest) presets.push("jest"); if (name === "build" && dependencies.vite) presets.push("vite"); if (name === "build" && dependencies.webpack) presets.push("webpack"); return { stripAnsi: true, trimWhitespace: true, lineEndings: "lf", presets }; }
async function jsPackageManager(root: string): Promise<ConfigDoctorReport["packageManager"]> { if (await pathExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm"; if (await pathExists(path.join(root, "yarn.lock"))) return "yarn"; if (await pathExists(path.join(root, "bun.lock")) || await pathExists(path.join(root, "bun.lockb"))) return "bun"; return "npm"; }
async function scriptExists(root: string, name: string | undefined): Promise<boolean> { if (!name) return false; const packagePath = path.join(root, "package.json"); if (!await pathExists(packagePath)) return false; return Boolean((await readJsonFile<{ scripts?: Record<string, string> }>(packagePath)).scripts?.[name]); }
function npmScriptName(command: string): string | undefined { return command.match(/npm\s+(?:run\s+)?([^\s]+)/)?.[1]; }
