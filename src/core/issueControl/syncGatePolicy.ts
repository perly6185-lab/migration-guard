import type {
  IssueControlSuperviseProgressLedger,
  IssueControlSyncGateReport
} from "../issueControl.js";

export interface IssueControlSyncGateSummary {
  completedIssueIds: string[];
  unresolvedIssueIds: string[];
  pendingIssueIds: string[];
}

export function summarizeIssueControlSyncGate(
  ledger: IssueControlSuperviseProgressLedger
): IssueControlSyncGateSummary {
  const completedIssueIds = uniqueStrings(ledger.items
    .filter(isIssueControlSyncCompletedItem)
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  const unresolvedIssueIds = uniqueStrings(ledger.items
    .filter((item) => item.state === "failed" || item.state === "blocked")
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  const pendingIssueIds = uniqueStrings(ledger.items
    .filter((item) => item.selected
      && !isIssueControlSyncCompletedItem(item)
      && item.state !== "failed"
      && item.state !== "blocked")
    .map((item) => item.issueId)
    .filter((issueId): issueId is string => Boolean(issueId)));
  return { completedIssueIds, unresolvedIssueIds, pendingIssueIds };
}

export function resolveIssueControlSyncGateRunId(
  runId: string | undefined,
  ledger: IssueControlSuperviseProgressLedger
): { runId: string; source: IssueControlSyncGateReport["runIdSource"] } {
  if (runId) {
    return { runId, source: "option" };
  }
  const ledgerRunId = ledger.items
    .map((item) => item.runId)
    .find((candidate) => candidate && !candidate.startsWith("<"));
  if (ledgerRunId) {
    return { runId: ledgerRunId, source: "ledger" };
  }
  return { runId: "latest", source: "latest-fallback" };
}

export function createIssueControlSyncGateCommand(
  runId: string,
  labels: string[],
  completedIssueIds: string[]
): string {
  const parts = [
    "node",
    "dist/cli.js",
    "sync-issues",
    "--config",
    "configs/md2-fast.migration-guard.json",
    "--run",
    runId,
    "--provider",
    "github",
    "--live-plan"
  ];
  if (labels.length > 0) {
    parts.push("--labels", labels.join(","));
  }
  if (completedIssueIds.length === 1) {
    parts.push("--only-issue", completedIssueIds[0]);
  }
  return parts.map(shellToken).join(" ");
}

function isIssueControlSyncCompletedItem(
  item: IssueControlSuperviseProgressLedger["items"][number]
): boolean {
  return item.selected && ["executed", "verified", "recovered", "continued"].includes(item.state);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(value) ? value : JSON.stringify(value);
}
