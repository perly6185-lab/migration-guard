import type {
  IssueControlAdaptiveGate,
  IssueControlProgressStatusItem,
  IssueControlSafetyEnvelope,
  IssueControlSafetyEnvelopeCheck,
  IssueControlSuperviseProgressLedger
} from "../issueControl.js";

export function createIssueControlSafetyEnvelopeFromLedger(
  ledger: IssueControlSuperviseProgressLedger
): IssueControlSafetyEnvelope {
  const trustTier = ledger.trustTier ?? ledger.controlOptions?.trustTier ?? "supervised";
  const selected = ledger.items.filter((item) => item.selected);
  const checks: IssueControlSafetyEnvelopeCheck[] = [{
    id: "no-high-risk",
    passed: selected.every((item) => item.risk !== "high"),
    reason: selected.some((item) => item.risk === "high") ? "Selected set includes high-risk issues." : "Selected set has no high-risk issues."
  }, {
    id: "unattended-low-risk-only",
    passed: trustTier !== "unattended" || selected.every((item) => !item.risk || item.risk === "low"),
    reason: trustTier === "unattended" ? "Unattended tier requires every selected issue to be low risk." : "Low-risk-only check is advisory outside unattended tier."
  }, {
    id: "verify-each",
    passed: Boolean(ledger.controlOptions?.verifyEach),
    reason: "Unattended mutation watchdog requires verify-each."
  }, {
    id: "repair-on-fail",
    passed: Boolean(ledger.controlOptions?.repairOnFail),
    reason: "Unattended mutation watchdog requires repair-on-fail."
  }, {
    id: "continue-after-repair",
    passed: Boolean(ledger.controlOptions?.continueAfterRepair),
    reason: "Unattended continuation requires explicit continue-after-repair."
  }, {
    id: "no-unresolved-failures",
    passed: ledger.summary.unresolvedCount === 0,
    reason: "Progress ledger has no unresolved failed or blocked items."
  }];
  return { passed: checks.every((check) => check.passed), trustTier, checks };
}

export function failedSafetyChecks(envelope: IssueControlSafetyEnvelope): string[] {
  return envelope.checks.filter((check) => !check.passed).map((check) => check.id);
}

export function createIssueControlAdaptiveGate(
  ledger: IssueControlSuperviseProgressLedger,
  unresolvedItems: IssueControlProgressStatusItem[]
): IssueControlAdaptiveGate {
  const current = ledger.controlOptions?.maxIterations ?? ledger.summary.selectedCount;
  if (unresolvedItems.length > 0 || ledger.status === "failed" || ledger.status === "blocked") {
    return { state: "downgrade", currentMaxIterations: current, recommendedMaxIterations: 1,
      reason: "A failed or blocked iteration downgrades the next unattended batch to single-step." };
  }
  if (ledger.mode === "execute" && ledger.status === "complete" && ledger.summary.reachedCount >= current && ledger.summary.reachedCount > 0) {
    return { state: "upgrade", currentMaxIterations: current, recommendedMaxIterations: Math.min(10, current + 1),
      reason: "The last bounded batch completed cleanly; the next batch may grow by one step." };
  }
  return { state: "hold", currentMaxIterations: current, recommendedMaxIterations: Math.max(1, current || 1),
    reason: "No upgrade or downgrade trigger was observed." };
}
