import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const PLAN_PROTOCOL = "migration-guard.batch-update-l4c-plan/v1";
export const OPERATION_PROTOCOL = "migration-guard.batch-update-l4c-operation/v1";
export const FAULT_PROTOCOL =
  "migration-guard.batch-update-l4c-fault-controller/v1";
export const REPORT_PROTOCOL = "migration-guard.batch-update-l4c-replay/v1";
export const REVIEW_PROTOCOL = "migration-guard.batch-update-l4c-review/v1";
export const WRITE_APPROVAL =
  "zboss-batch-update-with-progress:disposable-write";

const REQUIRED_OPERATIONS = [
  "health",
  "seed",
  "snapshot",
  "invoke",
  "collect",
  "cleanup",
  "verifyCleanup",
];
const OPTIONAL_OPERATIONS = ["setup", "start", "injectFault", "stop"];
const FORBIDDEN_PROGRAMS = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "command.com",
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "zsh",
]);
const SAFE_ENVIRONMENTS = new Set([
  "development",
  "local",
  "sandbox",
  "staging",
  "test",
]);
const CLEANUP_COUNTERS = [
  "fixtureRows",
  "undoRows",
  "outboxRows",
  "commitRows",
  "redisKeys",
  "leaseKeys",
  "schemaArtifacts",
  "faultArtifacts",
];
const REDACTED_KEY = /authorization|cookie|credential|password|secret|token/i;
const PLACEHOLDER = /<[^>]+>/;
const TERMINAL_STATUSES = new Set(["SUCCESS", "PARTIAL_FAILED", "FAILED"]);

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function findLatestIncompleteRun(outputRoot) {
  const root = path.resolve(outputRoot);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9-]{6,48}$/.test(entry.name)) {
      continue;
    }
    const checkpointPath = path.join(root, entry.name, "checkpoint.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    if (
      checkpoint
      && (
        ["cleanup-required", "running"].includes(checkpoint.status)
        || (
          checkpoint.status === "blocked"
          && checkpoint.cleanupVerified !== true
        )
      )
    ) {
      candidates.push({ checkpointPath, checkpoint });
    }
  }
  candidates.sort((left, right) =>
    Date.parse(right.checkpoint.updatedAt)
      - Date.parse(left.checkpoint.updatedAt));
  return candidates[0];
}

export function validateReplayPlan(plan, contract, options = {}) {
  const findings = [];
  const execute = options.execute === true;
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const now = options.now ?? Date.now();
  const scenarioFilter = options.scenarioFilter
    ? new Set(options.scenarioFilter)
    : undefined;

  if (!plan || typeof plan !== "object") {
    return { findings: ["MG-L4C-PLAN-MISSING"], scenarios: [] };
  }
  if (plan.schemaVersion !== 1 || plan.protocol !== PLAN_PROTOCOL) {
    findings.push("MG-L4C-PLAN-PROTOCOL-INVALID");
  }
  if (plan.status !== "approved") findings.push("MG-L4C-PLAN-NOT-APPROVED");
  if (plan.projectId !== contract.projectId) {
    findings.push("MG-L4C-PLAN-PROJECT-ID-MISMATCH");
  }
  if (plan.projectHash !== contract.projectHash) {
    findings.push("MG-L4C-PLAN-PROJECT-HASH-MISMATCH");
  }
  if (plan.runtimeContractHash !== contract.contractHash) {
    findings.push("MG-L4C-PLAN-RUNTIME-CONTRACT-MISMATCH");
  }

  validateApproval(
    plan.approval,
    now,
    execute,
    findings,
    options.allowExpiredApproval === true,
  );
  validateScope(plan.scope, findings);
  validateTargets(plan.targets, plan.scope, repositoryRoot, findings);

  const contractScenarios = contract.entries.flatMap((entry) =>
    entry.scenarios.map((scenario) => ({
      entrypointId: entry.id,
      ...scenario,
    })));
  const configuredIds = Array.isArray(plan.scenarios)
    ? plan.scenarios
    : contractScenarios.map((scenario) => scenario.id);
  if (new Set(configuredIds).size !== configuredIds.length) {
    findings.push("MG-L4C-PLAN-SCENARIO-DUPLICATE");
  }
  const unknown = configuredIds.filter(
    (id) => !contractScenarios.some((scenario) => scenario.id === id),
  );
  findings.push(...unknown.map((id) => `MG-L4C-PLAN-SCENARIO-UNKNOWN:${id}`));
  const missing = contractScenarios.filter(
    (scenario) => !configuredIds.includes(scenario.id),
  );
  if (!options.allowPartialScenarios) {
    findings.push(
      ...missing.map((scenario) =>
        `MG-L4C-PLAN-SCENARIO-MISSING:${scenario.id}`),
    );
  }
  if (scenarioFilter) {
    for (const id of scenarioFilter) {
      if (!configuredIds.includes(id)) {
        findings.push(`MG-L4C-SCENARIO-FILTER-UNKNOWN:${id}`);
      }
    }
  }
  const scenarios = contractScenarios.filter(
    (scenario) =>
      configuredIds.includes(scenario.id)
      && (!scenarioFilter || scenarioFilter.has(scenario.id)),
  );
  if (scenarios.length === 0) findings.push("MG-L4C-SCENARIO-SET-EMPTY");
  validateNormalization(plan.normalization, scenarios, findings);

  const secrets = Array.isArray(plan.environmentValueBindings)
    ? plan.environmentValueBindings
    : [];
  for (const variable of secrets) {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(variable)) {
      findings.push(`MG-L4C-SECRET-ENV-NAME-INVALID:${variable}`);
    } else if (execute && !process.env[variable]) {
      findings.push(`MG-L4C-SECRET-ENV-MISSING:${variable}`);
    }
  }
  const requiredEnvironment = Array.isArray(plan.requiredEnvironment)
    ? plan.requiredEnvironment
    : [];
  for (const variable of requiredEnvironment) {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(variable)) {
      findings.push(`MG-L4C-ENV-NAME-INVALID:${variable}`);
    } else if (execute && !process.env[variable]) {
      findings.push(`MG-L4C-ENV-MISSING:${variable}`);
    }
  }
  return {
    findings: [...new Set(findings)].sort(),
    scenarios,
    completeScenarioSet: missing.length === 0
      && scenarios.length === contractScenarios.length,
  };
}

export async function runReplayPlan(plan, contract, options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const execution = validateReplayPlan(plan, contract, {
    ...options,
    execute: true,
    repositoryRoot,
  });
  const findings = [...execution.findings];
  if (!options.synthetic) {
    if (process.env.MG_L4C_REAL_WRITE_APPROVED !== WRITE_APPROVAL) {
      findings.push("MG-L4C-EXECUTION-APPROVAL-MISSING");
    }
    const suppliedNonce = process.env.MG_L4C_APPROVAL_NONCE ?? "";
    if (
      !/^[a-f0-9]{64}$/.test(plan.approval?.executionNonceSha256 ?? "")
      || stableHash(suppliedNonce)
        !== plan.approval?.executionNonceSha256
    ) {
      findings.push("MG-L4C-EXECUTION-NONCE-MISMATCH");
    }
  }
  if (findings.length > 0) {
    throw new Error([...new Set(findings)].sort().join(", "));
  }

  const runId = options.runId ?? createRunId();
  validateRunId(runId);
  const executedAt = new Date(options.now ?? Date.now()).toISOString();
  const secretValues = (plan.environmentValueBindings ?? [])
    .map((name) => process.env[name])
    .filter(Boolean);
  const context = {
    contract,
    plan,
    repositoryRoot,
    runId,
    scenarios: execution.scenarios,
    secretValues,
    operationExecutor: options.operationExecutor ?? executeOperation,
    outputRoot: path.resolve(
      options.outputRoot
        ?? path.join(repositoryRoot, "artifacts", "batch-update-rust", "l4c-runs"),
      runId,
    ),
  };
  if (!options.synthetic) {
    ensureNested(repositoryRoot, context.outputRoot, "run output");
  }
  const scopeLock = await acquireScopeLock(plan.scope, context.outputRoot, runId);
  context.checkpoint = createCheckpoint(plan, execution, runId, executedAt);
  context.checkpointPath = path.join(context.outputRoot, "checkpoint.json");

  try {
    await persistCheckpoint(context);
    const targets = {};
    for (const targetKind of ["source", "target"]) {
      targets[targetKind] = await runTarget(targetKind, context);
    }
    const comparisons = compareTargets(
      targets.source,
      targets.target,
      plan.normalization,
    );
    const cleanupVerified = ["source", "target"].every((targetKind) =>
      targets[targetKind].scenarios.every((scenario) =>
        scenario.cleanupVerified));
    const scenarioParity = comparisons.every((comparison) =>
      comparison.equal);
    const status = targets.source.status === "passed"
        && targets.target.status === "passed"
        && cleanupVerified
        && scenarioParity
      ? "pass"
      : "blocked";
    const payload = {
      schemaVersion: 1,
      protocol: REPORT_PROTOCOL,
      stage: "batch-update-l4c-real-dual-replay",
      status,
      decision: status === "pass" ? "L4-C-EVIDENCE-READY" : "KEEP-L4-B",
      synthetic: options.synthetic === true,
      realEligible:
        status === "pass"
        && options.synthetic !== true
        && execution.completeScenarioSet,
      projectId: contract.projectId,
      projectHash: contract.projectHash,
      runtimeContractHash: contract.contractHash,
      sourceIdentity: contract.sourceIdentity,
      planHash: stableHash(plan),
      runId,
      executedAt,
      evidenceMaxAgeHours: 24,
      producer: {
        tool: "migration-guard-batch-update-l4c-replay",
        version: 1,
        command: "npm run batch-rust:l4c-run",
        identity: "migration-guard:l4c-replay",
      },
      scope: redactValue(plan.scope, secretValues),
      approval: {
        approvedBy: plan.approval.approvedBy,
        ticket: plan.approval.ticket,
        approvedAt: plan.approval.approvedAt,
        expiresAt: plan.approval.expiresAt,
        executionNonceSha256: plan.approval.executionNonceSha256,
      },
      completeScenarioSet: execution.completeScenarioSet,
      scenarioCount: execution.scenarios.length,
      cleanupVerified,
      dualReplayPassed: scenarioParity,
      targets,
      comparisons,
      findings: [
        ...targets.source.findings,
        ...targets.target.findings,
        ...comparisons
          .filter((comparison) => !comparison.equal)
          .map((comparison) =>
            `MG-L4C-DUAL-REPLAY-MISMATCH:${comparison.scenarioId}`),
        ...(cleanupVerified ? [] : ["MG-L4C-CLEANUP-NOT-VERIFIED"]),
      ].sort(),
    };
    const report = { ...payload, reportHash: stableHash(payload) };
    context.checkpoint.status = status === "pass" ? "completed" : "blocked";
    context.checkpoint.reportHash = report.reportHash;
    context.checkpoint.cleanupVerified = cleanupVerified;
    await persistCheckpoint(context);
    return report;
  } catch (error) {
    context.checkpoint.status = "cleanup-required";
    context.checkpoint.error = redactError(error, secretValues);
    await persistCheckpoint(context);
    throw error;
  } finally {
    await releaseScopeLock(scopeLock, runId);
  }
}

export async function cleanupReplayPlan(plan, contract, options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const execution = validateReplayPlan(plan, contract, {
    ...options,
    execute: true,
    repositoryRoot,
    allowPartialScenarios: true,
    allowExpiredApproval: true,
  });
  if (!options.synthetic
    && process.env.MG_L4C_REAL_WRITE_APPROVED !== WRITE_APPROVAL) {
    execution.findings.push("MG-L4C-EXECUTION-APPROVAL-MISSING");
  }
  if (!options.synthetic) {
    const suppliedNonce = process.env.MG_L4C_APPROVAL_NONCE ?? "";
    if (
      !/^[a-f0-9]{64}$/.test(plan.approval?.executionNonceSha256 ?? "")
      || stableHash(suppliedNonce)
        !== plan.approval?.executionNonceSha256
    ) {
      execution.findings.push("MG-L4C-EXECUTION-NONCE-MISMATCH");
    }
  }
  if (execution.findings.length > 0) {
    throw new Error([...new Set(execution.findings)].sort().join(", "));
  }
  validateRunId(options.runId);
  const secretValues = (plan.environmentValueBindings ?? [])
    .map((name) => process.env[name])
    .filter(Boolean);
  const context = {
    contract,
    plan,
    repositoryRoot,
    runId: options.runId,
    scenarios: execution.scenarios,
    secretValues,
    operationExecutor: options.operationExecutor ?? executeOperation,
    outputRoot: path.resolve(
      options.outputRoot
        ?? path.join(repositoryRoot, "artifacts", "batch-update-rust", "l4c-runs"),
      options.runId,
    ),
  };
  if (!options.synthetic) {
    ensureNested(repositoryRoot, context.outputRoot, "run output");
  }
  context.checkpointPath = path.join(context.outputRoot, "checkpoint.json");
  const existingCheckpoint = await readCheckpoint(context.checkpointPath);
  const expectedScopeHash = stableHash({
    environment: plan.scope.environment,
    database: plan.scope.database,
    tenantId: plan.scope.tenantId,
    panelId: plan.scope.panelId,
    table: plan.scope.table,
  });
  if (
    existingCheckpoint
    && (
      existingCheckpoint.planHash !== stableHash(plan)
      || existingCheckpoint.scopeHash !== expectedScopeHash
    )
  ) {
    throw new Error("MG-L4C-CLEANUP-CHECKPOINT-BINDING-MISMATCH");
  }
  if (!existingCheckpoint && options.requireCheckpoint) {
    throw new Error("MG-L4C-CLEANUP-CHECKPOINT-MISSING");
  }
  context.checkpoint = existingCheckpoint
    ?? createCheckpoint(
      plan,
      execution,
      options.runId,
      new Date(options.now ?? Date.now()).toISOString(),
    );
  const scopeLock = await acquireScopeLock(
    plan.scope,
    context.outputRoot,
    options.runId,
  );
  const results = [];
  try {
    for (const targetKind of ["source", "target"]) {
      for (const scenario of execution.scenarios) {
        const marker = buildMarker(
          plan.scope.markerPrefix,
          options.runId,
          scenario.id,
        );
        const cleanup = await runOperation(
          targetKind,
          "cleanup",
          scenario,
          marker,
          context,
        );
        const verification = await runOperation(
          targetKind,
          "verifyCleanup",
          scenario,
          marker,
          context,
        );
        results.push({
          targetKind,
          scenarioId: scenario.id,
          marker,
          cleanup,
          verification,
          cleanupVerified: cleanupIsZero(verification.cleanup),
        });
      }
    }
    context.checkpoint.status = results.every((result) =>
        result.cleanupVerified)
      ? "recovered"
      : "cleanup-required";
    context.checkpoint.cleanupVerified =
      context.checkpoint.status === "recovered";
    await persistCheckpoint(context);
  } finally {
    await releaseScopeLock(scopeLock, options.runId);
  }
  return {
    schemaVersion: 1,
    status: results.every((result) => result.cleanupVerified)
      ? "passed"
      : "blocked",
    runId: options.runId,
    results,
  };
}

export function validateReplayReport(report, contract, review, now = Date.now()) {
  const findings = [];
  if (!report || report.protocol !== REPORT_PROTOCOL || report.schemaVersion !== 1) {
    return ["MG-L4C-REPORT-PROTOCOL-INVALID"];
  }
  if (report.reportHash !== stableHash({ ...report, reportHash: undefined })) {
    findings.push("MG-L4C-REPORT-HASH-MISMATCH");
  }
  if (report.status !== "pass") findings.push("MG-L4C-REPORT-BLOCKED");
  if (report.synthetic !== false || report.realEligible !== true) {
    findings.push("MG-L4C-REPORT-NOT-REAL");
  }
  if (
    report.projectId !== contract.projectId
    || report.projectHash !== contract.projectHash
    || report.runtimeContractHash !== contract.contractHash
  ) {
    findings.push("MG-L4C-REPORT-CONTRACT-MISMATCH");
  }
  const expectedScenarios = contract.entries.flatMap((entry) =>
    entry.scenarios.map((scenario) => scenario.id));
  const actualScenarios = report.comparisons?.map((item) => item.scenarioId) ?? [];
  if (
    report.completeScenarioSet !== true
    || report.scenarioCount !== expectedScenarios.length
    || expectedScenarios.some((id) => !actualScenarios.includes(id))
  ) {
    findings.push("MG-L4C-REPORT-SCENARIO-COVERAGE-INCOMPLETE");
  }
  if (
    report.cleanupVerified !== true
    || ["source", "target"].some((kind) =>
      report.targets?.[kind]?.scenarios?.some((scenario) =>
        scenario.cleanupVerified !== true))
  ) {
    findings.push("MG-L4C-REPORT-CLEANUP-BLOCKED");
  }
  if (
    report.dualReplayPassed !== true
    || report.comparisons?.some((comparison) => comparison.equal !== true)
  ) {
    findings.push("MG-L4C-REPORT-DUAL-REPLAY-BLOCKED");
  }
  if (
    !report.producer?.tool
    || !report.producer?.command
    || report.producer?.identity !== "migration-guard:l4c-replay"
    || !/^[a-f0-9]{64}$/.test(report.planHash ?? "")
    || !/^[a-z0-9-]{6,48}$/.test(report.runId ?? "")
    || !Array.isArray(report.findings)
    || report.findings.length > 0
  ) {
    findings.push("MG-L4C-REPORT-PROVENANCE-INVALID");
  }
  const executedAt = Date.parse(report.executedAt ?? "");
  if (
    !Number.isFinite(executedAt)
    || executedAt > now + 300_000
    || now - executedAt > 86_400_000
  ) {
    findings.push("MG-L4C-REPORT-STALE");
  }
  const approvalStart = Date.parse(report.approval?.approvedAt ?? "");
  const approvalEnd = Date.parse(report.approval?.expiresAt ?? "");
  if (
    !report.approval?.approvedBy
    || !report.approval?.ticket
    || !Number.isFinite(approvalStart)
    || !Number.isFinite(approvalEnd)
    || approvalStart > executedAt
    || approvalEnd < executedAt
  ) {
    findings.push("MG-L4C-REPORT-WRITE-APPROVAL-INVALID");
  }
  if (
    !review
    || review.protocol !== REVIEW_PROTOCOL
    || review.schemaVersion !== 1
    || review.decision !== "approved"
    || review.evidenceReportHash !== report.reportHash
    || !review.identity
    || review.identity === report.producer?.identity
  ) {
    findings.push("MG-L4C-REPORT-INDEPENDENT-REVIEW-MISSING");
  } else {
    const reviewedAt = Date.parse(review.reviewedAt ?? "");
    if (
      !Number.isFinite(reviewedAt)
      || reviewedAt < executedAt
      || reviewedAt > now + 300_000
    ) {
      findings.push("MG-L4C-REPORT-INDEPENDENT-REVIEW-TIME-INVALID");
    }
  }
  validateReportScope(report, findings);
  validateReportTargetEvidence(report, contract, findings);
  return [...new Set(findings)].sort();
}

async function runTarget(targetKind, context) {
  const findings = [];
  const scenarios = [];
  let lifecycleStarted = false;
  try {
    for (const operation of ["setup", "start", "health"]) {
      if (context.plan.targets[targetKind].operations[operation]) {
        await runOperation(targetKind, operation, undefined, undefined, context);
        if (operation === "start") lifecycleStarted = true;
      }
    }
    for (const scenario of context.scenarios) {
      const marker = buildMarker(
        context.plan.scope.markerPrefix,
        context.runId,
        scenario.id,
      );
      scenarios.push(
        await runScenario(targetKind, scenario, marker, context),
      );
    }
  } catch (error) {
    findings.push(
      `MG-L4C-TARGET-EXECUTION:${targetKind}:${redactError(
        error,
        context.secretValues,
      )}`,
    );
  } finally {
    if (
      (lifecycleStarted
        || context.plan.targets[targetKind].operations.stop)
      && context.plan.targets[targetKind].operations.stop
    ) {
      try {
        await runOperation(targetKind, "stop", undefined, undefined, context);
      } catch (error) {
        findings.push(
          `MG-L4C-TARGET-STOP:${targetKind}:${redactError(
            error,
            context.secretValues,
          )}`,
        );
      }
    }
  }
  const passed =
    findings.length === 0
    && scenarios.length === context.scenarios.length
    && scenarios.every((scenario) =>
      scenario.status === "passed" && scenario.cleanupVerified);
  return {
    kind: targetKind,
    runtime: context.plan.targets[targetKind].kind,
    status: passed ? "passed" : "blocked",
    baseUrl: redactUrl(context.plan.targets[targetKind].baseUrl),
    scenarios,
    findings,
  };
}

async function runScenario(targetKind, scenario, marker, context) {
  const operations = {};
  const findings = [];
  let cleanupVerified = false;
  try {
    operations.seed = await runOperation(
      targetKind,
      "seed",
      scenario,
      marker,
      context,
    );
    operations.before = await runOperation(
      targetKind,
      "snapshot",
      scenario,
      marker,
      context,
      "before",
    );
    if (
      scenario.category === "fault"
      && context.plan.targets[targetKind].operations.injectFault
    ) {
      operations.injectFault = await runOperation(
        targetKind,
        "injectFault",
        scenario,
        marker,
        context,
      );
    }
    operations.invoke = await runOperation(
      targetKind,
      "invoke",
      scenario,
      marker,
      context,
      undefined,
      operations.seed?.bindings,
    );
    operations.after = await runOperation(
      targetKind,
      "snapshot",
      scenario,
      marker,
      context,
      "after",
    );
    operations.collect = await runOperation(
      targetKind,
      "collect",
      scenario,
      marker,
      context,
    );
    findings.push(...validateCanonicalObservation(
      operations.collect.observation,
      scenario,
      context.plan.scope,
      targetKind,
    ));
  } catch (error) {
    findings.push(
      `MG-L4C-SCENARIO-EXECUTION:${targetKind}:${scenario.id}:${redactError(
        error,
        context.secretValues,
      )}`,
    );
  } finally {
    try {
      operations.cleanup = await runOperation(
        targetKind,
        "cleanup",
        scenario,
        marker,
        context,
      );
      operations.verifyCleanup = await runOperation(
        targetKind,
        "verifyCleanup",
        scenario,
        marker,
        context,
      );
      cleanupVerified = cleanupIsZero(operations.verifyCleanup.cleanup);
      if (!cleanupVerified) {
        findings.push(
          `MG-L4C-CLEANUP-RESIDUE:${targetKind}:${scenario.id}`,
        );
      }
    } catch (error) {
      findings.push(
        `MG-L4C-CLEANUP-FAILED:${targetKind}:${scenario.id}:${redactError(
          error,
          context.secretValues,
        )}`,
      );
    }
  }
  const semantic = {
    before: operations.before?.snapshot,
    invoke: operations.invoke?.response,
    after: operations.after?.snapshot,
    observation: operations.collect?.observation,
  };
  const normalizedSemantic = normalizeSemantic(
    semantic,
    marker,
    context.plan.targets[targetKind].baseUrl,
    context.plan.normalization,
  );
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    marker,
    status: findings.length === 0 ? "passed" : "blocked",
    semanticHash: stableHash(normalizedSemantic),
    normalizedSemantic,
    cleanupVerified,
    operations: redactValue(operations, context.secretValues),
    findings,
  };
}

async function runOperation(
  targetKind,
  operation,
  scenario,
  marker,
  context,
  phase,
  seedBindings,
) {
  const definition =
    context.plan.targets[targetKind].operations[operation];
  if (!definition) throw new Error(`operation is not configured: ${operation}`);
  const operationContext = {
    targetKind,
    operation,
    scenarioId: scenario?.id,
    category: scenario?.category,
    marker,
    phase,
    runId: context.runId,
    outputRoot: context.outputRoot,
    scope: context.plan.scope,
    baseUrl: context.plan.targets[targetKind].baseUrl,
    seedBindings,
  };
  const raw = await context.operationExecutor(
    definition,
    operationContext,
    context,
  );
  const value = redactValue(raw, context.secretValues);
  validateOperationResult(value, operation, marker, context.plan.scope);
  await recordCheckpoint(context, {
    targetKind,
    operation,
    scenarioId: scenario?.id,
    marker,
    phase,
    status: "passed",
    outputHash: stableHash(value),
  });
  return value;
}

async function executeOperation(definition, operationContext, context) {
  const replacements = {
    baseUrl: operationContext.baseUrl,
    category: operationContext.category ?? "",
    marker: operationContext.marker ?? "",
    operation: operationContext.operation,
    outputRoot: operationContext.outputRoot,
    phase: operationContext.phase ?? "",
    runId: operationContext.runId,
    scenarioId: operationContext.scenarioId ?? "",
    targetKind: operationContext.targetKind,
  };
  const args = definition.args.map((argument) =>
    replacePlaceholders(argument, replacements));
  const cwd = path.resolve(
    context.repositoryRoot,
    definition.cwd ?? ".",
  );
  ensureNested(context.repositoryRoot, cwd, "operation cwd");
  const environment = {
    ...process.env,
    MG_L4C_BASE_URL: operationContext.baseUrl,
    MG_L4C_CATEGORY: operationContext.category ?? "",
    MG_L4C_DATABASE: context.plan.scope.database,
    MG_L4C_MARKER: operationContext.marker ?? "",
    MG_L4C_MAX_ROWS: String(context.plan.scope.maxRowsPerScenario),
    MG_L4C_OPERATION: operationContext.operation,
    MG_L4C_OUTPUT_ROOT: context.outputRoot,
    MG_L4C_PANEL_ID: String(context.plan.scope.panelId),
    MG_L4C_PHASE: operationContext.phase ?? "",
    MG_L4C_RUN_ID: operationContext.runId,
    MG_L4C_SCENARIO_ID: operationContext.scenarioId ?? "",
    MG_L4C_TABLE: context.plan.scope.table,
    MG_L4C_TARGET_KIND: operationContext.targetKind,
    MG_L4C_TENANT_ID: String(context.plan.scope.tenantId),
    ...(operationContext.seedBindings
      ? {
          MG_L4C_SEED_BINDINGS: JSON.stringify(
            operationContext.seedBindings,
          ),
        }
      : {}),
  };
  try {
    return await spawnJson(
      definition.program,
      args,
      cwd,
      environment,
      definition.timeoutMs ?? 120_000,
    );
  } catch (error) {
    throw new Error(redactError(error, context.secretValues));
  }
}

function validateApproval(
  approval,
  now,
  execute,
  findings,
  allowExpiredApproval = false,
) {
  if (
    !approval
    || approval.mode !== "disposable-test-write"
    || typeof approval.approvedBy !== "string"
    || !approval.approvedBy.trim()
    || PLACEHOLDER.test(approval.approvedBy)
    || typeof approval.ticket !== "string"
    || !approval.ticket.trim()
    || PLACEHOLDER.test(approval.ticket)
  ) {
    findings.push("MG-L4C-PLAN-WRITE-APPROVAL-INVALID");
    return;
  }
  const approvedAt = Date.parse(approval.approvedAt ?? "");
  const expiresAt = Date.parse(approval.expiresAt ?? "");
  if (
    !Number.isFinite(approvedAt)
    || !Number.isFinite(expiresAt)
    || approvedAt > now + 300_000
    || expiresAt <= approvedAt
    || expiresAt - approvedAt > 86_400_000
    || (!allowExpiredApproval && expiresAt <= now)
  ) {
    findings.push("MG-L4C-PLAN-WRITE-APPROVAL-EXPIRED");
  }
  if (
    execute
    && !/^[a-f0-9]{64}$/.test(approval.executionNonceSha256 ?? "")
  ) {
    findings.push("MG-L4C-PLAN-EXECUTION-NONCE-INVALID");
  }
}

function validateScope(scope, findings) {
  if (!scope || !SAFE_ENVIRONMENTS.has(scope.environment)) {
    findings.push("MG-L4C-SCOPE-ENVIRONMENT-UNSAFE");
    if (!scope) return;
  }
  if (
    typeof scope.database !== "string"
    || !/(dev|fixture|migration|sandbox|staging|test)/i.test(scope.database)
    || /prod|production/i.test(scope.database)
  ) {
    findings.push("MG-L4C-SCOPE-DATABASE-UNSAFE");
  }
  for (const key of ["tenantId", "panelId"]) {
    if (
      !String(scope[key] ?? "").trim()
      || PLACEHOLDER.test(String(scope[key]))
    ) {
      findings.push(`MG-L4C-SCOPE-${key.toUpperCase()}-INVALID`);
    }
  }
  if (!/^cust_table\d+$/.test(scope.table ?? "")) {
    findings.push("MG-L4C-SCOPE-TABLE-UNSAFE");
  }
  if (
    !/^mg-l4c-[a-z0-9-]{0,24}$/.test(scope.markerPrefix ?? "")
    || scope.markerPrefix.length > 32
  ) {
    findings.push("MG-L4C-SCOPE-MARKER-PREFIX-INVALID");
  }
  if (
    !Number.isInteger(scope.maxRowsPerScenario)
    || scope.maxRowsPerScenario < 1
    || scope.maxRowsPerScenario > 100
  ) {
    findings.push("MG-L4C-SCOPE-ROW-LIMIT-UNSAFE");
  }
  if (scope.schemaChangesAllowed !== false) {
    findings.push("MG-L4C-SCOPE-SCHEMA-CHANGE-NOT-DISABLED");
  }
  if (
    !Array.isArray(scope.allowedHosts)
    || scope.allowedHosts.length === 0
    || scope.allowedHosts.some((host) =>
      typeof host !== "string" || !host.trim() || PLACEHOLDER.test(host))
  ) {
    findings.push("MG-L4C-SCOPE-HOST-ALLOWLIST-INVALID");
  }
}

function validateTargets(targets, scope, repositoryRoot, findings) {
  for (const [targetKind, expectedRuntime] of [
    ["source", "java"],
    ["target", "rust"],
  ]) {
    const target = targets?.[targetKind];
    if (!target || target.kind !== expectedRuntime) {
      findings.push(`MG-L4C-TARGET-KIND-INVALID:${targetKind}`);
      continue;
    }
    let url;
    try {
      url = new URL(target.baseUrl);
    } catch {
      findings.push(`MG-L4C-TARGET-URL-INVALID:${targetKind}`);
      continue;
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || !scope?.allowedHosts?.includes(url.hostname)
      || /prod|production/i.test(url.hostname)
    ) {
      findings.push(`MG-L4C-TARGET-URL-UNSAFE:${targetKind}`);
    }
    for (const operation of REQUIRED_OPERATIONS) {
      if (!target.operations?.[operation]) {
        findings.push(
          `MG-L4C-TARGET-OPERATION-MISSING:${targetKind}:${operation}`,
        );
      }
    }
    for (const [operation, definition] of Object.entries(
      target.operations ?? {},
    )) {
      if (
        !REQUIRED_OPERATIONS.includes(operation)
        && !OPTIONAL_OPERATIONS.includes(operation)
      ) {
        findings.push(
          `MG-L4C-TARGET-OPERATION-UNKNOWN:${targetKind}:${operation}`,
        );
      }
      validateOperationDefinition(
        definition,
        targetKind,
        operation,
        repositoryRoot,
        findings,
      );
    }
  }
}

function validateOperationDefinition(
  definition,
  targetKind,
  operation,
  repositoryRoot,
  findings,
) {
  const prefix = `MG-L4C-TARGET-OPERATION-INVALID:${targetKind}:${operation}`;
  if (
    !definition
    || typeof definition.program !== "string"
    || !definition.program.trim()
    || PLACEHOLDER.test(definition.program)
    || /[\r\n\0]/.test(definition.program)
    || FORBIDDEN_PROGRAMS.has(path.basename(definition.program).toLowerCase())
    || !Array.isArray(definition.args)
    || definition.args.some((argument) =>
      typeof argument !== "string" || /[\r\n\0]/.test(argument))
  ) {
    findings.push(prefix);
    return;
  }
  if (
    definition.timeoutMs !== undefined
    && (
      !Number.isInteger(definition.timeoutMs)
      || definition.timeoutMs < 1_000
      || definition.timeoutMs > 300_000
    )
  ) {
    findings.push(`${prefix}:timeout`);
  }
  try {
    ensureNested(
      repositoryRoot,
      path.resolve(repositoryRoot, definition.cwd ?? "."),
      "operation cwd",
    );
  } catch {
    findings.push(`${prefix}:cwd`);
  }
}

function validateNormalization(normalization, scenarios, findings) {
  const paths = normalization?.ignorePaths ?? [];
  if (
    normalization?.profile !== undefined
    && normalization.profile !== "batch-update-contract-v1"
  ) {
    findings.push("MG-L4C-NORMALIZATION-PROFILE-INVALID");
  }
  const supportedScenarios = normalization?.supportedScenarios;
  if (normalization?.profile === "batch-update-contract-v1") {
    if (
      !Array.isArray(supportedScenarios)
      || supportedScenarios.length === 0
      || new Set(supportedScenarios).size !== supportedScenarios.length
      || supportedScenarios.some((scenarioId) =>
        typeof scenarioId !== "string"
        || !/^[A-Za-z0-9._:-]{3,128}$/.test(scenarioId))
    ) {
      findings.push("MG-L4C-NORMALIZATION-SCENARIOS-INVALID");
    } else {
      for (const scenario of scenarios) {
        if (!supportedScenarios.includes(scenario.id)) {
          findings.push(
            `MG-L4C-NORMALIZATION-SCENARIO-UNSUPPORTED:${scenario.id}`,
          );
        }
      }
    }
  } else if (supportedScenarios !== undefined) {
    findings.push("MG-L4C-NORMALIZATION-SCENARIOS-UNEXPECTED");
  }
  if (!Array.isArray(paths)) {
    findings.push("MG-L4C-NORMALIZATION-INVALID");
    return;
  }
  for (const value of paths) {
    if (
      typeof value !== "string"
      || !/^[A-Za-z0-9_.[\]-]+$/.test(value)
      || /response\.(code|status)|effects|state|failures/i.test(value)
    ) {
      findings.push(`MG-L4C-NORMALIZATION-PATH-UNSAFE:${value}`);
    }
  }
}

function validateOperationResult(value, operation, marker, scope) {
  if (
    !value
    || value.schemaVersion !== 1
    || value.protocol !== OPERATION_PROTOCOL
    || value.status !== "passed"
  ) {
    throw new Error(`invalid operation result: ${operation}`);
  }
  if (marker) {
    if (
      value.scope?.marker !== marker
      || String(value.scope?.tenantId) !== String(scope.tenantId)
      || String(value.scope?.panelId) !== String(scope.panelId)
      || value.scope?.table !== scope.table
      || value.scope?.database !== scope.database
      || !Number.isInteger(value.scope?.rowCount)
      || value.scope.rowCount < 0
      || value.scope.rowCount > scope.maxRowsPerScenario
    ) {
      throw new Error(`operation escaped approved scope: ${operation}`);
    }
  }
  if (
    operation === "injectFault"
    && !validFaultEvidence(value.fault, marker)
  ) {
    throw new Error("fault controller evidence is invalid");
  }
  if (
    operation === "seed"
    && (
      !value.bindings
      || typeof value.bindings !== "object"
      || Array.isArray(value.bindings)
      || Object.keys(value.bindings).length !== value.scope?.rowCount
    )
  ) {
    throw new Error("seed operation bindings are incomplete");
  }
  if (
    operation === "verifyCleanup"
    && (
      !value.cleanup
      || CLEANUP_COUNTERS.some((counter) =>
        !Number.isInteger(value.cleanup[counter])
        || value.cleanup[counter] < 0)
    )
  ) {
    throw new Error("cleanup verification counters are incomplete");
  }
}

function validateReportScope(report, findings) {
  const scope = report.scope;
  if (
    !scope
    || !SAFE_ENVIRONMENTS.has(scope.environment)
    || /prod|production/i.test(scope.environment)
    || typeof scope.database !== "string"
    || !/(dev|fixture|migration|sandbox|staging|test)/i.test(scope.database)
    || /prod|production/i.test(scope.database)
    || !/^cust_table\d+$/.test(scope.table ?? "")
    || scope.schemaChangesAllowed !== false
    || !Number.isInteger(scope.maxRowsPerScenario)
    || scope.maxRowsPerScenario < 1
    || scope.maxRowsPerScenario > 100
    || !Array.isArray(scope.allowedHosts)
    || scope.allowedHosts.length === 0
  ) {
    findings.push("MG-L4C-REPORT-DISPOSABLE-SCOPE-INVALID");
    return;
  }
  for (const targetKind of ["source", "target"]) {
    try {
      const targetUrl = new URL(report.targets?.[targetKind]?.baseUrl);
      if (
        !scope.allowedHosts.includes(targetUrl.hostname)
        || /prod|production/i.test(targetUrl.hostname)
      ) {
        findings.push(`MG-L4C-REPORT-TARGET-SCOPE-INVALID:${targetKind}`);
      }
    } catch {
      findings.push(`MG-L4C-REPORT-TARGET-SCOPE-INVALID:${targetKind}`);
    }
  }
}

function validateReportTargetEvidence(report, contract, findings) {
  const scenarioContracts = new Map(
    contract.entries.flatMap((entry) =>
      entry.scenarios.map((scenario) => [scenario.id, scenario])),
  );
  const targetScenarios = {};
  for (const [targetKind, runtime] of [["source", "java"], ["target", "rust"]]) {
    const target = report.targets?.[targetKind];
    if (
      !target
      || target.kind !== targetKind
      || target.runtime !== runtime
      || target.status !== "passed"
      || !Array.isArray(target.scenarios)
      || target.scenarios.length !== scenarioContracts.size
      || !Array.isArray(target.findings)
      || target.findings.length > 0
    ) {
      findings.push(`MG-L4C-REPORT-TARGET-EVIDENCE-INVALID:${targetKind}`);
      continue;
    }
    targetScenarios[targetKind] = new Map();
    for (const scenario of target.scenarios) {
      if (
        !scenarioContracts.has(scenario.scenarioId)
        || targetScenarios[targetKind].has(scenario.scenarioId)
      ) {
        findings.push(
          `MG-L4C-REPORT-SCENARIO-EVIDENCE-INVALID:${targetKind}:${scenario.scenarioId}`,
        );
        continue;
      }
      targetScenarios[targetKind].set(scenario.scenarioId, scenario);
      const scenarioContract = scenarioContracts.get(scenario.scenarioId);
      const operations = scenario.operations ?? {};
      const requiredResults = [
        operations.seed,
        operations.before,
        operations.invoke,
        operations.after,
        operations.collect,
        operations.cleanup,
        operations.verifyCleanup,
      ];
      const stateResults = [
        operations.seed,
        operations.before,
        operations.after,
        operations.collect,
        operations.cleanup,
        operations.verifyCleanup,
      ];
      if (scenarioContract.category === "fault") {
        requiredResults.push(operations.injectFault);
      }
      if (
        scenario.status !== "passed"
        || scenario.cleanupVerified !== true
        || !scenario.marker?.startsWith(report.scope.markerPrefix)
        || !Array.isArray(scenario.findings)
        || scenario.findings.length > 0
        || scenario.semanticHash !== stableHash(scenario.normalizedSemantic)
        || requiredResults.some((result) =>
          !validReportedOperation(result, scenario.marker, report.scope))
        || !cleanupIsZero(operations.verifyCleanup?.cleanup)
      ) {
        findings.push(
          `MG-L4C-REPORT-SCENARIO-EVIDENCE-INVALID:${targetKind}:${scenario.scenarioId}`,
        );
      }
      if (
        targetKind === "source"
        && (
          stateResults.some((result) =>
            !/^[a-f0-9]{64}$/.test(result?.profileHash ?? ""))
          || new Set(stateResults.map((result) => result.profileHash)).size !== 1
        )
      ) {
        findings.push(
          `MG-L4C-REPORT-STATE-PROFILE-INVALID:${targetKind}:${scenario.scenarioId}`,
        );
      }
      if (
        !/^[a-f0-9]{64}$/.test(operations.seed?.seedHash ?? "")
      ) {
        findings.push(
          `MG-L4C-REPORT-SEED-PROFILE-INVALID:${targetKind}:${scenario.scenarioId}`,
        );
      }
      if (validateCanonicalObservation(
        operations.collect?.observation,
        scenarioContract,
        report.scope,
        targetKind,
      ).length > 0) {
        findings.push(
          `MG-L4C-REPORT-SCENARIO-DIMENSIONS-INCOMPLETE:${targetKind}:${scenario.scenarioId}`,
        );
      }
      if (
        scenarioContract.category === "fault"
        && !validFaultEvidence(operations.injectFault?.fault, scenario.marker)
      ) {
        findings.push(
          `MG-L4C-REPORT-FAULT-EVIDENCE-INVALID:${targetKind}:${scenario.scenarioId}`,
        );
      }
    }
  }
  for (const comparison of report.comparisons ?? []) {
    const source = targetScenarios.source?.get(comparison.scenarioId);
    const target = targetScenarios.target?.get(comparison.scenarioId);
    if (
      !source
      || !target
      || source.marker !== target.marker
      || comparison.equal !== true
      || comparison.sourceHash !== source.semanticHash
      || comparison.targetHash !== target.semanticHash
      || comparison.sourceHash !== comparison.targetHash
      || comparison.differenceCount !== 0
      || !Array.isArray(comparison.differences)
      || comparison.differences.length !== 0
      || comparison.differencesTruncated !== false
    ) {
      findings.push(
        `MG-L4C-REPORT-COMPARISON-EVIDENCE-INVALID:${comparison.scenarioId}`,
      );
    }
  }
}

function validReportedOperation(value, marker, scope) {
  return Boolean(value)
    && value.schemaVersion === 1
    && value.protocol === OPERATION_PROTOCOL
    && value.status === "passed"
    && /^[a-f0-9]{64}$/.test(value.bindingHash ?? "")
    && value.scope?.marker === marker
    && String(value.scope?.tenantId) === String(scope.tenantId)
    && String(value.scope?.panelId) === String(scope.panelId)
    && value.scope?.table === scope.table
    && value.scope?.database === scope.database
    && Number.isInteger(value.scope?.rowCount)
    && value.scope.rowCount >= 0
    && value.scope.rowCount <= scope.maxRowsPerScenario;
}

function validFaultEvidence(value, marker) {
  return Boolean(value)
    && value.schemaVersion === 1
    && value.protocol === FAULT_PROTOCOL
    && value.status === "passed"
    && value.action === "verify-active"
    && value.state === "active"
    && value.marker === marker
    && typeof value.scenarioId === "string"
    && value.scenarioId.length > 0
    && typeof value.mechanismId === "string"
    && /^[A-Za-z0-9._:-]{3,128}$/.test(value.mechanismId)
    && typeof value.resourceId === "string"
    && value.resourceId.includes(marker)
    && value.restoreRequired === true
    && Number.isInteger(value.artifactCount)
    && value.artifactCount > 0
    && /^[a-f0-9]{64}$/.test(value.applyHash ?? "");
}

export function validateCanonicalObservation(
  observation,
  scenario,
  scope,
  targetKind = "unknown",
) {
  const findings = [];
  const dimensions = observation?.dimensions;
  const prefix = `MG-L4C-OBSERVATION:${targetKind}:${scenario.id}`;
  if (!isPlainObject(dimensions)) {
    return [`${prefix}:dimensions`];
  }
  for (const required of scenario.requiredDimensions) {
    if (!isPlainObject(dimensions[required])
      || dimensions[required].verified !== true) {
      findings.push(`${prefix}:${required}`);
    }
  }
  if (
    dimensions.http?.collector !== "operation-driver"
  ) {
    findings.push(`${prefix}:http-collector`);
  }
  if (
    String(dimensions.context?.tenantId) !== String(scope.tenantId)
    || String(dimensions.context?.panelId) !== String(scope.panelId)
    || dimensions.context?.database !== scope.database
    || dimensions.context?.table !== scope.table
  ) {
    findings.push(`${prefix}:context-scope`);
  }
  if (dimensions.decisions?.scenarioId !== scenario.id) {
    findings.push(`${prefix}:decision-scenario`);
  }
  for (const counter of [
    "fixtureRows",
    "commitRows",
    "undoRows",
    "outboxRows",
  ]) {
    if (
      !Number.isInteger(dimensions.effects?.[counter])
      || dimensions.effects[counter] < 0
    ) {
      findings.push(`${prefix}:effects-${counter}`);
    }
  }
  if (!isPlainObject(dimensions.state?.mysql)) {
    findings.push(`${prefix}:state-mysql`);
  }
  const redisEvents = validRedisTerminalEvents(dimensions.events?.redis);
  const websocketEvents =
    dimensions.events?.collector === "websocket"
    && TERMINAL_STATUSES.has(dimensions.events?.terminalStatus)
    && Number.isFinite(dimensions.events?.terminalPercentage)
    && dimensions.events.terminalPercentage >= 0
    && dimensions.events.terminalPercentage <= 100;
  const noEvents = scenario.id === "validation-failure"
    && dimensions.events?.completionMode === "no-event"
    && dimensions.events?.eventCount === 0
    && ["websocket", "state-profile"].includes(
      dimensions.events?.collector,
    );
  if (
    dimensions.events?.verified !== true
    || (!redisEvents && !websocketEvents && !noEvents)
  ) {
    findings.push(`${prefix}:events`);
  }
  if (dimensions.failures?.markerScoped !== true) {
    findings.push(`${prefix}:failures-marker`);
  }
  if (
    scenario.requiredDimensions.includes("performance")
    && (
      !Number.isInteger(dimensions.performance?.rowCount)
      || dimensions.performance.rowCount < 0
      || dimensions.performance.rowCount > scope.maxRowsPerScenario
      || dimensions.performance?.withinBudget !== true
    )
  ) {
    findings.push(`${prefix}:performance`);
  }
  return [...new Set(findings)].sort();
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function validRedisTerminalEvents(redis) {
  const progress = redis?.progress;
  if (
    !isPlainObject(redis)
    || !isPlainObject(progress)
    || !TERMINAL_STATUSES.has(progress.state)
    || String(progress.terminal) !== "1"
  ) {
    return false;
  }
  const total = integerValue(progress.total);
  const committed = integerValue(progress.committed);
  const failed = integerValue(progress.failed);
  return total !== undefined
    && total > 0
    && committed !== undefined
    && failed !== undefined
    && committed + failed === total;
}

function integerValue(value) {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  ) {
    return value;
  }
  if (
    typeof value === "string"
    && /^(0|[1-9][0-9]*)$/.test(value)
  ) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function compareTargets(source, target, normalization) {
  const targetById = new Map(
    target.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  return source.scenarios.map((sourceScenario) => {
    const targetScenario = targetById.get(sourceScenario.scenarioId);
    const sourceValue = applyIgnoredPaths(
      sourceScenario.normalizedSemantic,
      normalization?.ignorePaths ?? [],
    );
    const targetValue = targetScenario
      ? applyIgnoredPaths(
        targetScenario.normalizedSemantic,
        normalization?.ignorePaths ?? [],
      )
      : undefined;
    const sourceHash = stableHash(sourceValue);
    const targetHash = stableHash(targetValue);
    const differences = diffValues(sourceValue, targetValue);
    return {
      scenarioId: sourceScenario.scenarioId,
      equal:
        sourceScenario.status === "passed"
        && targetScenario?.status === "passed"
        && sourceHash === targetHash
        && differences.total === 0,
      sourceHash,
      targetHash,
      differenceCount: differences.total,
      differences: differences.items,
      differencesTruncated: differences.truncated,
    };
  });
}

function normalizeSemantic(value, marker, baseUrl, normalization) {
  const normalized = replaceExactValues(value, new Map([
    [marker, "<marker>"],
    [baseUrl, "<base-url>"],
  ]));
  const projected = normalization?.profile === "batch-update-contract-v1"
    ? projectBatchUpdateContract(normalized)
    : normalized;
  return applyIgnoredPaths(projected, normalization?.ignorePaths ?? []);
}

export function projectBatchUpdateContract(value) {
  const dimensions = value?.observation?.dimensions ?? {};
  return {
    before: canonicalState(value?.before),
    invoke: {
      httpStatus: value?.invoke?.httpStatus,
      code: value?.invoke?.body?.code,
    },
    after: canonicalState(value?.after),
    outcome: {
      context: {
        tenantId: dimensions.context?.tenantId,
        panelId: dimensions.context?.panelId,
        database: dimensions.context?.database,
        table: dimensions.context?.table,
      },
      scenarioId: dimensions.decisions?.scenarioId,
      affectedRows: dimensions.effects?.fixtureRows,
      undoRecorded: Number(dimensions.effects?.undoRows ?? 0) > 0,
      projection: canonicalProjection(
        dimensions.state?.mysql?.projection,
      ),
      terminal: canonicalTerminal(dimensions.events),
      markerScoped: dimensions.failures?.markerScoped,
    },
  };
}

function canonicalState(snapshot) {
  return {
    rowCount: snapshot?.mysql?.fixtureRows,
    projection: canonicalProjection(snapshot?.mysql?.projection),
  };
}

function canonicalProjection(rows) {
  if (!Array.isArray(rows)) return undefined;
  return rows
    .map((row) => {
      if (!isPlainObject(row)) return row;
      const { values, ...identity } = row;
      return isPlainObject(values)
        ? { ...values, ...identity }
        : row;
    })
    .sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right)));
}

function canonicalTerminal(events) {
  if (!isPlainObject(events)) return undefined;
  if (
    typeof events.terminalStatus === "string"
    && Number.isFinite(events.terminalPercentage)
  ) {
    return {
      status: events.terminalStatus,
      percentage: Number(events.terminalPercentage),
    };
  }
  const progress = events.redis?.progress;
  if (!isPlainObject(progress) || typeof progress.state !== "string") {
    return undefined;
  }
  const total = Number(progress.total);
  const completed = Number(progress.committed) + Number(progress.failed);
  return {
    status: progress.state,
    percentage:
      Number.isFinite(total)
      && total > 0
      && Number.isFinite(completed)
        ? (completed / total) * 100
        : undefined,
  };
}

function applyIgnoredPaths(value, paths) {
  const copy = structuredClone(value);
  for (const ignoredPath of paths) {
    const segments = ignoredPath
      .replaceAll("[", ".")
      .replaceAll("]", "")
      .split(".")
      .filter(Boolean);
    let current = copy;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (!current || typeof current !== "object") break;
      current = current[segments[index]];
    }
    if (current && typeof current === "object") {
      delete current[segments.at(-1)];
    }
  }
  return copy;
}

function cleanupIsZero(cleanup) {
  return Boolean(cleanup)
    && CLEANUP_COUNTERS.every((counter) => cleanup[counter] === 0);
}

function diffValues(source, target, limit = 200) {
  const items = [];
  let total = 0;
  const visit = (left, right, currentPath) => {
    if (Object.is(left, right)) return;
    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    if (leftArray || rightArray) {
      if (!leftArray || !rightArray) {
        add(currentPath, left, right);
        return;
      }
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        if (index >= left.length || index >= right.length) {
          add(`${currentPath}[${index}]`, left[index], right[index]);
        } else {
          visit(left[index], right[index], `${currentPath}[${index}]`);
        }
      }
      return;
    }
    const leftObject = left && typeof left === "object";
    const rightObject = right && typeof right === "object";
    if (leftObject || rightObject) {
      if (!leftObject || !rightObject) {
        add(currentPath, left, right);
        return;
      }
      const keys = [...new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ])].sort();
      for (const key of keys) {
        if (!(key in left) || !(key in right)) {
          add(`${currentPath}.${key}`, left[key], right[key]);
        } else {
          visit(left[key], right[key], `${currentPath}.${key}`);
        }
      }
      return;
    }
    add(currentPath, left, right);
  };
  const add = (valuePath, left, right) => {
    total += 1;
    if (items.length >= limit) return;
    items.push({
      path: valuePath,
      source: valueSummary(left),
      target: valueSummary(right),
    });
  };
  visit(source, target, "$");
  return {
    total,
    items,
    truncated: total > items.length,
  };
}

function valueSummary(value) {
  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return { type: value === null ? "null" : typeof value, value };
  }
  if (typeof value === "string") {
    return {
      type: "string",
      value: value.length <= 160 ? value : `${value.slice(0, 157)}...`,
      hash: stableHash(value),
    };
  }
  return {
    type: Array.isArray(value) ? "array" : "object",
    hash: stableHash(value),
    size: Array.isArray(value)
      ? value.length
      : value && typeof value === "object"
        ? Object.keys(value).length
        : 0,
  };
}

function createCheckpoint(plan, execution, runId, createdAt) {
  return {
    schemaVersion: 1,
    protocol: "migration-guard.batch-update-l4c-checkpoint/v1",
    status: "running",
    runId,
    projectId: plan.projectId,
    projectHash: plan.projectHash,
    planHash: stableHash(plan),
    scopeHash: stableHash({
      environment: plan.scope.environment,
      database: plan.scope.database,
      tenantId: plan.scope.tenantId,
      panelId: plan.scope.panelId,
      table: plan.scope.table,
    }),
    createdAt,
    updatedAt: createdAt,
    cleanupVerified: false,
    scenarios: execution.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      marker: buildMarker(plan.scope.markerPrefix, runId, scenario.id),
    })),
    operations: [],
  };
}

async function recordCheckpoint(context, event) {
  if (!context.checkpoint || !context.checkpointPath) return;
  context.checkpoint.status = "running";
  context.checkpoint.operations.push({
    sequence: context.checkpoint.operations.length + 1,
    observedAt: new Date().toISOString(),
    ...event,
  });
  await persistCheckpoint(context);
}

async function persistCheckpoint(context) {
  await mkdir(path.dirname(context.checkpointPath), { recursive: true });
  context.checkpoint.updatedAt = new Date().toISOString();
  const temporary = `${context.checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(context.checkpoint, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, context.checkpointPath);
}

async function readCheckpoint(checkpointPath) {
  try {
    const value = JSON.parse(await readFile(checkpointPath, "utf8"));
    return value?.protocol === "migration-guard.batch-update-l4c-checkpoint/v1"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function acquireScopeLock(scope, outputRoot, runId) {
  const lockRoot = path.dirname(outputRoot);
  await mkdir(lockRoot, { recursive: true });
  const scopeHash = stableHash({
    environment: scope.environment,
    database: scope.database,
    tenantId: scope.tenantId,
    panelId: scope.panelId,
    table: scope.table,
  });
  const lockPath = path.join(lockRoot, `.scope-${scopeHash}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({
          schemaVersion: 1,
          runId,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { lockPath, scopeHash };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLock(lockPath);
      if (existing && processIsAlive(existing.pid)) {
        throw new Error(`MG-L4C-SCOPE-LOCKED:${existing.runId}`);
      }
      if (attempt === 0) {
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      throw new Error("MG-L4C-SCOPE-LOCK-RECOVERY-FAILED");
    }
  }
  throw new Error("MG-L4C-SCOPE-LOCK-FAILED");
}

async function releaseScopeLock(lock, runId) {
  if (!lock) return;
  const existing = await readLock(lock.lockPath);
  if (!existing || existing.runId !== runId) return;
  await unlink(lock.lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function buildMarker(prefix, runId, scenarioId) {
  const scenario = scenarioId.replaceAll(/[^A-Za-z0-9-]/g, "-");
  const suffix = stableHash(scenarioId).slice(0, 8);
  return `${prefix}${runId}-${scenario.slice(0, 24)}-${suffix}`.slice(0, 80);
}

function createRunId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function validateRunId(value) {
  if (typeof value !== "string" || !/^[a-z0-9-]{6,48}$/.test(value)) {
    throw new Error("MG-L4C-RUN-ID-INVALID");
  }
}

function replacePlaceholders(value, replacements) {
  return value.replace(/\{([A-Za-z]+)\}/g, (full, name) => {
    if (!(name in replacements)) {
      throw new Error(`unknown operation argument placeholder: ${full}`);
    }
    return String(replacements[name]);
  });
}

function redactValue(value, secretValues = []) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      REDACTED_KEY.test(key)
        ? "<redacted>"
        : redactValue(item, secretValues),
    ]));
  }
  if (typeof value !== "string") return value;
  let redacted = value
    .replaceAll(/(mysql|redis|https?):\/\/[^/@\s]+@/gi, "$1://<redacted>@");
  for (const secret of secretValues) {
    if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

function redactError(error, secretValues) {
  return redactValue(
    error instanceof Error ? error.message : String(error),
    secretValues,
  );
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

function replaceExactValues(value, replacements) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceExactValues(item, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      replaceExactValues(item, replacements),
    ]));
  }
  return replacements.has(value) ? replacements.get(value) : value;
}

function ensureNested(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes repository root`);
  }
}

function spawnJson(program, args, cwd, environment, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        child.kill();
        finish(new Error("operation stdout exceeded 1 MiB"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 256 * 1024) {
        child.kill();
        finish(new Error("operation stderr exceeded 256 KiB"));
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(
          `operation exited ${code}: ${stderr.trim().slice(-2_000)}`,
        ));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(new Error("operation stdout is not one JSON document"));
      }
    });
  });
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}
