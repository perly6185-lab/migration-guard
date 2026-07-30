import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface MigrationGateUpstream {
  gate: "offline" | "real";
  path: string;
  projectHash: string;
  reportHash: string;
  status: "passed" | "blocked";
}

export interface MigrationGateIntegrity {
  generatedAt: string;
  freshness: "fresh" | "stale";
  upstream: MigrationGateUpstream[];
  reportHash: string;
}

export function finalizeGateIntegrity<T extends object>(
  report: T,
  generatedAt = new Date().toISOString()
): T & MigrationGateIntegrity {
  const partial = {
    ...report,
    generatedAt,
    freshness: "fresh" as const,
    upstream: "upstream" in report
      ? (report as { upstream?: MigrationGateUpstream[] }).upstream ?? []
      : []
  };
  return {
    ...partial,
    reportHash: gateReportHash(partial)
  };
}

export function gateReportHash(report: object): string {
  const copy = { ...report } as Record<string, unknown>;
  delete copy.reportHash;
  return sha256(stableStringify(copy));
}

export function validateGateIntegrity<T extends object>(
  report: T & Partial<MigrationGateIntegrity> & { projectHash?: string },
  expectedProjectHash: string,
  expectedUpstream: MigrationGateUpstream[] = []
): string[] {
  const findings: string[] = [];
  if (report.projectHash !== expectedProjectHash) findings.push("MG-GATE-PROJECT-HASH-STALE");
  if (report.freshness !== "fresh") findings.push("MG-GATE-STALE");
  if (!report.generatedAt) findings.push("MG-GATE-GENERATED-AT-MISSING");
  if (!report.reportHash || report.reportHash !== gateReportHash(report)) {
    findings.push("MG-GATE-REPORT-HASH-MISMATCH");
  }
  const actualUpstream = report.upstream ?? [];
  for (const expected of expectedUpstream) {
    const actual = actualUpstream.find((item) => item.gate === expected.gate);
    if (!actual) {
      findings.push(`MG-GATE-UPSTREAM-MISSING:${expected.gate}`);
      continue;
    }
    if (actual.projectHash !== expected.projectHash
      || actual.reportHash !== expected.reportHash
      || actual.status !== expected.status
      || actual.path !== expected.path) {
      findings.push(`MG-GATE-UPSTREAM-STALE:${expected.gate}`);
    }
  }
  return [...new Set(findings)].sort();
}
