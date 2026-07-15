import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { listBuiltinPolicies, resolvePolicy } from "./policy.js";

test("builtin policy hashes are stable and distinct", () => {
  const first = listBuiltinPolicies();
  const second = listBuiltinPolicies();
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((item) => item.hash)).size, 3);
});

test("policy overrides can tighten but cannot loosen preset boundaries", async () => {
  const resolved = await resolvePolicy({ preset: "conservative-migration", overrides: { maxChangedFiles: 2, maxCommands: 99, allowGithubMutation: true, allowTargetEdit: false } }, process.cwd());
  assert.equal(resolved.policy.maxChangedFiles, 2);
  assert.equal(resolved.policy.maxCommands, 4);
  assert.equal(resolved.policy.allowGithubMutation, false);
  assert.equal(resolved.policy.allowTargetEdit, false);
  assert.equal(resolved.findings.length, 2);
});

test("local policy presets work offline and cannot escape the config directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-policy-"));
  try {
    await writeFile(path.join(root, "team-policy.json"), JSON.stringify({ maxChangedFiles: 5, maxCommands: 5, artifactRetentionRuns: 10, requireStrictHealth: true, allowTargetEdit: true, allowGithubMutation: false, allowReleaseMutation: false }));
    const resolved = await resolvePolicy({ preset: "team-policy.json" }, root);
    assert.equal(resolved.policy.maxChangedFiles, 5);
    assert.match(resolved.source, /team-policy\.json$/);
    await assert.rejects(resolvePolicy({ preset: "../outside.json" }, root), /inside the config directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
