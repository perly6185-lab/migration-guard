import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectVmpCodeContract } from "./vmpContract.js";

test("VMP public code contract is statically recognizable", async () => {
  const report = await inspectVmpCodeContract(process.cwd());
  assert.equal(report.passed, true, JSON.stringify(report.files.filter((file) => file.missing.length), null, 2));
});

test("VMP code contract fails closed when modules are absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migration-guard-vmp-contract-"));
  const report = await inspectVmpCodeContract(root);
  assert.equal(report.passed, false);
  assert.ok(report.files.every((file) => file.missing.length > 0));
});
