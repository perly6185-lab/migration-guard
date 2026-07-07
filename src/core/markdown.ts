import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { CompareReport, DiffDecision, ScanSummary, Snapshot } from "../types.js";

export function renderScanSummary(scan: ScanSummary): string {
  const riskRows = scan.riskFiles
    .slice(0, 10)
    .map((file) => `| ${file.path} | ${file.score} | ${file.lines} | ${file.importerCount} | ${file.reasons.join(", ")} |`)
    .join("\n");

  return [
    "# Scan Summary",
    "",
    `Root: ${scan.root}`,
    `Scanned at: ${scan.scannedAt}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total files | ${scan.totalFiles} |`,
    `| Source files | ${scan.sourceFiles} |`,
    `| Test files | ${scan.testFiles} |`,
    `| Total lines | ${scan.totalLines} |`,
    `| Package manager | ${scan.packageManager} |`,
    `| Stack hints | ${scan.stackHints.join(", ") || "none"} |`,
    "",
    "## Highest Risk Files",
    "",
    riskRows ? "| File | Score | Lines | Importers | Reasons |\n| --- | ---: | ---: | ---: | --- |\n" + riskRows : "No risk files detected."
  ].join("\n");
}

export function renderCompareReport(report: CompareReport, decisions: DiffDecision[] = []): string {
  const decisionByKey = new Map(decisions.map((decision) => [decision.differenceKey, decision]));
  const rows = report.differences
    .map((difference) => {
      const decision = decisionByKey.get(sha256(stableStringify({
        severity: difference.severity,
        area: difference.area,
        name: difference.name,
        message: difference.message,
        before: difference.before,
        after: difference.after
      })));
      return decisions.length > 0
        ? `| ${difference.severity} | ${difference.area} | ${difference.name} | ${decision?.classification ?? "pending"} | ${decision?.reason ?? ""} | ${difference.message} |`
        : `| ${difference.severity} | ${difference.area} | ${difference.name} | ${difference.message} |`;
    })
    .join("\n");

  return [
    "# Compare Report",
    "",
    `Baseline: ${report.baselineId}`,
    `Current: ${report.currentId}`,
    `Created at: ${report.createdAt}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    "",
    rows
      ? decisions.length > 0
        ? "| Severity | Area | Name | Decision | Reason | Message |\n| --- | --- | --- | --- | --- | --- |\n" + rows
        : "| Severity | Area | Name | Message |\n| --- | --- | --- | --- |\n" + rows
      : "No differences detected."
  ].join("\n");
}

export function renderSnapshotSummary(snapshot: Snapshot): string {
  const checks = snapshot.checks.map((check) => `${check.name}:${check.status}`).join(", ") || "none";
  const probes = snapshot.probes.map((probe) => `${probe.name}:${probe.status}`).join(", ") || "none";

  return [
    `${snapshot.kind} ${snapshot.id}`,
    `checks: ${checks}`,
    `probes: ${probes}`
  ].join("\n");
}
