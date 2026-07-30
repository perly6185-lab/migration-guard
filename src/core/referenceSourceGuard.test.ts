import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertReferenceSourceSnapshotUnchanged,
  captureReferenceSourceSnapshot
} from "./referenceSourceGuard.js";

test("reference source snapshot detects ignored source changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-reference-guard-"));
  try {
    const sourceDir = path.join(root, "src", "main", "java");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "src/main/java/generated.java\n", "utf8");
    await writeFile(path.join(sourceDir, "App.java"), "class App {}\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "migration-guard@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Migration Guard"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });

    const before = await captureReferenceSourceSnapshot(root, ["src/main/java"]);
    await writeFile(path.join(sourceDir, "generated.java"), "class Generated {}\n", "utf8");

    await assert.rejects(
      assertReferenceSourceSnapshotUnchanged(before, "test-operation"),
      /MG-SOURCE-READ-ONLY-VIOLATION:test-operation/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference source snapshot rejects directories outside the reference root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-reference-path-"));
  try {
    await assert.rejects(
      captureReferenceSourceSnapshot(root, ["../other"]),
      /MG-SOURCE-DIRECTORY-UNSAFE/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
