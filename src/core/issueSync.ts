import path from "node:path";
import { writeJsonFile, writeTextFile } from "./files.js";
import { appendEvidence, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type { LoadedConfig, MigrationIssue } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export async function syncIssues(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  provider: "local" | "github" | "gitlab" | "jira" | "linear",
  options: { dryRun?: boolean } = {}
): Promise<string> {
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "issue-sync");
  const exported = pkg.issues.map((issue) => serializeIssue(issue, provider));
  const outputPath = path.join(dir, `${provider}${options.dryRun ? "-dry-run" : ""}-issues.json`);
  await writeJsonFile(outputPath, exported);

  if (provider !== "local") {
    const markdownPath = path.join(dir, `${provider}${options.dryRun ? "-dry-run" : ""}-issues.md`);
    await writeTextFile(markdownPath, renderIssueSyncMarkdown(pkg.issues, provider));
    if (!options.dryRun) {
      for (const issue of pkg.issues) {
        issue.externalUrl = issue.externalUrl ?? `${provider}:pending:${issue.id}`;
        issue.updatedAt = new Date().toISOString();
      }
    }
  }

  if (!options.dryRun) {
    pkg.run.issueProvider = provider;
    await saveRunPackage(loaded, pkg);
  }
  await appendEvidence(loaded, pkg.run.id, {
    runId: pkg.run.id,
    type: "sync",
    message: `${options.dryRun ? "Dry-run exported" : "Exported"} ${pkg.issues.length} issues for provider ${provider}`,
    data: {
      outputPath
    }
  });
  return outputPath;
}

function serializeIssue(issue: MigrationIssue, provider: string): Record<string, unknown> {
  return {
    provider,
    title: issue.title,
    body: [
      "---",
      `mg_run_id: ${issue.runId}`,
      `mg_issue_id: ${issue.id}`,
      issue.taskId ? `mg_task_id: ${issue.taskId}` : undefined,
      `mg_issue_type: ${issue.type}`,
      `mg_status: ${issue.status}`,
      `mg_risk: ${issue.risk}`,
      `mg_owner: ${issue.owner}`,
      "---",
      "",
      issue.body,
      "",
      issue.affectedFiles.length > 0 ? `Affected files: ${issue.affectedFiles.join(", ")}` : "Affected files: none"
    ].filter(Boolean).join("\n"),
    labels: ["migration-guard", `mg-type:${issue.type}`, `mg-risk:${issue.risk}`],
    status: issue.status
  };
}

function renderIssueSyncMarkdown(issues: MigrationIssue[], provider: string): string {
  return [
    `# ${provider} Issue Sync Export`,
    "",
    "This file is a provider-neutral export. A later provider adapter can turn each entry into a real external issue.",
    "",
    ...issues.map((issue) => [
      `## ${issue.title}`,
      "",
      "```yaml",
      `mg_run_id: ${issue.runId}`,
      `mg_issue_id: ${issue.id}`,
      issue.taskId ? `mg_task_id: ${issue.taskId}` : undefined,
      `mg_issue_type: ${issue.type}`,
      `mg_status: ${issue.status}`,
      `mg_risk: ${issue.risk}`,
      `mg_owner: ${issue.owner}`,
      "```",
      "",
      issue.body,
      "",
      issue.affectedFiles.length > 0 ? `Affected files: ${issue.affectedFiles.join(", ")}` : "Affected files: none",
      ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}
