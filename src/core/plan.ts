import type { ScanSummary } from "../types.js";

export function renderMigrationPlan(scan: ScanSummary): string {
  const highRisk = scan.riskFiles.slice(0, 10);
  const highRiskRows = highRisk
    .map((file, index) => `${index + 1}. ${file.path} - score ${file.score}; ${file.reasons.join(", ")}`)
    .join("\n");

  return [
    "# Behavior-Consistency Migration Plan",
    "",
    "This plan is generated from the current scan. Treat it as a starting point for a safe migration workflow.",
    "",
    "## Phase 0: Lock current behavior",
    "",
    "- Add command probes for critical pure functions and scripts.",
    "- Add HTTP probes for stable API endpoints.",
    "- Run `migration-guard baseline` before code changes.",
    "- Keep the first baseline immutable unless the intended behavior truly changes.",
    "",
    "## Phase 1: Strengthen verification",
    "",
    "- Make build, test, lint, and typecheck commands reliable.",
    "- Add feature or contract tests around high-risk files.",
    "- Normalize timestamps, generated IDs, and nondeterministic output in probes.",
    "",
    "## Phase 2: Migrate low-risk leaves first",
    "",
    "- Prefer files with few importers and nearby tests.",
    "- Run `migration-guard verify` after each small batch.",
    "- Commit only when compare reports are clean or intentional differences are documented.",
    "",
    "## Phase 3: Migrate shared modules with dual evidence",
    "",
    "- For shared modules, keep old and new behavior runnable side by side when possible.",
    "- Use command probes to replay the same input cases against both implementations.",
    "- Convert accepted differences into explicit test cases.",
    "",
    "## Phase 4: Retire compatibility code",
    "",
    "- Remove temporary adapters only after probes and downstream checks stay stable.",
    "- Re-run a fresh baseline once the migrated behavior is the new source of truth.",
    "",
    "## Current high-risk files",
    "",
    highRiskRows || "No high-risk files detected by the current scanner.",
    "",
    "## Current project signals",
    "",
    `- Package manager: ${scan.packageManager}`,
    `- Stack hints: ${scan.stackHints.join(", ") || "none"}`,
    `- Source files: ${scan.sourceFiles}`,
    `- Test files: ${scan.testFiles}`,
    `- Dependency edges: ${scan.dependencyEdges.length}`
  ].join("\n");
}
