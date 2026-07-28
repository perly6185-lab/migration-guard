import { JAVA_CORE_SEMANTIC_RULE_PACKAGE } from "./javaCoreSemanticRegistry.js";
import { JAVA_SEMANTIC_RULE_PACKAGE } from "./javaSemanticRegistry.js";
import type { SemanticRulePackage } from "./semanticRulePackage.js";

export const BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES: SemanticRulePackage[] = [
  JAVA_SEMANTIC_RULE_PACKAGE,
  JAVA_CORE_SEMANTIC_RULE_PACKAGE
];

export function getBuiltinJavaSemanticRulePackage(packageId: string): SemanticRulePackage | undefined {
  return BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES.find((pkg) => pkg.id === packageId);
}
