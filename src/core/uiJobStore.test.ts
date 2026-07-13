import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { claimUiJob, readUiJob, releaseUiJobClaim, uiJobPath, writeUiJob } from "./uiJobStore.js";

test("UI job claims are exclusive and releasable", async () => {
  const { dir, loaded } = await fixture();
  try {
    await writeUiJob(loaded, job("claim-job"));
    assert.equal(await claimUiJob(loaded, "claim-job"), true);
    assert.equal(await claimUiJob(loaded, "claim-job"), false);
    await releaseUiJobClaim(loaded, "claim-job");
    assert.equal(await claimUiJob(loaded, "claim-job"), true);
    await releaseUiJobClaim(loaded, "claim-job");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UI job store rejects future schema versions", async () => {
  const { dir, loaded } = await fixture();
  try {
    await mkdir(path.dirname(uiJobPath(loaded, "future-job")), { recursive: true });
    await writeFile(uiJobPath(loaded, "future-job"), JSON.stringify({ ...job("future-job"), version: 2 }));
    await assert.rejects(readUiJob(loaded, "future-job"), /Unsupported UI job schema version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-job-store-"));
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targetRoot: ".", artifactsDir: ".migration-guard" }));
  return { dir, loaded: await loadConfig(configPath) };
}

function job(id: string) {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    version: 1 as const,
    id,
    ownerPid: process.pid,
    action: "readiness" as const,
    status: "queued" as const,
    createdAt: now,
    updatedAt: now,
    params: { run: "latest" },
    artifactPaths: [],
    events: [{ at: now, type: "queued" as const, message: "queued" }]
  };
}