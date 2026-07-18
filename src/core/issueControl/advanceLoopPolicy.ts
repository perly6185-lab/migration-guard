import type {
  IssueControlAdvanceLoopReport,
  IssueControlAdvanceLoopRepeatGuard,
  IssueControlAdvanceLoopSchedulerDecision,
  IssueControlAdvanceLoopState,
  IssueControlAdvanceOptions,
  IssueControlSafetyEnvelope
} from "../issueControl.js";

export function createIssueControlAdvanceLoopRepeatGuard(
  previousState: IssueControlAdvanceLoopState | undefined,
  sourceLedgerPath: string,
  options: IssueControlAdvanceOptions
): IssueControlAdvanceLoopRepeatGuard {
  const repeatedTerminalCount = previousState?.sourceLedgerPath === sourceLedgerPath
    ? previousState.repeatedTerminalCount
    : 0;
  const triggered = Boolean(
    options.execute
    && !options.ignoreRepeatGuard
    && previousState
    && previousState.sourceLedgerPath === sourceLedgerPath
    && (previousState.status === "failed" || previousState.status === "blocked")
  );
  return {
    triggered,
    previousStatePath: previousState?.outputPath,
    repeatedTerminalCount: triggered ? repeatedTerminalCount + 1 : repeatedTerminalCount,
    reason: triggered
      ? [
        `Advance loop repeat guard blocked source ledger ${sourceLedgerPath}.`,
        `Previous loop already stopped as ${previousState?.status} for the same ledger.`,
        "Resolve the blocker, produce a new supervise progress ledger, or rerun with --force to override."
      ].join(" ")
      : "No repeated failed/blocked source ledger was detected."
  };
}

export function createIssueControlAdvanceLoopStateNextAction(
  report: IssueControlAdvanceLoopReport,
  repeatedTerminalCount: number
): string {
  if (report.status === "planned") {
    return "Review the planned advance, then rerun issue-control advance with --execute when acceptable.";
  }
  if (report.status === "complete" && isAdvanceLoopMaxStepPause(report.stopReason)) {
    return "Max-step guard was reached before a terminal sync or complete decision; another bounded advance loop may continue unattended.";
  }
  if (report.status === "complete") {
    return "Review completed loop artifacts and refresh md2 issue state with a reviewed sync plan when ready.";
  }
  if (repeatedTerminalCount > 1) {
    return "Repeat guard is active. Resolve the blocker or produce a new supervise progress ledger before unattended execution continues.";
  }
  if (report.status === "failed") {
    return "Inspect the failed step evidence and recovery artifacts before the next advance loop.";
  }
  return "Inspect the blocked step evidence and recovery artifacts before the next advance loop.";
}

export function createIssueControlAdvanceLoopSchedulerDecision(
  state: IssueControlAdvanceLoopState
): IssueControlAdvanceLoopSchedulerDecision {
  const trustTier = state.trustTier ?? "supervised";
  const safetyEnvelope = state.safetyEnvelope;
  const unattendedAllowed = trustTier === "unattended" ? safetyEnvelope?.passed === true : true;
  const decisionBase = { trustTier, safetyEnvelope, adaptiveGate: state.adaptiveGate };
  if (state.repeatGuardActive) {
    return { ...decisionBase, action: "stop-for-recovery", canRunUnattended: false, requiresHuman: true, exitCode: 1,
      reason: "Repeat guard is active for the same failed or blocked source ledger." };
  }
  if (state.status === "failed" || state.status === "blocked") {
    return { ...decisionBase, action: "stop-for-recovery", canRunUnattended: false, requiresHuman: true, exitCode: 1,
      reason: `Advance loop stopped as ${state.status}; inspect recovery evidence before continuing.` };
  }
  if (state.status === "planned") {
    return { ...decisionBase, action: "review-plan", canRunUnattended: false, requiresHuman: true, exitCode: 0,
      reason: "Advance loop is planned only; explicit review is required before execution.", nextCommand: createAdvanceCommand(state) };
  }
  if (state.status === "complete" && isAdvanceLoopMaxStepPause(state.stopReason)) {
    return {
      ...decisionBase,
      action: "run-advance-loop",
      canRunUnattended: unattendedAllowed,
      requiresHuman: !unattendedAllowed,
      exitCode: 0,
      reason: unattendedAllowed
        ? "Advance loop reached its max-step guard and the trust safety envelope allows unattended continuation."
        : `Advance loop reached max-step guard, but unattended safety envelope is not green: ${failedSafetyChecks(safetyEnvelope ?? { passed: false, trustTier, checks: [] }).join(", ") || "missing-envelope"}.`,
      nextCommand: createAdvanceCommand(state)
    };
  }
  return { ...decisionBase, action: "sync-issues", canRunUnattended: false, requiresHuman: false, exitCode: 0,
    reason: "Advance loop is complete; review artifacts and refresh md2 issue state with a sync plan." };
}

function isAdvanceLoopMaxStepPause(stopReason: string): boolean {
  return /^Reached max steps \d+\.$/.test(stopReason);
}

function failedSafetyChecks(envelope: IssueControlSafetyEnvelope): string[] {
  return envelope.checks.filter((check) => !check.passed).map((check) => check.id);
}

function createAdvanceCommand(state: IssueControlAdvanceLoopState): string {
  return [
    "node", "dist/cli.js", "issue-control", "advance",
    ...(state.configPath ? ["--config", state.configPath] : []),
    ...(state.sourceLedgerPath ? ["--input", state.sourceLedgerPath] : []),
    "--execute", "--max-steps", String(state.maxSteps)
  ].map(shellToken).join(" ");
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(value) ? value : JSON.stringify(value);
}
