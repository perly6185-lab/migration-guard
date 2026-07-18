import type { LoadedConfig } from "../../types.js";
import { validateGitHubRepo } from "../githubIssueAdapter.js";

export function resolveIssueControlGitHubRepo(loaded: LoadedConfig, repo?: string): string {
  const resolved = repo ?? loaded.config.issueSync?.githubRepo;
  if (!resolved) throw new Error("GitHub issue-control requires --repo owner/name or config issueSync.githubRepo.");
  validateGitHubRepo(resolved);
  return resolved;
}
