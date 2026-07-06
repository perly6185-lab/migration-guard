import { sha256 } from "./hash.js";

export interface GitHubIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface GitHubIssueAdapterOptions {
  repo: string;
  token: string;
  issues: GitHubIssueInput[];
  fetchImpl?: typeof fetch;
  onPlan?: (plan: GitHubIssueLivePlan) => void | Promise<void>;
}

export interface GitHubIssueSyncResult {
  repo: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  plan: GitHubIssueLivePlan;
  issues: Array<{
    title: string;
    action?: "created" | "updated" | "skipped" | "failed";
    url?: string;
    number?: number;
    bodyHash?: string;
    error?: string;
  }>;
}

export interface GitHubIssueLivePlan {
  provider: "github";
  repo: string;
  matchingStrategy: "open-issue-body-mg_issue_id";
  createdAt: string;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  issues: GitHubIssueLivePlanItem[];
}

export interface GitHubIssueLivePlanItem {
  issueId?: string;
  title: string;
  action: "create" | "update" | "skip";
  bodyHash: string;
  existingBodyHash?: string;
  existingNumber?: number;
  existingUrl?: string;
}

export function validateGitHubRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repo "${repo}". Expected owner/name.`);
  }
}

export async function createGitHubIssues(options: GitHubIssueAdapterOptions): Promise<GitHubIssueSyncResult> {
  validateGitHubRepo(options.repo);
  if (!options.token) {
    throw new Error("GITHUB_TOKEN is required for GitHub live issue sync.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const issues: GitHubIssueSyncResult["issues"] = [];
  const createUrl = `https://api.github.com/repos/${options.repo}/issues`;
  const existingIssues = await findExistingGitHubIssues(options.repo, options.token, fetchImpl);
  const plan = createGitHubIssueLivePlan(options.repo, options.issues, existingIssues);
  await options.onPlan?.(plan);

  for (let index = 0; index < options.issues.length; index += 1) {
    const issue = options.issues[index];
    const planItem = plan.issues[index];
    const existing = planItem?.existingNumber
      ? { number: planItem.existingNumber, htmlUrl: planItem.existingUrl, bodyHash: planItem.existingBodyHash }
      : undefined;
    if (planItem?.action === "skip") {
      issues.push({
        title: issue.title,
        action: "skipped",
        url: existing?.htmlUrl,
        number: existing?.number,
        bodyHash: planItem.bodyHash
      });
      continue;
    }
    const url = existing
      ? `https://api.github.com/repos/${options.repo}/issues/${existing.number}`
      : createUrl;
    try {
      const response = await fetchImpl(url, {
        method: existing ? "PATCH" : "POST",
        headers: githubHeaders(options.token),
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: issue.labels
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        issues.push({
          title: issue.title,
          action: "failed",
          error: typeof body?.message === "string" ? body.message : `GitHub API returned ${response.status}`
        });
        continue;
      }
      issues.push({
        title: issue.title,
        action: existing ? "updated" : "created",
        url: typeof body?.html_url === "string" ? body.html_url : undefined,
        number: typeof body?.number === "number" ? body.number : undefined,
        bodyHash: planItem?.bodyHash
      });
    } catch (error) {
      issues.push({
        title: issue.title,
        action: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    repo: options.repo,
    createdCount: issues.filter((issue) => issue.action === "created").length,
    updatedCount: issues.filter((issue) => issue.action === "updated").length,
    skippedCount: issues.filter((issue) => issue.action === "skipped").length,
    failedCount: issues.filter((issue) => issue.error).length,
    plan,
    issues
  };
}

interface ExistingGitHubIssue {
  number: number;
  htmlUrl?: string;
  bodyHash: string;
}

async function findExistingGitHubIssues(repo: string, token: string, fetchImpl: typeof fetch): Promise<Map<string, ExistingGitHubIssue>> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
    method: "GET",
    headers: githubHeaders(token)
  });
  if (!response.ok) {
    return new Map();
  }
  const body = await response.json().catch(() => []);
  if (!Array.isArray(body)) {
    return new Map();
  }
  const existing = new Map<string, ExistingGitHubIssue>();
  for (const issue of body) {
    const issueId = typeof issue?.body === "string" ? extractMigrationIssueId(issue.body) : undefined;
    if (issueId && typeof issue?.number === "number") {
      existing.set(issueId, {
        number: issue.number,
        htmlUrl: typeof issue?.html_url === "string" ? issue.html_url : undefined,
        bodyHash: sha256(issue.body)
      });
    }
  }
  return existing;
}

function createGitHubIssueLivePlan(
  repo: string,
  issues: GitHubIssueInput[],
  existingIssues: Map<string, ExistingGitHubIssue>
): GitHubIssueLivePlan {
  const planned = issues.map((issue): GitHubIssueLivePlanItem => {
    const issueId = extractMigrationIssueId(issue.body);
    const bodyHash = sha256(issue.body);
    const existing = issueId ? existingIssues.get(issueId) : undefined;
    const action = !existing
      ? "create"
      : existing.bodyHash === bodyHash
        ? "skip"
        : "update";
    return {
      issueId,
      title: issue.title,
      action,
      bodyHash,
      existingBodyHash: existing?.bodyHash,
      existingNumber: existing?.number,
      existingUrl: existing?.htmlUrl
    };
  });

  return {
    provider: "github",
    repo,
    matchingStrategy: "open-issue-body-mg_issue_id",
    createdAt: new Date().toISOString(),
    willCreate: planned.filter((issue) => issue.action === "create").length,
    willUpdate: planned.filter((issue) => issue.action === "update").length,
    willSkip: planned.filter((issue) => issue.action === "skip").length,
    issues: planned
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "migration-guard"
  };
}

function extractMigrationIssueId(body: string): string | undefined {
  return body.match(/^mg_issue_id:\s*(.+)$/m)?.[1]?.trim();
}
