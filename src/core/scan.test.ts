import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { scanProject } from "./scan.js";

test("scanProject reports workspace packages and cross-directory tests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-scan-workspace-"));
  try {
    await mkdir(path.join(dir, "packages", "shared", "src"), { recursive: true });
    await mkdir(path.join(dir, "packages", "shared", "test"), { recursive: true });
    await mkdir(path.join(dir, "apps", "web", "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "workspace", workspaces: ["packages/*", "apps/*"] }));
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(dir, "packages", "shared", "package.json"), JSON.stringify({ name: "@demo/shared", scripts: { test: "node test" } }));
    await writeFile(path.join(dir, "packages", "shared", "src", "format.ts"), "export const format = () => 'ok';\n");
    await writeFile(path.join(dir, "packages", "shared", "test", "format.test.ts"), "import '../src/format';\n");
    await writeFile(path.join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "@demo/web", dependencies: { "@demo/shared": "workspace:*" } }));
    await writeFile(path.join(dir, "apps", "web", "src", "main.ts"), "export const main = true;\n");
    const configPath = path.join(dir, ".migration-guard.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));

    const scan = await scanProject(await loadConfig(configPath));

    assert.equal(scan.packageManager, "pnpm");
    assert.equal(scan.sourceFiles, 3);
    assert.equal(scan.testFiles, 1);
    assert.equal(scan.packages?.find((pkg) => pkg.name === "@demo/shared")?.testFiles, 1);
    assert.deepEqual(scan.packages?.find((pkg) => pkg.name === "@demo/web")?.workspaceDependencies, ["@demo/shared"]);
    assert.equal(scan.riskFiles.some((file) => file.path.endsWith("format.ts") && file.reasons.includes("no nearby test detected")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});