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
  conflictPolicy?: {
    strategy: "ordered-first-match";
    reviewedPrecedence: Array<{
      id: string;
      winnerRuleId: string;
      loserRuleId: string;
      reason: string;
    }>;
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
  kind?: SemanticEvaluationSampleKind;
  applicable?: boolean;
  expectedBehavior?: BehaviorKind;
  expectedRuleId?: string;
}

export type SemanticEvaluationSampleKind =
  | "java-method"
  | "sql-source"
  | "external-boundary"
  | "generated-declaration"
  | "unknown";

export interface SemanticEvaluationPolicy {
  minimumCoveragePercent?: number;
  minimumRuleCoveragePercent?: number;
  maximumUnreviewedConflicts?: number;
  maximumExpectedMismatches?: number;
}

export interface SemanticRulePackageEvaluation {
  version: 1;
  packageId: string;
  packageVersion: string;
  packageHash: string;
  status: "passed" | "needs-review" | "blocked";
  sampleCount: number;
  applicableSampleCount: number;
  excludedSamples: Array<{
    sampleId: string;
    kind: SemanticEvaluationSampleKind;
  }>;
  classifiedCount: number;
  unclassified: string[];
  conflicts: Array<{
    sampleId: string;
    selectedRuleId: string;
    matchedRuleIds: string[];
    behaviors: BehaviorKind[];
    reviewed: boolean;
    reviewIds: string[];
  }>;
  expectedMismatches: Array<{
    sampleId: string;
    expected: BehaviorKind;
    actual?: BehaviorKind;
    ruleId?: string;
    expectedRuleId?: string;
  }>;
  coverage: {
    classifiedPercent: number;
    ruleCoveragePercent: number;
    rulesHit: number;
    totalRules: number;
    genericBuiltinHits: number;
    reviewedCompatibilityHits: number;
    projectHits: number;
    byKind: Array<{
      kind: SemanticEvaluationSampleKind;
      sampleCount: number;
      applicableCount: number;
      classifiedCount: number;
      classifiedPercent: number;
    }>;
  };
  policy: {
    configured: SemanticEvaluationPolicy;
    passed: boolean;
    findings: string[];
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
const SAMPLE_KINDS = new Set<SemanticEvaluationSampleKind>([
  "java-method",
  "sql-source",
  "external-boundary",
  "generated-declaration",
  "unknown"
]);
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
  if (!Array.isArray(pkg.scope?.frameworks)
    || pkg.scope.frameworks.some((value) => typeof value !== "string" || !value.trim())) {
    findings.push("SEMANTIC-PACKAGE-FRAMEWORK-SCOPE-INVALID");
  }
  if (!Array.isArray(pkg.scope?.projects)
    || pkg.scope.projects.some((value) => typeof value !== "string" || !value.trim())) {
    findings.push("SEMANTIC-PACKAGE-PROJECT-SCOPE-INVALID");
  }
  if (rules.length === 0) findings.push("SEMANTIC-PACKAGE-RULES-MISSING");

  const ids = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      findings.push(`SEMANTIC-RULE-INVALID:${index}`);
      continue;
    }
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
  if (pkg.conflictPolicy !== undefined
    && (!pkg.conflictPolicy || typeof pkg.conflictPolicy !== "object" || Array.isArray(pkg.conflictPolicy))) {
    findings.push("SEMANTIC-CONFLICT-POLICY-INVALID");
  } else if (pkg.conflictPolicy) {
    if (pkg.conflictPolicy.strategy !== "ordered-first-match") {
      findings.push("SEMANTIC-CONFLICT-POLICY-STRATEGY-INVALID");
    }
    const reviewIds = new Set<string>();
    const reviewedPrecedence = Array.isArray(pkg.conflictPolicy.reviewedPrecedence)
      ? pkg.conflictPolicy.reviewedPrecedence
      : [];
    if (!Array.isArray(pkg.conflictPolicy.reviewedPrecedence)) {
      findings.push("SEMANTIC-CONFLICT-REVIEWS-INVALID");
    }
    for (const [index, review] of reviewedPrecedence.entries()) {
      if (!review || typeof review !== "object" || Array.isArray(review)) {
        findings.push(`SEMANTIC-CONFLICT-REVIEW-INVALID:${index}`);
        continue;
      }
      if (!RULE_ID.test(review.id ?? "")) findings.push(`SEMANTIC-CONFLICT-REVIEW-ID-INVALID:${review.id ?? ""}`);
      if (reviewIds.has(review.id)) findings.push(`SEMANTIC-CONFLICT-REVIEW-ID-DUPLICATE:${review.id}`);
      reviewIds.add(review.id);
      const winnerIndex = rules.findIndex((rule) => rule?.id === review.winnerRuleId);
      const loserIndex = rules.findIndex((rule) => rule?.id === review.loserRuleId);
      if (winnerIndex < 0) findings.push(`SEMANTIC-CONFLICT-WINNER-MISSING:${review.id}`);
      if (loserIndex < 0) findings.push(`SEMANTIC-CONFLICT-LOSER-MISSING:${review.id}`);
      if (winnerIndex >= 0 && loserIndex >= 0 && winnerIndex >= loserIndex) {
        findings.push(`SEMANTIC-CONFLICT-PRECEDENCE-ORDER-INVALID:${review.id}`);
      }
      if (!review.reason?.trim()) findings.push(`SEMANTIC-CONFLICT-REASON-MISSING:${review.id}`);
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
  samples: SemanticEvaluationSample[],
  policy: SemanticEvaluationPolicy = {}
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
  const excludedSamples: SemanticRulePackageEvaluation["excludedSamples"] = [];
  const sampleFindings: string[] = [];
  const sampleIds = new Set<string>();
  const kindCounts = new Map<SemanticEvaluationSampleKind, {
    sampleCount: number;
    applicableCount: number;
    classifiedCount: number;
  }>();
  let classifiedCount = 0;
  let applicableSampleCount = 0;

  if (validation.valid) {
    for (const [index, sample] of samples.entries()) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
        sampleFindings.push(`SEMANTIC-SAMPLE-INVALID:${index}`);
        continue;
      }
      if (!sample.id?.trim()) {
        sampleFindings.push(`SEMANTIC-SAMPLE-ID-MISSING:${index}`);
        continue;
      }
      if (sampleIds.has(sample.id)) sampleFindings.push(`SEMANTIC-SAMPLE-ID-DUPLICATE:${sample.id}`);
      sampleIds.add(sample.id);
      if (typeof sample.text !== "string" || !sample.text.trim()) {
        sampleFindings.push(`SEMANTIC-SAMPLE-TEXT-MISSING:${sample.id}`);
        continue;
      }
      if (sample.kind !== undefined && !SAMPLE_KINDS.has(sample.kind)) {
        sampleFindings.push(`SEMANTIC-SAMPLE-KIND-INVALID:${sample.id}`);
        continue;
      }
      if (sample.expectedBehavior !== undefined && !BEHAVIOR_KINDS.has(sample.expectedBehavior)) {
        sampleFindings.push(`SEMANTIC-SAMPLE-EXPECTED-BEHAVIOR-INVALID:${sample.id}`);
        continue;
      }
      const kind = sample.kind ?? "unknown";
      const kindCount = kindCounts.get(kind) ?? { sampleCount: 0, applicableCount: 0, classifiedCount: 0 };
      kindCount.sampleCount += 1;
      kindCounts.set(kind, kindCount);
      if (sample.applicable === false) {
        excludedSamples.push({ sampleId: sample.id, kind });
        continue;
      }
      applicableSampleCount += 1;
      kindCount.applicableCount += 1;
      const matches = rules.filter((rule) => new RegExp(rule.pattern, rule.flags).test(sample.text));
      const selected = matches[0];
      if (!selected) {
        unclassified.push(sample.id);
      } else {
        classifiedCount += 1;
        kindCount.classifiedCount += 1;
        hitCounts.set(selected.id, (hitCounts.get(selected.id) ?? 0) + 1);
        originHits[selected.origin] += 1;
        const behaviors = [...new Set(matches.map((rule) => rule.behavior))];
        if (behaviors.length > 1) {
          const conflictingRules = matches.filter((rule) => rule.behavior !== selected.behavior);
          const reviews = conflictingRules.map((rule) => pkg.conflictPolicy?.reviewedPrecedence.find((review) =>
            review.winnerRuleId === selected.id && review.loserRuleId === rule.id));
          conflicts.push({
            sampleId: sample.id,
            selectedRuleId: selected.id,
            matchedRuleIds: matches.map((rule) => rule.id),
            behaviors,
            reviewed: reviews.every(Boolean),
            reviewIds: reviews.flatMap((review) => review ? [review.id] : [])
          });
        }
      }
      if ((sample.expectedBehavior !== undefined && selected?.behavior !== sample.expectedBehavior)
        || (sample.expectedRuleId !== undefined && selected?.id !== sample.expectedRuleId)) {
        expectedMismatches.push({
          sampleId: sample.id,
          expected: sample.expectedBehavior ?? selected?.behavior ?? "unknown",
          actual: selected?.behavior,
          ruleId: selected?.id,
          expectedRuleId: sample.expectedRuleId
        });
      }
    }
  }

  const ruleHits = [...hitCounts.entries()]
    .map(([ruleId, hits]) => ({ ruleId, hits }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.ruleId.localeCompare(b.ruleId));
  const unreviewedConflicts = conflicts.filter((conflict) => !conflict.reviewed);
  const policyFindings = evaluateSemanticPolicy(policy, {
    coveragePercent: percent(classifiedCount, applicableSampleCount),
    ruleCoveragePercent: percent(ruleHits.length, pkg.rules.length),
    unreviewedConflicts: unreviewedConflicts.length,
    expectedMismatches: expectedMismatches.length
  });
  const findings = [
    ...validation.findings,
    ...sampleFindings,
    ...(unreviewedConflicts.length > 0 ? ["SEMANTIC-EVALUATION-UNREVIEWED-CONFLICTS"] : []),
    ...(expectedMismatches.length > 0 ? ["SEMANTIC-EVALUATION-EXPECTED-MISMATCHES"] : []),
    ...policyFindings
  ];
  return {
    version: 1,
    packageId: pkg.id,
    packageVersion: pkg.version,
    packageHash: validation.packageHash,
    status: !validation.valid || sampleFindings.length > 0
      ? "blocked"
      : policyFindings.length > 0
        ? "blocked"
        : unreviewedConflicts.length > 0 || expectedMismatches.length > 0
        ? "needs-review"
        : "passed",
    sampleCount: samples.length,
    applicableSampleCount,
    excludedSamples: excludedSamples.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    classifiedCount,
    unclassified: unclassified.sort(),
    conflicts,
    expectedMismatches,
    coverage: {
      classifiedPercent: percent(classifiedCount, applicableSampleCount),
      ruleCoveragePercent: percent(ruleHits.length, pkg.rules.length),
      rulesHit: ruleHits.length,
      totalRules: pkg.rules.length,
      genericBuiltinHits: originHits["generic-builtin"],
      reviewedCompatibilityHits: originHits["reviewed-compatibility"],
      projectHits: originHits.project,
      byKind: [...kindCounts.entries()]
        .map(([kind, counts]) => ({
          kind,
          ...counts,
          classifiedPercent: percent(counts.classifiedCount, counts.applicableCount)
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind))
    },
    policy: {
      configured: policy,
      passed: policyFindings.length === 0,
      findings: policyFindings
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
        kind?: string;
        role?: string;
      }>;
    };
  };
  return (report.callGraph?.nodes ?? []).flatMap((node, index) => {
    if (!node.className || !node.methodName) return [];
    return [{
      id: node.id ?? `${node.className}.${node.methodName}:${index}`,
      text: `${node.className}.${node.methodName} ${node.file ?? ""} ${node.signature ?? ""}`,
      ...classifyJavaAnalysisSample(node)
    }];
  });
}

function classifyJavaAnalysisSample(node: {
  id?: string;
  signature?: string;
}): Pick<SemanticEvaluationSample, "kind" | "applicable"> {
  if (node.id?.startsWith("sql:")) return { kind: "sql-source", applicable: false };
  if (node.signature?.includes("[abstract-declaration]")) {
    return { kind: "generated-declaration", applicable: false };
  }
  if (node.id?.startsWith("external:")) return { kind: "external-boundary", applicable: true };
  return { kind: "java-method", applicable: true };
}

function evaluateSemanticPolicy(
  policy: SemanticEvaluationPolicy,
  actual: {
    coveragePercent: number;
    ruleCoveragePercent: number;
    unreviewedConflicts: number;
    expectedMismatches: number;
  }
): string[] {
  const findings: string[] = [];
  const minimumCoverageValid = policy.minimumCoveragePercent === undefined
    || (Number.isFinite(policy.minimumCoveragePercent)
      && policy.minimumCoveragePercent >= 0
      && policy.minimumCoveragePercent <= 100);
  const maximumConflictsValid = policy.maximumUnreviewedConflicts === undefined
    || (Number.isInteger(policy.maximumUnreviewedConflicts) && policy.maximumUnreviewedConflicts >= 0);
  const maximumMismatchesValid = policy.maximumExpectedMismatches === undefined
    || (Number.isInteger(policy.maximumExpectedMismatches) && policy.maximumExpectedMismatches >= 0);
  const minimumRuleCoverageValid = policy.minimumRuleCoveragePercent === undefined
    || (Number.isFinite(policy.minimumRuleCoveragePercent)
      && policy.minimumRuleCoveragePercent >= 0
      && policy.minimumRuleCoveragePercent <= 100);
  if (!minimumCoverageValid) findings.push("SEMANTIC-POLICY-MINIMUM-COVERAGE-INVALID");
  if (!minimumRuleCoverageValid) findings.push("SEMANTIC-POLICY-MINIMUM-RULE-COVERAGE-INVALID");
  if (!maximumConflictsValid) findings.push("SEMANTIC-POLICY-MAXIMUM-CONFLICTS-INVALID");
  if (!maximumMismatchesValid) findings.push("SEMANTIC-POLICY-MAXIMUM-MISMATCHES-INVALID");
  if (minimumCoverageValid
    && policy.minimumCoveragePercent !== undefined
    && actual.coveragePercent < policy.minimumCoveragePercent) {
    findings.push(`SEMANTIC-POLICY-COVERAGE-BELOW-MINIMUM:${actual.coveragePercent}<${policy.minimumCoveragePercent}`);
  }
  if (minimumRuleCoverageValid
    && policy.minimumRuleCoveragePercent !== undefined
    && actual.ruleCoveragePercent < policy.minimumRuleCoveragePercent) {
    findings.push(
      `SEMANTIC-POLICY-RULE-COVERAGE-BELOW-MINIMUM:${actual.ruleCoveragePercent}<${policy.minimumRuleCoveragePercent}`
    );
  }
  if (maximumConflictsValid
    && policy.maximumUnreviewedConflicts !== undefined
    && actual.unreviewedConflicts > policy.maximumUnreviewedConflicts) {
    findings.push(`SEMANTIC-POLICY-UNREVIEWED-CONFLICTS-EXCEEDED:${actual.unreviewedConflicts}>${policy.maximumUnreviewedConflicts}`);
  }
  if (maximumMismatchesValid
    && policy.maximumExpectedMismatches !== undefined
    && actual.expectedMismatches > policy.maximumExpectedMismatches) {
    findings.push(`SEMANTIC-POLICY-EXPECTED-MISMATCHES-EXCEEDED:${actual.expectedMismatches}>${policy.maximumExpectedMismatches}`);
  }
  return findings;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator * 100 / denominator).toFixed(2));
}
