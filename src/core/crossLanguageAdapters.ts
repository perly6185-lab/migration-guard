import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, toPosixPath } from "./files.js";

export type CrossLanguageId =
  | "typescript-node"
  | "python"
  | "java"
  | "go"
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
  ".go"
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
    detectGo(files, manifests)
  ])).filter((language) => language.sourceFiles > 0 || language.buildFiles.length > 0);
  const routes = files.flatMap((file) => extractRoutesFromFile(file));
  const primary = selectPrimaryLanguage(languageSummaries);

  return {
    root,
    detectedAt: new Date().toISOString(),
    primaryLanguage: primary?.id ?? "unknown",
    languageConfidence: confidenceForLanguage(primary),
    languages: languageSummaries,
    routes: routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
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
      : "No HTTP route candidates detected."
  ].join("\n");
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
    "go.mod"
  ];
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) {
      present.push(candidate);
    }
  }
  return present;
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
    .map((script) => `${pm} ${script}`);
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
    || /(^|\/)test_[^/]+\.py$/.test(relativePath);
}
