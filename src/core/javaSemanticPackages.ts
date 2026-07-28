import {
  classifyJavaCoreSemanticWithTrace,
  JAVA_CORE_SEMANTIC_RULE_PACKAGE
} from "./javaCoreSemanticRegistry.js";
import {
  classifyJavaSemanticWithTrace,
  JAVA_SEMANTIC_RULE_PACKAGE,
  type JavaSemanticRule
} from "./javaSemanticRegistry.js";
import type { SemanticRuleOrigin, SemanticRulePackage } from "./semanticRulePackage.js";

export const BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES: SemanticRulePackage[] = [
  JAVA_SEMANTIC_RULE_PACKAGE,
  JAVA_CORE_SEMANTIC_RULE_PACKAGE
];

export function getBuiltinJavaSemanticRulePackage(packageId: string): SemanticRulePackage | undefined {
  return BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES.find((pkg) => pkg.id === packageId);
}

export interface JavaSemanticPackageContext {
  projectId?: string;
  language?: string;
  framework?: string;
  explicitPackageIds?: string[];
}

export type JavaSemanticPackageSelectionReason =
  | "portable-default"
  | "project-scope-match"
  | "project-scope-mismatch"
  | "legacy-no-project-context"
  | "explicit-selection"
  | "explicitly-excluded";

export interface JavaSemanticPackageResolution {
  version: 1;
  mode: "auto" | "explicit" | "legacy";
  context: {
    projectId?: string;
    language?: string;
    framework?: string;
  };
  selected: Array<{
    packageId: string;
    packageVersion: string;
    reason: JavaSemanticPackageSelectionReason;
  }>;
  excluded: Array<{
    packageId: string;
    packageVersion: string;
    reason: JavaSemanticPackageSelectionReason;
  }>;
}

export interface JavaSemanticPackageClassificationTrace {
  packageId: string;
  packageVersion: string;
  ruleId: string;
  ruleIndex: number;
  origin: SemanticRuleOrigin;
  rule: JavaSemanticRule;
}

export function resolveJavaSemanticRulePackages(
  context: JavaSemanticPackageContext = {}
): JavaSemanticPackageResolution {
  const explicit = context.explicitPackageIds;
  if (explicit) {
    const unique = [...new Set(explicit)];
    const unknown = unique.filter((packageId) => !getBuiltinJavaSemanticRulePackage(packageId));
    if (unknown.length > 0) throw new Error(`Unknown built-in semantic package: ${unknown.join(", ")}.`);
    if (!unique.includes(JAVA_CORE_SEMANTIC_RULE_PACKAGE.id)) {
      throw new Error(`Explicit Java semantic package selection must include ${JAVA_CORE_SEMANTIC_RULE_PACKAGE.id}.`);
    }
    return packageResolution("explicit", context, (pkg) =>
      unique.includes(pkg.id) ? "explicit-selection" : "explicitly-excluded"
    );
  }
  if (!context.projectId) {
    return packageResolution("legacy", context, () => "legacy-no-project-context");
  }
  return packageResolution("auto", context, (pkg) => {
    if (pkg.id === JAVA_CORE_SEMANTIC_RULE_PACKAGE.id) return "portable-default";
    return packageMatchesProject(pkg, context.projectId!)
      ? "project-scope-match"
      : "project-scope-mismatch";
  });
}

export function classifyJavaSemanticPackagesWithTrace(
  text: string,
  packageIds?: string[]
): JavaSemanticPackageClassificationTrace | undefined {
  const selected = packageIds ?? BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES.map((pkg) => pkg.id);
  if (packageIds) validateExplicitPackageIds(selected);
  for (const packageId of selected) {
    if (packageId === JAVA_SEMANTIC_RULE_PACKAGE.id) {
      const trace = classifyJavaSemanticWithTrace(text);
      if (trace) return trace;
    }
    if (packageId === JAVA_CORE_SEMANTIC_RULE_PACKAGE.id) {
      const trace = classifyJavaCoreSemanticWithTrace(text);
      if (trace) return { ...trace, origin: "generic-builtin" };
    }
  }
  return undefined;
}

function packageResolution(
  mode: JavaSemanticPackageResolution["mode"],
  context: JavaSemanticPackageContext,
  reasonFor: (pkg: SemanticRulePackage) => JavaSemanticPackageSelectionReason
): JavaSemanticPackageResolution {
  const selected: JavaSemanticPackageResolution["selected"] = [];
  const excluded: JavaSemanticPackageResolution["excluded"] = [];
  for (const pkg of BUILTIN_JAVA_SEMANTIC_RULE_PACKAGES) {
    const reason = reasonFor(pkg);
    const item = { packageId: pkg.id, packageVersion: pkg.version, reason };
    if (["project-scope-mismatch", "explicitly-excluded"].includes(reason)) excluded.push(item);
    else selected.push(item);
  }
  return {
    version: 1,
    mode,
    context: {
      projectId: context.projectId,
      language: context.language,
      framework: context.framework
    },
    selected,
    excluded
  };
}

function packageMatchesProject(pkg: SemanticRulePackage, projectId: string): boolean {
  return pkg.scope.projects.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(projectId);
  });
}

function validateExplicitPackageIds(packageIds: string[]): void {
  const unknown = packageIds.filter((packageId) => !getBuiltinJavaSemanticRulePackage(packageId));
  if (unknown.length > 0) throw new Error(`Unknown built-in semantic package: ${unknown.join(", ")}.`);
  if (!packageIds.includes(JAVA_CORE_SEMANTIC_RULE_PACKAGE.id)) {
    throw new Error(`Explicit Java semantic package selection must include ${JAVA_CORE_SEMANTIC_RULE_PACKAGE.id}.`);
  }
}
