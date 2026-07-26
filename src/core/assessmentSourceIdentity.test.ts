import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureAssessmentSourceIdentity, normalizeAssessmentGitStatus } from "./assessmentSourceIdentity.js";

test("assessment source identity excludes generated artifacts and normalizes status ordering", () => {
  const before = " M pom.xml\r\n?? docs/note.md\r\n";
  const after = "?? zboss-module-data/.migration-guard/mg-205/report.json\n?? docs/note.md\n M pom.xml\n";
  assert.equal(normalizeAssessmentGitStatus(after), normalizeAssessmentGitStatus(before));
});

test("assessment source identity changes when dirty file content changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "migration-guard-source-identity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "migration-guard@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Migration Guard"], { cwd: root });
  await writeFile(path.join(root, "source.txt"), "baseline\n", "utf8");
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });

  await writeFile(path.join(root, "source.txt"), "first change\n", "utf8");
  const first = await captureAssessmentSourceIdentity(root);
  await writeFile(path.join(root, "source.txt"), "second change\n", "utf8");
  const second = await captureAssessmentSourceIdentity(root);

  assert.equal(first.revision, second.revision);
  assert.equal(first.dirty, true);
  assert.equal(second.dirty, true);
  assert.notEqual(first.dirtyFingerprint, second.dirtyFingerprint);
  assert.notEqual(first.identity, second.identity);
});

test("assessment source identity hashes untracked file content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "migration-guard-untracked-identity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "migration-guard@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Migration Guard"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "baseline\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });

  await writeFile(path.join(root, "new.txt"), "first\n", "utf8");
  const first = await captureAssessmentSourceIdentity(root);
  await writeFile(path.join(root, "new.txt"), "second\n", "utf8");
  const second = await captureAssessmentSourceIdentity(root);

  assert.notEqual(first.dirtyFingerprint, second.dirtyFingerprint);
});
