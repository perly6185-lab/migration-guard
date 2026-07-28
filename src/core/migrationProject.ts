import path from "node:path";
import { ensureDir, pathExists, readJsonFile, resolveMaybeRelative, writeJsonFile } from "./files.js";
import type { ReviewedOwnershipPolicy } from "./endpointReplacementModel.js";
import type { BehaviorClassificationRule } from "./behaviorGraph.js";
import type { BatchGateRequirements } from "./vmpBatch.js";
import type { PageGateRequirements } from "./pageRuntimeEvidence.js";
import type { QueryGateRequirements } from "./queryRuntimeEvidence.js";
import type { RuntimeCollectorKind } from "./runtimeCollectors.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { resolveJavaSemanticRulePackages } from "./javaSemanticPackages.js";

export const MIGRATION_PROFILE_FILE = "profile.json";
export const MIGRATION_SEMANTIC_RULES_FILE = "semantic-rules.json";
export const MIGRATION_COMPATIBILITY_DECISIONS_FILE = "compatibility-decisions.json";

export type MigrationContextKind = "tenant" | "user" | "request" | "datasource";
export type MigrationContextRequirement = "required" | "optional" | "none";

export interface MigrationProjectProfile {
  schemaVersion: 1;
  projectId: string;
  source: {
    root: string;
    access: "read-only";
    directories: string[];
    language: string;
    framework: string;
    adapter: string;
  };
  data: {
    dialect: string;
    adapters: string[];
  };
  entrypoints: Array<{
    id: string;
    kind: "http-route" | "service-method";
    method?: string;
    path?: string;
    symbol?: string;
  }>;
  contexts: Record<MigrationContextKind, MigrationContextRequirement> & {
    custom: string[];
  };
  infrastructure: {
    caches: string[];
    locks: string[];
    events: string[];
    externalServices: string[];
  };
  target: {
    language: string;
    root: string;
    serviceName: string;
  };
  compatibility: {
    strict: boolean;
    approvalRequired: boolean;
    approvedCorrectionIds: string[];
  };
}

export interface MigrationSemanticRules {
  schemaVersion: 1;
  packageIds?: string[];
  ownershipPolicy: ReviewedOwnershipPolicy;
  classifications: BehaviorClassificationRule[];
  runtimeGates?: Array<{
    id: string;
    entrypointId: string;
    scenarioPattern: string;
    collectors: RuntimeCollectorKind[];
    gates: {
      batch?: BatchGateRequirements;
      page?: PageGateRequirements;
      query?: QueryGateRequirements;
    };
    decisionIds?: string[];
  }>;
}

export interface MigrationCompatibilityDecisions {
  schemaVersion: 1;
  decisions: Array<{
    id: string;
    status: "approved" | "rejected" | "pending";
    scope: string;
    reason: string;
    approvedBy?: string;
    approvedAt?: string;
  }>;
}

export interface MigrationProjectPackage {
  caseDir: string;
  profilePath: string;
  semanticRulesPath: string;
  compatibilityDecisionsPath: string;
  fixturesDir: string;
  evidenceDir: string;
  profile: MigrationProjectProfile;
  semanticRules: MigrationSemanticRules;
  compatibilityDecisions: MigrationCompatibilityDecisions;
}

export interface MigrationProjectValidation {
  valid: boolean;
  findings: string[];
}

export interface InitMigrationProjectOptions {
  casesRoot: string;
  projectId: string;
  sourceRoot: string;
  targetRoot: string;
  endpoint?: string;
  method?: string;
  serviceName?: string;
  force?: boolean;
}

export async function initMigrationProject(options: InitMigrationProjectOptions): Promise<MigrationProjectPackage> {
  validateProjectId(options.projectId);
  const caseDir = path.resolve(options.casesRoot, options.projectId);
  const profilePath = path.join(caseDir, MIGRATION_PROFILE_FILE);
  if (await pathExists(profilePath) && !options.force) {
    throw new Error(`Migration project already exists: ${profilePath}. Use --force to replace its manifest files.`);
  }
  const profile = createMigrationProjectProfile(options);
  const semanticRules = createEmptySemanticRules();
  const compatibilityDecisions: MigrationCompatibilityDecisions = { schemaVersion: 1, decisions: [] };
  await ensureDir(path.join(caseDir, "fixtures"));
  await ensureDir(path.join(caseDir, "evidence"));
  await writeJsonFile(profilePath, profile);
  await writeJsonFile(path.join(caseDir, MIGRATION_SEMANTIC_RULES_FILE), semanticRules);
  await writeJsonFile(path.join(caseDir, MIGRATION_COMPATIBILITY_DECISIONS_FILE), compatibilityDecisions);
  return loadMigrationProject(caseDir);
}

export async function loadMigrationProject(caseDir: string): Promise<MigrationProjectPackage> {
  const resolvedCaseDir = path.resolve(caseDir);
  const profilePath = path.join(resolvedCaseDir, MIGRATION_PROFILE_FILE);
  const semanticRulesPath = path.join(resolvedCaseDir, MIGRATION_SEMANTIC_RULES_FILE);
  const compatibilityDecisionsPath = path.join(resolvedCaseDir, MIGRATION_COMPATIBILITY_DECISIONS_FILE);
  const required = [profilePath, semanticRulesPath, compatibilityDecisionsPath];
  const missing = [];
  for (const file of required) if (!await pathExists(file)) missing.push(path.basename(file));
  if (missing.length > 0) throw new Error(`Invalid migration project package; missing: ${missing.join(", ")}.`);
  const pkg: MigrationProjectPackage = {
    caseDir: resolvedCaseDir,
    profilePath,
    semanticRulesPath,
    compatibilityDecisionsPath,
    fixturesDir: path.join(resolvedCaseDir, "fixtures"),
    evidenceDir: path.join(resolvedCaseDir, "evidence"),
    profile: await readJsonFile<MigrationProjectProfile>(profilePath),
    semanticRules: await readJsonFile<MigrationSemanticRules>(semanticRulesPath),
    compatibilityDecisions: await readJsonFile<MigrationCompatibilityDecisions>(compatibilityDecisionsPath)
  };
  const validation = validateMigrationProject(pkg);
  if (!validation.valid) throw new Error(`Invalid migration project package: ${validation.findings.join(", ")}.`);
  return pkg;
}

export function validateMigrationProject(pkg: MigrationProjectPackage): MigrationProjectValidation {
  const findings: string[] = [];
  const { profile, semanticRules, compatibilityDecisions } = pkg;
  if (profile.schemaVersion !== 1) findings.push("MP-PROFILE-VERSION-UNSUPPORTED");
  try { validateProjectId(profile.projectId); } catch { findings.push("MP-PROJECT-ID-INVALID"); }
  if (!profile.source?.root) findings.push("MP-SOURCE-ROOT-MISSING");
  if (profile.source?.access !== "read-only") findings.push("MP-SOURCE-ACCESS-NOT-READ-ONLY");
  if (!profile.source?.language) findings.push("MP-SOURCE-LANGUAGE-MISSING");
  if (!profile.source?.framework) findings.push("MP-SOURCE-FRAMEWORK-MISSING");
  if (!profile.source?.adapter) findings.push("MP-SOURCE-ADAPTER-MISSING");
  if (!Array.isArray(profile.data?.adapters)) findings.push("MP-DATA-ADAPTERS-INVALID");
  if (!Array.isArray(profile.entrypoints) || profile.entrypoints.length === 0) findings.push("MP-ENTRYPOINT-MISSING");
  const entryIds = new Set<string>();
  for (const entrypoint of profile.entrypoints ?? []) {
    if (!entrypoint.id || entryIds.has(entrypoint.id)) findings.push(`MP-ENTRYPOINT-ID-INVALID:${entrypoint.id || "missing"}`);
    entryIds.add(entrypoint.id);
    if (entrypoint.kind === "http-route" && (!entrypoint.path || !entrypoint.method)) {
      findings.push(`MP-HTTP-ENTRYPOINT-INCOMPLETE:${entrypoint.id}`);
    }
    if (entrypoint.kind === "service-method" && !entrypoint.symbol) {
      findings.push(`MP-SERVICE-ENTRYPOINT-INCOMPLETE:${entrypoint.id}`);
    }
  }
  if (!profile.target?.language || !profile.target?.root || !profile.target?.serviceName) findings.push("MP-TARGET-INCOMPLETE");
  if (profile.source?.root && profile.target?.root) {
    const sourceRoot = resolveMaybeRelative(pkg.caseDir, profile.source.root);
    const targetRoot = resolveMaybeRelative(pkg.caseDir, profile.target.root);
    if (pathsOverlap(sourceRoot, targetRoot)) findings.push("MP-SOURCE-TARGET-OVERLAP");
    if (isSameOrNestedPath(sourceRoot, pkg.caseDir)) findings.push("MP-SOURCE-CASE-DIR-OVERLAP");
  }
  if (semanticRules.schemaVersion !== 1 || semanticRules.ownershipPolicy?.version !== 1) findings.push("MP-SEMANTIC-RULES-VERSION-UNSUPPORTED");
  if (!Array.isArray(semanticRules.classifications) || !Array.isArray(semanticRules.ownershipPolicy?.rules)) findings.push("MP-SEMANTIC-RULES-INVALID");
  if (semanticRules.packageIds !== undefined) {
    try {
      resolveJavaSemanticRulePackages({
        projectId: profile.projectId,
        language: profile.source?.language,
        framework: profile.source?.framework,
        explicitPackageIds: semanticRules.packageIds
      });
    } catch {
      findings.push("MP-SEMANTIC-PACKAGES-INVALID");
    }
  }
  const behaviors = new Set([
    "entrypoint", "validation", "context-resolution", "decision", "calculation", "state-read",
    "state-write", "external-call", "transaction", "event-publish", "compensation",
    "observability", "clock-read", "coordination", "async-boundary", "unknown"
  ]);
  for (const rule of semanticRules.classifications ?? []) {
    if (!rule.id || !rule.reason || !behaviors.has(rule.behavior)) findings.push(`MP-SEMANTIC-CLASSIFICATION-INVALID:${rule.id || "missing"}`);
    try { new RegExp(rule.symbolPattern); } catch { findings.push(`MP-SEMANTIC-PATTERN-INVALID:${rule.id || "missing"}`); }
  }
  const runtimeGateIds = new Set<string>();
  const collectors = new Set([
    "mysql", "redis", "events", "sql-trace", "ai-trace", "stream-trace", "tool-trace"
  ]);
  for (const rule of semanticRules.runtimeGates ?? []) {
    if (!rule.id || runtimeGateIds.has(rule.id)) findings.push(`MP-RUNTIME-GATE-ID-INVALID:${rule.id || "missing"}`);
    runtimeGateIds.add(rule.id);
    if (!entryIds.has(rule.entrypointId)) findings.push(`MP-RUNTIME-GATE-ENTRYPOINT-UNKNOWN:${rule.id || "missing"}`);
    try { new RegExp(rule.scenarioPattern); } catch { findings.push(`MP-RUNTIME-GATE-PATTERN-INVALID:${rule.id || "missing"}`); }
    if (!Array.isArray(rule.collectors) || rule.collectors.some((item) => !collectors.has(item))) {
      findings.push(`MP-RUNTIME-GATE-COLLECTORS-INVALID:${rule.id || "missing"}`);
    }
    if (!rule.gates || (!rule.gates.batch && !rule.gates.page && !rule.gates.query)) {
      findings.push(`MP-RUNTIME-GATE-SEMANTICS-MISSING:${rule.id || "missing"}`);
    }
    for (const decisionId of rule.decisionIds ?? []) {
      if (!compatibilityDecisions.decisions.some((item) => item.id === decisionId)) {
        findings.push(`MP-RUNTIME-GATE-DECISION-UNKNOWN:${rule.id || "missing"}:${decisionId}`);
      }
    }
  }
  if (compatibilityDecisions.schemaVersion !== 1 || !Array.isArray(compatibilityDecisions.decisions)) findings.push("MP-COMPATIBILITY-DECISIONS-INVALID");
  const approved = new Set(compatibilityDecisions.decisions.filter((item) => item.status === "approved").map((item) => item.id));
  for (const id of profile.compatibility?.approvedCorrectionIds ?? []) {
    if (!approved.has(id)) findings.push(`MP-APPROVED-CORRECTION-MISSING:${id}`);
  }
  return { valid: findings.length === 0, findings: [...new Set(findings)].sort() };
}

export function resolveMigrationProjectPath(pkg: MigrationProjectPackage, value: string): string {
  return resolveMaybeRelative(pkg.caseDir, value);
}

export function migrationProjectHash(pkg: MigrationProjectPackage): string {
  return sha256(stableStringify({
    profile: pkg.profile,
    semanticRules: pkg.semanticRules,
    compatibilityDecisions: pkg.compatibilityDecisions
  }));
}

function createMigrationProjectProfile(options: InitMigrationProjectOptions): MigrationProjectProfile {
  const endpoint = options.endpoint ?? "/replace-me";
  return {
    schemaVersion: 1,
    projectId: options.projectId,
    source: {
      root: path.resolve(options.sourceRoot),
      access: "read-only",
      directories: ["src/main/java", "src/main/resources"],
      language: "java",
      framework: "spring",
      adapter: "java-spring"
    },
    data: {
      dialect: "mysql",
      adapters: ["mybatis"]
    },
    entrypoints: [{
      id: routeId(options.method ?? "POST", endpoint),
      kind: "http-route",
      method: (options.method ?? "POST").toUpperCase(),
      path: endpoint
    }],
    contexts: {
      tenant: "required",
      user: "required",
      request: "required",
      datasource: "required",
      custom: []
    },
    infrastructure: {
      caches: [],
      locks: [],
      events: [],
      externalServices: []
    },
    target: {
      language: "rust",
      root: path.resolve(options.targetRoot),
      serviceName: options.serviceName ?? `${options.projectId}-migration`
    },
    compatibility: {
      strict: true,
      approvalRequired: true,
      approvedCorrectionIds: []
    }
  };
}

function createEmptySemanticRules(): MigrationSemanticRules {
  return {
    schemaVersion: 1,
    ownershipPolicy: {
      version: 1,
      rules: []
    },
    classifications: [],
    runtimeGates: []
  };
}

function validateProjectId(projectId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(projectId)) {
    throw new Error(`Invalid migration project id: ${projectId}.`);
  }
}

function routeId(method: string, endpoint: string): string {
  const suffix = endpoint.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
  return `${method.toLowerCase()}-${suffix}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrNestedPath(left, right) || isSameOrNestedPath(right, left);
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
