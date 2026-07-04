import type { CheckResult, ComparePolicy, CompareReport, Difference, ProbeResult, Snapshot } from "../types.js";

export function compareSnapshots(
  baseline: Snapshot,
  current: Snapshot,
  policy: ComparePolicy = {
    failOnCheckRegression: true,
    failOnProbeDiff: true
  }
): CompareReport {
  const differences: Difference[] = [];

  differences.push(...compareChecks(baseline.checks, current.checks, policy));
  differences.push(...compareProbes(baseline.probes, current.probes, policy));
  differences.push(...compareScan(baseline, current));

  return {
    passed: !differences.some((difference) => difference.severity === "error"),
    baselineId: baseline.id,
    currentId: current.id,
    createdAt: new Date().toISOString(),
    differences
  };
}

function compareChecks(baseline: CheckResult[], current: CheckResult[], policy: ComparePolicy): Difference[] {
  const differences: Difference[] = [];
  const currentByName = indexByName(current);

  for (const before of baseline) {
    const after = currentByName.get(before.name);
    if (!after) {
      differences.push({
        severity: before.critical ? "error" : "warn",
        area: "check",
        name: before.name,
        message: "Check is missing in current run."
      });
      continue;
    }

    if (before.status === "passed" && after.status !== "passed") {
      differences.push({
        severity: before.critical && policy.failOnCheckRegression ? "error" : "warn",
        area: "check",
        name: before.name,
        message: `Check regressed from ${before.status} to ${after.status}.`,
        before: before.exitCode,
        after: after.exitCode
      });
    } else if (before.status !== after.status) {
      differences.push({
        severity: "info",
        area: "check",
        name: before.name,
        message: `Check status changed from ${before.status} to ${after.status}.`,
        before: before.exitCode,
        after: after.exitCode
      });
    }

    const beforeStdoutHash = before.normalizedStdoutHash ?? before.stdoutHash;
    const afterStdoutHash = after.normalizedStdoutHash ?? after.stdoutHash;
    const beforeStderrHash = before.normalizedStderrHash ?? before.stderrHash;
    const afterStderrHash = after.normalizedStderrHash ?? after.stderrHash;

    if (beforeStdoutHash !== afterStdoutHash && before.status === "passed" && after.status === "passed") {
      differences.push({
        severity: "warn",
        area: "check",
        name: before.name,
        message: "Check stdout changed while still passing.",
        before: beforeStdoutHash,
        after: afterStdoutHash
      });
    }

    if (beforeStderrHash !== afterStderrHash && before.status === "passed" && after.status === "passed") {
      differences.push({
        severity: "warn",
        area: "check",
        name: before.name,
        message: "Check stderr changed while still passing.",
        before: beforeStderrHash,
        after: afterStderrHash
      });
    }
  }

  return differences;
}

function compareProbes(baseline: ProbeResult[], current: ProbeResult[], policy: ComparePolicy): Difference[] {
  const differences: Difference[] = [];
  const currentByName = indexByName(current);

  for (const before of baseline) {
    const after = currentByName.get(before.name);
    if (!after) {
      differences.push({
        severity: policy.failOnProbeDiff ? "error" : "warn",
        area: "probe",
        name: before.name,
        message: "Probe is missing in current run."
      });
      continue;
    }

    if (before.type !== after.type) {
      differences.push({
        severity: policy.failOnProbeDiff ? "error" : "warn",
        area: "probe",
        name: before.name,
        message: `Probe type changed from ${before.type} to ${after.type}.`
      });
    }

    if (before.status !== after.status) {
      differences.push({
        severity: policy.failOnProbeDiff ? "error" : "warn",
        area: "probe",
        name: before.name,
        message: `Probe status changed from ${before.status} to ${after.status}.`
      });
    }

    if (before.outputHash !== after.outputHash) {
      differences.push({
        severity: policy.failOnProbeDiff ? "error" : "warn",
        area: "probe",
        name: before.name,
        message: "Probe output changed.",
        before: before.outputHash,
        after: after.outputHash
      });
    }
  }

  return differences;
}

function compareScan(baseline: Snapshot, current: Snapshot): Difference[] {
  const differences: Difference[] = [];

  if (baseline.configHash !== current.configHash) {
    differences.push({
      severity: "info",
      area: "scan",
      name: "config",
      message: "Configuration changed between snapshots.",
      before: baseline.configHash,
      after: current.configHash
    });
  }

  if (baseline.scan.sourceFiles !== current.scan.sourceFiles) {
    differences.push({
      severity: "info",
      area: "scan",
      name: "source-files",
      message: "Source file count changed.",
      before: baseline.scan.sourceFiles,
      after: current.scan.sourceFiles
    });
  }

  return differences;
}

function indexByName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}
