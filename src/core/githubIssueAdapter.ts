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
}

export interface GitHubIssueSyncResult {
  repo: string;
  createdCount: number;
  failedCount: number;
  issues: Array<{
    title: string;
    url?: string;
    number?: number;
    error?: string;
  }>;
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
  const url = `https://api.github.com/repos/${options.repo}/issues`;

  for (const issue of options.issues) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${options.token}`,
          "content-type": "application/json",
          "user-agent": "migration-guard"
        },
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
          error: typeof body?.message === "string" ? body.message : `GitHub API returned ${response.status}`
        });
        continue;
      }
      issues.push({
        title: issue.title,
        url: typeof body?.html_url === "string" ? body.html_url : undefined,
        number: typeof body?.number === "number" ? body.number : undefined
      });
    } catch (error) {
      issues.push({
        title: issue.title,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    repo: options.repo,
    createdCount: issues.filter((issue) => issue.url).length,
    failedCount: issues.filter((issue) => issue.error).length,
    issues
  };
}
