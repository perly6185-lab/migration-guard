import assert from "node:assert/strict";
import test from "node:test";
import type { IssueControlSuperviseProgressLedger } from "./issueControl.js";
import {
  createIssueControlSyncGateCommand,
  resolveIssueControlSyncGateRunId,
  summarizeIssueControlSyncGate
} from "./issueControl/syncGatePolicy.js";

function ledger(items: IssueControlSuperviseProgressLedger["items"]): IssueControlSuperviseProgressLedger {
  return {
    version: 1,
    id: "ledger-1",
    createdAt: "2026-07-18T00:00:00.000Z",
    provider: "github",
    repo: "owner/repo",
    sourceSuperviseId: "supervise-1",
    mode: "execute",
    status: "complete",
    trustTier: "supervised",
    riskBudget: 3,
    items,
    summary: {
      issueCount: items.length,
      selectedCount: items.filter((item) => item.selected).length,
      reachedCount: items.length,
      unreachedSelectedCount: items.filter((item) => item.selected && !item.reached).length,
      recoveredCount: items.filter((item) => item.state === "recovered").length,
      continuedCount: items.filter((item) => item.state === "continued").length,
      unresolvedCount: items.filter((item) => item.state === "failed" || item.state === "blocked").length
    }
  };
}

test("sync gate policy classifies unique completed, unresolved and pending issues", () => {
  const report = summarizeIssueControlSyncGate(ledger([
    progressItem("issue-1", "verified", true, "run-1"),
    progressItem("issue-1", "continued", true, "run-1"),
    progressItem("issue-2", "failed", true, "run-2"),
    progressItem("issue-3", "selected", true),
    progressItem("issue-4", "skipped", false)
  ]));
  assert.deepEqual(report, {
    completedIssueIds: ["issue-1"],
    unresolvedIssueIds: ["issue-2"],
    pendingIssueIds: ["issue-3"]
  });
});

test("sync gate policy resolves run precedence and renders a reviewed command", () => {
  const source = ledger([progressItem("issue-1", "verified", true, "run-ledger")]);
  assert.deepEqual(resolveIssueControlSyncGateRunId("run-option", source), { runId: "run-option", source: "option" });
  assert.deepEqual(resolveIssueControlSyncGateRunId(undefined, source), { runId: "run-ledger", source: "ledger" });
  assert.equal(
    createIssueControlSyncGateCommand("run with space", ["ready", "team:a"], ["issue-1"]),
    'node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run "run with space" --provider github --live-plan --labels ready,team:a --only-issue issue-1'
  );
});

function progressItem(
  issueId: string,
  state: IssueControlSuperviseProgressLedger["items"][number]["state"],
  selected: boolean,
  runId?: string
): IssueControlSuperviseProgressLedger["items"][number] {
  return {
    issueNumber: Number(issueId.replace(/\D/g, "")),
    issueId,
    runId,
    title: issueId,
    action: "execute-task",
    selected,
    reached: state !== "selected" && state !== "skipped",
    state,
    reason: state,
    artifactPaths: [],
    events: []
  };
}
