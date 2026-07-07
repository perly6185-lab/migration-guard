#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const adapterPath = path.join(repoRoot, "dist", "core", "githubIssueAdapter.js");

if (!existsSync(adapterPath)) {
  console.error("dist/ is missing. Run `npm run build` before this smoke helper.");
  process.exit(1);
}

const { planGitHubIssues } = await import(pathToFileURL(adapterPath).href);

const issues = [{
  title: "Stable skip issue",
  body: [
    "---",
    "mg_issue_id: issue-stable-skip",
    "---",
    "",
    "Body that should match the existing GitHub issue.",
    ""
  ].join("\n"),
  labels: ["migration-guard", "team:smoke"]
}, {
  title: "Stable create issue",
  body: [
    "---",
    "mg_issue_id: issue-stable-create",
    "---",
    "",
    "Body for a missing GitHub issue.",
    ""
  ].join("\n"),
  labels: ["migration-guard", "team:smoke"]
}];

let requestCount = 0;
const mockFetch = async (input, init) => {
  requestCount += 1;
  const method = init?.method ?? "GET";
  if (method !== "GET" || !String(input).includes("?state=open")) {
    throw new Error(`Unexpected network mutation attempt: ${method} ${String(input)}`);
  }
  return new Response(JSON.stringify([{
    number: 42,
    html_url: "https://github.com/owner/repo/issues/42",
    body: issues[0].body
  }]), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": String(5000 - requestCount),
      "x-ratelimit-reset": String(1783312000 + requestCount)
    }
  });
};

const first = await planGitHubIssues({
  repo: "owner/repo",
  token: "mock-token",
  issues,
  fetchImpl: mockFetch
});
const second = await planGitHubIssues({
  repo: "owner/repo",
  token: "mock-token",
  issues,
  fetchImpl: mockFetch
});

if (first.plan.planHash !== second.plan.planHash) {
  console.error(JSON.stringify({
    passed: false,
    reason: "planHash changed between identical read-only plans",
    firstPlanHash: first.plan.planHash,
    secondPlanHash: second.plan.planHash
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  passed: true,
  requestCount,
  mutationRequests: 0,
  planHash: first.plan.planHash,
  mutationCount: first.plan.mutationCount,
  firstRateLimitRemaining: first.rateLimit[0]?.remaining,
  secondRateLimitRemaining: second.rateLimit[0]?.remaining
}, null, 2));
