import type { MigrationIssueType } from "../types.js";
import type { GitHubIssueRemote } from "./githubIssueAdapter.js";
import type { IssueControlMetadata, IssueControlPlanItem, IssueControlRemoteIssue } from "./issueControl.js";

export function toIssueControlRemoteIssue(issue: GitHubIssueRemote): IssueControlRemoteIssue {
  return { ...issue, migrationGuard: parseIssueControlMetadata(issue) };
}

export function parseIssueControlMetadata(issue: Pick<GitHubIssueRemote, "title" | "body" | "labels">): IssueControlMetadata {
  return {
    runId: field(issue.body, "mg_run_id"),
    issueId: field(issue.body, "mg_issue_id"),
    taskId: field(issue.body, "mg_task_id"),
    issueType: issueType(field(issue.body, "mg_issue_type") ?? labelValue(issue.labels, "mg-type")),
    status: field(issue.body, "mg_status") ?? labelValue(issue.labels, "status"),
    risk: risk(field(issue.body, "mg_risk") ?? labelValue(issue.labels, "mg-risk")),
    owner: owner(field(issue.body, "mg_owner") ?? labelValue(issue.labels, "owner")),
    proposalId: proposalId(issue.title, issue.body)
  };
}

export function toIssueControlPlanItem(issue: IssueControlRemoteIssue): IssueControlPlanItem {
  const metadata = issue.migrationGuard;
  const base = {
    issueNumber: issue.number, title: issue.title, url: issue.htmlUrl, issueId: metadata.issueId,
    runId: metadata.runId, taskId: metadata.taskId, issueType: metadata.issueType,
    status: metadata.status, risk: metadata.risk, labels: issue.labels
  };
  const commandRun = metadata.runId ? ` --run ${metadata.runId}` : " --run <run-id>";
  if (!metadata.issueId) return { ...base, action: "review-external", executable: false, reason: "Issue has no mg_issue_id; keep it out of automated Migration Guard execution." };
  if (isBootstrapIssue(issue)) return { ...base, action: "bootstrap-target", executable: true, reason: "Target bootstrap issue; run the bounded md -> md2 bootstrap/import lane before normal refactor checks.", recommendedCommand: "node dist/cli.js issue-control bootstrap --config configs/md2-fast.migration-guard.json --execute --verify --labels team:migration" };
  if (metadata.issueType === "failure") {
    const proposal = metadata.proposalId ?? "<failed-proposal-id>";
    return { ...base, action: "repair-proposal", executable: true, reason: "Failure issue can enter the proposal repair loop.", recommendedCommand: `node dist/cli.js proposal repair --config configs/md2-fast.migration-guard.json${commandRun} --proposal ${proposal} --checks --accept` };
  }
  if (metadata.issueType === "risk" || metadata.issueType === "diff") return { ...base, action: "classify-risk", executable: false, reason: "Risk/diff issues need classification before source edits." };
  if (metadata.taskId && isReadyStatus(metadata.status)) return { ...base, action: "execute-task", executable: true, reason: "Ready Migration Guard task issue can be handed to the task executor.", recommendedCommand: `node dist/cli.js task run --config configs/md2-fast.migration-guard.json${commandRun} --task ${metadata.taskId}` };
  return { ...base, action: "track", executable: false, reason: "Issue is mapped to Migration Guard but is not ready for automated execution." };
}

export function proposalFromCommand(command?: string): string | undefined {
  return command?.match(/--proposal\s+(\S+)/)?.[1]?.replace(/^<|>$/g, "");
}

function field(body: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]?.trim();
}
function labelValue(labels: string[], prefix: string): string | undefined { return labels.find((label) => label.startsWith(`${prefix}:`))?.slice(prefix.length + 1).trim(); }
function issueType(value?: string): MigrationIssueType | undefined { return value && ["epic", "phase", "task", "risk", "diff", "failure"].includes(value) ? value as MigrationIssueType : undefined; }
function risk(value?: string): "low" | "medium" | "high" | undefined { return value && ["low", "medium", "high"].includes(value) ? value as "low" | "medium" | "high" : undefined; }
function owner(value?: string): "engine" | "ai" | "human" | undefined { return value && ["engine", "ai", "human"].includes(value) ? value as "engine" | "ai" | "human" : undefined; }
function proposalId(title: string, body: string): string | undefined { return title.match(/^Proposal gate failed:\s*(\S+)/)?.[1] ?? body.match(/\bproposal(?:Id| id)?:?\s*`?([A-Za-z0-9_.-]+)`?/i)?.[1]; }
function isReadyStatus(status?: string): boolean { return Boolean(status && ["ready", "running", "replanned"].includes(status)); }
function isBootstrapIssue(issue: IssueControlRemoteIssue): boolean {
  const title = issue.title.toLowerCase();
  const labels = issue.labels.map((label) => label.toLowerCase());
  const taskId = issue.migrationGuard.taskId?.toLowerCase() ?? "";
  const issueId = issue.migrationGuard.issueId?.toLowerCase() ?? "";
  return labels.some((label) => ["bootstrap", "mg-bootstrap", "type:bootstrap", "mg-type:bootstrap"].includes(label)) || taskId.includes("bootstrap") || issueId.includes("bootstrap") || /\bbootstrap\b/.test(title) || /\binitial import\b/.test(title);
}
