import type { CheckHealthResult, CheckHealthSummary, CheckResult, ComparePolicy, CompareReport, Difference, ProbeResult, Snapshot } from "../types.js";

export function compareSnapshots(
  baseline: Snapshot,
  current: Snapshot,
  policy: ComparePolicy = {
    failOnCheckRegression: true,
    failOnProbeDiff: true
  }
): CompareReport {
  const differences: Difference[] = [];
  const checkHealth = classifyCheckHealth(baseline.checks, current.checks);

  differences.push(...compareChecks(baseline.checks, current.checks, policy));
  differences.push(...compareProbes(baseline.probes, current.probes, policy));
  differences.push(...compareScan(baseline, current));

  return {
    passed: !differences.some((difference) => difference.severity === "error")
      && (policy.allowInheritedFailures !== false || checkHealth.inheritedFailure === 0),
    baselineId: baseline.id,
    currentId: current.id,
    createdAt: new Date().toISOString(),
    differences,
    checkHealth
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

    const health = classifyCheck(before, after);
    if (health.classification === "regression") {
      differences.push({
        severity: before.critical && policy.failOnCheckRegression ? "error" : "warn",
        area: "check",
        name: before.name,
        message: `Check regressed from ${before.status} to ${after.status}.`,
        before: before.exitCode,
        after: after.exitCode
      });
    } else if (health.classification === "recovered") {
      differences.push({
        severity: "info",
        area: "check",
        name: before.name,
        message: `Check status changed from ${before.status} to ${after.status}.`,
        before: before.exitCode,
        after: after.exitCode
      });
    } else if (health.classification === "changed-failure") {
      differences.push({
        severity: before.critical && policy.failOnChangedFailure !== false ? "error" : "warn",
        area: "check",
        name: before.name,
        message: "Check remains failing, but its failure output changed.",
        before: failureFingerprint(before),
        after: failureFingerprint(after)
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

function classifyCheckHealth(baseline: CheckResult[], current: CheckResult[]): CheckHealthSummary {
  const currentByName = indexByName(current);
  const results = baseline.map((before) => classifyCheck(before, currentByName.get(before.name)));
  return {
    total: results.length,
    healthy: countHealth(results, "healthy"),
    inheritedFailure: countHealth(results, "inherited-failure"),
    regression: countHealth(results, "regression"),
    changedFailure: countHealth(results, "changed-failure"),
    recovered: countHealth(results, "recovered"),
    missing: countHealth(results, "missing"),
    results
  };
}

function classifyCheck(before: CheckResult, after: CheckResult | undefined): CheckHealthResult {
  const base = {
    name: before.name,
    critical: before.critical,
    baselineStatus: before.status,
    currentStatus: after?.status,
    baselineExitCode: before.exitCode,
    currentExitCode: after?.exitCode,
    outputChanged: after ? failureFingerprint(before) !== failureFingerprint(after) : false
  };
  if (!after) return { ...base, classification: "missing" };
  if (before.status === "passed" && after.status === "passed") return { ...base, classification: "healthy" };
  if (before.status === "passed") return { ...base, classification: "regression" };
  if (after.status === "passed") return { ...base, classification: "recovered" };
  if (before.status === after.status && !base.outputChanged) return { ...base, classification: "inherited-failure" };
  return { ...base, classification: "changed-failure" };
}

function failureFingerprint(check: CheckResult): string {
  return [check.status, check.exitCode, check.normalizedStdoutHash ?? check.stdoutHash, check.normalizedStderrHash ?? check.stderrHash, check.error ?? ""].join(":");
}

function countHealth(results: CheckHealthResult[], classification: CheckHealthResult["classification"]): number {
  return results.filter((result) => result.classification === classification).length;
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
