#!/usr/bin/env node
import path from "node:path";
import { CONFIG_FILE_NAME, initConfigFile, loadConfig } from "./core/config.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./core/files.js";
import { renderAiBrief } from "./core/aiBrief.js";
import { createCheckpoint, listCheckpoints, rollbackToCheckpoint } from "./core/checkpoint.js";
import { captureContract, runDualRun, testContract } from "./core/contract.js";
import { executeReadyTasks, executeTask } from "./core/executor.js";
import { renderCompareReport, renderScanSummary, renderSnapshotSummary } from "./core/markdown.js";
import {
  createMigrationRun,
  loadRunPackage,
  renderIssues,
  renderRunReport,
  renderRunStatus,
  resolveRunNextAction,
  setRunStatus,
  writeCiHandoffReport,
  writeRunReport
} from "./core/migrationRun.js";
import { renderMigrationPlan } from "./core/plan.js";
import { scanProject } from "./core/scan.js";
import { captureSnapshot, latestBaselinePath, latestRunPath, loadSnapshot, saveSnapshot } from "./core/snapshot.js";
import { compareSnapshots } from "./core/compare.js";
import {
  decisionsForCompareReport,
  loadDiffDecisionLedger,
  recordDiffDecision,
  renderDiffDecisionList
} from "./core/diffDecision.js";
import { getReadyTasks, validateTaskGraph } from "./core/taskGraph.js";
import { syncIssues } from "./core/issueSync.js";
import { loadActionPlan, renderActionPlan } from "./core/actionPlan.js";
import {
  applyProposalBatch,
  applyProposedPatch,
  createProposalRetry,
  createProposalBatchPlan,
  getProposalStatus,
  proposeActionPatch,
  proposePatch,
  renderProposalBatchPlan,
  renderProposalBatchReport,
  renderProposalRollbackReport,
  renderProposalStatus,
  renderProposalVerificationReport,
  replanProposal,
  rollbackProposedPatch,
  verifyProposedPatch
} from "./core/patch.js";
import { runPreviewProbe } from "./core/preview.js";
import type { CompareReport, DiffDecisionClassification, Difference, MigrationAutomationMode, MigrationRun, ProposalGatePolicy } from "./types.js";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "init":
      await commandInit(args);
      return;
    case "scan":
      await commandScan(args);
      return;
    case "baseline":
      await commandBaseline(args);
      return;
    case "verify":
      await commandVerify(args);
      return;
    case "compare":
      await commandCompare(args);
      return;
    case "diff":
      await commandDiff(args);
      return;
    case "plan":
      await commandPlan(args);
      return;
    case "ai-brief":
      await commandAiBrief(args);
      return;
    case "run":
      await commandRun(args);
      return;
    case "status":
      await commandStatus(args);
      return;
    case "issues":
      await commandIssues(args);
      return;
    case "tasks":
      await commandTasks(args);
      return;
    case "actions":
      await commandActions(args);
      return;
    case "report":
      await commandReport(args);
      return;
    case "checkpoint":
      await commandCheckpoint(args);
      return;
    case "resume":
      await commandResume(args);
      return;
    case "rollback":
      await commandRollback(args);
      return;
    case "task":
      await commandTask(args);
      return;
    case "action":
      await commandAction(args);
      return;
    case "proposal":
      await commandProposal(args);
      return;
    case "sync-issues":
      await commandSyncIssues(args);
      return;
    case "ci":
      await commandCi(args);
      return;
    case "contract":
      await commandContract(args);
      return;
    case "dual-run":
      await commandDualRun(args);
      return;
    case "preview":
      await commandPreview(args);
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [key, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return {
    command,
    options,
    positionals
  };
}

async function commandInit(args: ParsedArgs): Promise<void> {
  const targetRoot = stringOption(args, "target") ?? args.positionals[0] ?? ".";
  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  const force = Boolean(args.options.force);

  await initConfigFile(configPath, targetRoot, force);
  await ensureDir(path.resolve(process.cwd(), ".migration-guard"));

  console.log(`Created ${configPath}`);
  console.log("Next: edit probes in .migration-guard.json, then run `migration-guard baseline`.");
}

async function commandScan(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const outputPath = path.join(loaded.artifactsDir, "scan", `${Date.now()}.json`);

  await writeJsonFile(outputPath, scan);

  if (args.options.json) {
    console.log(JSON.stringify(scan, null, 2));
  } else {
    console.log(renderScanSummary(scan));
    console.log("");
    console.log(`Wrote ${outputPath}`);
  }
}

async function commandBaseline(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const snapshot = await captureSnapshot(loaded, "baseline");
  const outputPath = await saveSnapshot(loaded, snapshot);

  console.log(renderSnapshotSummary(snapshot));
  console.log(`Wrote ${outputPath}`);
}

async function commandVerify(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const snapshot = await captureSnapshot(loaded, "run");
  const outputPath = await saveSnapshot(loaded, snapshot);
  const baselinePath = stringOption(args, "baseline") ?? latestBaselinePath(loaded);

  console.log(renderSnapshotSummary(snapshot));
  console.log(`Wrote ${outputPath}`);

  if (!await pathExists(baselinePath)) {
    console.log(`No baseline found at ${baselinePath}. Run baseline first or pass --baseline.`);
    return;
  }

  const baseline = await loadSnapshot(baselinePath);
  const report = compareSnapshots(baseline, snapshot, loaded.config.compare);
  const reportPath = await writeCompareArtifacts(loaded.artifactsDir, report);

  console.log("");
  console.log(renderCompareReport(report));
  console.log("");
  console.log(`Wrote ${reportPath}`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function commandCompare(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const baselinePath = stringOption(args, "baseline") ?? args.positionals[0] ?? latestBaselinePath(loaded);
  const currentPath = stringOption(args, "current") ?? args.positionals[1] ?? latestRunPath(loaded);
  const baseline = await readJsonFile<Awaited<ReturnType<typeof loadSnapshot>>>(path.resolve(process.cwd(), baselinePath));
  const current = await readJsonFile<Awaited<ReturnType<typeof loadSnapshot>>>(path.resolve(process.cwd(), currentPath));
  const report = compareSnapshots(baseline, current, loaded.config.compare);
  const reportPath = await writeCompareArtifacts(loaded.artifactsDir, report);

  console.log(renderCompareReport(report));
  console.log("");
  console.log(`Wrote ${reportPath}`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function commandDiff(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "list";
  const loaded = await loadFromArgs(args);
  const runId = await resolveRunIdOption(loaded, args);

  if (action === "decide") {
    const compareReportPath = stringOption(args, "compare");
    const area = differenceAreaOption(args);
    const name = stringOption(args, "name");
    const classification = diffDecisionClassificationOption(args);
    const reason = stringOption(args, "reason");
    if (!compareReportPath || !area || !name || !classification || !reason) {
      throw new Error("diff decide requires --compare <compare.json> --area check|probe|scan --name <name> --as intentional|accidental|unknown --reason <text>.");
    }
    const result = await recordDiffDecision(loaded, {
      runId,
      proposalId: stringOption(args, "proposal"),
      compareReportPath,
      area,
      name,
      classification,
      reason,
      approvedBy: stringOption(args, "approved-by"),
      severity: differenceSeverityOption(args),
      message: stringOption(args, "message")
    });
    if (args.options.json) {
      console.log(JSON.stringify(result.decision, null, 2));
    } else {
      console.log(`Recorded ${result.decision.classification} decision for ${result.decision.area}/${result.decision.name}.`);
      console.log(`Ledger: ${result.ledgerPath}`);
      console.log(`Compare: ${result.decision.compareReportPath}`);
    }
    return;
  }

  if (action === "list") {
    const ledger = await loadDiffDecisionLedger(loaded, runId);
    const compareReportPath = stringOption(args, "compare");
    if (compareReportPath) {
      const report = await readJsonFile<CompareReport>(path.resolve(process.cwd(), compareReportPath));
      const decisions = await decisionsForCompareReport(loaded, report, runId);
      if (args.options.json) {
        console.log(JSON.stringify({ ledgerPath: undefined, report, decisions }, null, 2));
      } else {
        console.log(renderDiffDecisionList(ledger, report, decisions));
      }
      return;
    }
    if (args.options.json) {
      console.log(JSON.stringify(ledger, null, 2));
    } else {
      console.log(renderDiffDecisionList(ledger));
    }
    return;
  }

  throw new Error(`Unknown diff command: ${action}`);
}

async function commandPlan(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const plan = renderMigrationPlan(scan);
  const outputPath = path.join(loaded.artifactsDir, "migration-plan.md");

  await writeTextFile(outputPath, plan);
  console.log(plan);
  console.log("");
  console.log(`Wrote ${outputPath}`);
}

async function commandAiBrief(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const baselinePath = stringOption(args, "baseline") ?? latestBaselinePath(loaded);
  const currentPath = stringOption(args, "current") ?? latestRunPath(loaded);
  const baseline = await loadOptionalSnapshot(baselinePath);
  const current = await loadOptionalSnapshot(currentPath);
  const compareReport = baseline && current
    ? compareSnapshots(baseline, current, loaded.config.compare)
    : undefined;
  let brief = renderAiBrief({
    loaded,
    scan,
    baseline,
    current,
    compareReport
  });
  const runSelector = stringOption(args, "run");
  if (runSelector) {
    const pkg = await loadRunPackage(loaded, runSelector);
    const taskId = stringOption(args, "task");
    const task = taskId ? pkg.graph.tasks.find((candidate) => candidate.id === taskId) : undefined;
    brief += `\n\n${[
      "## Migration Run Context",
      "",
      `- Run: ${pkg.run.id}`,
      `- Goal: ${pkg.run.goal}`,
      `- Status: ${pkg.run.status}`,
      `- Ready tasks: ${getReadyTasks(pkg.graph).map((candidate) => candidate.id).join(", ") || "none"}`,
      task ? "" : undefined,
      task ? "## Task Context" : undefined,
      task ? "" : undefined,
      task ? `- Task: ${task.id}` : undefined,
      task ? `- Title: ${task.title}` : undefined,
      task ? `- Status: ${task.status}` : undefined,
      task ? `- Affected files: ${task.affectedFiles.join(", ") || "none"}` : undefined,
      task ? `- Acceptance criteria: ${task.acceptanceCriteria.join("; ") || "none"}` : undefined
    ].filter(Boolean).join("\n")}`;
  }
  const outputPath = stringOption(args, "output")
    ? path.resolve(process.cwd(), stringOption(args, "output") as string)
    : path.join(loaded.artifactsDir, "ai", `brief-${Date.now()}.md`);

  await writeTextFile(outputPath, brief);
  console.log(brief);
  console.log("");
  console.log(`Wrote ${outputPath}`);
}

async function commandRun(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const goal = stringOption(args, "goal") ?? "General migration";
  const sourceRoot = path.resolve(process.cwd(), stringOption(args, "source") ?? loaded.targetRoot);
  const targetRoot = path.resolve(process.cwd(), stringOption(args, "target") ?? loaded.targetRoot);
  const adapter = stringOption(args, "adapter");
  const issueProvider = issueProviderOption(args) ?? "local";
  const mode = resolveRunMode(args);

  if (args.options.resume) {
    const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
    if (args.options.auto) {
      pkg.run.mode = "auto";
    }
    await executeReadyTasks(loaded, pkg, { createCheckpoint: true });
    console.log(renderRunStatus(pkg, await resolveRunNextAction(loaded, pkg)));
    return;
  }

  const pkg = await createMigrationRun(loaded, {
    goal,
    sourceRoot,
    targetRoot,
    mode,
    adapter,
    issueProvider
  });

  if (mode === "auto" || mode === "manual") {
    await executeReadyTasks(loaded, pkg, { createCheckpoint: true });
  }

  console.log(renderRunStatus(pkg, await resolveRunNextAction(loaded, pkg)));
  const reportPath = await writeRunReport(loaded, pkg);
  console.log("");
  console.log(`Wrote ${reportPath}`);
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  console.log(renderRunStatus(pkg, await resolveRunNextAction(loaded, pkg)));
}

async function commandIssues(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  if (args.options.json) {
    console.log(JSON.stringify(pkg.issues, null, 2));
    return;
  }
  console.log(renderIssues(pkg.issues));
}

async function commandTasks(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  if (args.options.json) {
    console.log(JSON.stringify(pkg.graph, null, 2));
    return;
  }

  const errors = validateTaskGraph(pkg.graph);
  console.log(`Run: ${pkg.run.id}`);
  console.log(`Graph: ${errors.length === 0 ? "valid" : "invalid"}`);
  for (const task of pkg.graph.tasks) {
    console.log(`- ${task.id} [${task.status}/${task.risk}] ${task.title}`);
    if (task.dependsOn.length > 0) {
      console.log(`  depends on: ${task.dependsOn.join(", ")}`);
    }
  }
  if (errors.length > 0) {
    console.log("");
    console.log("Graph errors:");
    console.log(errors.map((error) => `- ${error}`).join("\n"));
  }
}

async function commandActions(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const plan = await loadActionPlan(loaded, pkg);
  if (args.options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(renderActionPlan(plan));
}

async function commandReport(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const report = await renderRunReport(loaded, pkg);
  const reportPath = await writeRunReport(loaded, pkg);
  console.log(report);
  console.log("");
  console.log(`Wrote ${reportPath}`);
}

async function commandCheckpoint(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "list";
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");

  if (action === "create") {
    const checkpoint = await createCheckpoint(loaded, pkg, stringOption(args, "task"), stringOption(args, "note"));
    console.log(`Created checkpoint ${checkpoint.id}`);
    console.log(checkpoint.patchPath);
    return;
  }

  if (action === "list") {
    const checkpoints = await listCheckpoints(loaded, pkg.run.id);
    if (args.options.json) {
      console.log(JSON.stringify(checkpoints, null, 2));
      return;
    }
    console.log(checkpoints.length > 0
      ? checkpoints.map((checkpoint) => `- ${checkpoint.id} ${checkpoint.createdAt} ${checkpoint.taskId ?? ""}`).join("\n")
      : "No checkpoints.");
    return;
  }

  throw new Error(`Unknown checkpoint action: ${action}`);
}

async function commandResume(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  if (args.options.auto) {
    pkg.run.mode = "auto";
  }
  setRunStatus(pkg, "running");
  await executeReadyTasks(loaded, pkg, { createCheckpoint: true });
  console.log(renderRunStatus(pkg, await resolveRunNextAction(loaded, pkg)));
}

async function commandRollback(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const checkpointId = stringOption(args, "checkpoint") ?? args.positionals[0];
  if (!checkpointId) {
    throw new Error("rollback requires --checkpoint <checkpoint-id>.");
  }
  const message = await rollbackToCheckpoint(loaded, pkg, checkpointId);
  console.log(message);
}

async function commandTask(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "run";
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const taskId = stringOption(args, "task") ?? args.positionals[1];
  if (action === "run") {
    if (!taskId) {
      throw new Error("task run requires --task <task-id>.");
    }
    const task = await executeTask(loaded, pkg, taskId, { createCheckpoint: true });
    console.log(`Task ${task.id}: ${task.status}`);
    if (task.result) {
      console.log(task.result);
    }
    return;
  }
  if (action === "propose") {
    if (!taskId) {
      throw new Error("task propose requires --task <task-id>.");
    }
    const patch = await proposePatch(loaded, pkg, taskId);
    console.log(`Proposed ${patch.id}`);
    console.log(patch.patchPath);
    return;
  }
  if (action === "apply") {
    const proposalId = stringOption(args, "proposal") ?? args.positionals[1];
    if (!proposalId) {
      throw new Error("task apply requires --proposal <proposal-id>.");
    }
    const result = await applyProposedPatch(loaded, pkg, proposalId, {
      behaviorDiff: Boolean(args.options["behavior-diff"])
    });
    console.log(result.message);
    if (result.report) {
      console.log(renderProposalVerificationReport(result.report));
    }
    return;
  }
  throw new Error(`Unknown task action: ${action}`);
}

async function commandAction(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "propose";
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const actionId = stringOption(args, "action") ?? args.positionals[1];

  if (action === "propose") {
    if (!actionId) {
      throw new Error("action propose requires --action <action-id>.");
    }
    const patch = await proposeActionPatch(loaded, pkg, actionId);
    console.log(`Proposed ${patch.id}`);
    console.log(patch.patchPath);
    if (patch.generatedFiles && patch.generatedFiles.length > 0) {
      console.log(`Generated files: ${patch.generatedFiles.join(", ")}`);
    }
    return;
  }

  if (action === "apply") {
    const proposalId = stringOption(args, "proposal") ?? args.positionals[1];
    if (!proposalId) {
      throw new Error("action apply requires --proposal <proposal-id>.");
    }
    const result = await applyProposedPatch(loaded, pkg, proposalId, {
      runChecks: !args.options["skip-checks"],
      rollbackOnFail: Boolean(args.options["rollback-on-fail"]),
      gatePolicy: gatePolicyOption(args),
      behaviorDiff: Boolean(args.options["behavior-diff"])
    });
    console.log(result.message);
    if (result.report) {
      console.log(renderProposalVerificationReport(result.report));
    }
    if (result.rollbackReport) {
      console.log(renderProposalRollbackReport(result.rollbackReport));
    }
    return;
  }

  throw new Error(`Unknown action command: ${action}`);
}

async function commandProposal(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "verify";
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const proposalId = stringOption(args, "proposal") ?? args.positionals[1];

  if (action === "batch") {
    const batchAction = args.positionals[1] ?? "plan";
    const limit = numberOption(args, "limit");
    if (batchAction === "plan") {
      const plan = await createProposalBatchPlan(loaded, pkg, { limit });
      if (args.options.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(renderProposalBatchPlan(plan));
      }
      return;
    }
    if (batchAction === "apply") {
      const report = await applyProposalBatch(loaded, pkg, {
        limit,
        runChecks: !args.options["skip-checks"],
        rollbackOnFail: !args.options["no-rollback-on-fail"],
        gatePolicy: gatePolicyOption(args),
        behaviorDiff: Boolean(args.options["behavior-diff"])
      });
      if (args.options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderProposalBatchReport(report));
      }
      if (!report.passed) {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`Unknown proposal batch command: ${batchAction}`);
  }

  if (action === "verify") {
    if (!proposalId) {
      throw new Error("proposal verify requires --proposal <proposal-id>.");
    }
    const report = await verifyProposedPatch(loaded, pkg, proposalId, {
      runChecks: Boolean(args.options.checks),
      gatePolicy: gatePolicyOption(args)
    });
    if (args.options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderProposalVerificationReport(report));
    }
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (action === "status") {
    if (!proposalId) {
      throw new Error("proposal status requires --proposal <proposal-id>.");
    }
    const status = await getProposalStatus(loaded, pkg, proposalId);
    if (args.options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(renderProposalStatus(status));
    }
    return;
  }

  if (action === "rollback") {
    if (!proposalId) {
      throw new Error("proposal rollback requires --proposal <proposal-id>.");
    }
    const report = await rollbackProposedPatch(loaded, pkg, proposalId);
    if (args.options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderProposalRollbackReport(report));
    }
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (action === "replan") {
    if (!proposalId) {
      throw new Error("proposal replan requires --proposal <proposal-id>.");
    }
    const result = await replanProposal(loaded, pkg, proposalId);
    if (args.options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      console.log(`Task: ${result.task.id}`);
      console.log(`Report: ${result.report.outputPath}`);
      console.log(`Replan brief: ${result.briefPath}`);
      console.log(`Replan context: ${result.contextPath}`);
    }
    return;
  }

  if (action === "retry") {
    if (!proposalId) {
      throw new Error("proposal retry requires --proposal <proposal-id>.");
    }
    const result = await createProposalRetry(loaded, pkg, proposalId);
    if (args.options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      console.log(`Retry proposal: ${result.proposal.id}`);
      console.log(`Patch: ${result.proposal.patchPath}`);
      console.log(`Replan brief: ${result.proposal.replanBriefPath ?? "none"}`);
      console.log(`Replan context: ${result.proposal.replanContextPath ?? "none"}`);
    }
    return;
  }

  throw new Error(`Unknown proposal command: ${action}`);
}

async function commandSyncIssues(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const pkg = await loadRunPackage(loaded, stringOption(args, "run") ?? "latest");
  const provider = issueProviderOption(args) ?? "local";
  const outputPath = await syncIssues(loaded, pkg, provider, {
    dryRun: Boolean(args.options["dry-run"]),
    live: Boolean(args.options.live),
    livePlan: Boolean(args.options["live-plan"]),
    repo: stringOption(args, "repo"),
    liveConfirm: stringOption(args, "live-confirm"),
    livePlanConfirm: stringOption(args, "live-plan-confirm"),
    labels: labelsOption(args),
    onlyIssue: stringOption(args, "only-issue"),
    maxLiveMutations: nonNegativeIntegerOption(args, "max-live-mutations")
  });
  if (args.options["dry-run"]) {
    console.log(`Dry-run export wrote ${outputPath}`);
    return;
  }
  if (args.options["live-plan"]) {
    console.log(`GitHub live-plan read-only lookup wrote ${outputPath}`);
    console.log("Read-only: fetched open issues with GET only; no POST/PATCH mutations were sent.");
    return;
  }
  console.log(`Wrote ${outputPath}`);
}

async function commandCi(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "verify";
  if (action !== "verify") {
    throw new Error(`Unknown ci action: ${action}`);
  }
  await commandVerify(args);
  const runId = stringOption(args, "run");
  if (runId) {
    const loaded = await loadFromArgs(args);
    const pkg = await loadRunPackage(loaded, runId);
    const outputPath = await writeCiHandoffReport(loaded, pkg);
    console.log(`CI handoff wrote ${outputPath}`);
  }
}

async function commandContract(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "capture";
  const loaded = await loadFromArgs(args);

  if (action === "capture") {
    const source = stringOption(args, "source");
    if (!source) {
      throw new Error("contract capture requires --source <url>.");
    }
    const outputPath = await captureContract(loaded, {
      source,
      name: stringOption(args, "name"),
      method: stringOption(args, "method"),
      body: stringOption(args, "body")
    });
    console.log(`Wrote ${outputPath}`);
    return;
  }

  if (action === "test") {
    const target = stringOption(args, "target");
    const contractPath = stringOption(args, "contract") ?? args.positionals[1];
    if (!target || !contractPath) {
      throw new Error("contract test requires --target <url> --contract <path>.");
    }
    const outputPath = await testContract(loaded, path.resolve(process.cwd(), contractPath), target);
    console.log(`Wrote ${outputPath}`);
    return;
  }

  throw new Error(`Unknown contract action: ${action}`);
}

async function commandDualRun(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const source = stringOption(args, "source");
  const target = stringOption(args, "target");
  if (!source || !target) {
    throw new Error("dual-run requires --source <url> --target <url>.");
  }
  const outputPath = await runDualRun(loaded, source, target, stringOption(args, "name") ?? "default");
  console.log(`Wrote ${outputPath}`);
}

async function commandPreview(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const command = stringOption(args, "command");
  const url = stringOption(args, "url") ?? "http://localhost:5173";
  const timeoutMs = Number(stringOption(args, "timeout-ms") ?? 60000);
  if (!command) {
    throw new Error("preview requires --command <command>.");
  }
  const result = await runPreviewProbe(loaded, command, url, timeoutMs);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    process.exitCode = 1;
  }
}

async function loadOptionalSnapshot(filePath: string) {
  return await pathExists(filePath) ? loadSnapshot(filePath) : undefined;
}

async function writeCompareArtifacts(artifactsDir: string, report: CompareReport): Promise<string> {
  const reportPath = path.join(artifactsDir, "compare", `${Date.now()}.json`);
  const markdownPath = reportPath.replace(/\.json$/, ".md");

  await writeJsonFile(reportPath, report);
  await writeTextFile(markdownPath, renderCompareReport(report));
  return reportPath;
}

async function loadFromArgs(args: ParsedArgs) {
  return loadConfig(stringOption(args, "config"));
}

function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

function numberOption(args: ParsedArgs, name: string): number | undefined {
  const value = stringOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for --${name}: ${value}`);
  }
  return parsed;
}

function nonNegativeIntegerOption(args: ParsedArgs, name: string): number | undefined {
  const value = numberOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid --${name}: ${value}. Expected a non-negative integer.`);
  }
  return value;
}

function labelsOption(args: ParsedArgs): string[] | undefined {
  const value = stringOption(args, "labels") ?? stringOption(args, "label");
  if (!value) {
    return undefined;
  }
  return [...new Set(value.split(",").map((label) => label.trim()).filter(Boolean))];
}

function gatePolicyOption(args: ParsedArgs): ProposalGatePolicy | undefined {
  const value = stringOption(args, "gate-policy");
  if (!value) {
    return undefined;
  }
  if (value !== "fail-fast" && value !== "collect-all") {
    throw new Error(`Invalid --gate-policy: ${value}. Expected fail-fast or collect-all.`);
  }
  return { mode: value };
}

async function resolveRunIdOption(loaded: Awaited<ReturnType<typeof loadFromArgs>>, args: ParsedArgs): Promise<string | undefined> {
  const runSelector = stringOption(args, "run");
  if (!runSelector) {
    return undefined;
  }
  return (await loadRunPackage(loaded, runSelector)).run.id;
}

function diffDecisionClassificationOption(args: ParsedArgs): DiffDecisionClassification | undefined {
  const value = stringOption(args, "as") ?? stringOption(args, "classification");
  if (!value) {
    return undefined;
  }
  if (value === "intentional" || value === "accidental" || value === "unknown") {
    return value;
  }
  throw new Error(`Invalid diff decision: ${value}. Expected intentional, accidental, or unknown.`);
}

function differenceAreaOption(args: ParsedArgs): Difference["area"] | undefined {
  const value = stringOption(args, "area");
  if (!value) {
    return undefined;
  }
  if (value === "check" || value === "probe" || value === "scan") {
    return value;
  }
  throw new Error(`Invalid --area: ${value}. Expected check, probe, or scan.`);
}

function differenceSeverityOption(args: ParsedArgs): Difference["severity"] | undefined {
  const value = stringOption(args, "severity");
  if (!value) {
    return undefined;
  }
  if (value === "error" || value === "warn" || value === "info") {
    return value;
  }
  throw new Error(`Invalid --severity: ${value}. Expected error, warn, or info.`);
}

function resolveRunMode(args: ParsedArgs): MigrationAutomationMode {
  if (args.options.auto) {
    return "auto";
  }
  if (args.options["dry-run"]) {
    return "dry-run";
  }
  if (args.options["init-only"]) {
    return "init-only";
  }
  const execute = stringOption(args, "execute");
  if (execute === "manual") {
    return "manual";
  }
  return "init-only";
}

function issueProviderOption(args: ParsedArgs): MigrationRun["issueProvider"] | undefined {
  const provider = stringOption(args, "provider") ?? stringOption(args, "issue-provider");
  if (!provider) {
    return undefined;
  }
  if (["local", "github", "gitlab", "jira", "linear"].includes(provider)) {
    return provider as MigrationRun["issueProvider"];
  }
  throw new Error(`Unsupported issue provider: ${provider}`);
}

function printHelp(): void {
  console.log(`Migration Guard

Usage:
  migration-guard init [--target <path>] [--force]
  migration-guard scan [--config <path>] [--json]
  migration-guard baseline [--config <path>]
  migration-guard verify [--config <path>] [--baseline <path>]
  migration-guard compare [--config <path>] [--baseline <path>] [--current <path>]
  migration-guard diff list [--run <id|latest>] [--compare <compare.json>] [--json]
  migration-guard diff decide [--run <id|latest>] --compare <compare.json> --area check|probe|scan --name <name> --as intentional|accidental|unknown --reason <text> [--approved-by <name>] [--proposal <id>] [--json]
  migration-guard plan [--config <path>]
  migration-guard ai-brief [--config <path>] [--baseline <path>] [--current <path>] [--output <path>]
  migration-guard run [--source <path>] [--target <path>] --goal <text> [--init-only|--dry-run|--auto]
  migration-guard status [--run <id|latest>]
  migration-guard issues [--run <id|latest>] [--json]
  migration-guard tasks [--run <id|latest>] [--json]
  migration-guard actions [--run <id|latest>] [--json]
  migration-guard report [--run <id|latest>]
  migration-guard checkpoint create|list [--run <id|latest>]
  migration-guard resume [--run <id|latest>] [--auto]
  migration-guard rollback [--run <id|latest>] --checkpoint <id>
  migration-guard task run [--run <id|latest>] --task <id>
  migration-guard task propose [--run <id|latest>] --task <id>
  migration-guard task apply [--run <id|latest>] --proposal <id> [--behavior-diff]
  migration-guard action propose [--run <id|latest>] --action <id>
  migration-guard action apply [--run <id|latest>] --proposal <id> [--skip-checks] [--rollback-on-fail] [--gate-policy fail-fast|collect-all] [--behavior-diff]
  migration-guard proposal verify [--run <id|latest>] --proposal <id> [--checks] [--gate-policy fail-fast|collect-all] [--json]
  migration-guard proposal status [--run <id|latest>] --proposal <id> [--json]
  migration-guard proposal rollback [--run <id|latest>] --proposal <id> [--json]
  migration-guard proposal replan [--run <id|latest>] --proposal <id> [--json]
  migration-guard proposal retry [--run <id|latest>] --proposal <id> [--json]
  migration-guard proposal batch plan|apply [--run <id|latest>] [--limit <n>] [--skip-checks] [--gate-policy fail-fast|collect-all] [--behavior-diff] [--json]
  migration-guard sync-issues [--run <id|latest>] [--provider local|github|gitlab|jira|linear] [--dry-run|--live|--live-plan] [--repo owner/name] [--live-confirm <run-id>] [--live-plan-confirm <hash>] [--labels a,b] [--only-issue <issue-id>] [--max-live-mutations <n>]
  migration-guard ci verify --baseline <path> [--run <id|latest>]
  migration-guard contract capture --source <url>
  migration-guard contract test --target <url> --contract <path>
  migration-guard dual-run --source <url> --target <url>
  migration-guard preview --command <command> [--url <url>] [--timeout-ms <ms>]

Behavior consistency workflow:
  1. init      Create .migration-guard.json
  2. baseline  Capture the current behavior
  3. verify    Re-run checks and probes after a small migration step
  4. compare   Inspect behavior drift explicitly
  5. diff      Classify differences as intentional, accidental, or unknown
  6. ai-brief  Give an AI assistant the current evidence and operating rules
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
