import path from "node:path";
import { promises as fs } from "node:fs";
import { createDifferenceKey, decisionsForCompareReport, evaluateDiffDecisionPolicy, recordDiffDecision, summarizeDiffDecisionCoverage } from "./diffDecision.js";
import { pathExists } from "./files.js";
import { loadRunPackage, migrationRunDir } from "./migrationRun.js";
import { resolveArtifactPath } from "./uiArtifacts.js";
import { UiHttpError } from "./uiHttpError.js";
import { requiredParam, trimmedParam } from "./uiRequest.js";
import { readCompareArtifactFile } from "./artifactV2.js";
import type {
  CompareReport,
  DiffDecision,
  DiffDecisionClassification,
  DiffDecisionCoverage,
  DiffDecisionPolicyResult,
  Difference,
  LoadedConfig
} from "../types.js";

export async function collectDiffArtifacts(loaded: LoadedConfig, runSelector?: string): Promise<Array<{
  path: string;
  id?: string;
  passed?: boolean;
  differenceCount?: number;
  differences: Array<{
    area: string;
    name: string;
    severity?: string;
    message: string;
    decision?: Pick<DiffDecision, "classification" | "reason" | "approvedBy" | "updatedAt">;
  }>;
  coverage?: DiffDecisionCoverage;
  policy?: DiffDecisionPolicyResult;
}>> {
  const runId = runSelector ? (await loadRunPackage(loaded, runSelector)).run.id : undefined;
  const root = runId ? migrationRunDir(loaded, runId) : loaded.artifactsDir;
  const files = await findJsonFiles(root);
  const reports = [];
  for (const file of files.filter((item) => /compare.*\.json$|diff.*\.json$/.test(path.basename(item)))) {
    try {
      const report = await readCompareArtifactFile(file) as Partial<CompareReport> & { id?: string };
      if (!Array.isArray(report.differences)) {
        continue;
      }
      const fullReport = isCompareReport(report) ? report : undefined;
      const decisions = fullReport ? await decisionsForCompareReport(loaded, fullReport, runId) : [];
      const decisionByKey = new Map(decisions.map((decision) => [decision.differenceKey, decision]));
      reports.push({
        path: file,
        id: report.id,
        passed: report.passed,
        differenceCount: report.differences.length,
        differences: report.differences.slice(0, 20).map((difference) => ({
          area: difference.area,
          name: difference.name,
          severity: difference.severity,
          message: difference.message,
          decision: decisionSummaryForDifference(decisionByKey.get(createDifferenceKey(difference)))
        })),
        coverage: fullReport ? summarizeDiffDecisionCoverage(fullReport, decisions) : undefined,
        policy: fullReport ? evaluateDiffDecisionPolicy(fullReport, decisions) : undefined
      });
    } catch {
      // Ignore non-report JSON files; the UI is observational.
    }
  }
  return reports.sort((a, b) => a.path.localeCompare(b.path));
}

export async function recordUiDiffDecision(
  loaded: LoadedConfig,
  searchParams: URLSearchParams
): Promise<{
  ledgerPath: string;
  decision: DiffDecision;
  coverage: DiffDecisionCoverage;
  policy: DiffDecisionPolicyResult;
}> {
  const compareReportPath = resolveArtifactPath(loaded, requiredParam(searchParams, "compare"));
  const runId = await resolveOptionalRunId(loaded, trimmedParam(searchParams, "run"));
  const area = differenceAreaParam(searchParams);
  const name = requiredParam(searchParams, "name");
  const classification = diffDecisionClassificationParam(searchParams);
  const reason = requiredParam(searchParams, "reason");
  const severity = differenceSeverityParam(searchParams);
  const message = trimmedParam(searchParams, "message");
  const result = await recordDiffDecision(loaded, {
    runId,
    compareReportPath,
    area,
    name,
    classification,
    reason,
    approvedBy: trimmedParam(searchParams, "approvedBy"),
    severity,
    message
  });
  const decisions = await decisionsForCompareReport(loaded, result.report, runId);
  return {
    ledgerPath: result.ledgerPath,
    decision: result.decision,
    coverage: summarizeDiffDecisionCoverage(result.report, decisions),
    policy: evaluateDiffDecisionPolicy(result.report, decisions)
  };
}

export async function recordUiDiffDecisionBatch(
  loaded: LoadedConfig,
  searchParams: URLSearchParams
): Promise<{
  ledgerPath: string;
  decisions: DiffDecision[];
  coverage: DiffDecisionCoverage;
  policy: DiffDecisionPolicyResult;
}> {
  const compareReportPath = resolveArtifactPath(loaded, requiredParam(searchParams, "compare"));
  const report = await readCompareArtifactFile(compareReportPath);
  if (!isCompareReport(report)) {
    throw new UiHttpError("compare report is not a full compare report", 400);
  }
  const runId = await resolveOptionalRunId(loaded, trimmedParam(searchParams, "run"));
  const severity = diffBatchSeverityParam(searchParams);
  const classification = diffDecisionClassificationParam(searchParams);
  const reason = requiredParam(searchParams, "reason");
  const matches = report.differences.filter((difference) => !severity || difference.severity === severity);
  if (!matches.length) {
    throw new UiHttpError("No differences match the batch decision filter.", 400);
  }
  const decisions: DiffDecision[] = [];
  let ledgerPath = "";
  let latestReport = report;
  for (const difference of matches) {
    const result = await recordDiffDecision(loaded, {
      runId,
      compareReportPath,
      area: difference.area,
      name: difference.name,
      classification,
      reason,
      approvedBy: trimmedParam(searchParams, "approvedBy"),
      severity: difference.severity,
      message: difference.message
    });
    ledgerPath = result.ledgerPath;
    latestReport = result.report;
    decisions.push(result.decision);
  }
  const allDecisions = await decisionsForCompareReport(loaded, latestReport, runId);
  return {
    ledgerPath,
    decisions,
    coverage: summarizeDiffDecisionCoverage(latestReport, allDecisions),
    policy: evaluateDiffDecisionPolicy(latestReport, allDecisions)
  };
}

function decisionSummaryForDifference(
  decision: DiffDecision | undefined
): Pick<DiffDecision, "classification" | "reason" | "approvedBy" | "updatedAt"> | undefined {
  return decision
    ? {
      classification: decision.classification,
      reason: decision.reason,
      approvedBy: decision.approvedBy,
      updatedAt: decision.updatedAt
    }
    : undefined;
}

function isCompareReport(report: Partial<CompareReport>): report is CompareReport {
  return typeof report.baselineId === "string"
    && typeof report.currentId === "string"
    && typeof report.createdAt === "string"
    && typeof report.passed === "boolean"
    && Array.isArray(report.differences);
}

async function resolveOptionalRunId(loaded: LoadedConfig, runSelector: string | undefined): Promise<string | undefined> {
  return runSelector ? (await loadRunPackage(loaded, runSelector)).run.id : undefined;
}

async function findJsonFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

function differenceAreaParam(searchParams: URLSearchParams): Difference["area"] {
  const value = requiredParam(searchParams, "area");
  if (value === "check" || value === "probe" || value === "scan") {
    return value;
  }
  throw new UiHttpError(`Invalid area: ${value}. Expected check, probe, or scan.`, 400);
}

function differenceSeverityParam(searchParams: URLSearchParams): Difference["severity"] | undefined {
  const value = trimmedParam(searchParams, "severity");
  if (!value) {
    return undefined;
  }
  if (value === "error" || value === "warn" || value === "info") {
    return value;
  }
  throw new UiHttpError(`Invalid severity: ${value}. Expected error, warn, or info.`, 400);
}

function diffBatchSeverityParam(searchParams: URLSearchParams): Difference["severity"] | undefined {
  const value = trimmedParam(searchParams, "severity");
  if (!value || value === "all") {
    return undefined;
  }
  return differenceSeverityParam(searchParams);
}

function diffDecisionClassificationParam(searchParams: URLSearchParams): DiffDecisionClassification {
  const value = trimmedParam(searchParams, "as") ?? trimmedParam(searchParams, "classification");
  if (value === "intentional" || value === "accidental" || value === "unknown") {
    return value;
  }
  throw new UiHttpError(`Invalid diff decision: ${value ?? "missing"}. Expected intentional, accidental, or unknown.`, 400);
}
