import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  bootstrapMd2Target,
  verifyBootstrapMd2Target,
  type BootstrapMd2Manifest,
  type BootstrapMd2VerifyReport
} from "./bootstrap.js";
import { pathExists } from "./files.js";
import { runShellCommand } from "./exec.js";

test("bootstrap md2 dry-run writes manifest without copying files", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-dry-");
  try {
    const manifest = await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot
    });

    assert.equal(manifest.mode, "dry-run");
    assert.equal(manifest.summary.plannedFileCount, 2);
    assert.equal(manifest.summary.copiedFileCount, 0);
    assert.equal(await pathExists(path.join(fixture.targetRoot, "package.json")), false);
    assert.ok(manifest.skippedFiles.some((file) => file.path === ".env" && file.reason === "environment file"));
    assert.ok(manifest.skippedFiles.some((file) => file.path === "node_modules" && file.reason === "excluded path"));
    assert.match(manifest.outputPath ?? "", /md2-bootstrap-/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 execute copies allowed files and excludes generated or sensitive files", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-exec-");
  try {
    const manifest = await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      execute: true
    });

    assert.equal(manifest.mode, "execute");
    assert.equal(manifest.summary.copiedFileCount, 2);
    assert.equal(await readFile(path.join(fixture.targetRoot, "package.json"), "utf8"), "{}");
    assert.equal(await readFile(path.join(fixture.targetRoot, "src", "index.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(await pathExists(path.join(fixture.targetRoot, ".env")), false);
    assert.equal(await pathExists(path.join(fixture.targetRoot, "node_modules", "left-pad", "index.js")), false);
    assert.match(manifest.targetGit.statusAfter ?? "", /\?\? package\.json/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 rejects unsafe roots and dirty targets", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-safe-");
  try {
    await assert.rejects(
      () => bootstrapMd2Target(fixture.loaded, {
        sourceRoot: fixture.sourceRoot,
        targetRoot: fixture.sourceRoot
      }),
      /source and target/
    );

    await writeFile(path.join(fixture.targetRoot, "dirty.txt"), "dirty", "utf8");
    await assert.rejects(
      () => bootstrapMd2Target(fixture.loaded, {
        sourceRoot: fixture.sourceRoot,
        targetRoot: fixture.targetRoot
      }),
      /must be clean/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 verify blocks before package.json exists", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-verify-no-package-");
  try {
    const report = await verifyBootstrapMd2Target(fixture.loaded, {
      targetRoot: fixture.targetRoot,
      pnpmCommand: `${process.execPath} -e "console.log('9.0.0')"`
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.checks.some((check) => check.name === "package-json" && check.status === "blocked"));
    assert.match(report.checks.find((check) => check.name === "package-json")?.message ?? "", /package\.json/);
    assert.equal(await pathExists(report.outputPath ?? ""), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 verify blocks when dependencies are not installed", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-verify-no-deps-", {
    packageJson: {
      packageManager: "pnpm@9.0.0"
    }
  });
  try {
    await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      execute: true
    });

    const report = await verifyBootstrapMd2Target(fixture.loaded, {
      targetRoot: fixture.targetRoot,
      pnpmCommand: `${process.execPath} -e "console.log('9.0.0')"`
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.checks.some((check) => check.name === "node-modules" && check.status === "blocked"));
    assert.match(report.checks.find((check) => check.name === "node-modules")?.message ?? "", /install required/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 verify captures baseline, run, and compare when install is ready", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-verify-ready-", {
    packageJson: {
      packageManager: "pnpm@9.0.0"
    },
    checks: [],
    probes: []
  });
  try {
    await writeFile(path.join(fixture.sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      execute: true
    });
    await mkdir(path.join(fixture.targetRoot, "node_modules"), { recursive: true });

    const report = await verifyBootstrapMd2Target(fixture.loaded, {
      targetRoot: fixture.targetRoot,
      pnpmCommand: `${process.execPath} -e "console.log('9.0.0')"`
    });

    assert.equal(report.status, "passed");
    assert.equal(report.summary.ready, true);
    assert.equal(report.summary.differenceCount, 0);
    assert.equal(await pathExists(report.baselineSnapshotPath ?? ""), true);
    assert.equal(await pathExists(report.runSnapshotPath ?? ""), true);
    assert.equal(await pathExists(report.compareReportPath ?? ""), true);
    assert.ok(report.checks.some((check) => check.name === "bootstrap-compare" && check.status === "passed"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap md2 verify can compare source baseline to target run", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-verify-source-target-", {
    packageJson: {
      packageManager: "pnpm@9.0.0"
    },
    checks: [],
    probes: []
  });
  try {
    await writeFile(path.join(fixture.sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      execute: true
    });
    await mkdir(path.join(fixture.targetRoot, "node_modules"), { recursive: true });

    const report = await verifyBootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      pnpmCommand: `${process.execPath} -e "console.log('9.0.0')"`
    });

    assert.equal(report.status, "passed");
    assert.equal(report.compareMode, "source-to-target");
    assert.equal(report.sourceRoot, fixture.sourceRoot);
    assert.equal(await pathExists(report.baselineSnapshotPath ?? ""), true);
    assert.equal(await pathExists(report.runSnapshotPath ?? ""), true);
    assert.ok(report.checks.some((check) => check.name === "bootstrap-compare" && /Source baseline/.test(check.message)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bootstrap CLI verify does not re-import when target already has bootstrap files", async () => {
  const fixture = await createBootstrapFixture("migration-guard-bootstrap-cli-verify-dirty-", {
    packageJson: {
      packageManager: "pnpm@9.0.0"
    }
  });
  try {
    await bootstrapMd2Target(fixture.loaded, {
      sourceRoot: fixture.sourceRoot,
      targetRoot: fixture.targetRoot,
      execute: true
    });

    const result = await runShellCommand([
      quoteShellArg(process.execPath),
      quoteShellArg(path.resolve("dist", "cli.js")),
      "issue-control",
      "bootstrap",
      "--config",
      quoteShellArg(fixture.configPath),
      "--verify",
      "--skip-issue-auto",
      "--json"
    ].join(" "), {
      cwd: path.resolve("."),
      timeoutMs: 30000,
      maxOutputBytes: 100000
    });

    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must be clean/);
    const parsed = JSON.parse(result.stdout) as {
      manifest?: BootstrapMd2Manifest;
      verify: BootstrapMd2VerifyReport;
    };
    assert.equal(parsed.manifest, undefined);
    assert.equal(parsed.verify.status, "blocked");
    assert.ok(parsed.verify.checks.some((check) => check.name === "node-modules" && check.status === "blocked"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createBootstrapFixture(prefix: string): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  configPath: string;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
}>;
async function createBootstrapFixture(prefix: string, options: {
  packageJson?: Record<string, unknown>;
  checks?: unknown[];
  probes?: unknown[];
}): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  configPath: string;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
}>;
async function createBootstrapFixture(prefix: string, options?: {
  packageJson?: Record<string, unknown>;
  checks?: unknown[];
  probes?: unknown[];
}): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  configPath: string;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceRoot = path.join(root, "md");
  const targetRoot = path.join(root, "md2");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await mkdir(path.join(sourceRoot, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(sourceRoot, ".git"), { recursive: true });
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify(options?.packageJson ?? {}), "utf8");
  await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(sourceRoot, ".env"), "SECRET=1\n", "utf8");
  await writeFile(path.join(sourceRoot, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
  await mkdir(targetRoot, { recursive: true });
  await runShellCommand("git init", {
    cwd: targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: 100000
  });
  const configPath = path.join(root, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    targetRoot,
    artifactsDir: ".migration-guard",
    checks: options?.checks,
    probes: options?.probes,
    variables: {
      MG_SOURCE_ROOT: sourceRoot
    }
  }), "utf8");
  const loaded = await loadConfig(configPath);
  return {
    root,
    sourceRoot,
    targetRoot,
    configPath,
    loaded
  };
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}
