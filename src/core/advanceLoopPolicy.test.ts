import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueControlAdvanceLoopRepeatGuard,
  createIssueControlAdvanceLoopSchedulerDecision,
  createIssueControlAdvanceLoopStateNextAction
} from "./issueControl/advanceLoopPolicy.js";
import type { IssueControlAdvanceLoopReport, IssueControlAdvanceLoopState } from "./issueControl.js";

function loopReport(status: IssueControlAdvanceLoopReport["status"], stopReason: string): IssueControlAdvanceLoopReport {
  return {
    version: 1,
    id: "loop-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "execute",
    maxSteps: 2,
    status,
    stopReason,
    steps: []
  };
}

function loopState(overrides: Partial<IssueControlAdvanceLoopState> = {}): IssueControlAdvanceLoopState {
  return {
    version: 1,
    id: "issue-control-advance-loop-state",
    updatedAt: "2026-01-01T00:00:00.000Z",
    mode: "execute",
    maxSteps: 2,
    status: "complete",
    stopReason: "Reached max steps 2.",
    lastLoopId: "loop-1",
    repeatedTerminalCount: 0,
    repeatGuardActive: false,
    nextAction: "continue",
    ...overrides
  };
}

test("advance loop policy blocks repeated failed ledger execution", () => {
  const previous = loopState({ status: "failed", sourceLedgerPath: "ledger.json", repeatedTerminalCount: 1 });
  const guard = createIssueControlAdvanceLoopRepeatGuard(previous, "ledger.json", { execute: true });
  assert.equal(guard.triggered, true);
  assert.equal(guard.repeatedTerminalCount, 2);
});

test("advance loop policy allows bounded unattended continuation only with a green envelope", () => {
  const blocked = createIssueControlAdvanceLoopSchedulerDecision(loopState({
    trustTier: "unattended",
    safetyEnvelope: { passed: false, trustTier: "unattended", checks: [{ id: "clean-target", passed: false, reason: "dirty" }] }
  }));
  assert.equal(blocked.action, "run-advance-loop");
  assert.equal(blocked.canRunUnattended, false);
  assert.match(blocked.reason, /clean-target/);

  const allowed = createIssueControlAdvanceLoopSchedulerDecision(loopState({
    trustTier: "unattended",
    safetyEnvelope: { passed: true, trustTier: "unattended", checks: [] }
  }));
  assert.equal(allowed.canRunUnattended, true);
  assert.match(allowed.nextCommand ?? "", /--max-steps 2/);
});

test("advance loop policy selects stable next actions", () => {
  assert.match(createIssueControlAdvanceLoopStateNextAction(loopReport("planned", "planned"), 0), /Review/);
  assert.match(createIssueControlAdvanceLoopStateNextAction(loopReport("complete", "Reached max steps 2."), 0), /continue unattended/);
  assert.match(createIssueControlAdvanceLoopStateNextAction(loopReport("blocked", "blocked"), 2), /Repeat guard/);
});
