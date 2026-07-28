import type { BehaviorKind } from "./endpointReplacementModel.js";
import type { SemanticRulePackage } from "./semanticRulePackage.js";
import {
  JAVA_SEMANTIC_RULE_PACKAGE,
  JAVA_SEMANTIC_RULES
} from "./javaSemanticRegistry.js";

export interface JavaCoreSemanticRule {
  id: string;
  pattern: RegExp;
  kind: BehaviorKind;
  reason: string;
  defaultOwnership: "target-owned" | "infrastructure-port" | "reviewed-exclusion";
}

export const PROMOTED_JAVA_CORE_SEMANTIC_RULES: JavaCoreSemanticRule[] = [
  { id: "compensation-keyword", pattern: /undo|rollback|reconcile|compensat|restore/i, kind: "compensation", reason: "compensation semantics", defaultOwnership: "target-owned" },
  { id: "transaction-keyword", pattern: /transaction|commit|unitofwork/i, kind: "transaction", reason: "transaction boundary", defaultOwnership: "target-owned" },
  { id: "event-publication-keyword", pattern: /publish|emit|event|progress|notify/i, kind: "event-publish", reason: "event publication", defaultOwnership: "infrastructure-port" },
  { id: "validation-keyword", pattern: /validat|assert|check|required|unique|permission/i, kind: "validation", reason: "validation or policy check", defaultOwnership: "target-owned" },
  { id: "context-keyword", pattern: /tenant|security|auth|datasource|requestcontext|webframework|device|locale|SecurityFramework/i, kind: "context-resolution", reason: "runtime context access", defaultOwnership: "infrastructure-port" },
  { id: "external-boundary-keyword", pattern: /client|\bapi\.|gateway|adapter|storage|fileApi|http|rpc/i, kind: "external-call", reason: "external service boundary", defaultOwnership: "infrastructure-port" },
  { id: "ddl-mutation-keyword", pattern: /\bddl\b|create\s+table|alter\s+table|drop\s+table|truncate\s+table/i, kind: "state-write", reason: "database schema mutation", defaultOwnership: "infrastructure-port" },
  { id: "state-mutation-keyword", pattern: /insert|save|create|update|delete|remove|clear|write|upsert|persist|record|set|lock|acquire|cancel|terminate|submit|enable|disable|approve|reject|archive/i, kind: "state-write", reason: "state mutation", defaultOwnership: "infrastructure-port" },
  { id: "state-lookup-keyword", pattern: /select|query|find|get|list|load|read|count|exists|rowNum|(^|\.)page(?:\b|[A-Z])/i, kind: "state-read", reason: "state lookup", defaultOwnership: "infrastructure-port" },
  { id: "infrastructure-keyword", pattern: /repository|mapper|cache|upload|download|file/i, kind: "external-call", reason: "external or infrastructure boundary", defaultOwnership: "infrastructure-port" }
];

const GENERIC_JAVA_SEMANTIC_RULES = JAVA_SEMANTIC_RULES.filter((_, index) =>
  JAVA_SEMANTIC_RULE_PACKAGE.rules[index]?.origin === "generic-builtin"
);

export const JAVA_CORE_SEMANTIC_RULES: JavaCoreSemanticRule[] = [
  ...GENERIC_JAVA_SEMANTIC_RULES,
  ...PROMOTED_JAVA_CORE_SEMANTIC_RULES
];

export const JAVA_CORE_SEMANTIC_RULE_PACKAGE: SemanticRulePackage = {
  schemaVersion: 1,
  id: "builtin-java-core",
  version: "1.1.0",
  language: "java",
  description: "Portable Java semantics extracted from generic built-ins plus promoted high-risk classifier rules.",
  compatibility: {
    engineSchemaVersion: 1,
    mode: "portable"
  },
  scope: {
    frameworks: ["java", "spring", "jakarta", "mybatis", "spring-data"],
    projects: ["*"]
  },
  conflictPolicy: {
    strategy: "ordered-first-match",
    reviewedPrecedence: [
      ...(JAVA_SEMANTIC_RULE_PACKAGE.conflictPolicy?.reviewedPrecedence.filter((review) =>
        JAVA_CORE_SEMANTIC_RULES.some((rule) => rule.id === review.winnerRuleId)
        && JAVA_CORE_SEMANTIC_RULES.some((rule) => rule.id === review.loserRuleId)
      ) ?? []),
      {
        id: "event-publication-before-state-mutation",
        winnerRuleId: "event-publication-keyword",
        loserRuleId: "state-mutation-keyword",
        reason: "Publishing and notification names describe an event boundary even when they also contain a mutation verb."
      },
      {
        id: "state-mutation-before-infrastructure",
        winnerRuleId: "state-mutation-keyword",
        loserRuleId: "infrastructure-keyword",
        reason: "Repository and mapper mutation methods retain their more precise state-write behavior."
      },
      {
        id: "state-lookup-before-infrastructure",
        winnerRuleId: "state-lookup-keyword",
        loserRuleId: "infrastructure-keyword",
        reason: "Repository and mapper lookup methods retain their more precise state-read behavior."
      }
    ]
  },
  rules: JAVA_CORE_SEMANTIC_RULES.map((rule) => ({
    id: rule.id,
    pattern: rule.pattern.source,
    flags: rule.pattern.flags,
    behavior: rule.kind,
    reason: rule.reason,
    defaultOwnership: rule.defaultOwnership,
    origin: "generic-builtin"
  }))
};

export interface JavaCoreSemanticClassificationTrace {
  packageId: string;
  packageVersion: string;
  ruleId: string;
  ruleIndex: number;
  rule: JavaCoreSemanticRule;
}

export function classifyJavaCoreSemanticWithTrace(text: string): JavaCoreSemanticClassificationTrace | undefined {
  const ruleIndex = JAVA_CORE_SEMANTIC_RULES.findIndex((rule) => rule.pattern.test(text));
  if (ruleIndex < 0) return undefined;
  return {
    packageId: JAVA_CORE_SEMANTIC_RULE_PACKAGE.id,
    packageVersion: JAVA_CORE_SEMANTIC_RULE_PACKAGE.version,
    ruleId: JAVA_CORE_SEMANTIC_RULES[ruleIndex].id,
    ruleIndex,
    rule: JAVA_CORE_SEMANTIC_RULES[ruleIndex]
  };
}
