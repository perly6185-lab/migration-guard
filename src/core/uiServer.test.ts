import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { saveRunPackage, type MigrationRunPackage } from "./migrationRun.js";
import { startUiServer } from "./uiServer.js";

test("ui server exposes read-only dashboard data and guarded dry-run actions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-ui-"));
  const targetRoot = path.join(dir, "target");
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }), "utf8");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: "target",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/migration-guard"
      }
    }), "utf8");

    const loaded = await loadConfig(configPath);
    await saveRunPackage(loaded, createUiRunPackage(dir, targetRoot));
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4999"
      }
    });
    const handle = await startUiServer(loaded, { port: 0, fetchImpl });
    try {
      const html = await (await fetch(`${handle.url}/`)).text();
      assert.match(html, /Migration Guard/);
      assert.match(html, /Guarded Actions/);

      const dashboard = await fetchJson<{ runId: string; summary: { readyTaskCount: number } }>(`${handle.url}/api/dashboard`);
      assert.equal(dashboard.runId, "run-ui");
      assert.equal(dashboard.summary.readyTaskCount, 1);

      const runs = await fetchJson<{ runCount: number; runs: Array<{ runId: string }> }>(`${handle.url}/api/runs`);
      assert.equal(runs.runCount, 1);
      assert.equal(runs.runs[0]?.runId, "run-ui");

      const readiness = await postJson<{ status: string }>(`${handle.url}/api/actions/readiness`);
      assert.ok(["go", "hold", "blocked"].includes(readiness.status));

      const dryRun = await postJson<{ mode: string; summary: { issueCount: number } }>(
        `${handle.url}/api/actions/issue-control-dry-run`
      );
      assert.equal(dryRun.mode, "dry-run");
      assert.equal(dryRun.summary.issueCount, 0);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json() as T;
}

async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json() as T;
}

function createUiRunPackage(dir: string, targetRoot: string): MigrationRunPackage {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    run: {
      version: 1,
      id: "run-ui",
      goal: "serve local board",
      sourceRoot: path.join(dir, "source"),
      targetRoot,
      artifactsDir: path.join(dir, ".migration-guard", "migration-runs", "run-ui"),
      status: "running",
      mode: "manual",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 1,
        testFiles: 1,
        taskCount: 1,
        riskLevel: "low",
        confidence: "medium",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    },
    graph: {
      version: 1,
      runId: "run-ui",
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-ui",
        title: "Expose local board",
        description: "Serve read-only board data.",
        type: "code-change",
        status: "ready",
        priority: 10,
        risk: "low",
        owner: "engine",
        dependsOn: [],
        affectedFiles: ["src/core/uiServer.ts"],
        verificationCommands: ["npm test"],
        acceptanceCriteria: ["dashboard endpoint responds"],
        issueId: "issue-ui",
        createdAt: now,
        updatedAt: now
      }]
    },
    issues: [{
      id: "issue-ui",
      runId: "run-ui",
      taskId: "task-ui",
      type: "task",
      title: "Expose local board",
      body: "Serve read-only board data.",
      status: "ready",
      risk: "low",
      owner: "engine",
      affectedFiles: ["src/core/uiServer.ts"],
      createdAt: now,
      updatedAt: now
    }]
  };
}
