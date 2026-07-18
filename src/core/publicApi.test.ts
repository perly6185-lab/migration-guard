import assert from "node:assert/strict";
import test from "node:test";
import * as issueControl from "./issueControl.js";
import * as patch from "./patch.js";

test("issue-control runtime public API remains stable during module split", () => {
  assert.deepEqual(Object.keys(issueControl).sort(), [
    "advanceIssueControl", "advanceIssueControlLoop", "advanceIssueControlScheduler", "autoIssueControl",
    "collectIssueControlPlan", "issueControlAdvanceLoopStatus", "issueControlProgressStatus", "issueControlSyncGate",
    "loadIssueControlPlanReport", "loadIssueControlPullReport", "loadIssueControlSuperviseProgressLedger",
    "pullIssueControl", "renderIssueControlAdvance", "renderIssueControlAdvanceLoop", "renderIssueControlAdvanceLoopState",
    "renderIssueControlAdvanceScheduler", "renderIssueControlAuto", "renderIssueControlPlan", "renderIssueControlProgressStatus",
    "renderIssueControlPull", "renderIssueControlRun", "renderIssueControlSupervise", "renderIssueControlSuperviseProgressLedger",
    "renderIssueControlSyncGate", "runIssueControlPlan", "superviseIssueControl", "writeIssueControlPlan"
  ].sort());
});

test("proposal runtime public API remains stable during module split", () => {
  assert.deepEqual(Object.keys(patch).sort(), [
    "acceptProposalRepair", "applyProposalBatch", "applyProposedPatch", "createAddFilePatch", "createProposalBatchPlan",
    "createProposalRetry", "excludeProposal", "getProposalStatus", "listProposals", "proposeActionPatch", "proposePatch",
    "renderProposalBatchPlan", "renderProposalBatchReport", "renderProposalList", "renderProposalRepairAcceptanceReport",
    "renderProposalRollbackReport", "renderProposalStatus", "renderProposalVerificationReport", "repairProposal",
    "replanProposal", "rollbackProposedPatch", "verifyProposedPatch"
  ].sort());
});
