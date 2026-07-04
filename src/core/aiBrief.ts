import path from "node:path";
import type { CompareReport, LoadedConfig, ScanSummary, Snapshot } from "../types.js";

export interface AiBriefInput {
  loaded: LoadedConfig;
  scan: ScanSummary;
  baseline?: Snapshot;
  current?: Snapshot;
  compareReport?: CompareReport;
}

export function renderAiBrief(input: AiBriefInput): string {
  const { loaded, scan, baseline, current, compareReport } = input;
  const highRiskFiles = scan.riskFiles.slice(0, 12);
  const checks = loaded.config.checks.filter((check) => check.enabled !== false);
  const probes = loaded.config.probes.filter((probe) => probe.enabled !== false);

  return [
    "# AI Migration Brief",
    "",
    "This brief gives an AI migration assistant the current project context and the guardrails required to preserve behavior.",
    "",
    "## Mission",
    "",
    "- Refactor or migrate in small, reviewable steps.",
    "- Preserve externally observable behavior unless an intentional change is explicitly approved.",
    "- Use Migration Guard snapshots and compare reports as the source of truth for behavior consistency.",
    "- Do not treat passing compilation alone as proof of safe migration.",
    "",
    "## Project Context",
    "",
    `- Target root: ${loaded.targetRoot}`,
    `- Config file: ${loaded.path}`,
    `- Artifacts dir: ${loaded.artifactsDir}`,
    `- Package manager: ${scan.packageManager}`,
    `- Stack hints: ${scan.stackHints.join(", ") || "none"}`,
    `- Source files: ${scan.sourceFiles}`,
    `- Test files: ${scan.testFiles}`,
    `- Dependency edges: ${scan.dependencyEdges.length}`,
    "",
    "## Protected Checks",
    "",
    checks.length > 0
      ? checks.map((check) => `- ${check.name}: \`${check.command}\`${check.critical === false ? " (non-critical)" : ""}`).join("\n")
      : "- No checks configured yet. Add build, test, lint, and typecheck checks before risky migration work.",
    "",
    "## Behavior Probes",
    "",
    probes.length > 0
      ? probes.map((probe) => {
          if (probe.type === "command") {
            return `- ${probe.name}: command probe \`${probe.command}\``;
          }
          return `- ${probe.name}: HTTP probe ${probe.method ?? "GET"} ${probe.url}`;
        }).join("\n")
      : "- No probes configured yet. Add command or HTTP probes for critical behavior before changing core modules.",
    "",
    "## Latest Evidence",
    "",
    renderEvidenceSection(baseline, current, compareReport),
    "",
    "## Highest Risk Files",
    "",
    highRiskFiles.length > 0
      ? highRiskFiles.map((file, index) => `${index + 1}. ${file.path} - score ${file.score}; lines ${file.lines}; importers ${file.importerCount}; ${file.reasons.join(", ")}`).join("\n")
      : "No high-risk files were detected by the current scanner.",
    "",
    "## AI Operating Rules",
    "",
    "- Before editing, state the exact migration objective, affected files, expected behavior, and verification command.",
    "- Prefer leaf modules with low importer counts before shared modules.",
    "- Do not combine dependency upgrades, architecture changes, formatting churn, and behavior changes in one step.",
    "- Do not delete or weaken checks, probes, baselines, tests, or compare artifacts to make verification pass.",
    "- If behavior output changes, classify the difference as intentional, accidental, or unknown before continuing.",
    "- For intentional changes, update or add probes/tests so the new behavior becomes explicit.",
    "- After each step, run `migration-guard verify` and inspect the compare report.",
    "",
    "## Recommended Next AI Task",
    "",
    renderRecommendedTask(scan, probes.length),
    "",
    "## Suggested Prompt",
    "",
    "```text",
    "You are assisting with a high-risk refactoring/migration. Use the AI Migration Brief as binding context.",
    "Make one small change only. Preserve existing behavior unless an intentional behavior change is explicitly requested.",
    "Before editing, list affected files and the verification command. After editing, run Migration Guard verify and summarize any differences.",
    "```",
    "",
    "## Paths For Review",
    "",
    `- Latest baseline: ${baseline ? path.join(loaded.artifactsDir, "latest-baseline.json") : "not available"}`,
    `- Latest run: ${current ? path.join(loaded.artifactsDir, "latest-run.json") : "not available"}`,
    `- Migration plan: ${path.join(loaded.artifactsDir, "migration-plan.md")}`
  ].join("\n");
}

function renderEvidenceSection(
  baseline: Snapshot | undefined,
  current: Snapshot | undefined,
  compareReport: CompareReport | undefined
): string {
  const lines: string[] = [];

  if (baseline) {
    lines.push(`- Baseline: ${baseline.id} at ${baseline.createdAt}`);
    lines.push(`- Baseline checks: ${summarizeStatuses(baseline.checks)}`);
    lines.push(`- Baseline probes: ${summarizeStatuses(baseline.probes)}`);
  } else {
    lines.push("- Baseline: missing. Run `migration-guard baseline` before risky edits.");
  }

  if (current) {
    lines.push(`- Latest run: ${current.id} at ${current.createdAt}`);
    lines.push(`- Latest run checks: ${summarizeStatuses(current.checks)}`);
    lines.push(`- Latest run probes: ${summarizeStatuses(current.probes)}`);
  } else {
    lines.push("- Latest run: missing. Run `migration-guard verify` after each migration step.");
  }

  if (compareReport) {
    const errors = compareReport.differences.filter((difference) => difference.severity === "error").length;
    const warnings = compareReport.differences.filter((difference) => difference.severity === "warn").length;
    const infos = compareReport.differences.filter((difference) => difference.severity === "info").length;
    lines.push(`- Latest compare: ${compareReport.passed ? "passed" : "failed"} (${errors} errors, ${warnings} warnings, ${infos} info)`);
  }

  return lines.join("\n");
}

function summarizeStatuses(items: Array<{ name: string; status: string }>): string {
  return items.length > 0
    ? items.map((item) => `${item.name}:${item.status}`).join(", ")
    : "none";
}

function renderRecommendedTask(scan: ScanSummary, probeCount: number): string {
  if (probeCount === 0) {
    return [
      "Add the first behavior probes before migration work.",
      "",
      "Good candidates are deterministic scripts or HTTP endpoints that cover pricing, permissions, state transitions, validation, serialization, or other user-visible behavior."
    ].join("\n");
  }

  const candidate = scan.riskFiles
    .filter((file) => file.importerCount <= 2)
    .sort((a, b) => a.score - b.score)[0];

  if (candidate) {
    return `Start with a small, behavior-preserving refactor around \`${candidate.path}\`, then run \`migration-guard verify\`.`;
  }

  return "Choose a low-risk leaf module, make one behavior-preserving change, then run `migration-guard verify`.";
}
