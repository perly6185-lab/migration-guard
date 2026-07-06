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
  maxLiveMutations?: number;
  retry?: GitHubRetryOptions;
}

export interface GitHubIssueSyncResult {
  repo: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  plan: GitHubIssueLivePlan;
  rateLimit: GitHubRateLimitSnapshot[];
  issues: Array<{
    title: string;
    action?: "created" | "updated" | "skipped" | "failed";
    url?: string;
    number?: number;
    bodyHash?: string;
    attemptCount?: number;
    error?: string;
  }>;
}

export interface GitHubIssuePlanOptions {
  repo: string;
  token: string;
  issues: GitHubIssueInput[];
  fetchImpl?: typeof fetch;
  retry?: GitHubRetryOptions;
}

export interface GitHubIssuePlanResult {
  repo: string;
  plan: GitHubIssueLivePlan;
  rateLimit: GitHubRateLimitSnapshot[];
}

export interface GitHubIssueLivePlan {
  provider: "github";
  repo: string;
  matchingStrategy: "open-issue-body-mg_issue_id";
  createdAt: string;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  mutationCount: number;
  maxLiveMutations?: number;
  rateLimit?: GitHubRateLimitSnapshot[];
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

export interface GitHubRateLimitSnapshot {
  request: string;
  status: number;
  attempt: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  used?: number;
  resource?: string;
}

export interface GitHubRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

const DEFAULT_MAX_LIVE_MUTATIONS = 3;
const DEFAULT_RETRY_OPTIONS: Required<GitHubRetryOptions> = {
  maxAttempts: 3,
  delayMs: 250
};

export function validateGitHubRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repo "${repo}". Expected owner/name.`);
  }
}

export async function planGitHubIssues(options: GitHubIssuePlanOptions): Promise<GitHubIssuePlanResult> {
  validateGitHubRepo(options.repo);
  if (!options.token) {
    throw new Error("GITHUB_TOKEN is required for GitHub live issue sync.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = await findExistingGitHubIssues(options.repo, options.token, fetchImpl, options.retry);
  const plan = createGitHubIssueLivePlan(options.repo, options.issues, lookup.issues, undefined, lookup.rateLimit);
  return {
    repo: options.repo,
    plan,
    rateLimit: lookup.rateLimit
  };
}

export async function createGitHubIssues(options: GitHubIssueAdapterOptions): Promise<GitHubIssueSyncResult> {
  validateGitHubRepo(options.repo);
  if (!options.token) {
    throw new Error("GITHUB_TOKEN is required for GitHub live issue sync.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const issues: GitHubIssueSyncResult["issues"] = [];
  const createUrl = `https://api.github.com/repos/${options.repo}/issues`;
  const lookup = await findExistingGitHubIssues(options.repo, options.token, fetchImpl, options.retry);
  const rateLimit = [...lookup.rateLimit];
  const maxLiveMutations = options.maxLiveMutations ?? DEFAULT_MAX_LIVE_MUTATIONS;
  const plan = createGitHubIssueLivePlan(options.repo, options.issues, lookup.issues, maxLiveMutations, rateLimit);
  await options.onPlan?.(plan);
  if (plan.mutationCount > maxLiveMutations) {
    throw new Error(`GitHub live mutation limit exceeded: plan has ${plan.mutationCount} create/update mutation(s), max is ${maxLiveMutations}. Review issue-sync/github-live-plan.json or pass --max-live-mutations <n>.`);
  }

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
      const requestLabel = existing ? "PATCH issue" : "POST issue";
      const api = await fetchGitHubWithRetry(fetchImpl, url, {
        method: existing ? "PATCH" : "POST",
        headers: githubHeaders(options.token),
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: issue.labels
        })
      }, options.retry, requestLabel);
      rateLimit.push(...api.rateLimit);
      const response = api.response;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        issues.push({
          title: issue.title,
          action: "failed",
          bodyHash: planItem?.bodyHash,
          attemptCount: api.attemptCount,
          error: typeof body?.message === "string" ? body.message : `GitHub API returned ${response.status}`
        });
        continue;
      }
      issues.push({
        title: issue.title,
        action: existing ? "updated" : "created",
        url: typeof body?.html_url === "string" ? body.html_url : undefined,
        number: typeof body?.number === "number" ? body.number : undefined,
        bodyHash: planItem?.bodyHash,
        attemptCount: api.attemptCount
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
    rateLimit,
    issues
  };
}

interface ExistingGitHubIssue {
  number: number;
  htmlUrl?: string;
  bodyHash: string;
}

async function findExistingGitHubIssues(
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  retry?: GitHubRetryOptions
): Promise<{ issues: Map<string, ExistingGitHubIssue>; rateLimit: GitHubRateLimitSnapshot[] }> {
  const api = await fetchGitHubWithRetry(fetchImpl, `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
    method: "GET",
    headers: githubHeaders(token)
  }, retry, "GET open issues");
  const response = api.response;
  if (!response.ok) {
    throw new Error(`GitHub open issue lookup failed: GitHub API returned ${response.status}`);
  }
  const body = await response.json().catch(() => []);
  if (!Array.isArray(body)) {
    return {
      issues: new Map(),
      rateLimit: api.rateLimit
    };
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
  return {
    issues: existing,
    rateLimit: api.rateLimit
  };
}

function createGitHubIssueLivePlan(
  repo: string,
  issues: GitHubIssueInput[],
  existingIssues: Map<string, ExistingGitHubIssue>,
  maxLiveMutations?: number,
  rateLimit?: GitHubRateLimitSnapshot[]
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
  const willCreate = planned.filter((issue) => issue.action === "create").length;
  const willUpdate = planned.filter((issue) => issue.action === "update").length;
  const willSkip = planned.filter((issue) => issue.action === "skip").length;

  return {
    provider: "github",
    repo,
    matchingStrategy: "open-issue-body-mg_issue_id",
    createdAt: new Date().toISOString(),
    willCreate,
    willUpdate,
    willSkip,
    mutationCount: willCreate + willUpdate,
    maxLiveMutations,
    rateLimit,
    issues: planned
  };
}

async function fetchGitHubWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  retry: GitHubRetryOptions | undefined,
  requestLabel: string
): Promise<{ response: Response; rateLimit: GitHubRateLimitSnapshot[]; attemptCount: number }> {
  const policy = {
    maxAttempts: retry?.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts,
    delayMs: retry?.delayMs ?? DEFAULT_RETRY_OPTIONS.delayMs
  };
  const rateLimit: GitHubRateLimitSnapshot[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      rateLimit.push(readRateLimit(response, requestLabel, attempt));
      if (!shouldRetry(response.status) || attempt === policy.maxAttempts) {
        return {
          response,
          rateLimit,
          attemptCount: attempt
        };
      }
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts) {
        throw error;
      }
    }
    await delay(policy.delayMs);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function readRateLimit(response: Response, request: string, attempt: number): GitHubRateLimitSnapshot {
  const reset = readHeaderNumber(response, "x-ratelimit-reset");
  return {
    request,
    status: response.status,
    attempt,
    limit: readHeaderNumber(response, "x-ratelimit-limit"),
    remaining: readHeaderNumber(response, "x-ratelimit-remaining"),
    resetAt: typeof reset === "number" ? new Date(reset * 1000).toISOString() : undefined,
    used: readHeaderNumber(response, "x-ratelimit-used"),
    resource: response.headers.get("x-ratelimit-resource") ?? undefined
  };
}

function readHeaderNumber(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
