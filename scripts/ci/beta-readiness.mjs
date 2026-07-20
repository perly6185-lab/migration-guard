import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.version, "0.3.0-beta.1");
const manifest = JSON.parse(await readFile(path.join(root, "scripts/ci/test-manifest.json"), "utf8"));
await runTests();
const checks = [
  await fileCheck("golden fixtures", "scripts/smoke/golden-path-smoke.mjs", ["single-typescript", "pnpm-workspace", "go-module", "python-package"]),
  await fileCheck("handoff contract", "src/core/handoff.test.ts", ["portable renderings", "redacts secrets"]),
  await fileCheck("result acceptance", "src/core/handoffResult.test.ts", ["applies with confirmation", "paths outside the handoff budget"]),
  await fileCheck("failure repair", "src/core/repairLoopCli.test.ts", ["repair loop replans, retries, verifies, and accepts"]),
  await fileCheck("worker fencing", "src/core/uiJobStore.test.ts", ["stale fencing tokens"]),
  await fileCheck("policy presets", "src/core/policy.test.ts", ["cannot loosen", "work offline"]),
  await fileCheck("method candidate and anchors", "src/core/methodExtraction.test.ts", ["rank safe cohesive ranges", "reject semantic drift"]),
  await fileCheck("method automation session", "src/core/methodExtractionSession.test.ts", ["pauses for exact confirmation", "required quality gate"]),
  await fileCheck("method quality evaluation", "src/core/methodExtractionQuality.test.ts", ["structural improvement", "not evaluated"]),
  await fileCheck("method real pilot", "scripts/smoke/method-extraction-real-pilot.mjs", ["at least three real-repository cases", "originalRepositoryUnchanged"]),
  { id: "test-suite", passed: true, evidence: `run-tests.mjs passed; minimumTests=${manifest.minimumTests}` }
];
for (const name of ["js-ts-monorepo", "go-service", "conservative-migration"]) checks.push(await fileCheck(`preset:${name}`, `configs/policies/${name}.json`, ["maxChangedFiles", "artifactRetentionRuns"]));
const compatibility = [
  { artifact: "AI handoff", current: "migration-guard.ai-handoff/v1", reads: ["v1"], writes: "v1" },
  { artifact: "AI result", current: "migration-guard.ai-result/v1", reads: ["v1"], writes: "external manifest" },
  { artifact: "snapshot", current: "core artifact/v2", reads: ["v1", "v2"], writes: "v2" },
  { artifact: "compare", current: "core artifact/v2", reads: ["v1", "v2"], writes: "v2" },
  { artifact: "UI job", current: "core artifact/v2", reads: ["v1", "v2"], writes: "v2" }
];
const passed = checks.every((item) => item.passed);
const core = { version: 1, packageVersion: pkg.version, status: passed ? "go" : "hold", checks, compatibility, safety: { remoteMutationDefault: "denied", publish: "manual", tag: "manual", forceRecovery: "CLI-only" }, nextAction: passed ? "Run the release gate from a clean checkout with all three real pilot roots configured." : "Fix failed beta readiness checks and rerun npm run beta:readiness." };
const report = { ...core, reportHash: createHash("sha256").update(JSON.stringify(core)).digest("hex"), createdAt: new Date().toISOString() };
const dir = path.join(root, ".migration-guard", "beta-readiness");
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(dir, "latest.md"), render(report));
console.log(`beta readiness: ${report.status}; ${checks.filter((item) => item.passed).length}/${checks.length} checks; ${report.reportHash}`);
if (!passed) process.exitCode = 1;

async function fileCheck(id, relative, needles) { const content = await readFile(path.join(root, relative), "utf8").catch(() => ""); const missing = needles.filter((needle) => !content.includes(needle)); return { id, passed: missing.length === 0, evidence: relative, ...(missing.length ? { missing } : {}) }; }
function render(report) { return [`# 0.3.0 Beta Readiness`, "", `- Status: ${report.status}`, `- Version: ${report.packageVersion}`, `- Report hash: ${report.reportHash}`, "", "## Checks", "", ...report.checks.map((item) => `- ${item.passed ? "passed" : "failed"}: ${item.id} (${item.evidence})`), "", "## Compatibility", "", "| Artifact | Current | Reads | Writes |", "| --- | --- | --- | --- |", ...report.compatibility.map((item) => `| ${item.artifact} | ${item.current} | ${item.reads.join(", ")} | ${item.writes} |`), "", `Next: ${report.nextAction}`, ""].join("\n"); }
function runTests() { return new Promise((resolve, reject) => { const child = spawn(process.execPath, ["scripts/ci/run-tests.mjs"], { cwd: root, stdio: "inherit", windowsHide: true }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`test suite failed with ${code}`))); }); }
