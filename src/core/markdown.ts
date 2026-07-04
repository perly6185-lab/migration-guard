import type { CompareReport, ScanSummary, Snapshot } from "../types.js";

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

export function renderCompareReport(report: CompareReport): string {
  const rows = report.differences
    .map((difference) => `| ${difference.severity} | ${difference.area} | ${difference.name} | ${difference.message} |`)
    .join("\n");

  return [
    "# Compare Report",
    "",
    `Baseline: ${report.baselineId}`,
    `Current: ${report.currentId}`,
    `Created at: ${report.createdAt}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    "",
    rows ? "| Severity | Area | Name | Message |\n| --- | --- | --- | --- |\n" + rows : "No differences detected."
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
