import path from "node:path";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { renderCompareReport } from "./markdown.js";
import { readCompareArtifactFile } from "./artifactV2.js";
import type {
  CompareReport,
  DiffDecision,
  DiffDecisionClassification,
  DiffDecisionCoverage,
  DiffDecisionLedger,
  DiffDecisionPolicyResult,
  Difference,
  LoadedConfig
} from "../types.js";

export interface RecordDiffDecisionOptions {
  runId?: string;
  proposalId?: string;
  compareReportPath: string;
  area: Difference["area"];
  name: string;
  classification: DiffDecisionClassification;
  reason: string;
  approvedBy?: string;
  severity?: Difference["severity"];
  message?: string;
}

export function diffDecisionLedgerPath(loaded: LoadedConfig, runId?: string): string {
  const baseDir = runId
    ? path.join(loaded.artifactsDir, "migration-runs", runId)
    : loaded.artifactsDir;
  return path.join(baseDir, "diff-decisions", "decisions.json");
}

export async function loadDiffDecisionLedger(
  loaded: LoadedConfig,
  runId?: string
): Promise<DiffDecisionLedger> {
  const filePath = diffDecisionLedgerPath(loaded, runId);
  if (!await pathExists(filePath)) {
    const now = new Date().toISOString();
    return {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      decisions: []
    };
  }
  return readJsonFile<DiffDecisionLedger>(filePath);
}

export async function saveDiffDecisionLedger(
  loaded: LoadedConfig,
  ledger: DiffDecisionLedger
): Promise<string> {
  const filePath = diffDecisionLedgerPath(loaded, ledger.runId);
  await writeJsonFile(filePath, ledger);
  return filePath;
}

export async function recordDiffDecision(
  loaded: LoadedConfig,
  options: RecordDiffDecisionOptions
): Promise<{ ledgerPath: string; decision: DiffDecision; report: CompareReport }> {
  const compareReportPath = path.resolve(process.cwd(), options.compareReportPath);
  const report = await readCompareArtifactFile(compareReportPath);
  const difference = findDifference(report, options);
  const key = createDifferenceKey(difference);
  const now = new Date().toISOString();
  const ledger = await loadDiffDecisionLedger(loaded, options.runId);
  const existingIndex = ledger.decisions.findIndex((decision) => decision.differenceKey === key);
  const previous = existingIndex >= 0 ? ledger.decisions[existingIndex] : undefined;
  const decision: DiffDecision = {
    version: 1,
    id: previous?.id ?? createDecisionId(key),
    differenceKey: key,
    runId: options.runId,
    proposalId: options.proposalId,
    compareReportPath,
    baselineId: report.baselineId,
    currentId: report.currentId,
    severity: difference.severity,
    area: difference.area,
    name: difference.name,
    message: difference.message,
    classification: options.classification,
    reason: options.reason,
    approvedBy: options.approvedBy,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    ledger.decisions[existingIndex] = decision;
  } else {
    ledger.decisions.push(decision);
  }
  ledger.updatedAt = now;
  const ledgerPath = await saveDiffDecisionLedger(loaded, ledger);
  await refreshCompareMarkdown(compareReportPath, report, ledger.decisions);
  return { ledgerPath, decision, report };
}

export async function decisionsForCompareReport(
  loaded: LoadedConfig,
  report: CompareReport,
  runId?: string
): Promise<DiffDecision[]> {
  const ledger = await loadDiffDecisionLedger(loaded, runId);
  const keys = new Set(report.differences.map(createDifferenceKey));
  return ledger.decisions.filter((decision) => keys.has(decision.differenceKey));
}

export async function decisionCoverageForCompareReportPath(
  loaded: LoadedConfig,
  runId: string | undefined,
  compareReportPath: string | undefined
): Promise<DiffDecisionCoverage | undefined> {
  if (!compareReportPath || !await pathExists(compareReportPath)) {
    return undefined;
  }
  const report = await readCompareArtifactFile(compareReportPath).catch(() => undefined);
  if (!report) {
    return undefined;
  }
  const decisions = await decisionsForCompareReport(loaded, report, runId);
  return summarizeDiffDecisionCoverage(report, decisions);
}

export async function decisionPolicyForCompareReportPath(
  loaded: LoadedConfig,
  runId: string | undefined,
  compareReportPath: string | undefined
): Promise<DiffDecisionPolicyResult | undefined> {
  if (!compareReportPath || !await pathExists(compareReportPath)) {
    return undefined;
  }
  const report = await readCompareArtifactFile(compareReportPath).catch(() => undefined);
  if (!report) {
    return undefined;
  }
  const decisions = await decisionsForCompareReport(loaded, report, runId);
  return evaluateDiffDecisionPolicy(report, decisions);
}

export function summarizeDiffDecisionCoverage(
  report: CompareReport,
  decisions: DiffDecision[]
): DiffDecisionCoverage {
  const decisionByKey = indexDecisionsByKey(decisions);
  const pending = report.differences.filter((difference) => !decisionByKey.has(createDifferenceKey(difference)));
  return {
    total: report.differences.length,
    decided: report.differences.length - pending.length,
    pending: pending.length,
    pendingRisk: pending.filter((difference) => difference.severity === "error" || difference.severity === "warn").length,
    intentional: decisions.filter((decision) => decision.classification === "intentional").length,
    accidental: decisions.filter((decision) => decision.classification === "accidental").length,
    unknown: decisions.filter((decision) => decision.classification === "unknown").length
  };
}

export function evaluateDiffDecisionPolicy(
  report: CompareReport,
  decisions: DiffDecision[]
): DiffDecisionPolicyResult {
  const coverage = summarizeDiffDecisionCoverage(report, decisions);
  const decisionByKey = indexDecisionsByKey(decisions);
  const riskDifferences = report.differences.filter(isRiskDifference);
  let intentionalRisk = 0;
  let accidentalRisk = 0;
  let unknownRisk = 0;
  let pendingRisk = 0;

  for (const difference of riskDifferences) {
    const decision = decisionByKey.get(createDifferenceKey(difference));
    if (!decision) {
      pendingRisk += 1;
    } else if (decision.classification === "intentional") {
      intentionalRisk += 1;
    } else if (decision.classification === "accidental") {
      accidentalRisk += 1;
    } else {
      unknownRisk += 1;
    }
  }

  if (riskDifferences.length === 0) {
    return {
      rawPassed: report.passed,
      status: "clean",
      canContinue: true,
      reason: "no error or warning behavior differences",
      coverage,
      riskTotal: 0,
      intentionalRisk,
      accidentalRisk,
      unknownRisk,
      pendingRisk
    };
  }

  if (accidentalRisk > 0) {
    return {
      rawPassed: report.passed,
      status: "blocked",
      canContinue: false,
      reason: `${accidentalRisk} risk difference(s) are classified accidental and require replan`,
      coverage,
      riskTotal: riskDifferences.length,
      intentionalRisk,
      accidentalRisk,
      unknownRisk,
      pendingRisk
    };
  }

  if (pendingRisk > 0 || unknownRisk > 0) {
    return {
      rawPassed: report.passed,
      status: "pending",
      canContinue: false,
      reason: `${pendingRisk + unknownRisk} risk difference(s) are pending or unknown`,
      coverage,
      riskTotal: riskDifferences.length,
      intentionalRisk,
      accidentalRisk,
      unknownRisk,
      pendingRisk
    };
  }

  return {
    rawPassed: report.passed,
    status: "accepted",
    canContinue: true,
    reason: "all risk behavior differences are classified intentional",
    coverage,
    riskTotal: riskDifferences.length,
    intentionalRisk,
    accidentalRisk,
    unknownRisk,
    pendingRisk
  };
}

export function renderDiffDecisionList(
  ledger: DiffDecisionLedger,
  report?: CompareReport,
  decisions: DiffDecision[] = ledger.decisions
): string {
  if (report) {
    const coverage = summarizeDiffDecisionCoverage(report, decisions);
    const policy = evaluateDiffDecisionPolicy(report, decisions);
    const decisionByKey = indexDecisionsByKey(decisions);
    const rows = report.differences.map((difference) => {
      const decision = decisionByKey.get(createDifferenceKey(difference));
      return `| ${difference.severity} | ${difference.area} | ${difference.name} | ${decision?.classification ?? "pending"} | ${decision?.reason ?? ""} | ${difference.message} |`;
    }).join("\n");
    return [
      "# Diff Decisions",
      "",
      `Compare: ${report.baselineId} -> ${report.currentId}`,
      formatCoverageLine(coverage),
      `Policy: ${policy.status} (${policy.reason})`,
      "",
      rows ? "| Severity | Area | Name | Decision | Reason | Message |\n| --- | --- | --- | --- | --- | --- |\n" + rows : "No differences detected."
    ].join("\n");
  }

  const rows = ledger.decisions
    .map((decision) => `| ${decision.classification} | ${decision.area} | ${decision.name} | ${decision.reason} | ${decision.compareReportPath} |`)
    .join("\n");
  return [
    "# Diff Decision Ledger",
    "",
    `Run: ${ledger.runId ?? "global"}`,
    `Decisions: ${ledger.decisions.length}`,
    "",
    rows ? "| Decision | Area | Name | Reason | Compare |\n| --- | --- | --- | --- | --- |\n" + rows : "No decisions recorded."
  ].join("\n");
}

export function createDifferenceKey(difference: Pick<Difference, "severity" | "area" | "name" | "message" | "before" | "after">): string {
  return sha256(stableStringify({
    severity: difference.severity,
    area: difference.area,
    name: difference.name,
    message: difference.message,
    before: difference.before,
    after: difference.after
  }));
}

export function decisionLabelForDifference(
  difference: Pick<Difference, "severity" | "area" | "name" | "message" | "before" | "after">,
  decisions: DiffDecision[]
): string {
  return indexDecisionsByKey(decisions).get(createDifferenceKey(difference))?.classification ?? "pending";
}

export function formatCoverageLine(coverage: DiffDecisionCoverage): string {
  return `Decisions: ${coverage.decided}/${coverage.total} decided, pending:${coverage.pending}, pending-risk:${coverage.pendingRisk}, intentional:${coverage.intentional}, accidental:${coverage.accidental}, unknown:${coverage.unknown}`;
}

export function formatPolicyLine(policy: DiffDecisionPolicyResult): string {
  return `Decision gate: ${policy.status} can-continue:${policy.canContinue ? "yes" : "no"} risk:${policy.riskTotal} intentional:${policy.intentionalRisk} accidental:${policy.accidentalRisk} unknown:${policy.unknownRisk} pending:${policy.pendingRisk} (${policy.reason})`;
}

function findDifference(report: CompareReport, options: RecordDiffDecisionOptions): Difference {
  const matches = report.differences.filter((difference) => {
    return difference.area === options.area
      && difference.name === options.name
      && (!options.severity || difference.severity === options.severity)
      && (!options.message || difference.message === options.message);
  });
  if (matches.length === 0) {
    throw new Error(`No matching difference found for ${options.area}/${options.name}.`);
  }
  if (matches.length > 1 && !options.message && !options.severity) {
    throw new Error(`Multiple differences matched ${options.area}/${options.name}. Pass --severity or --message to disambiguate.`);
  }
  return matches[0];
}

function indexDecisionsByKey(decisions: DiffDecision[]): Map<string, DiffDecision> {
  return new Map(decisions.map((decision) => [decision.differenceKey, decision]));
}

function isRiskDifference(difference: Difference): boolean {
  return difference.severity === "error" || difference.severity === "warn";
}

function createDecisionId(key: string): string {
  return `diff-decision-${key.slice(0, 12)}`;
}

async function refreshCompareMarkdown(
  compareReportPath: string,
  report: CompareReport,
  decisions: DiffDecision[]
): Promise<void> {
  const markdownPath = compareReportPath.replace(/\.json$/, ".md");
  await ensureDir(path.dirname(markdownPath));
  await writeTextFile(markdownPath, renderCompareReport(report, decisions));
}
