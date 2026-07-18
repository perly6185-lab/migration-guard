import type { LoadedConfig } from "../../types.js";
import { pathExists } from "../files.js";
import { latestBaselinePath } from "../snapshot.js";
import type { IssueControlSafetyEnvelope, IssueControlSafetyEnvelopeCheck, IssueControlSuperviseReport } from "../issueControl.js";
import { readIssueControlTargetClean } from "./safetyIo.js";

export async function createIssueControlSafetyEnvelopeForReport(
  loaded: LoadedConfig,
  report: IssueControlSuperviseReport
): Promise<IssueControlSafetyEnvelope> {
  const selected = report.selection.filter((item) => item.selected);
  const targetClean = report.mode === "execute"
    ? await readIssueControlTargetClean(loaded)
    : { passed: true, reason: "Target git clean is enforced before unattended execution, not for dry-run planning." };
  const baselinePresent = report.mode === "execute"
    ? await pathExists(latestBaselinePath(loaded))
    : true;
  const checks: IssueControlSafetyEnvelopeCheck[] = [{
    id: "no-high-risk",
    passed: selected.every((item) => item.risk !== "high"),
    reason: selected.some((item) => item.risk === "high")
      ? "Selected set includes high-risk issues."
      : "Selected set has no high-risk issues."
  }, {
    id: "unattended-low-risk-only",
    passed: report.trustTier !== "unattended" || selected.every((item) => !item.risk || item.risk === "low"),
    reason: report.trustTier === "unattended"
      ? "Unattended tier requires every selected issue to be low risk."
      : "Low-risk-only check is advisory outside unattended tier."
  }, {
    id: "target-git-clean",
    passed: targetClean.passed,
    reason: targetClean.reason
  }, {
    id: "baseline-present",
    passed: baselinePresent,
    reason: baselinePresent
      ? "Latest baseline snapshot is available or not required for dry-run planning."
      : "Latest baseline snapshot is required before unattended execution."
  }, {
    id: "verify-each",
    passed: Boolean(report.controlOptions?.verifyEach),
    reason: "Unattended mutation watchdog requires verify-each."
  }, {
    id: "repair-on-fail",
    passed: Boolean(report.controlOptions?.repairOnFail),
    reason: "Unattended mutation watchdog requires repair-on-fail."
  }, {
    id: "continue-after-repair",
    passed: Boolean(report.controlOptions?.continueAfterRepair),
    reason: "Unattended continuation requires explicit continue-after-repair."
  }, {
    id: "critical-verification",
    passed: report.mode !== "execute" || report.summary.executedCount === 0 || report.summary.verifiedCount >= report.summary.executedCount,
    reason: report.mode !== "execute"
      ? "Critical verification is enforced during execution."
      : "Every executed unattended iteration must have post-iteration verification."
  }, {
    id: "no-no-op-risk",
    passed: true,
    reason: "No selected issue-control item carries no-op-risk metadata."
  }, {
    id: "no-unresolved-failures",
    passed: report.summary.failedCount === 0 && report.summary.blockedCount === 0 && report.humanActionRequired !== true,
    reason: "No failed, blocked or human-action-required iterations are present."
  }];
  return {
    passed: checks.every((check) => check.passed),
    trustTier: report.trustTier,
    checks
  };
}

