import assert from "node:assert/strict";
import test from "node:test";
import { VMP_REPLAY_BEHAVIORS, buildVmpEvidenceBundle, checkVmpReadiness, replayVmpCases, sanitizeVmpFixture, type VmpReplayCase } from "./vmpReplay.js";

function cases(): VmpReplayCase[] {
  return VMP_REPLAY_BEHAVIORS.map((behavior) => ({ id: behavior, behavior, request: { pageId: behavior }, expectedStatus: 200 }));
}

const observation = (id: number, snapshotHash = "snapshot-1", tenantId = "tenant-1") => ({
  response: { status: 200, body: { data: [{ id }] } },
  snapshotHash,
  context: { tenantId, userId: "user-1" }
});

test("VMP-05 readiness blocks until both services, databases, token and seven cases exist", () => {
  const blocked = checkVmpReadiness({ oldService: true, newService: false, oldDatabase: true, newDatabase: true, token: false, cases: [] });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes("new-service-unavailable"));
  const ready = checkVmpReadiness({ oldService: true, newService: true, oldDatabase: true, newDatabase: true, token: true, cases: cases() });
  assert.equal(ready.ready, true);
  assert.equal(ready.caseCount, 7);
});

test("VMP-06 replays old and new endpoints independently and compares each case", async () => {
  const execute = async (request: Record<string, unknown>) => ({
    response: { status: 200, body: { request, data: [{ id: 1 }] } },
    snapshotHash: "snapshot-1",
    context: { tenantId: "tenant-1", userId: "user-1" }
  });
  const results = await replayVmpCases(cases(), execute, execute);
  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result.compare?.passed));
  assert.ok(results.every((result) => result.requestHash.length === 64));
});

test("VMP-07 fixtures redact secrets recursively", () => {
  const sanitized = sanitizeVmpFixture({ headers: { Authorization: "Bearer secret", Cookie: "sid=x" }, user: { phone: "13800000000" }, data: [{ value: 1 }] });
  assert.deepEqual(sanitized, { headers: { Authorization: "<redacted>", Cookie: "<redacted>" }, user: { phone: "<redacted>" }, data: [{ value: 1 }] });
});

test("VMP-08 evidence bundle fails closed on readiness or replay differences", async () => {
  const readiness = checkVmpReadiness({ oldService: true, newService: true, oldDatabase: true, newDatabase: true, token: true, cases: cases() });
  const results = await replayVmpCases(cases(), async () => observation(1), async () => observation(2));
  const evidence = buildVmpEvidenceBundle(readiness, results);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.blockers.includes("旧链/新链存在未分类差异"));
});

test("VMP-08 fails closed on snapshot or tenant-context mismatch", async () => {
  const readiness = checkVmpReadiness({ oldService: true, newService: true, oldDatabase: true, newDatabase: true, token: true, cases: cases() });
  const snapshotResults = await replayVmpCases(cases(), async () => observation(1, "old"), async () => observation(1, "new"));
  assert.ok(buildVmpEvidenceBundle(readiness, snapshotResults).blockers.includes("旧链/新链快照不一致"));
  const contextResults = await replayVmpCases(cases(), async () => observation(1, "same", "old-tenant"), async () => observation(1, "same", "new-tenant"));
  assert.ok(buildVmpEvidenceBundle(readiness, contextResults).blockers.includes("旧链/新链租户或用户上下文不一致"));
});

test("VMP-08 accepts a fully classified response difference with matching evidence", async () => {
  const readiness = checkVmpReadiness({ oldService: true, newService: true, oldDatabase: true, newDatabase: true, token: true, cases: cases() });
  const results = await replayVmpCases(cases(), async () => observation(1), async () => observation(2));
  const decisions = results.flatMap((result) => result.compare?.differences.map((difference) => ({
    caseId: result.caseId,
    path: difference.path,
    classification: "accepted-equivalent" as const,
    reason: "Reviewed fixture-only representation difference."
  })) ?? []);
  assert.equal(buildVmpEvidenceBundle(readiness, results, decisions).passed, true);
});

test("VMP-05 rejects duplicate ids and sensitive fixture fields", () => {
  const invalidCases = cases();
  invalidCases[1] = { ...invalidCases[1], id: invalidCases[0].id, request: { token: "must-not-be-stored" } };
  const report = checkVmpReadiness({ oldService: true, newService: true, oldDatabase: true, newDatabase: true, token: true, cases: invalidCases });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("用例包含敏感字段:")));
});
