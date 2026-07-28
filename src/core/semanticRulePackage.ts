import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { BehaviorKind } from "./endpointReplacementModel.js";

export type SemanticRuleOrigin =
  | "generic-builtin"
  | "reviewed-compatibility"
  | "project";

export interface VersionedSemanticRule {
  id: string;
  pattern: string;
  flags: string;
  behavior: BehaviorKind;
  reason: string;
  defaultOwnership: "target-owned" | "infrastructure-port" | "reviewed-exclusion";
  origin: SemanticRuleOrigin;
}

export interface SemanticRulePackage {
  schemaVersion: 1;
  id: string;
  version: string;
  language: string;
  description: string;
  compatibility: {
    engineSchemaVersion: 1;
    mode: "builtin-compatibility" | "portable" | "project";
  };
  scope: {
    frameworks: string[];
    projects: string[];
  };
  rules: VersionedSemanticRule[];
}

export interface SemanticRulePackageValidation {
  version: 1;
  packageId: string;
  packageVersion: string;
  valid: boolean;
  findings: string[];
  ruleCount: number;
  packageHash: string;
}

export interface SemanticRulePackageLock {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  language: string;
  packageHash: string;
  ruleCount: number;
  rules: Array<{
    id: string;
    ruleHash: string;
  }>;
}

export interface SemanticRulePackageDiff {
  version: 1;
  packageId: string;
  fromVersion: string;
  toVersion: string;
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: number;
  fromHash: string;
  toHash: string;
}

export interface SemanticEvaluationSample {
  id: string;
  text: string;
  expectedBehavior?: BehaviorKind;
}

export interface SemanticRulePackageEvaluation {
  version: 1;
  packageId: string;
  packageVersion: string;
  packageHash: string;
  status: "passed" | "needs-review" | "blocked";
  sampleCount: number;
  classifiedCount: number;
  unclassified: string[];
  conflicts: Array<{
    sampleId: string;
    selectedRuleId: string;
    matchedRuleIds: string[];
    behaviors: BehaviorKind[];
  }>;
  expectedMismatches: Array<{
    sampleId: string;
    expected: BehaviorKind;
    actual?: BehaviorKind;
    ruleId?: string;
  }>;
  coverage: {
    classifiedPercent: number;
    genericBuiltinHits: number;
    reviewedCompatibilityHits: number;
    projectHits: number;
  };
  ruleHits: Array<{
    ruleId: string;
    hits: number;
  }>;
  unusedRuleIds: string[];
  findings: string[];
}

const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const BEHAVIOR_KINDS = new Set<BehaviorKind>([
  "entrypoint",
  "validation",
  "context-resolution",
  "decision",
  "calculation",
  "state-read",
  "state-write",
  "external-call",
  "transaction",
  "event-publish",
  "compensation",
  "observability",
  "clock-read",
  "coordination",
  "async-boundary",
  "unknown"
]);

export function semanticRulePackageHash(pkg: SemanticRulePackage): string {
  return sha256(stableStringify(pkg));
}

export function validateSemanticRulePackage(pkg: SemanticRulePackage): SemanticRulePackageValidation {
  const findings: string[] = [];
  const rules = Array.isArray(pkg.rules) ? pkg.rules : [];
  if (pkg.schemaVersion !== 1) findings.push("SEMANTIC-PACKAGE-SCHEMA-UNSUPPORTED");
  if (!PACKAGE_ID.test(pkg.id ?? "")) findings.push("SEMANTIC-PACKAGE-ID-INVALID");
  if (!VERSION.test(pkg.version ?? "")) findings.push("SEMANTIC-PACKAGE-VERSION-INVALID");
  if (!pkg.language?.trim()) findings.push("SEMANTIC-PACKAGE-LANGUAGE-MISSING");
  if (!pkg.description?.trim()) findings.push("SEMANTIC-PACKAGE-DESCRIPTION-MISSING");
  if (pkg.compatibility?.engineSchemaVersion !== 1) findings.push("SEMANTIC-PACKAGE-ENGINE-SCHEMA-UNSUPPORTED");
  if (!["builtin-compatibility", "portable", "project"].includes(pkg.compatibility?.mode)) {
    findings.push("SEMANTIC-PACKAGE-MODE-INVALID");
  }
  if (rules.length === 0) findings.push("SEMANTIC-PACKAGE-RULES-MISSING");

  const ids = new Set<string>();
  for (const rule of rules) {
    if (!RULE_ID.test(rule.id ?? "")) findings.push(`SEMANTIC-RULE-ID-INVALID:${rule.id ?? ""}`);
    if (ids.has(rule.id)) findings.push(`SEMANTIC-RULE-ID-DUPLICATE:${rule.id}`);
    ids.add(rule.id);
    if (!rule.pattern) findings.push(`SEMANTIC-RULE-PATTERN-MISSING:${rule.id}`);
    else {
      try {
        new RegExp(rule.pattern, rule.flags);
      } catch {
        findings.push(`SEMANTIC-RULE-PATTERN-INVALID:${rule.id}`);
      }
    }
    if (!BEHAVIOR_KINDS.has(rule.behavior)) findings.push(`SEMANTIC-RULE-BEHAVIOR-INVALID:${rule.id}`);
    if (!rule.reason?.trim()) findings.push(`SEMANTIC-RULE-REASON-MISSING:${rule.id}`);
    if (!["target-owned", "infrastructure-port", "reviewed-exclusion"].includes(rule.defaultOwnership)) {
      findings.push(`SEMANTIC-RULE-OWNERSHIP-INVALID:${rule.id}`);
    }
    if (!["generic-builtin", "reviewed-compatibility", "project"].includes(rule.origin)) {
      findings.push(`SEMANTIC-RULE-ORIGIN-INVALID:${rule.id}`);
    }
  }

  return {
    version: 1,
    packageId: pkg.id ?? "",
    packageVersion: pkg.version ?? "",
    valid: findings.length === 0,
    findings: [...new Set(findings)].sort(),
    ruleCount: rules.length,
    packageHash: semanticRulePackageHash(pkg)
  };
}

export function createSemanticRulePackageLock(pkg: SemanticRulePackage): SemanticRulePackageLock {
  const validation = validateSemanticRulePackage(pkg);
  if (!validation.valid) {
    throw new Error(`Invalid semantic rule package: ${validation.findings.join(", ")}`);
  }
  return {
    schemaVersion: 1,
    packageId: pkg.id,
    packageVersion: pkg.version,
    language: pkg.language,
    packageHash: validation.packageHash,
    ruleCount: pkg.rules.length,
    rules: pkg.rules.map((rule) => ({
      id: rule.id,
      ruleHash: sha256(stableStringify(rule))
    }))
  };
}

export function diffSemanticRulePackageLocks(
  from: SemanticRulePackageLock,
  to: SemanticRulePackageLock
): SemanticRulePackageDiff {
  if (from.schemaVersion !== 1 || to.schemaVersion !== 1) {
    throw new Error("Unsupported semantic rule package lock schema.");
  }
  if (from.packageId !== to.packageId) {
    throw new Error(`Semantic package id mismatch: ${from.packageId} != ${to.packageId}.`);
  }
  const fromRules = new Map(from.rules.map((rule) => [rule.id, rule.ruleHash]));
  const toRules = new Map(to.rules.map((rule) => [rule.id, rule.ruleHash]));
  const added = [...toRules.keys()].filter((id) => !fromRules.has(id)).sort();
  const removed = [...fromRules.keys()].filter((id) => !toRules.has(id)).sort();
  const modified = [...toRules.keys()]
    .filter((id) => fromRules.has(id) && fromRules.get(id) !== toRules.get(id))
    .sort();
  const unchanged = [...toRules.keys()]
    .filter((id) => fromRules.get(id) === toRules.get(id))
    .length;
  return {
    version: 1,
    packageId: from.packageId,
    fromVersion: from.packageVersion,
    toVersion: to.packageVersion,
    changed: from.packageHash !== to.packageHash,
    added,
    removed,
    modified,
    unchanged,
    fromHash: from.packageHash,
    toHash: to.packageHash
  };
}

export function evaluateSemanticRulePackage(
  pkg: SemanticRulePackage,
  samples: SemanticEvaluationSample[]
): SemanticRulePackageEvaluation {
  const validation = validateSemanticRulePackage(pkg);
  const rules = Array.isArray(pkg.rules) ? pkg.rules : [];
  const hitCounts = new Map(rules.map((rule) => [rule.id, 0]));
  const originHits: Record<SemanticRuleOrigin, number> = {
    "generic-builtin": 0,
    "reviewed-compatibility": 0,
    project: 0
  };
  const unclassified: string[] = [];
  const conflicts: SemanticRulePackageEvaluation["conflicts"] = [];
  const expectedMismatches: SemanticRulePackageEvaluation["expectedMismatches"] = [];
  let classifiedCount = 0;

  if (validation.valid) {
    for (const sample of samples) {
      const matches = rules.filter((rule) => new RegExp(rule.pattern, rule.flags).test(sample.text));
      const selected = matches[0];
      if (!selected) {
        unclassified.push(sample.id);
      } else {
        classifiedCount += 1;
        hitCounts.set(selected.id, (hitCounts.get(selected.id) ?? 0) + 1);
        originHits[selected.origin] += 1;
        const behaviors = [...new Set(matches.map((rule) => rule.behavior))];
        if (behaviors.length > 1) {
          conflicts.push({
            sampleId: sample.id,
            selectedRuleId: selected.id,
            matchedRuleIds: matches.map((rule) => rule.id),
            behaviors
          });
        }
      }
      if (sample.expectedBehavior !== undefined && selected?.behavior !== sample.expectedBehavior) {
        expectedMismatches.push({
          sampleId: sample.id,
          expected: sample.expectedBehavior,
          actual: selected?.behavior,
          ruleId: selected?.id
        });
      }
    }
  }

  const ruleHits = [...hitCounts.entries()]
    .map(([ruleId, hits]) => ({ ruleId, hits }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.ruleId.localeCompare(b.ruleId));
  const findings = [
    ...validation.findings,
    ...(conflicts.length > 0 ? ["SEMANTIC-EVALUATION-CONFLICTS"] : []),
    ...(expectedMismatches.length > 0 ? ["SEMANTIC-EVALUATION-EXPECTED-MISMATCHES"] : [])
  ];
  return {
    version: 1,
    packageId: pkg.id,
    packageVersion: pkg.version,
    packageHash: validation.packageHash,
    status: !validation.valid
      ? "blocked"
      : conflicts.length > 0 || expectedMismatches.length > 0
        ? "needs-review"
        : "passed",
    sampleCount: samples.length,
    classifiedCount,
    unclassified: unclassified.sort(),
    conflicts,
    expectedMismatches,
    coverage: {
      classifiedPercent: samples.length === 0 ? 0 : Number((classifiedCount * 100 / samples.length).toFixed(2)),
      genericBuiltinHits: originHits["generic-builtin"],
      reviewedCompatibilityHits: originHits["reviewed-compatibility"],
      projectHits: originHits.project
    },
    ruleHits,
    unusedRuleIds: [...hitCounts.entries()]
      .filter(([, hits]) => hits === 0)
      .map(([id]) => id)
      .sort(),
    findings: [...new Set(findings)].sort()
  };
}

export function semanticSamplesFromJavaAnalysis(value: unknown): SemanticEvaluationSample[] {
  const report = value as {
    callGraph?: {
      nodes?: Array<{
        id?: string;
        className?: string;
        methodName?: string;
        file?: string;
        signature?: string;
      }>;
    };
  };
  return (report.callGraph?.nodes ?? []).flatMap((node, index) => {
    if (!node.className || !node.methodName) return [];
    return [{
      id: node.id ?? `${node.className}.${node.methodName}:${index}`,
      text: `${node.className}.${node.methodName} ${node.file ?? ""} ${node.signature ?? ""}`
    }];
  });
}
