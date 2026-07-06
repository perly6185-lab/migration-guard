import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { createGitHubIssues, planGitHubIssues, validateGitHubRepo } from "./githubIssueAdapter.js";
import { appendEvidence, migrationRunDir, saveRunPackage } from "./migrationRun.js";
import type { LoadedConfig, MigrationIssue, ProposalBatchReport, ProposalCommandCheck, ProposalVerificationReport } from "../types.js";
import type { MigrationRunPackage } from "./migrationRun.js";

export async function syncIssues(
  loaded: LoadedConfig,
  pkg: MigrationRunPackage,
  provider: "local" | "github" | "gitlab" | "jira" | "linear",
  options: { dryRun?: boolean; live?: boolean; livePlan?: boolean; repo?: string; token?: string; liveConfirm?: string; livePlanConfirm?: string; labels?: string[]; maxLiveMutations?: number; retry?: { maxAttempts?: number; delayMs?: number }; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const dir = path.join(migrationRunDir(loaded, pkg.run.id), "issue-sync");
  enforceProviderSafety(provider, options, pkg.run.id);
  const context = await readIssueSyncContext(loaded, pkg);
  const mapping = providerMapping(provider);
  const exported = pkg.issues.map((issue) => serializeIssue(issue, provider, context, mapping, normalizeExtraLabels(options.labels)));
  const suffix = issueSyncSuffix(options);
  const outputPath = path.join(dir, `${provider}${suffix}-issues.json`);
  await writeJsonFile(outputPath, exported);

  if (provider !== "local") {
    const markdownPath = path.join(dir, `${provider}${suffix}-issues.md`);
    await writeTextFile(markdownPath, renderIssueSyncMarkdown(pkg.issues, provider, context));
    await writeJsonFile(path.join(dir, `${provider}${suffix}-mapping.json`), mapping);
    if (provider === "github" && options.dryRun) {
      await writeTextFile(path.join(dir, "github-pr-comment.md"), renderGitHubPrComment(pkg, context));
    }
    if (provider === "github" && options.livePlan) {
      const livePlanPath = path.join(dir, "github-live-plan.json");
      const result = await planGitHubIssues({
        repo: options.repo ?? "",
        token: options.token ?? process.env.GITHUB_TOKEN ?? "",
        issues: exported.map((issue) => ({
          title: String(issue.title),
          body: String(issue.body),
          labels: Array.isArray(issue.labels) ? issue.labels.map(String) : []
        })),
        fetchImpl: options.fetchImpl,
        retry: options.retry
      });
      await writeJsonFile(livePlanPath, result.plan);
      await writeJsonFile(path.join(dir, "github-live-plan-summary.json"), {
        provider: "github",
        repo: result.repo,
        planPath: livePlanPath,
        planHash: result.plan.planHash,
        mutationCount: result.plan.mutationCount,
        willCreate: result.plan.willCreate,
        willUpdate: result.plan.willUpdate,
        willSkip: result.plan.willSkip,
        rateLimit: result.rateLimit
      });
    }
    if (provider === "github" && options.live) {
      const livePlanPath = path.join(dir, "github-live-plan.json");
      const result = await createGitHubIssues({
        repo: options.repo ?? "",
        token: options.token ?? process.env.GITHUB_TOKEN ?? "",
        issues: exported.map((issue) => ({
          title: String(issue.title),
          body: String(issue.body),
          labels: Array.isArray(issue.labels) ? issue.labels.map(String) : []
        })),
        fetchImpl: options.fetchImpl,
        maxLiveMutations: options.maxLiveMutations,
        livePlanConfirm: options.livePlanConfirm,
        retry: options.retry,
        onPlan: async (plan) => {
          await writeJsonFile(livePlanPath, plan);
        }
      });
      const liveSummaryPath = path.join(dir, "github-live-sync.json");
      await writeJsonFile(liveSummaryPath, {
        provider: "github",
        repo: result.repo,
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        planPath: livePlanPath,
        planHash: result.plan.planHash,
        livePlanConfirm: options.livePlanConfirm,
        rateLimit: result.rateLimit,
        issues: result.issues
      });
      for (let index = 0; index < pkg.issues.length; index += 1) {
        const externalUrl = result.issues[index]?.url;
        if (externalUrl) {
          pkg.issues[index].externalUrl = externalUrl;
          pkg.issues[index].updatedAt = new Date().toISOString();
        }
      }
    }
    if (!options.dryRun && !options.livePlan) {
      for (const issue of pkg.issues) {
        issue.externalUrl = issue.externalUrl ?? (options.live ? undefined : `${provider}:pending:${issue.id}`);
        issue.updatedAt = new Date().toISOString();
      }
    }
  }

  if (!options.dryRun && !options.livePlan) {
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

interface IssueSyncContext {
  gatesByIssueId: Map<string, ProposalGateContext>;
  gatesByTaskId: Map<string, ProposalGateContext>;
  failedGates: ProposalGateContext[];
  latestFailedBatch?: ProposalBatchContext;
}

interface ProposalGateContext {
  proposalId: string;
  reportPath: string;
  replanIssueId?: string;
  replanTaskId?: string;
  firstFailedCheck?: {
    command: string;
    kind?: string;
    phase?: string;
    failureCategory?: string;
    remediationHints?: string[];
  };
}

interface ProposalBatchContext {
  batchId: string;
  reportPath: string;
  passed: boolean;
  gatePolicy?: string;
  executedCount: number;
  skippedCount: number;
  firstFailedProposalId?: string;
  firstFailedVerificationPath?: string;
  stopReason?: string;
  nextCommand?: string;
  skippedProposals: string[];
  recommendedNextActions?: string[];
}

interface ProviderMapping {
  provider: string;
  tokenEnv?: string;
  dryRunDefault: boolean;
  fields: {
    title: string;
    body: string;
    labels: string;
    status: string;
  };
  labels: string[];
  bodySections: string[];
}

function serializeIssue(issue: MigrationIssue, provider: string, context: IssueSyncContext, mapping: ProviderMapping, extraLabels: string[] = []): Record<string, unknown> {
  const gate = contextForIssue(issue, context);
  const batch = gate ? context.latestFailedBatch : undefined;
  return {
    provider,
    providerMapping: {
      title: mapping.fields.title,
      body: mapping.fields.body,
      labels: mapping.fields.labels,
      status: mapping.fields.status
    },
    title: issue.title,
    body: renderIssueBody(issue, gate, batch),
    migrationGuard: {
      runId: issue.runId,
      issueId: issue.id,
      taskId: issue.taskId,
      issueType: issue.type,
      gate,
      batch
    },
    labels: uniqueLabels(["migration-guard", `mg-type:${issue.type}`, `mg-risk:${issue.risk}`, ...extraLabels]),
    status: issue.status
  };
}

function renderIssueBody(issue: MigrationIssue, gate?: ProposalGateContext, batch?: ProposalBatchContext): string {
  return [
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
      issue.affectedFiles.length > 0 ? `Affected files: ${issue.affectedFiles.join(", ")}` : "Affected files: none",
      gate ? renderGateContext(gate) : undefined,
      batch ? renderBatchContext(batch) : undefined
    ].filter(Boolean).join("\n");
}

function renderIssueSyncMarkdown(issues: MigrationIssue[], provider: string, context: IssueSyncContext): string {
  return [
    `# ${provider} Issue Sync Export`,
    "",
    "This file is a provider-neutral export. A later provider adapter can turn each entry into a real external issue.",
    "",
    ...issues.map((issue) => {
      const gate = contextForIssue(issue, context);
      const batch = gate ? context.latestFailedBatch : undefined;
      return [
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
      gate ? renderGateContext(gate) : undefined,
      batch ? renderBatchContext(batch) : undefined,
      ""
    ].filter(Boolean).join("\n");
    })
  ].join("\n");
}

function renderGitHubPrComment(pkg: MigrationRunPackage, context: IssueSyncContext): string {
  const failedGate = context.failedGates[0];
  const batch = context.latestFailedBatch;
  return [
    "## Migration Guard",
    "",
    `Run: \`${pkg.run.id}\``,
    `Goal: ${pkg.run.goal}`,
    "",
    "### Latest Failed Gate",
    "",
    failedGate ? [
      `- Proposal: \`${failedGate.proposalId}\``,
      `- Verification: \`${failedGate.reportPath}\``,
      failedGate.replanIssueId ? `- Replan issue: \`${failedGate.replanIssueId}\`` : undefined,
      failedGate.replanTaskId ? `- Replan task: \`${failedGate.replanTaskId}\`` : undefined,
      failedGate.firstFailedCheck ? `- First failed check: \`${failedGate.firstFailedCheck.command}\`` : undefined,
      failedGate.firstFailedCheck?.failureCategory ? `- Failure category: \`${failedGate.firstFailedCheck.failureCategory}\`` : undefined,
      ...(failedGate.firstFailedCheck?.remediationHints?.length ? [
        "",
        "Remediation hints:",
        ...failedGate.firstFailedCheck.remediationHints.map((hint) => `- ${hint}`)
      ] : [])
    ].filter(Boolean).join("\n") : "No failed proposal gate.",
    "",
    "### Latest Failed Batch",
    "",
    batch ? [
      `- Batch: \`${batch.batchId}\``,
      `- Report: \`${batch.reportPath}\``,
      batch.stopReason ? `- Stop reason: ${batch.stopReason}` : undefined,
      batch.nextCommand ? `- Next command: \`${batch.nextCommand}\`` : undefined,
      batch.skippedProposals.length > 0 ? `- Skipped proposals: ${batch.skippedProposals.map((proposal) => `\`${proposal}\``).join(", ")}` : undefined,
      ...(batch.recommendedNextActions?.length ? [
        "",
        "Recommended next actions:",
        ...batch.recommendedNextActions.map((action) => `- ${action}`)
      ] : [])
    ].filter(Boolean).join("\n") : "No failed proposal batch."
  ].join("\n");
}

function providerMapping(provider: string): ProviderMapping {
  return {
    provider,
    tokenEnv: providerTokenEnv(provider),
    dryRunDefault: provider !== "local",
    fields: provider === "jira"
      ? { title: "summary", body: "description", labels: "labels", status: "status" }
      : { title: "title", body: "body", labels: "labels", status: "state/status" },
    labels: ["migration-guard", "mg-type:*", "mg-risk:*"],
    bodySections: [
      "machine-readable front matter",
      "issue body",
      "affected files",
      "proposal gate context",
      "proposal batch context"
    ]
  };
}

function providerTokenEnv(provider: string): string | undefined {
  switch (provider) {
    case "github":
      return "GITHUB_TOKEN";
    case "gitlab":
      return "GITLAB_TOKEN";
    case "jira":
      return "JIRA_TOKEN";
    case "linear":
      return "LINEAR_API_KEY";
    default:
      return undefined;
  }
}

function enforceProviderSafety(provider: string, options: { dryRun?: boolean; live?: boolean; livePlan?: boolean; repo?: string; token?: string; liveConfirm?: string; livePlanConfirm?: string }, runId?: string): void {
  if (provider === "local") {
    return;
  }
  if (options.dryRun && options.live) {
    throw new Error("--dry-run and --live cannot be used together.");
  }
  if (options.dryRun && options.livePlan) {
    throw new Error("--dry-run and --live-plan cannot be used together.");
  }
  if (options.live && options.livePlan) {
    throw new Error("--live and --live-plan cannot be used together.");
  }
  if (options.dryRun) {
    return;
  }
  if (provider === "github" && options.livePlan) {
    if (!options.repo) {
      throw new Error("GitHub live plan requires --repo owner/name.");
    }
    validateGitHubRepo(options.repo);
    if (!(options.token ?? process.env.GITHUB_TOKEN)) {
      throw new Error("GitHub live plan requires GITHUB_TOKEN.");
    }
    return;
  }
  if (provider === "github" && options.live) {
    if (!options.liveConfirm) {
      throw new Error("GitHub live issue sync requires --live-confirm <run-id>.");
    }
    if (runId && options.liveConfirm !== runId) {
      throw new Error(`GitHub live confirmation mismatch. Expected --live-confirm ${runId}.`);
    }
    if (!options.repo) {
      throw new Error("GitHub live issue sync requires --repo owner/name.");
    }
    validateGitHubRepo(options.repo);
    if (!(options.token ?? process.env.GITHUB_TOKEN)) {
      throw new Error("GitHub live issue sync requires GITHUB_TOKEN.");
    }
    if (!options.livePlanConfirm) {
      throw new Error("GitHub live issue sync requires --live-plan-confirm <plan-hash>.");
    }
    return;
  }
  const tokenEnv = providerTokenEnv(provider);
  const tokenHint = tokenEnv ? ` Set ${tokenEnv} when a live ${provider} adapter is implemented.` : "";
  throw new Error(`Live ${provider} issue sync is not implemented yet. Re-run with --dry-run to write provider-neutral artifacts, or use --live only for implemented providers.${tokenHint}`);
}

function issueSyncSuffix(options: { dryRun?: boolean; livePlan?: boolean }): string {
  if (options.dryRun) {
    return "-dry-run";
  }
  if (options.livePlan) {
    return "-live-plan";
  }
  return "";
}

function normalizeExtraLabels(labels: string[] | undefined): string[] {
  return uniqueLabels((labels ?? []).map((label) => label.trim()).filter(Boolean));
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}

function contextForIssue(issue: MigrationIssue, context: IssueSyncContext): ProposalGateContext | undefined {
  if (context.gatesByIssueId.has(issue.id)) {
    return context.gatesByIssueId.get(issue.id);
  }
  if (issue.taskId && context.gatesByTaskId.has(issue.taskId)) {
    return context.gatesByTaskId.get(issue.taskId);
  }
  if (issue.type === "failure" && issue.title.startsWith("Proposal gate failed:")) {
    return context.failedGates[0];
  }
  return undefined;
}

function renderGateContext(gate: ProposalGateContext): string {
  return [
    "",
    "Proposal gate context:",
    `- Proposal: ${gate.proposalId}`,
    `- Verification report: ${gate.reportPath}`,
    gate.replanIssueId ? `- Replan issue: ${gate.replanIssueId}` : undefined,
    gate.replanTaskId ? `- Replan task: ${gate.replanTaskId}` : undefined,
    gate.firstFailedCheck ? `- First failed check: ${gate.firstFailedCheck.command}` : undefined,
    gate.firstFailedCheck?.failureCategory ? `- Failure category: ${gate.firstFailedCheck.failureCategory}` : undefined,
    ...(gate.firstFailedCheck?.remediationHints?.length ? [
      "- Remediation hints:",
      ...gate.firstFailedCheck.remediationHints.map((hint) => `  - ${hint}`)
    ] : [])
  ].filter(Boolean).join("\n");
}

function renderBatchContext(batch: ProposalBatchContext): string {
  return [
    "",
    "Proposal batch context:",
    `- Batch: ${batch.batchId}`,
    `- Batch report: ${batch.reportPath}`,
    `- Passed: ${batch.passed ? "yes" : "no"}`,
    batch.gatePolicy ? `- Gate policy: ${batch.gatePolicy}` : undefined,
    `- Executed: ${batch.executedCount}`,
    `- Skipped: ${batch.skippedCount}`,
    batch.firstFailedProposalId ? `- First failed proposal: ${batch.firstFailedProposalId}` : undefined,
    batch.firstFailedVerificationPath ? `- First failed verification: ${batch.firstFailedVerificationPath}` : undefined,
    batch.stopReason ? `- Stop reason: ${batch.stopReason}` : undefined,
    batch.nextCommand ? `- Next command: ${batch.nextCommand}` : undefined,
    batch.skippedProposals.length > 0 ? `- Skipped proposals: ${batch.skippedProposals.join(", ")}` : undefined,
    ...(batch.recommendedNextActions?.length ? [
      "- Recommended next actions:",
      ...batch.recommendedNextActions.map((action) => `  - ${action}`)
    ] : [])
  ].filter(Boolean).join("\n");
}

async function readIssueSyncContext(loaded: LoadedConfig, pkg: MigrationRunPackage): Promise<IssueSyncContext> {
  const failedGates = (await readProposalGateContexts(loaded, pkg.run.id)).filter((gate) => gate.firstFailedCheck);
  const gatesByIssueId = new Map<string, ProposalGateContext>();
  const gatesByTaskId = new Map<string, ProposalGateContext>();
  for (const gate of failedGates) {
    if (gate.replanIssueId) {
      gatesByIssueId.set(gate.replanIssueId, gate);
    }
    if (gate.replanTaskId) {
      gatesByTaskId.set(gate.replanTaskId, gate);
    }
  }
  return {
    gatesByIssueId,
    gatesByTaskId,
    failedGates,
    latestFailedBatch: await readLatestFailedBatchContext(loaded, pkg.run.id)
  };
}

async function readProposalGateContexts(loaded: LoadedConfig, runId: string): Promise<ProposalGateContext[]> {
  const proposalsDir = path.join(migrationRunDir(loaded, runId), "proposals");
  if (!await pathExists(proposalsDir)) {
    return [];
  }

  const entries = await fs.readdir(proposalsDir, { withFileTypes: true });
  const reports: ProposalVerificationReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const proposalDir = path.join(proposalsDir, entry.name);
    const files = await fs.readdir(proposalDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.startsWith("verification-") && file.name.endsWith(".json")) {
        reports.push(await readJsonFile<ProposalVerificationReport>(path.join(proposalDir, file.name)));
      }
    }
  }

  return reports
    .filter((report) => !report.passed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((report) => {
      const failed = report.checks.find((check) => !check.passed);
      return {
        proposalId: report.proposalId,
        reportPath: report.outputPath,
        replanIssueId: report.replanIssueId,
        replanTaskId: report.replanTaskId,
        firstFailedCheck: failed ? checkToContext(failed) : undefined
      };
    });
}

function checkToContext(check: ProposalCommandCheck): ProposalGateContext["firstFailedCheck"] {
  return {
    command: check.command,
    kind: check.kind,
    phase: check.phase,
    failureCategory: check.failureCategory,
    remediationHints: check.remediationHints
  };
}

async function readLatestFailedBatchContext(loaded: LoadedConfig, runId: string): Promise<ProposalBatchContext | undefined> {
  const batchesDir = path.join(migrationRunDir(loaded, runId), "proposal-batches");
  if (!await pathExists(batchesDir)) {
    return undefined;
  }

  const entries = await fs.readdir(batchesDir, { withFileTypes: true });
  const reports: ProposalBatchReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const batchDir = path.join(batchesDir, entry.name);
    const files = await fs.readdir(batchDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.startsWith("proposal-batch-report-") && file.name.endsWith(".json")) {
        reports.push(await readJsonFile<ProposalBatchReport>(path.join(batchDir, file.name)));
      }
    }
  }

  const report = reports
    .filter((candidate) => !candidate.passed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return report ? {
    batchId: report.id,
    reportPath: report.outputPath,
    passed: report.passed,
    gatePolicy: report.gatePolicy?.mode,
    executedCount: report.executedCount,
    skippedCount: report.skippedCount,
    firstFailedProposalId: report.firstFailedProposalId,
    firstFailedVerificationPath: report.firstFailedVerificationPath,
    stopReason: report.stopReason,
    nextCommand: report.nextCommand,
    skippedProposals: report.skipped.map((item) => item.proposalId),
    recommendedNextActions: report.recommendedNextActions
  } : undefined;
}
