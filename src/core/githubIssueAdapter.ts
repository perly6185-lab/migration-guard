import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface GitHubIssueInput {
  title: string;
  body: string;
  labels: string[];
  state?: "open" | "closed";
}

export interface GitHubIssueAdapterOptions {
  repo: string;
  token: string;
  issues: GitHubIssueInput[];
  fetchImpl?: typeof fetch;
  onPlan?: (plan: GitHubIssueLivePlan) => void | Promise<void>;
  maxLiveMutations?: number;
  livePlanConfirm?: string;
  retry?: GitHubRetryOptions;
}

export interface GitHubIssueSyncResult {
  repo: string;
  createdCount: number;
  updatedCount: number;
  closedCount: number;
  reopenedCount: number;
  skippedCount: number;
  failedCount: number;
  plan: GitHubIssueLivePlan;
  rateLimit: GitHubRateLimitSnapshot[];
  issues: Array<{
    title: string;
    action?: "created" | "updated" | "closed" | "reopened" | "skipped" | "failed";
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

export interface GitHubIssueReadOptions {
  repo: string;
  token?: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  fetchImpl?: typeof fetch;
  retry?: GitHubRetryOptions;
}

export interface GitHubIssueReadResult {
  repo: string;
  state: "open" | "closed" | "all";
  labels: string[];
  rateLimit: GitHubRateLimitSnapshot[];
  issues: GitHubIssueRemote[];
}

export interface GitHubIssueRemote {
  number: number;
  title: string;
  body: string;
  htmlUrl?: string;
  state: "open" | "closed";
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  bodyHash: string;
}

export interface GitHubIssueLivePlan {
  provider: "github";
  repo: string;
  matchingStrategy: "open-issue-body-mg_issue_id" | "all-issues-body-mg_issue_id";
  createdAt: string;
  willCreate: number;
  willUpdate: number;
  willClose: number;
  willReopen: number;
  willSkip: number;
  mutationCount: number;
  planHash: string;
  maxLiveMutations?: number;
  rateLimit?: GitHubRateLimitSnapshot[];
  issues: GitHubIssueLivePlanItem[];
}

export interface GitHubIssueLivePlanItem {
  issueId?: string;
  title: string;
  action: "create" | "update" | "close" | "reopen" | "skip";
  desiredState?: "open" | "closed";
  bodyHash: string;
  existingBodyHash?: string;
  existingNumber?: number;
  existingUrl?: string;
  existingState?: "open" | "closed";
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
  const lookup = await findExistingGitHubIssues(options.repo, options.token, fetchImpl, gitHubLookupState(options.issues), options.retry);
  const plan = createGitHubIssueLivePlan(options.repo, options.issues, lookup.issues, lookup.matchingStrategy, undefined, lookup.rateLimit);
  return {
    repo: options.repo,
    plan,
    rateLimit: lookup.rateLimit
  };
}

export async function readGitHubIssues(options: GitHubIssueReadOptions): Promise<GitHubIssueReadResult> {
  validateGitHubRepo(options.repo);
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = options.state ?? "open";
  const labels = options.labels ?? [];
  const params = new URLSearchParams({
    state,
    per_page: "100"
  });
  if (labels.length > 0) {
    params.set("labels", labels.join(","));
  }
  const api = await fetchGitHubWithRetry(fetchImpl, `https://api.github.com/repos/${options.repo}/issues?${params.toString()}`, {
    method: "GET",
    headers: githubHeaders(options.token)
  }, options.retry, "GET issues");
  const response = api.response;
  if (!response.ok) {
    throw new Error(`GitHub issue read failed: GitHub API returned ${response.status}`);
  }
  const body = await response.json().catch(() => []);
  const issues = Array.isArray(body)
    ? body
      .filter((issue) => !issue?.pull_request)
      .filter((issue) => typeof issue?.number === "number" && typeof issue?.title === "string")
      .map((issue): GitHubIssueRemote => {
        const issueBody = typeof issue?.body === "string" ? issue.body : "";
        return {
          number: issue.number,
          title: issue.title,
          body: issueBody,
          htmlUrl: typeof issue?.html_url === "string" ? issue.html_url : undefined,
          state: issue?.state === "closed" ? "closed" : "open",
          labels: normalizeGitHubLabels(issue?.labels),
          createdAt: typeof issue?.created_at === "string" ? issue.created_at : undefined,
          updatedAt: typeof issue?.updated_at === "string" ? issue.updated_at : undefined,
          author: typeof issue?.user?.login === "string" ? issue.user.login : undefined,
          bodyHash: sha256(issueBody)
        };
      })
    : [];
  return {
    repo: options.repo,
    state,
    labels,
    rateLimit: api.rateLimit,
    issues
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
  const lookup = await findExistingGitHubIssues(options.repo, options.token, fetchImpl, gitHubLookupState(options.issues), options.retry);
  const rateLimit = [...lookup.rateLimit];
  const maxLiveMutations = options.maxLiveMutations ?? DEFAULT_MAX_LIVE_MUTATIONS;
  const plan = createGitHubIssueLivePlan(options.repo, options.issues, lookup.issues, lookup.matchingStrategy, maxLiveMutations, rateLimit);
  await options.onPlan?.(plan);
  if (options.livePlanConfirm !== undefined && options.livePlanConfirm !== plan.planHash) {
    throw new Error(`GitHub live plan confirmation mismatch. Expected --live-plan-confirm ${plan.planHash}.`);
  }
  if (plan.mutationCount > maxLiveMutations) {
    throw new Error(`GitHub live mutation limit exceeded: plan has ${plan.mutationCount} create/update/close/reopen mutation(s), max is ${maxLiveMutations}. Review issue-sync/github-live-plan.json or pass --max-live-mutations <n>.`);
  }

  for (let index = 0; index < options.issues.length; index += 1) {
    const issue = options.issues[index];
    const planItem = plan.issues[index];
    const existing = planItem?.existingNumber
      ? { number: planItem.existingNumber, htmlUrl: planItem.existingUrl, bodyHash: planItem.existingBodyHash, state: planItem.existingState }
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
      const desiredState = planItem?.action === "close"
        ? "closed"
        : planItem?.action === "reopen"
          ? "open"
          : undefined;
      const api = await fetchGitHubWithRetry(fetchImpl, url, {
        method: existing ? "PATCH" : "POST",
        headers: githubHeaders(options.token),
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          state: desiredState
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
        action: planItem?.action === "close"
          ? "closed"
          : planItem?.action === "reopen"
            ? "reopened"
            : existing ? "updated" : "created",
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
    closedCount: issues.filter((issue) => issue.action === "closed").length,
    reopenedCount: issues.filter((issue) => issue.action === "reopened").length,
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
  state: "open" | "closed";
}

async function findExistingGitHubIssues(
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  state: "open" | "all",
  retry?: GitHubRetryOptions
): Promise<{ issues: Map<string, ExistingGitHubIssue>; matchingStrategy: GitHubIssueLivePlan["matchingStrategy"]; rateLimit: GitHubRateLimitSnapshot[] }> {
  const api = await fetchGitHubWithRetry(fetchImpl, `https://api.github.com/repos/${repo}/issues?state=${state}&per_page=100`, {
    method: "GET",
    headers: githubHeaders(token)
  }, retry, state === "all" ? "GET all issues" : "GET open issues");
  const response = api.response;
  if (!response.ok) {
    throw new Error(`GitHub open issue lookup failed: GitHub API returned ${response.status}`);
  }
  const body = await response.json().catch(() => []);
  if (!Array.isArray(body)) {
    return {
      issues: new Map(),
      matchingStrategy: state === "all" ? "all-issues-body-mg_issue_id" : "open-issue-body-mg_issue_id",
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
        bodyHash: sha256(issue.body),
        state: issue?.state === "closed" ? "closed" : "open"
      });
    }
  }
  return {
    issues: existing,
    matchingStrategy: state === "all" ? "all-issues-body-mg_issue_id" : "open-issue-body-mg_issue_id",
    rateLimit: api.rateLimit
  };
}

function createGitHubIssueLivePlan(
  repo: string,
  issues: GitHubIssueInput[],
  existingIssues: Map<string, ExistingGitHubIssue>,
  matchingStrategy: GitHubIssueLivePlan["matchingStrategy"],
  maxLiveMutations?: number,
  rateLimit?: GitHubRateLimitSnapshot[]
): GitHubIssueLivePlan {
  const planned = issues.map((issue): GitHubIssueLivePlanItem => {
    const issueId = extractMigrationIssueId(issue.body);
    const bodyHash = sha256(issue.body);
    const existing = issueId ? existingIssues.get(issueId) : undefined;
    const desiredState = issue.state ?? "open";
    const action = planGitHubIssueAction(existing, bodyHash, desiredState);
    return {
      issueId,
      title: issue.title,
      action,
      desiredState,
      bodyHash,
      existingBodyHash: existing?.bodyHash,
      existingNumber: existing?.number,
      existingUrl: existing?.htmlUrl,
      existingState: existing?.state
    };
  });
  const willCreate = planned.filter((issue) => issue.action === "create").length;
  const willUpdate = planned.filter((issue) => issue.action === "update").length;
  const willClose = planned.filter((issue) => issue.action === "close").length;
  const willReopen = planned.filter((issue) => issue.action === "reopen").length;
  const willSkip = planned.filter((issue) => issue.action === "skip").length;
  const planHash = hashGitHubIssueLivePlan({
    provider: "github",
    repo,
    matchingStrategy,
    willCreate,
    willUpdate,
    willClose,
    willReopen,
    willSkip,
    mutationCount: willCreate + willUpdate + willClose + willReopen,
    issues: planned
  });

  return {
    provider: "github",
    repo,
    matchingStrategy,
    createdAt: new Date().toISOString(),
    willCreate,
    willUpdate,
    willClose,
    willReopen,
    willSkip,
    mutationCount: willCreate + willUpdate + willClose + willReopen,
    planHash,
    maxLiveMutations,
    rateLimit,
    issues: planned
  };
}

function gitHubLookupState(issues: GitHubIssueInput[]): "open" | "all" {
  return issues.some((issue) => issue.state) ? "all" : "open";
}

function planGitHubIssueAction(
  existing: ExistingGitHubIssue | undefined,
  bodyHash: string,
  desiredState: "open" | "closed"
): GitHubIssueLivePlanItem["action"] {
  if (!existing) {
    return desiredState === "closed" ? "skip" : "create";
  }
  if (desiredState === "closed" && existing.state === "open") {
    return "close";
  }
  if (desiredState === "open" && existing.state === "closed") {
    return "reopen";
  }
  return existing.bodyHash === bodyHash ? "skip" : "update";
}

function hashGitHubIssueLivePlan(plan: Omit<GitHubIssueLivePlan, "createdAt" | "planHash" | "maxLiveMutations" | "rateLimit">): string {
  return sha256(stableStringify(plan));
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

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "accept": "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "migration-guard"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function extractMigrationIssueId(body: string): string | undefined {
  return body.match(/^mg_issue_id:\s*(.+)$/m)?.[1]?.trim();
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === "string") {
        return label;
      }
      if (typeof label?.name === "string") {
        return label.name;
      }
      return undefined;
    })
    .filter((label): label is string => Boolean(label));
}
