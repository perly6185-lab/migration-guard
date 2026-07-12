import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpoint, rollbackToCheckpoint } from "./checkpoint.js";
import { loadConfig } from "./config.js";
import { saveRunPackage, type MigrationRunPackage } from "./migrationRun.js";

const execFileAsync = promisify(execFile);

test("checkpoint records git metadata and force rollback resets a later commit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-checkpoint-reset-"));
  try {
    const repo = await setupGitRepo(dir);
    const loaded = await loadCheckpointConfig(dir);
    const pkg = createCheckpointRunPackage(dir, repo, "run-checkpoint-reset");
    await saveRunPackage(loaded, pkg);

    const checkpoint = await createCheckpoint(loaded, pkg, undefined, "before later commit");
    assert.match(checkpoint.gitHead ?? "", /^[a-f0-9]{40}$/);
    assert.equal(checkpoint.gitStatusFingerprint?.length, 64);
    assert.deepEqual(checkpoint.untrackedFiles, []);
    assert.equal(checkpoint.sideEffects?.nodeModules?.exists, false);

    await writeFile(path.join(repo, "src.txt"), "later\n", "utf8");
    await git(repo, "add", "src.txt");
    await git(repo, "-c", "user.name=Migration Guard", "-c", "user.email=guard@example.test", "commit", "-m", "later");

    await assert.rejects(
      rollbackToCheckpoint(loaded, pkg, checkpoint.id),
      /checkpoint HEAD .* differs from current HEAD/
    );
    const message = await rollbackToCheckpoint(loaded, pkg, checkpoint.id, { force: true });

    assert.match(message, /Rolled back checkpoint/);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "src.txt"), "utf8")), "base\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollback precheck blocks new untracked files before reset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-checkpoint-untracked-"));
  try {
    const repo = await setupGitRepo(dir);
    const loaded = await loadCheckpointConfig(dir);
    const pkg = createCheckpointRunPackage(dir, repo, "run-checkpoint-untracked");
    await saveRunPackage(loaded, pkg);
    const checkpoint = await createCheckpoint(loaded, pkg, undefined, "clean");

    await writeFile(path.join(repo, "new-file.txt"), "untracked\n", "utf8");

    await assert.rejects(
      rollbackToCheckpoint(loaded, pkg, checkpoint.id),
      /new untracked files are outside checkpoint state: new-file\.txt/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reset rollback restores tracked dirty state captured by checkpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-checkpoint-dirty-"));
  try {
    const repo = await setupGitRepo(dir);
    const loaded = await loadCheckpointConfig(dir);
    const pkg = createCheckpointRunPackage(dir, repo, "run-checkpoint-dirty");
    await saveRunPackage(loaded, pkg);

    await writeFile(path.join(repo, "src.txt"), "checkpoint dirty\n", "utf8");
    const checkpoint = await createCheckpoint(loaded, pkg, undefined, "dirty checkpoint");
    await writeFile(path.join(repo, "src.txt"), "later dirty\n", "utf8");

    await rollbackToCheckpoint(loaded, pkg, checkpoint.id);

    assert.equal(normalizeNewlines(await readFile(path.join(repo, "src.txt"), "utf8")), "checkpoint dirty\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setupGitRepo(dir: string): Promise<string> {
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await writeFile(path.join(repo, "src.txt"), "base\n", "utf8");
  await git(repo, "add", "src.txt");
  await git(repo, "-c", "user.name=Migration Guard", "-c", "user.email=guard@example.test", "commit", "-m", "base");
  return repo;
}

async function loadCheckpointConfig(dir: string) {
  const configPath = path.join(dir, ".migration-guard.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    targetRoot: "repo",
    artifactsDir: ".migration-guard"
  }), "utf8");
  return loadConfig(configPath);
}

function createCheckpointRunPackage(dir: string, repo: string, runId: string): MigrationRunPackage {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    run: {
      version: 1,
      id: runId,
      goal: "checkpoint safety",
      sourceRoot: path.join(dir, "source"),
      targetRoot: repo,
      artifactsDir: path.join(dir, ".migration-guard", "migration-runs", runId),
      status: "running",
      mode: "manual",
      issueProvider: "local",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 1,
        testFiles: 0,
        taskCount: 0,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    },
    graph: {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: []
    },
    issues: []
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
