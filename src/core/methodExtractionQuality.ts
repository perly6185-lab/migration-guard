import ts from "typescript";
import { runShellCommand } from "./exec.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export type MethodQualityVerdict = "improved" | "neutral" | "regressed" | "not-evaluated";
export type AdvancedGateKind = "coverage" | "mutation" | "benchmark" | "memory" | "bundle" | "api-compatibility";

export interface MethodStructuralMetrics {
  lines: number;
  statements: number;
  cyclomaticComplexity: number;
  parameters: number;
  localVariables: number;
  callSites: number;
}

export interface MethodAdvancedGateConfig {
  kind: AdvancedGateKind;
  command?: string;
  required?: boolean;
  comparison?: "exact" | "no-decrease" | "no-increase";
  tolerancePercent?: number;
}

export interface MethodAdvancedGateResult {
  kind: AdvancedGateKind;
  status: "passed" | "failed" | "not-evaluated";
  command?: string;
  exitCode?: number | null;
  outputHash?: string;
  baselineHash?: string;
  baselineValue?: number;
  currentValue?: number;
  changePercent?: number;
  reason: string;
}

export interface MethodExtractionQualityReport {
  version: 1;
  createdAt: string;
  symbol: string;
  behaviorConfidence: "passed" | "failed" | "not-evaluated";
  structuralImprovement: MethodQualityVerdict;
  operationalRisk: "low" | "medium" | "high";
  before?: MethodStructuralMetrics;
  after?: MethodStructuralMetrics;
  deltas?: MethodStructuralMetrics;
  advancedGates: MethodAdvancedGateResult[];
  passed: boolean;
  findings: string[];
  reportHash: string;
}

export async function createMethodExtractionQualityReport(options: {
  symbol: string;
  beforeSource?: string;
  afterSource?: string;
  fileName?: string;
  behaviorPassed?: boolean;
  root: string;
  advancedGates?: MethodAdvancedGateConfig[];
  advancedGateBaseline?: MethodAdvancedGateResult[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<MethodExtractionQualityReport> {
  const before = options.beforeSource ? measureMethod(options.beforeSource, options.fileName ?? "source.ts", options.symbol) : undefined;
  const after = options.afterSource ? measureMethod(options.afterSource, options.fileName ?? "source.ts", options.symbol) : undefined;
  const deltas = before && after ? subtractMetrics(after, before) : undefined;
  const structuralImprovement = compareStructure(before, after);
  const advancedGates = await runAdvancedGates(options.root, options.advancedGates ?? [], options.timeoutMs, options.maxOutputBytes, options.advancedGateBaseline);
  const requiredFailure = (options.advancedGates ?? []).some((config) => config.required
    && advancedGates.find((result) => result.kind === config.kind)?.status !== "passed");
  const behaviorConfidence: MethodExtractionQualityReport["behaviorConfidence"] = options.behaviorPassed === undefined ? "not-evaluated" : options.behaviorPassed ? "passed" : "failed";
  const findings: string[] = [];
  if (!before || !after) findings.push("Before and after source are required for structural evaluation.");
  if (structuralImprovement === "regressed") findings.push("The target method structural metrics regressed.");
  if (requiredFailure) findings.push("One or more required advanced evaluation gates did not pass.");
  const operationalRisk: MethodExtractionQualityReport["operationalRisk"] = behaviorConfidence !== "passed" || requiredFailure
    ? "high"
    : structuralImprovement === "improved" && advancedGates.every((gate) => gate.status !== "failed") ? "low" : "medium";
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    symbol: options.symbol,
    behaviorConfidence,
    structuralImprovement,
    operationalRisk,
    before,
    after,
    deltas,
    advancedGates,
    passed: behaviorConfidence === "passed" && structuralImprovement !== "regressed" && !requiredFailure,
    findings
  };
  return { ...base, reportHash: sha256(stableStringify(base)) };
}

export async function captureMethodAdvancedGateBaseline(
  root: string,
  configs: MethodAdvancedGateConfig[],
  timeoutMs?: number,
  maxOutputBytes?: number
): Promise<MethodAdvancedGateResult[]> {
  return runAdvancedGates(root, configs, timeoutMs, maxOutputBytes);
}

export function renderMethodExtractionQualityReport(report: MethodExtractionQualityReport): string {
  return [
    "# Method Extraction Quality Report", "",
    `- Symbol: ${report.symbol}`,
    `- Behavior confidence: ${report.behaviorConfidence}`,
    `- Structural improvement: ${report.structuralImprovement}`,
    `- Operational risk: ${report.operationalRisk}`,
    `- Passed: ${report.passed}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Structural Metrics", "",
    `- Before: ${formatMetrics(report.before)}`,
    `- After: ${formatMetrics(report.after)}`,
    `- Delta: ${formatMetrics(report.deltas)}`, "",
    "## Advanced Gates", "",
    ...(report.advancedGates.length ? report.advancedGates.map((gate) => `- ${gate.kind}: ${gate.status} - ${gate.reason}`) : ["- none configured (not evaluated)"]), "",
    "## Findings", "",
    ...(report.findings.length ? report.findings.map((finding) => `- ${finding}`) : ["- none"]), ""
  ].join("\n");
}

function measureMethod(source: string, fileName: string, symbol: string): MethodStructuralMetrics | undefined {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const expected = symbol.split(/[.#]/).at(-1);
  let selected: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (selected) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      const name = "name" in node && node.name && ts.isIdentifier(node.name) ? node.name.text
        : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
      if (name === expected) selected = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!selected || !selected.body) return undefined;
  let complexity = 1;
  let localVariables = 0;
  let callSites = 0;
  const count = (node: ts.Node): void => {
    if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCaseClause(node) || ts.isConditionalExpression(node)
      || node.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.kind === ts.SyntaxKind.BarBarToken) complexity += 1;
    if (ts.isVariableDeclaration(node)) localVariables += 1;
    if (ts.isCallExpression(node)) callSites += 1;
    ts.forEachChild(node, count);
  };
  count(selected.body);
  const start = sourceFile.getLineAndCharacterOfPosition(selected.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(selected.getEnd()).line;
  return {
    lines: end - start + 1,
    statements: ts.isBlock(selected.body) ? selected.body.statements.length : 1,
    cyclomaticComplexity: complexity,
    parameters: selected.parameters.length,
    localVariables,
    callSites
  };
}

async function runAdvancedGates(
  root: string,
  configs: MethodAdvancedGateConfig[],
  timeoutMs = 120_000,
  maxOutputBytes = 262_144,
  baseline?: MethodAdvancedGateResult[]
): Promise<MethodAdvancedGateResult[]> {
  const byKind = new Map(configs.map((config) => [config.kind, config]));
  const kinds: AdvancedGateKind[] = ["coverage", "mutation", "benchmark", "memory", "bundle", "api-compatibility"];
  const results: MethodAdvancedGateResult[] = [];
  for (const kind of kinds) {
    const config = byKind.get(kind);
    if (!config?.command) {
      results.push({ kind, status: "not-evaluated", reason: "No command configured." });
      continue;
    }
    const result = await runShellCommand(config.command, { cwd: root, timeoutMs, maxOutputBytes });
    const output = `${result.stdout}\n${result.stderr}`;
    const passed = result.exitCode === 0 && !result.timedOut && !result.error;
    const prior = baseline?.find((item) => item.kind === kind);
    const currentValue = parseMetricValue(result.stdout);
    const comparison = config.comparison ?? defaultComparison(kind);
    const comparisonResult = passed && prior ? compareGateSamples(prior, sha256(output), currentValue, comparison, config.tolerancePercent ?? 0) : undefined;
    results.push({
      kind,
      status: !passed || comparisonResult === false ? "failed" : "passed",
      command: config.command,
      exitCode: result.exitCode,
      outputHash: sha256(output),
      baselineHash: prior?.outputHash,
      baselineValue: prior?.currentValue,
      currentValue,
      changePercent: percentChange(prior?.currentValue, currentValue),
      reason: !passed
        ? result.timedOut ? "Configured evaluation command timed out." : result.error ?? "Configured evaluation command failed."
        : comparisonResult === false ? `Current ${kind} sample regressed beyond the configured ${comparison} tolerance.`
          : prior ? `Current ${kind} sample passed ${comparison} comparison with baseline.` : "Baseline evaluation command passed."
    });
  }
  return results;
}

function parseMetricValue(output: string): number | undefined {
  const trimmed = output.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as { value?: unknown };
    return typeof parsed.value === "number" && Number.isFinite(parsed.value) ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function defaultComparison(kind: AdvancedGateKind): "exact" | "no-decrease" | "no-increase" {
  if (kind === "coverage" || kind === "mutation") return "no-decrease";
  if (kind === "benchmark" || kind === "memory" || kind === "bundle") return "no-increase";
  return "exact";
}

function compareGateSamples(
  baseline: MethodAdvancedGateResult,
  currentHash: string,
  currentValue: number | undefined,
  comparison: "exact" | "no-decrease" | "no-increase",
  tolerancePercent: number
): boolean {
  if (comparison === "exact") return baseline.outputHash === currentHash;
  if (baseline.currentValue === undefined || currentValue === undefined) return false;
  const tolerance = Math.abs(baseline.currentValue) * Math.max(0, tolerancePercent) / 100;
  return comparison === "no-decrease"
    ? currentValue + tolerance >= baseline.currentValue
    : currentValue <= baseline.currentValue + tolerance;
}

function percentChange(before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || before === 0) return undefined;
  return Number((((after - before) / Math.abs(before)) * 100).toFixed(3));
}

function compareStructure(before?: MethodStructuralMetrics, after?: MethodStructuralMetrics): MethodQualityVerdict {
  if (!before || !after) return "not-evaluated";
  const beforeScore = before.lines + before.cyclomaticComplexity * 4 + before.localVariables * 2 + before.callSites;
  const afterScore = after.lines + after.cyclomaticComplexity * 4 + after.localVariables * 2 + after.callSites;
  return afterScore < beforeScore ? "improved" : afterScore > beforeScore ? "regressed" : "neutral";
}

function subtractMetrics(after: MethodStructuralMetrics, before: MethodStructuralMetrics): MethodStructuralMetrics {
  return {
    lines: after.lines - before.lines,
    statements: after.statements - before.statements,
    cyclomaticComplexity: after.cyclomaticComplexity - before.cyclomaticComplexity,
    parameters: after.parameters - before.parameters,
    localVariables: after.localVariables - before.localVariables,
    callSites: after.callSites - before.callSites
  };
}

function formatMetrics(metrics?: MethodStructuralMetrics): string {
  return metrics ? `lines=${metrics.lines}, statements=${metrics.statements}, complexity=${metrics.cyclomaticComplexity}, parameters=${metrics.parameters}, locals=${metrics.localVariables}, calls=${metrics.callSites}` : "not evaluated";
}
