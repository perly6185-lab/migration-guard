import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupReplayPlan,
  findLatestIncompleteRun,
  runReplayPlan,
  validateReplayPlan,
} from "./l4c-replay-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(
  serviceRoot,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const caseRoot = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const defaultPlanPath = path.join(
  caseRoot,
  "evidence",
  "runtime",
  "l4c",
  "replay-plan.json",
);
const defaultReportPath = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
  "l4c-real-replay.json",
);
const defaultRunRoot = path.join(
  repositoryRoot,
  "artifacts",
  "batch-update-rust",
  "l4c-runs",
);
const contractPath = path.join(
  caseRoot,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(renderHelp());
  process.exit(0);
}

const planPath = path.resolve(options.plan ?? defaultPlanPath);
const contract = await readJson(contractPath);
const plan = await readJson(planPath);
let scenarioFilter = options.scenarios.length > 0
  ? options.scenarios
  : undefined;

if (options.cleanupOnly) {
  if (!options.execute) {
    throw new Error("--cleanup-only also requires --execute");
  }
  if (!options.runId && !options.latestIncomplete) {
    throw new Error(
      "--cleanup-only requires --run-id or --latest-incomplete",
    );
  }
  if (options.runId && options.latestIncomplete) {
    throw new Error("--run-id and --latest-incomplete are mutually exclusive");
  }
  if (options.latestIncomplete) {
    const latest = await findLatestIncompleteRun(defaultRunRoot);
    if (!latest) throw new Error("no incomplete L4-C run was found");
    options.runId = latest.checkpoint.runId;
    if (!scenarioFilter) {
      scenarioFilter = latest.checkpoint.scenarios.map(
        (scenario) => scenario.scenarioId,
      );
    }
  }
  const result = await cleanupReplayPlan(plan, contract, {
    repositoryRoot,
    runId: options.runId,
    scenarioFilter,
    requireCheckpoint: options.latestIncomplete,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
} else if (!options.execute) {
  const preflight = validateReplayPlan(plan, contract, {
    repositoryRoot,
    scenarioFilter,
    allowPartialScenarios: Boolean(scenarioFilter),
  });
  const result = {
    schemaVersion: 1,
    stage: "batch-update-l4c-preflight",
    status: preflight.findings.length === 0 ? "ready" : "blocked",
    planPath,
    projectId: contract.projectId,
    projectHash: contract.projectHash,
    scenarioCount: preflight.scenarios.length,
    completeScenarioSet: preflight.completeScenarioSet,
    findings: preflight.findings,
    next:
      preflight.findings.length === 0
        ? "Set both execution approval variables and rerun with --execute."
        : "Resolve every finding; template or partial plans cannot execute.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "ready") process.exitCode = 1;
} else {
  const report = await runReplayPlan(plan, contract, {
    repositoryRoot,
    runId: options.runId,
    scenarioFilter,
    allowPartialScenarios: Boolean(scenarioFilter),
  });
  const outputPath = path.resolve(options.output ?? defaultReportPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: report.status,
    decision: report.decision,
    realEligible: report.realEligible,
    runId: report.runId,
    scenarioCount: report.scenarioCount,
    cleanupVerified: report.cleanupVerified,
    dualReplayPassed: report.dualReplayPassed,
    reportHash: report.reportHash,
    outputPath,
  }, null, 2));
  if (!report.realEligible) process.exitCode = 1;
}

function parseArguments(args) {
  const result = {
    cleanupOnly: false,
    execute: false,
    help: false,
    latestIncomplete: false,
    scenarios: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--cleanup-only") result.cleanupOnly = true;
    else if (value === "--execute") result.execute = true;
    else if (value === "--latest-incomplete") result.latestIncomplete = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--plan") result.plan = requiredValue(args, ++index, value);
    else if (value === "--output") {
      result.output = requiredValue(args, ++index, value);
    } else if (value === "--run-id") {
      result.runId = requiredValue(args, ++index, value);
    } else if (value === "--scenario") {
      result.scenarios.push(requiredValue(args, ++index, value));
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return result;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function renderHelp() {
  return `zboss batch-update L4-C real dual replay

Preflight:
  node l4c-real-replay.mjs --plan <approved-plan.json>

Execute all contract scenarios:
  node l4c-real-replay.mjs --plan <approved-plan.json> --execute

Execute a development subset (never L4-C eligible):
  node l4c-real-replay.mjs --plan <approved-plan.json> --scenario <id> --execute

Recover marker-bound cleanup:
  node l4c-real-replay.mjs --plan <approved-plan.json> --cleanup-only --run-id <id> --execute
  node l4c-real-replay.mjs --plan <approved-plan.json> --cleanup-only --latest-incomplete --execute

Real execution additionally requires:
  MG_L4C_REAL_WRITE_APPROVED=zboss-batch-update-with-progress:disposable-write
  MG_L4C_APPROVAL_NONCE=<value whose SHA-256 is in the approved plan>

Sensitive values are inherited only from environment variable names listed by
environmentValueBindings. Commands are spawned directly without a shell.`;
}
