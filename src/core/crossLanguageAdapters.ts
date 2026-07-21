import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, toPosixPath } from "./files.js";
import type { MigrationAction, MigrationActionPlan } from "../types.js";

export type CrossLanguageId =
  | "typescript-node"
  | "python"
  | "java"
  | "go"
  | "rust"
  | "unknown";

export interface CrossLanguageRouteCandidate {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  confidence: "low" | "medium" | "high";
  handler?: string;
}

export interface CrossLanguageUnresolvedRoute {
  code: "unsupported-rust-route-syntax";
  file: string;
  line: number;
  framework: "Axum" | "Actix Web" | "Rocket" | "Rust HTTP";
  syntax: string;
  reason: string;
}

export interface CrossLanguageProjectInventory {
  root: string;
  detectedAt: string;
  primaryLanguage: CrossLanguageId;
  languageConfidence: "low" | "medium" | "high";
  languages: Array<{
    id: CrossLanguageId;
    sourceFiles: number;
    testFiles: number;
    frameworks: string[];
    buildFiles: string[];
    reasons: string[];
  }>;
  routes: CrossLanguageRouteCandidate[];
  unresolvedRoutes: CrossLanguageUnresolvedRoute[];
  recommendedChecks: string[];
}

export interface CrossLanguageRouteMatch {
  method: string;
  path: string;
  source?: CrossLanguageRouteCandidate;
  target?: CrossLanguageRouteCandidate;
  status: "matched" | "missing-target" | "target-extra";
}

export interface CrossLanguageHttpInventory {
  version: 1;
  createdAt: string;
  source: CrossLanguageProjectInventory;
  target: CrossLanguageProjectInventory;
  routeMatrix: CrossLanguageRouteMatch[];
  summary: {
    sourceRouteCount: number;
    targetRouteCount: number;
    matchedRouteCount: number;
    missingTargetRouteCount: number;
    targetExtraRouteCount: number;
  };
}

export interface CrossLanguageContractPlan {
  version: 1;
  createdAt: string;
  sourceBaseUrlPlaceholder: string;
  targetBaseUrlPlaceholder: string;
  recommendedCommands: string[];
  exchanges: Array<{
    name: string;
    method: string;
    path: string;
    status: "ready-for-dual-run" | "source-only" | "target-only";
  }>;
}

export interface CrossLanguageMigrationSlicePlan {
  version: 1;
  createdAt: string;
  slices: Array<{
    id: string;
    title: string;
    risk: "low" | "medium" | "high";
    sourceRoutes: Array<{ method: string; path: string; file: string }>;
    targetRoutes: Array<{ method: string; path: string; file: string }>;
    recommendedChecks: string[];
    acceptanceCriteria: string[];
  }>;
}

export type CrossLanguageCapabilityLevel = "CL1" | "CL2" | "CL3" | "CL4" | "CL5";
export type CrossLanguageLevelStatus = "ready" | "partial" | "blocked";

export interface CrossLanguageRecipePlan {
  version: 1;
  createdAt: string;
  sourceLanguage: CrossLanguageId;
  targetLanguage: CrossLanguageId;
  recipeId: string;
  supported: boolean;
  confidence: "low" | "medium" | "high";
  routeMappings: Array<{
    name: string;
    method: string;
    path: string;
    status: "can-replay" | "port-required" | "review-target-extra";
    risk: "low" | "medium" | "high";
    source?: { framework: string; file: string; line: number };
    target?: { framework: string; file: string; line: number };
    transformationHints: string[];
  }>;
  checklist: string[];
  codeGenerationPolicy: {
    mode: "proposal-only";
    requires: string[];
  };
}

export interface CrossLanguageContractCorpusDraft {
  version: 1;
  createdAt: string;
  sourceBaseUrlPlaceholder: string;
  targetBaseUrlPlaceholder: string;
  requests: Array<{
    name: string;
    method: string;
    path: string;
    urlTemplate: string;
    headers: Record<string, string>;
    bodyTemplate?: string;
    captureStatus: "ready" | "needs-route-port" | "target-only-review";
    sourceFile?: string;
    targetFile?: string;
  }>;
  coverage: {
    readyForDualRun: number;
    sourceOnly: number;
    targetOnly: number;
  };
}

export interface CrossLanguageIssuePlanItem {
  id: string;
  title: string;
  type: "task" | "risk";
  risk: "low" | "medium" | "high";
  owner: "engine" | "ai" | "human";
  actionId?: string;
  affectedFiles: string[];
  body: string;
}

export interface CrossLanguageReadinessReport {
  version: 1;
  createdAt: string;
  achievedLevel: CrossLanguageCapabilityLevel;
  levels: Array<{
    level: CrossLanguageCapabilityLevel;
    title: string;
    status: CrossLanguageLevelStatus;
    evidence: string[];
    blockers: string[];
  }>;
  gates: Array<{
    id: string;
    title: string;
    status: "ready" | "needs-runtime" | "needs-review";
    command?: string;
    reason: string;
  }>;
  issuePlan: CrossLanguageIssuePlanItem[];
  recommendedNextCommands: string[];
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  ext: string;
  content: string;
  isTest: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs"
]);

const SUPPORTED_RECIPE_PAIRS = new Set([
  "python-to-typescript-node",
  "typescript-node-to-python",
  "java-to-python",
  "java-to-typescript-node",
  "go-to-typescript-node",
  "typescript-node-to-go",
  "java-to-rust"
]);

export async function createCrossLanguageHttpInventory(sourceRoot: string, targetRoot: string): Promise<CrossLanguageHttpInventory> {
  const source = await createProjectInventory(sourceRoot);
  const target = await createProjectInventory(targetRoot);
  const routeMatrix = createRouteMatrix(source.routes, target.routes);
  const matchedRouteCount = routeMatrix.filter((route) => route.status === "matched").length;
  const missingTargetRouteCount = routeMatrix.filter((route) => route.status === "missing-target").length;
  const targetExtraRouteCount = routeMatrix.filter((route) => route.status === "target-extra").length;

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    source,
    target,
    routeMatrix,
    summary: {
      sourceRouteCount: source.routes.length,
      targetRouteCount: target.routes.length,
      matchedRouteCount,
      missingTargetRouteCount,
      targetExtraRouteCount
    }
  };
}

export async function createProjectInventory(root: string): Promise<CrossLanguageProjectInventory> {
  const files = await collectSourceFiles(root);
  const manifests = await collectBuildFiles(root);
  const languageSummaries = (await Promise.all([
    detectTypescriptNode(root, files, manifests),
    detectPython(root, files, manifests),
    detectJava(files, manifests),
    detectGo(files, manifests),
    detectRust(root, files, manifests)
  ])).filter((language) => language.sourceFiles > 0 || language.buildFiles.length > 0);
  const routes = files.flatMap((file) => extractRoutesFromFile(file));
  const unresolvedRoutes = files.flatMap((file) => extractUnresolvedRoutesFromFile(file));
  const primary = selectPrimaryLanguage(languageSummaries);

  return {
    root,
    detectedAt: new Date().toISOString(),
    primaryLanguage: primary?.id ?? "unknown",
    languageConfidence: confidenceForLanguage(primary),
    languages: languageSummaries,
    routes: routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    unresolvedRoutes: unresolvedRoutes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    recommendedChecks: await recommendedChecksForProject(root, primary?.id ?? "unknown", manifests, languageSummaries)
  };
}

export function createRouteMatrix(
  sourceRoutes: CrossLanguageRouteCandidate[],
  targetRoutes: CrossLanguageRouteCandidate[]
): CrossLanguageRouteMatch[] {
  const sourceByKey = new Map(sourceRoutes.map((route) => [routeKey(route), route]));
  const targetByKey = new Map(targetRoutes.map((route) => [routeKey(route), route]));
  const keys = [...new Set([...sourceByKey.keys(), ...targetByKey.keys()])].sort();

  return keys.map((key) => {
    const source = sourceByKey.get(key);
    const target = targetByKey.get(key);
    const [method, routePath] = key.split(" ", 2);
    return {
      method,
      path: routePath,
      source,
      target,
      status: source && target ? "matched" : source ? "missing-target" : "target-extra"
    };
  });
}

export function createContractPlan(inventory: CrossLanguageHttpInventory): CrossLanguageContractPlan {
  const exchanges = inventory.routeMatrix.map((route) => ({
    name: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    status: route.status === "matched"
      ? "ready-for-dual-run" as const
      : route.status === "missing-target"
        ? "source-only" as const
        : "target-only" as const
  }));

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceBaseUrlPlaceholder: "http://127.0.0.1:<source-port>",
    targetBaseUrlPlaceholder: "http://127.0.0.1:<target-port>",
    recommendedCommands: [
      "migration-guard contract capture --source <source-base-url>",
      "migration-guard dual-run --source <source-base-url> --target <target-base-url>",
      "migration-guard contract test --target <target-base-url> --contract <contract-corpus>"
    ],
    exchanges
  };
}

export function createMigrationSlicePlan(inventory: CrossLanguageHttpInventory): CrossLanguageMigrationSlicePlan {
  const checks = [
    ...inventory.source.recommendedChecks.map((command) => `source: ${command}`),
    ...inventory.target.recommendedChecks.map((command) => `target: ${command}`),
    "migration-guard dual-run --source <source-base-url> --target <target-base-url>"
  ];
  const sourceOnly = inventory.routeMatrix.filter((route) => route.status === "missing-target");
  const matched = inventory.routeMatrix.filter((route) => route.status === "matched");
  const targetOnly = inventory.routeMatrix.filter((route) => route.status === "target-extra");
  const slices: CrossLanguageMigrationSlicePlan["slices"] = [];

  if (sourceOnly.length > 0) {
    slices.push({
      id: "cl-slice-port-missing-routes",
      title: "Port source HTTP routes that are missing in the target",
      risk: sourceOnly.length >= 8 ? "high" : "medium",
      sourceRoutes: sourceOnly.flatMap((route) => route.source ? [routeRef(route.source)] : []),
      targetRoutes: [],
      recommendedChecks: checks,
      acceptanceCriteria: [
        "each source route has a target route candidate",
        "dual-run reports no error-level route drift",
        "target project checks pass"
      ]
    });
  }

  if (matched.length > 0) {
    slices.push({
      id: "cl-slice-replay-matched-routes",
      title: "Replay behavior contracts for matched routes",
      risk: "medium",
      sourceRoutes: matched.flatMap((route) => route.source ? [routeRef(route.source)] : []),
      targetRoutes: matched.flatMap((route) => route.target ? [routeRef(route.target)] : []),
      recommendedChecks: checks,
      acceptanceCriteria: [
        "contract corpus covers matched routes",
        "dual-run body/status/header differences are classified",
        "intentional differences are recorded before continuing"
      ]
    });
  }

  if (targetOnly.length > 0) {
    slices.push({
      id: "cl-slice-review-target-extra-routes",
      title: "Review target-only HTTP routes",
      risk: "low",
      sourceRoutes: [],
      targetRoutes: targetOnly.flatMap((route) => route.target ? [routeRef(route.target)] : []),
      recommendedChecks: checks,
      acceptanceCriteria: [
        "target-only routes are marked intentional or removed",
        "contract plan documents ownership for target-only behavior"
      ]
    });
  }

  if (slices.length === 0) {
    slices.push({
      id: "cl-slice-bootstrap-contracts",
      title: "Bootstrap cross-language contract replay",
      risk: "medium",
      sourceRoutes: [],
      targetRoutes: [],
      recommendedChecks: checks,
      acceptanceCriteria: [
        "source and target startup commands are documented",
        "at least one HTTP contract exchange is captured",
        "dual-run can compare source and target services"
      ]
    });
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    slices
  };
}

export function createRecipePlan(inventory: CrossLanguageHttpInventory): CrossLanguageRecipePlan {
  const recipeId = `${inventory.source.primaryLanguage}-to-${inventory.target.primaryLanguage}`;
  const supported = isSupportedRecipePair(inventory.source.primaryLanguage, inventory.target.primaryLanguage);
  const confidence = supported && inventory.source.languageConfidence === "high" && inventory.target.languageConfidence === "high"
    ? "high"
    : supported
      ? "medium"
      : "low";

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceLanguage: inventory.source.primaryLanguage,
    targetLanguage: inventory.target.primaryLanguage,
    recipeId,
    supported,
    confidence,
    routeMappings: inventory.routeMatrix.map((route) => ({
      name: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      status: route.status === "matched"
        ? "can-replay"
        : route.status === "missing-target"
          ? "port-required"
          : "review-target-extra",
      risk: riskForRouteMapping(route),
      source: route.source ? routeLocation(route.source) : undefined,
      target: route.target ? routeLocation(route.target) : undefined,
      transformationHints: transformationHintsForRoute(inventory, route)
    })),
    checklist: [
      "capture source HTTP responses before translating handler logic",
      "map request path params, query params, headers, and JSON body explicitly",
      "preserve status codes and intentional error shapes before body refactors",
      "port validation and serialization separately from route wiring",
      "run target checks before dual-run replay and classify every behavior difference"
    ],
    codeGenerationPolicy: {
      mode: "proposal-only",
      requires: [
        "route inventory artifact",
        "language-pair recipe plan",
        "contract corpus draft",
        "target checks in proposal gate",
        "dual-run replay after source and target services are available"
      ]
    }
  };
}

export function createContractCorpusDraft(inventory: CrossLanguageHttpInventory): CrossLanguageContractCorpusDraft {
  const requests = inventory.routeMatrix.map((route) => {
    const bodyTemplate = bodyTemplateForMethod(route.method);
    const headers: Record<string, string> = bodyTemplate
      ? { accept: "application/json", "content-type": "application/json" }
      : { accept: "application/json" };
    return {
      name: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      urlTemplate: `http://127.0.0.1:<source-port>${route.path}`,
      headers,
      bodyTemplate,
      captureStatus: route.status === "matched"
        ? "ready" as const
        : route.status === "missing-target"
          ? "needs-route-port" as const
          : "target-only-review" as const,
      sourceFile: route.source ? `${route.source.file}:${route.source.line}` : undefined,
      targetFile: route.target ? `${route.target.file}:${route.target.line}` : undefined
    };
  });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceBaseUrlPlaceholder: "http://127.0.0.1:<source-port>",
    targetBaseUrlPlaceholder: "http://127.0.0.1:<target-port>",
    requests,
    coverage: {
      readyForDualRun: requests.filter((request) => request.captureStatus === "ready").length,
      sourceOnly: requests.filter((request) => request.captureStatus === "needs-route-port").length,
      targetOnly: requests.filter((request) => request.captureStatus === "target-only-review").length
    }
  };
}

export function createCrossLanguageActionPlan(
  runId: string,
  goal: string,
  inventory: CrossLanguageHttpInventory,
  recipePlan = createRecipePlan(inventory),
  corpusDraft = createContractCorpusDraft(inventory)
): MigrationActionPlan {
  const targetChecks = inventory.target.recommendedChecks;
  const targetAnchors = targetProjectAnchors(inventory);
  const missingTargetRoutes = inventory.routeMatrix.filter((route) => route.status === "missing-target");
  const matchedRoutes = inventory.routeMatrix.filter((route) => route.status === "matched");
  const targetExtraRoutes = inventory.routeMatrix.filter((route) => route.status === "target-extra");
  const actions: MigrationAction[] = [
    crossLanguageAction({
      id: "action-cl2-language-pair-recipe",
      title: `Review ${recipePlan.recipeId} route translation recipe`,
      summary: `Review the detected ${recipePlan.sourceLanguage} to ${recipePlan.targetLanguage} recipe before any generated source edit.`,
      risk: recipePlan.supported ? "low" : "medium",
      affectedFiles: targetAnchors,
      recommendedChecks: targetChecks,
      patchMode: "dry-run-only"
    }),
    crossLanguageAction({
      id: "action-cl3-contract-corpus",
      title: "Prepare cross-language HTTP contract corpus",
      summary: `Prepare capture and replay coverage for ${corpusDraft.requests.length} HTTP exchange draft(s).`,
      risk: corpusDraft.coverage.sourceOnly > 0 ? "medium" : "low",
      affectedFiles: targetAnchors,
      recommendedChecks: targetChecks,
      patchMode: "dry-run-only"
    })
  ];

  if (missingTargetRoutes.length > 0) {
    actions.push(crossLanguageAction({
      id: "action-cl4-port-missing-http-routes",
      title: "Port source-only HTTP routes into target service",
      summary: `Create target route candidates for ${missingTargetRoutes.length} source route(s) before dual-run parity can pass.`,
      risk: missingTargetRoutes.length >= 5 ? "high" : "medium",
      affectedFiles: targetAnchors,
      recommendedChecks: targetChecks,
      patchMode: "manual-approval-required"
    }));
  }

  if (matchedRoutes.length > 0) {
    actions.push(crossLanguageAction({
      id: "action-cl4-replay-matched-http-routes",
      title: "Replay matched HTTP route behavior",
      summary: `Run contract replay for ${matchedRoutes.length} matched route(s) and classify drift before broader migration.`,
      risk: "medium",
      affectedFiles: routeFiles(matchedRoutes, "target").length > 0 ? routeFiles(matchedRoutes, "target") : targetAnchors,
      recommendedChecks: targetChecks,
      patchMode: "dry-run-only"
    }));
  }

  if (targetExtraRoutes.length > 0) {
    actions.push(crossLanguageAction({
      id: "action-cl4-review-target-extra-routes",
      title: "Review target-only HTTP routes",
      summary: `Decide whether ${targetExtraRoutes.length} target-only route(s) are intentional additions or migration drift.`,
      risk: "low",
      affectedFiles: routeFiles(targetExtraRoutes, "target").length > 0 ? routeFiles(targetExtraRoutes, "target") : targetAnchors,
      recommendedChecks: targetChecks,
      patchMode: "dry-run-only"
    }));
  }

  actions.push(crossLanguageAction({
    id: "action-cl5-verification-issue-loop",
    title: "Run CL5 verification and issue loop",
    summary: "Gate cross-language code migration on target checks, dual-run replay, issue sync, and follow-up issue creation for unresolved drift.",
    risk: "medium",
    affectedFiles: targetAnchors,
    recommendedChecks: targetChecks,
    patchMode: "dry-run-only"
  }));

  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    goal,
    actions
  };
}

export function createReadinessReport(
  inventory: CrossLanguageHttpInventory,
  recipePlan: CrossLanguageRecipePlan,
  corpusDraft: CrossLanguageContractCorpusDraft,
  actionPlan: MigrationActionPlan
): CrossLanguageReadinessReport {
  const issuePlan = createIssuePlan(inventory, recipePlan, actionPlan);
  const cl1Ready = inventory.source.primaryLanguage !== "unknown" && inventory.target.primaryLanguage !== "unknown";
  const cl2Ready = cl1Ready && recipePlan.supported;
  const cl3Ready = cl2Ready && corpusDraft.requests.length > 0;
  const cl4Ready = cl3Ready && actionPlan.actions.length > 0;
  const cl5Ready = cl4Ready && issuePlan.length > 0;
  const levels: CrossLanguageReadinessReport["levels"] = [
    {
      level: "CL1",
      title: "Inventory source and target languages/routes",
      status: cl1Ready ? "ready" : "partial",
      evidence: ["adapter/cross-language-http-inventory.json"],
      blockers: cl1Ready
        ? []
        : inventory.source.primaryLanguage === "unknown" || inventory.target.primaryLanguage === "unknown"
        ? ["source or target language could not be detected confidently"]
        : []
    },
    {
      level: "CL2",
      title: "Create language-pair migration recipe",
      status: cl2Ready ? "ready" : "partial",
      evidence: ["adapter/cross-language-http-recipe-plan.json"],
      blockers: [
        ...(!cl1Ready ? ["CL1 language inventory is not ready"] : []),
        ...(!recipePlan.supported ? [`language pair ${recipePlan.recipeId} is not in the supported recipe set; recipe remains review-only`] : [])
      ]
    },
    {
      level: "CL3",
      title: "Prepare HTTP contract corpus draft",
      status: corpusDraft.requests.length === 0 ? "blocked" : cl3Ready ? "ready" : "partial",
      evidence: ["adapter/cross-language-http-contract-corpus-draft.json"],
      blockers: [
        ...(!cl2Ready ? ["CL2 language-pair recipe is not ready"] : []),
        ...(corpusDraft.requests.length > 0 ? [] : ["no HTTP route candidates were detected"])
      ]
    },
    {
      level: "CL4",
      title: "Generate guarded migration actions",
      status: actionPlan.actions.length === 0 ? "blocked" : cl4Ready ? "ready" : "partial",
      evidence: ["adapter/cross-language-http-action-plan.json"],
      blockers: [
        ...(!cl3Ready ? ["CL3 contract corpus draft is not ready"] : []),
        ...(actionPlan.actions.length > 0 ? [] : ["no action plan entries were generated"])
      ]
    },
    {
      level: "CL5",
      title: "Close the verification and issue loop",
      status: cl5Ready ? "ready" : issuePlan.length > 0 ? "partial" : "blocked",
      evidence: ["adapter/cross-language-http-readiness-report.json", "issues.json"],
      blockers: [
        ...(!cl4Ready ? ["CL4 migration action plan is not ready"] : []),
        ...(issuePlan.length > 0 ? [] : ["no issue candidates were generated"])
      ]
    }
  ];
  const achieved = highestContiguousReadyLevel(levels);
  const firstAction = actionPlan.actions[0]?.id ?? "<action-id>";

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    achievedLevel: achieved,
    levels,
    gates: [
      {
        id: "target-checks",
        title: "Target project checks",
        status: inventory.target.recommendedChecks.length > 0 ? "ready" : "needs-review",
        command: inventory.target.recommendedChecks.join(" && ") || undefined,
        reason: inventory.target.recommendedChecks.length > 0
          ? "target inventory found runnable project checks"
          : "target inventory did not find known test/build/type-check commands"
      },
      {
        id: "dual-run",
        title: "HTTP behavior replay",
        status: "needs-runtime",
        command: "migration-guard dual-run --source <source-base-url> --target <target-base-url>",
        reason: "requires source and target services to be running on known base URLs"
      },
      {
        id: "issue-sync",
        title: "Follow-up issue sync",
        status: "ready",
        command: "migration-guard sync-issues --run latest --provider github --dry-run",
        reason: "local issue candidates are generated before live provider mutation"
      }
    ],
    issuePlan,
    recommendedNextCommands: [
      "migration-guard actions --run latest",
      `migration-guard action propose --run latest --action ${firstAction}`,
      "migration-guard sync-issues --run latest --provider github --dry-run"
    ]
  };
}

export function renderCrossLanguageInventory(inventory: CrossLanguageHttpInventory): string {
  return [
    "# Cross-Language HTTP Inventory",
    "",
    `- Source: ${inventory.source.primaryLanguage} (${inventory.source.languageConfidence}) routes:${inventory.source.routes.length}`,
    `- Target: ${inventory.target.primaryLanguage} (${inventory.target.languageConfidence}) routes:${inventory.target.routes.length}`,
    `- Matched routes: ${inventory.summary.matchedRouteCount}`,
    `- Missing target routes: ${inventory.summary.missingTargetRouteCount}`,
    `- Target extra routes: ${inventory.summary.targetExtraRouteCount}`,
    "",
    "## Source Languages",
    "",
    ...renderLanguageLines(inventory.source),
    "",
    "## Target Languages",
    "",
    ...renderLanguageLines(inventory.target),
    "",
    "## Route Matrix",
    "",
    inventory.routeMatrix.length > 0
      ? inventory.routeMatrix.map((route) => `- [${route.status}] ${route.method} ${route.path}`).join("\n")
      : "No HTTP route candidates detected.",
    "",
    "## Unresolved Routes",
    "",
    renderUnresolvedRoutes(inventory)
  ].join("\n");
}

function renderUnresolvedRoutes(inventory: CrossLanguageHttpInventory): string {
  const findings = [
    ...inventory.source.unresolvedRoutes.map((route) => ({ side: "source", route })),
    ...inventory.target.unresolvedRoutes.map((route) => ({ side: "target", route }))
  ];
  return findings.length > 0
    ? findings.map(({ side, route }) => `- [${route.code}] ${side} ${route.file}:${route.line} (${route.framework}): ${route.syntax}`).join("\n")
    : "No unresolved route syntax detected.";
}

export function renderContractPlan(plan: CrossLanguageContractPlan): string {
  return [
    "# Cross-Language Contract Plan",
    "",
    "## Commands",
    "",
    ...plan.recommendedCommands.map((command) => `- ${command}`),
    "",
    "## Exchanges",
    "",
    plan.exchanges.length > 0
      ? plan.exchanges.map((exchange) => `- [${exchange.status}] ${exchange.method} ${exchange.path}`).join("\n")
      : "No exchanges yet."
  ].join("\n");
}

export function renderMigrationSlicePlan(plan: CrossLanguageMigrationSlicePlan): string {
  return [
    "# Cross-Language Migration Slice Plan",
    "",
    ...plan.slices.map((slice) => [
      `## ${slice.id}`,
      "",
      `- Title: ${slice.title}`,
      `- Risk: ${slice.risk}`,
      `- Source routes: ${slice.sourceRoutes.length}`,
      `- Target routes: ${slice.targetRoutes.length}`,
      "- Recommended checks:",
      ...slice.recommendedChecks.map((command) => `  - ${command}`),
      "- Acceptance:",
      ...slice.acceptanceCriteria.map((criterion) => `  - ${criterion}`)
    ].join("\n"))
  ].join("\n\n");
}

export function renderRecipePlan(plan: CrossLanguageRecipePlan): string {
  return [
    "# Cross-Language Recipe Plan",
    "",
    `- Recipe: ${plan.recipeId}`,
    `- Supported: ${plan.supported ? "yes" : "review-only"}`,
    `- Confidence: ${plan.confidence}`,
    `- Route mappings: ${plan.routeMappings.length}`,
    "",
    "## Checklist",
    "",
    ...plan.checklist.map((item) => `- ${item}`),
    "",
    "## Route Mappings",
    "",
    plan.routeMappings.length > 0
      ? plan.routeMappings.map((mapping) => [
        `- [${mapping.status}/${mapping.risk}] ${mapping.method} ${mapping.path}`,
        ...mapping.transformationHints.map((hint) => `  - ${hint}`)
      ].join("\n")).join("\n")
      : "No route mappings detected.",
    "",
    "## Code Generation Policy",
    "",
    `- Mode: ${plan.codeGenerationPolicy.mode}`,
    ...plan.codeGenerationPolicy.requires.map((item) => `- Requires: ${item}`)
  ].join("\n");
}

export function renderContractCorpusDraft(draft: CrossLanguageContractCorpusDraft): string {
  return [
    "# Cross-Language Contract Corpus Draft",
    "",
    `- Source base URL: ${draft.sourceBaseUrlPlaceholder}`,
    `- Target base URL: ${draft.targetBaseUrlPlaceholder}`,
    `- Ready for dual-run: ${draft.coverage.readyForDualRun}`,
    `- Source-only: ${draft.coverage.sourceOnly}`,
    `- Target-only: ${draft.coverage.targetOnly}`,
    "",
    "## Requests",
    "",
    draft.requests.length > 0
      ? draft.requests.map((request) => `- [${request.captureStatus}] ${request.method} ${request.path} -> ${request.urlTemplate}`).join("\n")
      : "No request drafts generated."
  ].join("\n");
}

export function renderCrossLanguageActionPlan(plan: MigrationActionPlan): string {
  return [
    "# Cross-Language Action Plan",
    "",
    `- Run: ${plan.runId}`,
    `- Goal: ${plan.goal}`,
    `- Actions: ${plan.actions.length}`,
    "",
    ...plan.actions.map((action) => [
      `## ${action.id}`,
      "",
      `- Title: ${action.title}`,
      `- Risk: ${action.risk}`,
      `- Patch mode: ${action.patchMode}`,
      `- Template: ${action.patchTemplate ?? "auto"}`,
      `- Affected files: ${action.affectedFiles.join(", ") || "none"}`,
      "- Recommended checks:",
      ...(action.recommendedChecks.length > 0 ? action.recommendedChecks.map((command) => `  - ${command}`) : ["  - none"])
    ].join("\n"))
  ].join("\n\n");
}

export function renderReadinessReport(report: CrossLanguageReadinessReport): string {
  return [
    "# Cross-Language CL5 Readiness",
    "",
    `- Achieved level: ${report.achievedLevel}`,
    "",
    "## Levels",
    "",
    ...report.levels.map((level) => [
      `- ${level.level} [${level.status}] ${level.title}`,
      ...level.evidence.map((item) => `  evidence: ${item}`),
      ...level.blockers.map((item) => `  blocker: ${item}`)
    ].join("\n")),
    "",
    "## Gates",
    "",
    ...report.gates.map((gate) => [
      `- [${gate.status}] ${gate.id}: ${gate.title}`,
      gate.command ? `  command: ${gate.command}` : undefined,
      `  reason: ${gate.reason}`
    ].filter(Boolean).join("\n")),
    "",
    "## Issue Plan",
    "",
    report.issuePlan.length > 0
      ? report.issuePlan.map((issue) => `- [${issue.risk}/${issue.owner}] ${issue.title}`).join("\n")
      : "No issue candidates generated.",
    "",
    "## Next Commands",
    "",
    ...report.recommendedNextCommands.map((command) => `- ${command}`)
  ].join("\n");
}

function renderLanguageLines(inventory: CrossLanguageProjectInventory): string[] {
  if (inventory.languages.length === 0) {
    return ["- none detected"];
  }

  return inventory.languages.map((language) => [
    `- ${language.id}: source:${language.sourceFiles} test:${language.testFiles}`,
    language.frameworks.length > 0 ? `  frameworks: ${language.frameworks.join(", ")}` : undefined,
    language.buildFiles.length > 0 ? `  build-files: ${language.buildFiles.join(", ")}` : undefined,
    language.reasons.length > 0 ? `  reasons: ${language.reasons.join("; ")}` : undefined
  ].filter(Boolean).join("\n"));
}

function isSupportedRecipePair(source: CrossLanguageId, target: CrossLanguageId): boolean {
  return SUPPORTED_RECIPE_PAIRS.has(`${source}-to-${target}`);
}

function highestContiguousReadyLevel(levels: CrossLanguageReadinessReport["levels"]): CrossLanguageCapabilityLevel {
  let achieved: CrossLanguageCapabilityLevel = "CL1";
  for (const level of levels) {
    if (level.status !== "ready") {
      break;
    }
    achieved = level.level;
  }
  return achieved;
}

function riskForRouteMapping(route: CrossLanguageRouteMatch): "low" | "medium" | "high" {
  if (route.status === "target-extra") {
    return "low";
  }
  if (route.status === "missing-target") {
    return isMutatingMethod(route.method) ? "high" : "medium";
  }
  return isMutatingMethod(route.method) ? "medium" : "low";
}

function isMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function routeLocation(route: CrossLanguageRouteCandidate): { framework: string; file: string; line: number } {
  return {
    framework: route.framework,
    file: route.file,
    line: route.line
  };
}

function transformationHintsForRoute(inventory: CrossLanguageHttpInventory, route: CrossLanguageRouteMatch): string[] {
  const hints = [
    `${inventory.source.primaryLanguage} -> ${inventory.target.primaryLanguage}: keep HTTP method and normalized path stable`,
    "map path params, query params, headers, and JSON body before changing handler internals",
    "record expected status code and response shape in the contract corpus draft"
  ];
  if (route.status === "matched") {
    hints.push("matched route can enter dual-run replay once both services are running");
  } else if (route.status === "missing-target") {
    hints.push("target route must be added behind normal target project checks before behavior replay");
  } else {
    hints.push("target-only route needs owner review before it is treated as intentional new behavior");
  }
  hints.push(languagePairHint(inventory.source.primaryLanguage, inventory.target.primaryLanguage));
  return [...new Set(hints)];
}

function languagePairHint(source: CrossLanguageId, target: CrossLanguageId): string {
  if (source === "python" && target === "typescript-node") {
    return "translate FastAPI/Flask handlers into Node route handlers with explicit request body validation";
  }
  if (source === "typescript-node" && target === "python") {
    return "translate middleware assumptions into FastAPI/Flask dependencies before handler logic";
  }
  if (source === "java" && target === "python") {
    return "map Spring annotations, DTOs, and exception handlers into Python router, schema, and error layers";
  }
  if (source === "java" && target === "typescript-node") {
    return "map Spring controller methods and DTOs into Node route modules plus typed schemas";
  }
  if (source === "java" && target === "rust") {
    return "map Spring routes and DTO validation into Rust extractors, preserve error envelopes in response types, propagate request context through middleware, keep async work non-blocking, and isolate databases or brokers behind infrastructure ports";
  }
  if (source === "go" && target === "typescript-node") {
    return "map Go handler structs and net/http response writes into Node request/response helpers";
  }
  if (source === "typescript-node" && target === "go") {
    return "map Node middleware and async handlers into Go routing, request decoding, and response writing";
  }
  return "treat framework lifecycle, dependency injection, validation, and error handling as separate migration slices";
}

function bodyTemplateForMethod(method: string): string | undefined {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    return undefined;
  }
  return "{}";
}

function targetProjectAnchors(inventory: CrossLanguageHttpInventory): string[] {
  const anchors = uniqueStrings([
    ...inventory.target.routes.map((route) => route.file),
    ...inventory.target.languages.flatMap((language) => language.buildFiles)
  ]);
  return anchors.length > 0 ? anchors.slice(0, 12) : ["."];
}

function routeFiles(routes: CrossLanguageRouteMatch[], side: "source" | "target"): string[] {
  return uniqueStrings(routes.flatMap((route) => {
    const candidate = side === "source" ? route.source : route.target;
    return candidate ? [candidate.file] : [];
  }));
}

function crossLanguageAction(input: {
  id: string;
  title: string;
  summary: string;
  risk: MigrationAction["risk"];
  affectedFiles: string[];
  recommendedChecks: string[];
  patchMode: MigrationAction["patchMode"];
}): MigrationAction {
  const recommendedChecks = uniqueStrings(input.recommendedChecks.filter(isRunnableTargetCheck));
  return {
    id: input.id,
    title: input.title,
    summary: input.summary,
    risk: input.risk,
    affectedFiles: uniqueStrings(input.affectedFiles).slice(0, 20),
    recommendedChecks,
    checkReadiness: recommendedChecks.map((command) => ({
      command,
      status: "ready",
      reason: "detected from target project inventory"
    })),
    patchMode: input.patchMode,
    patchTemplate: "cross-language-contract-probe"
  };
}

function isRunnableTargetCheck(command: string): boolean {
  return !/[<>]/.test(command) && !command.startsWith("source:") && !command.startsWith("target:");
}

function createIssuePlan(
  inventory: CrossLanguageHttpInventory,
  recipePlan: CrossLanguageRecipePlan,
  actionPlan: MigrationActionPlan
): CrossLanguageIssuePlanItem[] {
  const actionIssues = actionPlan.actions.map((action): CrossLanguageIssuePlanItem => ({
    id: `cl-issue-${action.id}`,
    title: action.title,
    type: "task",
    risk: action.risk,
    owner: action.patchMode === "manual-approval-required" ? "human" : "ai",
    actionId: action.id,
    affectedFiles: action.affectedFiles,
    body: [
      action.summary,
      "",
      `Recommended checks: ${action.recommendedChecks.join(", ") || "none"}`,
      `Patch mode: ${action.patchMode}`,
      "Generated from cross-language CL5 readiness planning."
    ].join("\n")
  }));
  const riskIssues: CrossLanguageIssuePlanItem[] = [];

  if (!recipePlan.supported) {
    riskIssues.push({
      id: "cl-issue-review-language-pair",
      title: `Review unsupported or uncertain language pair: ${recipePlan.recipeId}`,
      type: "risk",
      risk: "medium",
      owner: "human",
      affectedFiles: targetProjectAnchors(inventory),
      body: "The adapter could not confirm a true supported cross-language pair. Review inventory and recipe hints before source edits."
    });
  }

  if (inventory.summary.missingTargetRouteCount > 0) {
    riskIssues.push({
      id: "cl-issue-missing-target-routes",
      title: `Port ${inventory.summary.missingTargetRouteCount} source-only HTTP route(s)`,
      type: "risk",
      risk: inventory.summary.missingTargetRouteCount >= 5 ? "high" : "medium",
      owner: "ai",
      actionId: "action-cl4-port-missing-http-routes",
      affectedFiles: targetProjectAnchors(inventory),
      body: "Source-only routes block full dual-run parity. Add target route candidates behind contract replay and target checks."
    });
  }

  return [...actionIssues, ...riskIssues];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

async function collectSourceFiles(root: string): Promise<SourceFile[]> {
  const absolutePaths = await walkFiles(root);
  const files: SourceFile[] = [];

  for (const absolutePath of absolutePaths) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    const content = stat.size <= 1024 * 1024 ? await fs.readFile(absolutePath, "utf8") : "";
    const relativePath = toPosixPath(path.relative(root, absolutePath));
    files.push({
      absolutePath,
      relativePath,
      ext,
      content,
      isTest: isTestFile(relativePath)
    });
  }

  return files;
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if ([".git", ".migration-guard", "node_modules", "dist", "build", "target", "__pycache__"].includes(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        result.push(absolutePath);
      }
    }
  }

  await visit(root);
  return result;
}

async function collectBuildFiles(root: string): Promise<string[]> {
  const candidates = [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "poetry.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "Cargo.toml"
  ];
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) {
      present.push(candidate);
    }
  }
  const cargoManifests = (await walkFiles(root))
    .filter((file) => path.basename(file) === "Cargo.toml")
    .map((file) => toPosixPath(path.relative(root, file)));
  present.push(...cargoManifests);
  return [...new Set(present)].sort();
}

async function detectTypescriptNode(root: string, files: SourceFile[], buildFiles: string[]) {
  const jsFiles = files.filter((file) => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(file.ext));
  const packageJsonPath = path.join(root, "package.json");
  const packageHints = await readPackageJsonHints(packageJsonPath);
  return languageSummary({
    id: "typescript-node",
    files: jsFiles,
    buildFiles: buildFiles.filter((file) => ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"].includes(file)),
    frameworks: packageHints.frameworks,
    reasons: packageHints.reasons
  });
}

async function detectPython(root: string, files: SourceFile[], buildFiles: string[]) {
  const pyFiles = files.filter((file) => file.ext === ".py");
  const manifestContent = await readKnownManifest(root, ["pyproject.toml", "requirements.txt", "Pipfile"]);
  const frameworks = frameworkHints(`${manifestContent}\n${pyFiles.map((file) => file.content).join("\n")}`, [
    ["fastapi", "FastAPI"],
    ["flask", "Flask"],
    ["django", "Django"]
  ]);
  return languageSummary({
    id: "python",
    files: pyFiles,
    buildFiles: buildFiles.filter((file) => ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock"].includes(file)),
    frameworks,
    reasons: frameworks.map((name) => `${name} signal`)
  });
}

function detectJava(files: SourceFile[], buildFiles: string[]) {
  const javaFiles = files.filter((file) => file.ext === ".java");
  const content = javaFiles.map((file) => file.content).join("\n");
  const frameworks = frameworkHints(content, [
    ["org.springframework", "Spring"],
    ["@RestController", "Spring"],
    ["@Controller", "Spring"]
  ]);
  return languageSummary({
    id: "java",
    files: javaFiles,
    buildFiles: buildFiles.filter((file) => ["pom.xml", "build.gradle", "build.gradle.kts"].includes(file)),
    frameworks,
    reasons: frameworks.map((name) => `${name} signal`)
  });
}

function detectGo(files: SourceFile[], buildFiles: string[]) {
  const goFiles = files.filter((file) => file.ext === ".go");
  const content = goFiles.map((file) => file.content).join("\n");
  const frameworks = frameworkHints(content, [
    ["github.com/gin-gonic/gin", "Gin"],
    ["github.com/go-chi/chi", "Chi"],
    ["github.com/gofiber/fiber", "Fiber"],
    ["net/http", "net/http"]
  ]);
  return languageSummary({
    id: "go",
    files: goFiles,
    buildFiles: buildFiles.filter((file) => file === "go.mod"),
    frameworks,
    reasons: frameworks.map((name) => `${name} signal`)
  });
}

async function detectRust(root: string, files: SourceFile[], buildFiles: string[]) {
  const rustFiles = files.filter((file) => file.ext === ".rs");
  const cargoFiles = buildFiles.filter((file) => path.basename(file) === "Cargo.toml");
  const manifestEntries = await Promise.all(cargoFiles.map(async (file) => ({
    file,
    content: await fs.readFile(path.join(root, file), "utf8").catch(() => "")
  })));
  const manifests = manifestEntries.map((entry) => entry.content).join("\n");
  const content = `${manifests}\n${rustFiles.map((file) => file.content).join("\n")}`;
  const frameworks = frameworkHints(content, [
    ["axum", "Axum"],
    ["actix_web", "Actix Web"],
    ["rocket", "Rocket"]
  ]);
  const workspaceManifests = manifestEntries.filter((entry) => /\[workspace\]/.test(entry.content));
  return languageSummary({
    id: "rust",
    files: rustFiles,
    buildFiles: cargoFiles,
    frameworks,
    reasons: [
      ...frameworks.map((name) => `${name} signal`),
      cargoFiles.length > 1 ? `${cargoFiles.length} Cargo manifest(s)` : "",
      workspaceManifests.length > 0 ? "Cargo workspace present" : ""
    ].filter(Boolean)
  });
}

function languageSummary({
  id,
  files,
  buildFiles,
  frameworks,
  reasons,
}: {
  id: CrossLanguageId;
  files: SourceFile[];
  buildFiles: string[];
  frameworks: string[];
  reasons: string[];
}) {
  const uniqueFrameworks = [...new Set(frameworks)].sort();
  return {
    id,
    sourceFiles: files.filter((file) => !file.isTest).length,
    testFiles: files.filter((file) => file.isTest).length,
    frameworks: uniqueFrameworks,
    buildFiles,
    reasons: [...new Set([
      ...reasons,
      files.length > 0 ? `${files.length} source/test file(s)` : "",
      buildFiles.length > 0 ? `${buildFiles.join(", ")} present` : ""
    ].filter(Boolean))].sort()
  };
}

async function readPackageJsonHints(packageJsonPath: string): Promise<{ frameworks: string[]; reasons: string[] }> {
  const pkg = await readJsonFile<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(packageJsonPath).catch(() => undefined);
  const hints: { frameworks: string[]; reasons: string[] } = { frameworks: [], reasons: [] };
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  for (const [dep, label] of [
    ["express", "Express"],
    ["koa", "Koa"],
    ["fastify", "Fastify"],
    ["@nestjs/core", "NestJS"],
    ["hono", "Hono"]
  ] as const) {
    if (deps[dep]) {
      hints.frameworks.push(label);
      hints.reasons.push(`${label} dependency`);
    }
  }
  if (pkg?.scripts?.test) {
    hints.reasons.push("package test script");
  }
  return hints;
}

async function readKnownManifest(root: string, names: string[]): Promise<string> {
  const parts = await Promise.all(names.map(async (name) => {
    const filePath = path.join(root, name);
    return await fs.readFile(filePath, "utf8").catch(() => "");
  }));
  return parts.join("\n");
}

function frameworkHints(content: string, hints: Array<[needle: string, label: string]>): string[] {
  const lower = content.toLowerCase();
  return [...new Set(hints
    .filter(([needle]) => lower.includes(needle.toLowerCase()))
    .map(([, label]) => label))].sort();
}

function selectPrimaryLanguage(languages: CrossLanguageProjectInventory["languages"]) {
  return [...languages].sort((a, b) => {
    const scoreA = a.sourceFiles * 2 + a.testFiles + a.frameworks.length * 5 + a.buildFiles.length * 3;
    const scoreB = b.sourceFiles * 2 + b.testFiles + b.frameworks.length * 5 + b.buildFiles.length * 3;
    return scoreB - scoreA;
  })[0];
}

function confidenceForLanguage(language: CrossLanguageProjectInventory["languages"][number] | undefined): "low" | "medium" | "high" {
  if (!language) {
    return "low";
  }
  if (language.frameworks.length > 0 && language.buildFiles.length > 0) {
    return "high";
  }
  if (language.sourceFiles > 0 || language.buildFiles.length > 0) {
    return "medium";
  }
  return "low";
}

async function recommendedChecksForProject(
  root: string,
  language: CrossLanguageId,
  buildFiles: string[],
  languages: CrossLanguageProjectInventory["languages"]
): Promise<string[]> {
  switch (language) {
    case "typescript-node":
      return recommendedNodeChecks(root);
    case "python":
      return ["python -m compileall .", "python -m pytest"];
    case "java":
      if (buildFiles.includes("pom.xml")) {
        return ["mvn test"];
      }
      if (buildFiles.includes("build.gradle") || buildFiles.includes("build.gradle.kts")) {
        return ["./gradlew test"];
      }
      return ["javac <sources>"];
    case "go":
      return ["go test ./..."];
    case "rust":
      return ["cargo check --all-targets", "cargo test --all-targets"];
    default:
      return (await Promise.all(languages.map((candidate) => recommendedChecksForProject(root, candidate.id, buildFiles, [])))).flat();
  }
}

async function recommendedNodeChecks(root: string): Promise<string[]> {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = await readJsonFile<{ scripts?: Record<string, unknown> }>(packageJsonPath).catch(() => undefined);
  const scripts = typeof packageJson?.scripts === "object" && packageJson.scripts !== null
    ? Object.keys(packageJson.scripts as Record<string, unknown>)
    : [];
  const pm = await detectNodePackageManager(root);
  return ["type-check", "test", "build"]
    .filter((script) => scripts.includes(script))
    .map((script) => nodeScriptCommand(pm, script));
}

async function detectNodePackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function nodeScriptCommand(packageManager: "npm" | "pnpm" | "yarn", script: string): string {
  return packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;
}

function extractRoutesFromFile(file: SourceFile): CrossLanguageRouteCandidate[] {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(file.ext)) {
    return extractNodeRoutes(file);
  }
  if (file.ext === ".py") {
    return extractPythonRoutes(file);
  }
  if (file.ext === ".java") {
    return extractJavaRoutes(file);
  }
  if (file.ext === ".go") {
    return extractGoRoutes(file);
  }
  if (file.ext === ".rs") {
    return extractRustRoutes(file);
  }
  return [];
}

function extractNodeRoutes(file: SourceFile): CrossLanguageRouteCandidate[] {
  const routes: CrossLanguageRouteCandidate[] = [];
  const lines = file.content.split(/\r?\n/);
  const callPattern = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|options|head|all)\(\s*["'`]([^"'`]+)["'`]\s*,?\s*([A-Za-z0-9_$]+)?/i;
  const decoratorPattern = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/;
  for (const [index, line] of lines.entries()) {
    const call = line.match(callPattern);
    if (call) {
      routes.push(routeCandidate(file, index, call[1], call[2], "Node HTTP", "high", call[3]));
      continue;
    }
    const decorator = line.match(decoratorPattern);
    if (decorator) {
      routes.push(routeCandidate(file, index, decorator[1], normalizeRoutePath(decorator[2]), "NestJS", "medium"));
    }
  }
  return routes;
}

function extractPythonRoutes(file: SourceFile): CrossLanguageRouteCandidate[] {
  const routes: CrossLanguageRouteCandidate[] = [];
  const lines = file.content.split(/\r?\n/);
  const fastApiPattern = /@(?:app|router)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/i;
  const flaskPattern = /@(?:app|blueprint)\.route\(\s*["']([^"']+)["'](?:,\s*methods\s*=\s*\[["']([A-Z]+)["'])?/i;
  for (const [index, line] of lines.entries()) {
    const fastApi = line.match(fastApiPattern);
    if (fastApi) {
      routes.push(routeCandidate(file, index, fastApi[1], fastApi[2], "FastAPI", "high"));
      continue;
    }
    const flask = line.match(flaskPattern);
    if (flask) {
      routes.push(routeCandidate(file, index, flask[2] ?? "GET", flask[1], "Flask", "medium"));
    }
  }
  return routes;
}

function extractJavaRoutes(file: SourceFile): CrossLanguageRouteCandidate[] {
  const routes: CrossLanguageRouteCandidate[] = [];
  const lines = file.content.split(/\r?\n/);
  const mappingPattern = /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/;
  const requestMappingPattern = /@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']+)["'].*RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/;
  for (const [index, line] of lines.entries()) {
    const mapping = line.match(mappingPattern);
    if (mapping) {
      routes.push(routeCandidate(file, index, mapping[1], mapping[2], "Spring", "high"));
      continue;
    }
    const requestMapping = line.match(requestMappingPattern);
    if (requestMapping) {
      routes.push(routeCandidate(file, index, requestMapping[2], requestMapping[1], "Spring", "medium"));
    }
  }
  return routes;
}

function extractGoRoutes(file: SourceFile): CrossLanguageRouteCandidate[] {
  const routes: CrossLanguageRouteCandidate[] = [];
  const lines = file.content.split(/\r?\n/);
  const netHttpPattern = /http\.HandleFunc\(\s*["'`]([^"'`]+)["'`]\s*,?\s*([A-Za-z0-9_$.]+)?/;
  const frameworkPattern = /\b[A-Za-z0-9_$]+\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\(\s*["'`]([^"'`]+)["'`]\s*,?\s*([A-Za-z0-9_$.]+)?/;
  for (const [index, line] of lines.entries()) {
    const framework = line.match(frameworkPattern);
    if (framework) {
      routes.push(routeCandidate(file, index, framework[1], framework[2], "Go router", "high", framework[3]));
      continue;
    }
    const netHttp = line.match(netHttpPattern);
    if (netHttp) {
      routes.push(routeCandidate(file, index, "GET", netHttp[1], "net/http", "low", netHttp[2]));
    }
  }
  return routes;
}

function extractRustRoutes(file: SourceFile): CrossLanguageRouteCandidate[] {
  const routes: CrossLanguageRouteCandidate[] = [];
  const lines = file.content.split(/\r?\n/);
  const framework = rustFrameworkForFile(file.content);
  const actixPattern = /\.route\(\s*"([^"]+)"\s*,\s*web::(get|post|put|patch|delete|head)\(\)\.to\(\s*([A-Za-z0-9_:]+)?/gi;
  const attributePattern = /#\[(get|post|put|patch|delete|head)\(\s*"([^"]+)"/i;
  for (const [index, line] of lines.entries()) {
    const attribute = line.match(attributePattern);
    if (attribute && (framework === "Actix Web" || framework === "Rocket")) {
      routes.push(routeCandidate(file, index, attribute[1], attribute[2], framework, "high"));
    }
    if (framework === "Actix Web") {
      for (const match of line.matchAll(actixPattern)) {
        routes.push(routeCandidate(file, index, match[2], match[1], framework, "high", match[3]));
      }
    } else if (framework === "Axum") {
      const route = line.match(/\.route\(\s*"([^"]+)"\s*,\s*(.+)\)\s*;?$/i);
      if (route) {
        const methodPattern = /(?:^|\.)(get|post|put|patch|delete|options|head)\s*\(\s*([A-Za-z0-9_:]+)?/gi;
        for (const method of route[2].matchAll(methodPattern)) {
          routes.push(routeCandidate(file, index, method[1], route[1], framework, "high", method[2]));
        }
      }
    }
  }
  return routes;
}

function extractUnresolvedRoutesFromFile(file: SourceFile): CrossLanguageUnresolvedRoute[] {
  if (file.ext !== ".rs") {
    return [];
  }
  const resolvedLines = new Set(extractRustRoutes(file).map((route) => route.line));
  const framework = rustFrameworkForFile(file.content);
  return file.content.split(/\r?\n/).flatMap((line, index) => {
    const lineNumber = index + 1;
    const looksLikeRoute = /\.route\s*\(|#\[(?:route|get|post|put|patch|delete|head)\s*\(/i.test(line);
    if (!looksLikeRoute || resolvedLines.has(lineNumber)) {
      return [];
    }
    return [{
      code: "unsupported-rust-route-syntax" as const,
      file: file.relativePath,
      line: lineNumber,
      framework,
      syntax: line.trim(),
      reason: "Rust route declaration was detected but its HTTP method or literal path could not be resolved statically."
    }];
  });
}

function rustFrameworkForFile(content: string): CrossLanguageUnresolvedRoute["framework"] {
  const lower = content.toLowerCase();
  if (lower.includes("actix_web") || lower.includes("actix-web")) return "Actix Web";
  if (lower.includes("rocket")) return "Rocket";
  if (lower.includes("axum")) return "Axum";
  return "Rust HTTP";
}

function routeCandidate(
  file: SourceFile,
  zeroBasedLine: number,
  method: string,
  routePath: string,
  framework: string,
  confidence: CrossLanguageRouteCandidate["confidence"],
  handler?: string
): CrossLanguageRouteCandidate {
  return {
    method: method.toUpperCase(),
    path: normalizeRoutePath(routePath),
    file: file.relativePath,
    line: zeroBasedLine + 1,
    framework,
    confidence,
    handler
  };
}

function normalizeRoutePath(routePath: string): string {
  const clean = routePath.trim();
  if (!clean || clean === "/") {
    return "/";
  }
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function routeKey(route: Pick<CrossLanguageRouteCandidate, "method" | "path">): string {
  return `${route.method.toUpperCase()} ${normalizeRoutePath(route.path)}`;
}

function routeRef(route: CrossLanguageRouteCandidate): { method: string; path: string; file: string } {
  return {
    method: route.method,
    path: route.path,
    file: `${route.file}:${route.line}`
  };
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|test|tests)\//.test(relativePath)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    || /_test\.go$/.test(relativePath)
    || /(^|\/)tests?\/.*\.rs$/.test(relativePath)
    || /(^|\/)test_[^/]+\.py$/.test(relativePath);
}
