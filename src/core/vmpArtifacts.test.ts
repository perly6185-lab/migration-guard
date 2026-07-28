import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadVmpFixtureCases, readVmpEvidenceEnvelope, writeVmpEvidenceEnvelope } from "./vmpArtifacts.js";
import { VMP_REPLAY_BEHAVIORS, buildVmpEvidenceBundle, checkVmpReadiness } from "./vmpReplay.js";

test("fixture loader requires seven valid, secret-free behavior cases", async () => {
  const cases = await loadVmpFixtureCases(path.resolve("fixtures/vmp/offline-cases.json"));
  assert.equal(cases.length, 7);
  assert.deepEqual(new Set(cases.map((item) => item.behavior)), new Set(VMP_REPLAY_BEHAVIORS));
});

test("evidence envelope detects persisted bundle tampering", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-guard-vmp-"));
  const file = path.join(dir, "evidence.json");
  const cases = await loadVmpFixtureCases(path.resolve("fixtures/vmp/offline-cases.json"));
  const readiness = checkVmpReadiness({
    oldService: false,
    newService: false,
    oldDatabase: false,
    newDatabase: false,
    token: false,
    cases
  });
  const bundle = buildVmpEvidenceBundle(readiness, []);
  await writeVmpEvidenceEnvelope(file, bundle);
  assert.deepEqual((await readVmpEvidenceEnvelope(file)).bundle, bundle);
  const tampered = JSON.parse(await fs.readFile(file, "utf8"));
  tampered.bundle.passed = true;
  await fs.writeFile(file, JSON.stringify(tampered), "utf8");
  await assert.rejects(() => readVmpEvidenceEnvelope(file), /integrity hash mismatch/);
});
