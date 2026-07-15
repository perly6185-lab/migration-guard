import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { claimUiJob, heartbeatUiJobClaim, inspectUiJobClaim, readUiJob, releaseUiJobClaim, uiJobPath, writeUiJob } from "./uiJobStore.js";

test("UI job claims are exclusive and releasable", async () => {
  const { dir, loaded } = await fixture();
  try {
    await writeUiJob(loaded, job("claim-job"));
    const stored = JSON.parse(await readFile(uiJobPath(loaded, "claim-job"), "utf8"));
    assert.equal(stored.artifactSchemaVersion, 2);
    assert.equal(stored.kind, "ui-job");
    assert.equal(stored.metadata.action, "readiness");
    assert.equal((await readUiJob(loaded, "claim-job")).id, "claim-job");
    const claim = await claimUiJob(loaded, "claim-job", "fingerprint");
    assert.ok(claim);
    assert.equal(await claimUiJob(loaded, "claim-job", "fingerprint"), undefined);
    const inspection = await inspectUiJobClaim(loaded, "claim-job");
    assert.equal(inspection.claimed, true);
    assert.equal(inspection.expired, false);
    await heartbeatUiJobClaim(loaded, "claim-job", claim);
    await releaseUiJobClaim(loaded, "claim-job", claim);
    const nextClaim = await claimUiJob(loaded, "claim-job", "fingerprint");
    assert.ok(nextClaim);
    await releaseUiJobClaim(loaded, "claim-job", nextClaim);
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

test("stale fencing tokens cannot heartbeat or release a replacement claim", async () => {
  const { dir, loaded } = await fixture();
  try {
    await writeUiJob(loaded, job("fenced-job"));
    const stale = await claimUiJob(loaded, "fenced-job", "fingerprint");
    assert.ok(stale);
    const replacement = { ...stale, ownerId: "replacement-owner", fencingToken: "replacement-token" };
    await writeFile(`${uiJobPath(loaded, "fenced-job")}.claim`, `${JSON.stringify(replacement)}\n`);
    await assert.rejects(heartbeatUiJobClaim(loaded, "fenced-job", stale), /fencing token/);
    await assert.rejects(releaseUiJobClaim(loaded, "fenced-job", stale), /fencing token/);
    assert.equal((await inspectUiJobClaim(loaded, "fenced-job")).claim?.fencingToken, "replacement-token");
    await releaseUiJobClaim(loaded, "fenced-job");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UI job claim tolerates an artifacts directory removed during shutdown", async () => {
  const { dir, loaded } = await fixture();
  await writeUiJob(loaded, job("removed-job"));
  await rm(dir, { recursive: true, force: true });
  assert.equal(await claimUiJob(loaded, "removed-job", "fingerprint"), undefined);
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
