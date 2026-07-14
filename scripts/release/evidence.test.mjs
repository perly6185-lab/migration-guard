import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  createReleaseRunId,
  describeArtifact,
  getGitState,
  readCoreArtifactPayload,
  sha256,
  verifyArtifactDescriptor,
  writeJsonAtomic
} from "./evidence.mjs";

test("release run ids are timestamped and unique", () => {
  const now = new Date("2026-07-14T01:02:03.456Z");
  const first = createReleaseRunId(now);
  const second = createReleaseRunId(now);
  assert.match(first, /^release-2026-07-14T01-02-03-456Z-[a-f0-9]{8}$/);
  assert.notEqual(first, second);
});

test("artifact descriptors reject changed evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-release-evidence-"));
  try {
    const filePath = path.join(temp, "artifact.json");
    await writeFile(filePath, "{\"passed\":true}\n", "utf8");
    const descriptor = await describeArtifact(filePath, temp);
    assert.equal((await verifyArtifactDescriptor(descriptor, temp)).valid, true);
    await writeFile(filePath, "{\"passed\":false}\n", "utf8");
    const verification = await verifyArtifactDescriptor(descriptor, temp);
    assert.equal(verification.valid, false);
    assert.match(verification.reason, /hash mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("release evidence reads v2 core payloads and validates their hash", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-release-v2-"));
  try {
    const filePath = path.join(temp, "snapshot.json");
    const payload = { id: "baseline", version: 1 };
    await writeJsonAtomic(filePath, { artifactSchemaVersion: 2, kind: "snapshot", migratedAt: "2026-07-14T00:00:00.000Z", sourceVersion: 1, payloadHash: sha256(JSON.stringify({ id: "baseline", version: 1 })), metadata: {}, payload });
    assert.deepEqual(await readCoreArtifactPayload(filePath, "snapshot"), payload);
    await writeJsonAtomic(filePath, { artifactSchemaVersion: 2, kind: "snapshot", migratedAt: "2026-07-14T00:00:00.000Z", sourceVersion: 1, payloadHash: "invalid", metadata: {}, payload });
    await assert.rejects(() => readCoreArtifactPayload(filePath, "snapshot"), /payload hash mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("git dirty fingerprints change when tracked content changes", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-release-git-"));
  try {
    await run("git", ["init"], temp);
    await run("git", ["config", "user.email", "release-test@example.com"], temp);
    await run("git", ["config", "user.name", "Release Test"], temp);
    const filePath = path.join(temp, "tracked.txt");
    await writeFile(filePath, "first\n", "utf8");
    await run("git", ["add", "tracked.txt"], temp);
    await run("git", ["commit", "-m", "fixture"], temp);
    await writeFile(filePath, "second\n", "utf8");
    const first = await getGitState(temp);
    await writeFile(filePath, "third\n", "utf8");
    const second = await getGitState(temp);
    assert.equal(first.dirty, true);
    assert.equal(second.dirty, true);
    assert.notEqual(first.dirtyHash, second.dirtyHash);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pilot report rejects a release run without current pilot evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-pilot-report-"));
  try {
    const scriptPath = path.resolve("scripts/smoke/rc-feedback-report.mjs");
    const result = await run(process.execPath, [scriptPath, "--release-run", "release-test"], temp);
    assert.equal(result.code, 1);
    const reportPath = path.join(temp, ".migration-guard", "releases", "release-test", "pilot-report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.go, false);
    assert.equal(report.metrics.executedProjects, 0);
    assert.ok(report.projects.every((project) => project.status === "skipped"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("pilot report rejects a pilot result changed after smoke", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-pilot-tamper-"));
  try {
    const releaseRunId = "release-tamper";
    const resultPath = path.join(temp, ".migration-guard", "releases", releaseRunId, "pilot-results", "ascllcreator.json");
    await writeJsonAtomic(resultPath, { version: 1, releaseRunId, project: "ascllcreator", status: "skipped", reason: "fixture" });
    const evidence = await describeArtifact(resultPath, temp);
    await writeJsonAtomic(path.join(temp, ".migration-guard", "releases", releaseRunId, "pilot-smoke.json"), {
      version: 1,
      releaseRunId,
      results: [{ project: "ascllcreator", status: "skipped", evidence }]
    });
    await writeJsonAtomic(resultPath, { version: 1, releaseRunId, project: "ascllcreator", status: "passed" });
    const scriptPath = path.resolve("scripts/smoke/rc-feedback-report.mjs");
    const result = await run(process.execPath, [scriptPath, "--release-run", releaseRunId], temp);
    assert.equal(result.code, 1);
    const report = JSON.parse(await readFile(path.join(temp, ".migration-guard", "releases", releaseRunId, "pilot-report.json"), "utf8"));
    assert.equal(report.projects[0].status, "stale");
    assert.match(report.projects[0].reason, /hash mismatch/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: Number(code ?? 1), stdout, stderr }));
  });
}
