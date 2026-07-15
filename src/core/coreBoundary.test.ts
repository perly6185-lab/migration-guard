import test from "node:test";
import assert from "node:assert/strict";
import { createAddFilePatch, normalizePatchPath } from "./patchModel.js";
import { parseIssueControlMetadata, proposalFromCommand, toIssueControlPlanItem, toIssueControlRemoteIssue } from "./issueControlModel.js";

test("patch model preserves portable add-file patch output and path guards", () => {
  assert.equal(normalizePatchPath("src\\generated.ts"), "src/generated.ts");
  assert.match(createAddFilePatch("src/generated.ts", "export const value = 1;"), /@@ -0,0 \+1,1 @@\n\+export const value = 1;/);
  assert.throws(() => normalizePatchPath("../outside.ts"), /Unsafe patch path/);
});

test("issue-control model keeps body metadata precedence and failure routing", () => {
  const remote = toIssueControlRemoteIssue({
    number: 7,
    title: "Proposal gate failed: proposal-7",
    body: "mg_run_id: run-7\nmg_issue_id: issue-7\nmg_issue_type: failure\nmg_status: ready\nmg_risk: medium\nmg_owner: ai",
    bodyHash: "hash",
    htmlUrl: "https://example.test/issues/7",
    state: "open",
    labels: ["mg-risk:low", "owner:human"]
  });
  assert.deepEqual(parseIssueControlMetadata(remote), remote.migrationGuard);
  assert.equal(remote.migrationGuard.risk, "medium");
  assert.equal(remote.migrationGuard.owner, "ai");
  const plan = toIssueControlPlanItem(remote);
  assert.equal(plan.action, "repair-proposal");
  assert.equal(plan.executable, true);
  assert.equal(proposalFromCommand(plan.recommendedCommand), "proposal-7");
});

test("issue-control model keeps external issues outside automated execution", () => {
  const plan = toIssueControlPlanItem(toIssueControlRemoteIssue({
    number: 8,
    title: "External issue",
    body: "No Migration Guard metadata",
    bodyHash: "hash",
    state: "open",
    labels: []
  }));
  assert.equal(plan.action, "review-external");
  assert.equal(plan.executable, false);
});
