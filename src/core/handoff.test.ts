import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHandoffContract, explainHandoffContract, redactHandoffContract, referenceHandoffArtifact, validateHandoffContract, writeHandoffContract } from "./handoff.js";

test("handoff contract writes portable renderings and verifies evidence hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-handoff-"));
  try {
    const evidencePath = path.join(root, "evidence.json");
    await writeFile(evidencePath, "{\"passed\":true}\n");
    const contract = await createHandoffContract({
      id: "handoff-test", createdAt: "2026-07-15T00:00:00.000Z", goal: "Refactor safely",
      task: { id: "task-1", title: "Extract helper", description: "Bounded edit", source: "task" },
      permissions: { granted: ["target-edit"], denied: ["github-mutation", "release-mutation"] },
      scope: { root, allowedPaths: ["src/helper.ts"], maxChangedFiles: 1 },
      forbiddenActions: ["push commits"], evidence: [await referenceHandoffArtifact(root, evidencePath, "verification")],
      suggestedCommands: ["npm test"], acceptanceCriteria: ["tests pass"], budget: { maxChangedFiles: 1, maxCommands: 1 },
      lineage: { runId: "run-1", taskId: "task-1" }
    });
    const written = await writeHandoffContract(root, contract, path.join(root, "handoffs"));
    assert.equal((await validateHandoffContract(written)).valid, true);
    assert.match(await readFile(written.output!.markdownPath, "utf8"), /## Permissions/);
    assert.match(await readFile(written.output!.promptPath, "utf8"), /Edit only: src\/helper.ts/);
    assert.equal(explainHandoffContract(written).allowedPathCount, 1);
    await writeFile(evidencePath, "tampered\n");
    assert.deepEqual((await validateHandoffContract(written)).errors, ["Evidence hash mismatch: evidence.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("handoff contract rejects unsafe paths and redacts secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-handoff-redact-"));
  try {
    await assert.rejects(createHandoffContract({
      goal: "Unsafe", task: { id: "task", title: "Task", description: "", source: "task" },
      permissions: { granted: ["target-edit"], denied: [] }, scope: { root, allowedPaths: ["../outside"], maxChangedFiles: 1 },
      forbiddenActions: [], evidence: [], suggestedCommands: [], acceptanceCriteria: [], budget: { maxChangedFiles: 1, maxCommands: 0 }, lineage: {}
    }), /Unsafe allowed path/);
    const contract = await createHandoffContract({
      goal: "Use token=secret-value safely", task: { id: "task", title: "Task", description: "Authorization: Bearer abc123", source: "task" },
      permissions: { granted: ["read-only"], denied: ["github-mutation"] }, scope: { root, allowedPaths: [], maxChangedFiles: 0 },
      forbiddenActions: [], evidence: [], suggestedCommands: ["tool --api-key=topsecret"], acceptanceCriteria: [], budget: { maxChangedFiles: 0, maxCommands: 1 }, lineage: {}
    });
    const redacted = redactHandoffContract(contract);
    assert.doesNotMatch(JSON.stringify(redacted), /secret-value|abc123|topsecret/);
    assert.equal((await validateHandoffContract(redacted, { verifyEvidence: false })).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
