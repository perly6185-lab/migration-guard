import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonFile, writeTextFile, toPosixPath } from "./files.js";

export type JavaEndpointHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "ALL";
export type JavaEndpointRiskSeverity = "low" | "medium" | "high";

export interface AnalyzeJavaEndpointOptions {
  root: string;
  endpoint: string;
  method?: string;
  maxDepth?: number;
  maxEdges?: number;
  includeTests?: boolean;
}

export interface JavaEndpointAnalyzer {
  root: string;
  routes: JavaEndpointRouteCandidate[];
  serviceMethods: JavaServiceMethodCandidate[];
  analyze(options: Omit<AnalyzeJavaEndpointOptions, "root" | "includeTests">): JavaEndpointAnalysisReport;
  analyzeServiceMethod(candidate: JavaServiceMethodCandidate, options?: Pick<AnalyzeJavaEndpointOptions, "maxDepth" | "maxEdges">): JavaEndpointAnalysisReport;
  analyzeServiceMethodAdaptive(candidate: JavaServiceMethodCandidate, options?: AdaptiveJavaAnalysisOptions): AdaptiveJavaAnalysisResult;
}

export interface AdaptiveJavaAnalysisOptions {
  initialDepth?: number;
  initialEdges?: number;
  maxDepth?: number;
  maxEdges?: number;
  maxRounds?: number;
}

export interface AdaptiveJavaAnalysisResult {
  report: JavaEndpointAnalysisReport;
  status: "complete" | "budget-exhausted";
  rounds: Array<{ round: number; maxDepth: number; maxEdges: number; nodes: number; edges: number; unexpandedBoundaries: number; complete: boolean }>;
}

export interface JavaServiceMethodCandidate {
  id: string;
  className: string;
  qualifiedClassName: string;
  methodName: string;
  signature: string;
  returnType?: string;
  parameterTypes: string[];
  annotations: string[];
  file: string;
  line: number;
}

export interface JavaEndpointRouteCandidate {
  method: JavaEndpointHttpMethod;
  path: string;
  file: string;
  line: number;
  className: string;
  methodName: string;
  signature: string;
  classRoute?: string;
  methodRoute?: string;
  framework: "Spring";
  confidence: "low" | "medium" | "high";
  annotations?: string[];
  entryKind?: "controller" | "service";
}

export interface JavaEndpointCallGraphNode {
  id: string;
  kind: "controller" | "service" | "repository" | "mapper" | "dto" | "unknown";
  role?: JavaTypeRole;
  className: string;
  methodName: string;
  file: string;
  line: number;
  signature?: string;
  route?: Pick<JavaEndpointRouteCandidate, "method" | "path">;
}

export interface JavaEndpointCallGraphEdge {
  from: string;
  to?: string;
  unresolvedTarget?: string;
  call: {
    receiver?: string;
    method: string;
    expression: string;
    file: string;
      line: number;
      argumentCount?: number;
      argumentTypes?: string[];
    };
  resolution: "field-injection" | "same-class" | "static-or-external" | "ambiguous" | "unresolved";
  resolutionCandidates?: Array<{ methodId: string; signature: string; score: number }>;
}

export interface JavaEndpointRiskSignal {
  id: string;
  title: string;
  severity: JavaEndpointRiskSeverity;
  summary: string;
  evidence: string[];
}

export interface JavaEndpointGoldenCase {
  id: string;
  title: string;
  requestFocus: string[];
  expectedComparison: string[];
  reason: string;
  status: "draft";
}

export interface JavaEndpointGoldenCasePlan {
  version: 1;
  model: "page-query" | "batch-command" | "sync-command";
  endpoint: {
    method: JavaEndpointHttpMethod;
    path: string;
  };
  cases: JavaEndpointGoldenCase[];
  fixtureTemplate: {
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  comparisonDimensions: string[];
}

export interface JavaEndpointAnalysisReport {
  version: 1;
  createdAt: string;
  root: string;
  endpoint: {
    method: JavaEndpointHttpMethod;
    path: string;
  };
  summary: {
    javaFileCount: number;
    routeCount: number;
    exactMatchCount: number;
    callGraphNodeCount: number;
    callGraphEdgeCount: number;
    highRiskCount: number;
    goldenCaseCount: number;
  };
  matches: JavaEndpointRouteCandidate[];
  selectedRoute?: JavaEndpointRouteCandidate;
  callGraph: {
    nodes: JavaEndpointCallGraphNode[];
    edges: JavaEndpointCallGraphEdge[];
    truncation: {
      maxDepth: number;
      maxTotalEdges: number;
      edgeCapHit: boolean;
      depthCapHit: boolean;
      maxObservedDepth: number;
      nodeDepthCounts: Record<string, number>;
      edgeSourceDepthCounts: Record<string, number>;
      unexpandedBoundaryNodes: string[];
    };
  };
  requestModel?: {
    className: string;
    file: string;
    fields: string[];
  };
  riskSignals: JavaEndpointRiskSignal[];
  goldenCasePlan: JavaEndpointGoldenCasePlan;
  recommendedNextActions: string[];
  outputPath?: string;
  markdownPath?: string;
}

interface JavaSourceFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  isTest: boolean;
}

interface JavaProjectModel {
  root: string;
  files: JavaSourceFile[];
  types: JavaTypeInfo[];
  typesByName: Map<string, JavaTypeInfo[]>;
  implementationsByInterface: Map<string, JavaTypeInfo[]>;
}

interface JavaTypeInfo {
  name: string;
  qualifiedName: string;
  packageName?: string;
  kind: "class" | "interface" | "enum";
  file: string;
  line: number;
  annotations: string[];
  implements: string[];
  extends: string[];
  fields: JavaFieldInfo[];
  plainFields: JavaPlainFieldInfo[];
  constants: Map<string, string>;
  methods: JavaMethodInfo[];
}

interface JavaFieldInfo {
  name: string;
  typeName: string;
  annotations: string[];
  line: number;
}

interface JavaPlainFieldInfo {
  name: string;
  typeName: string;
  line: number;
}

interface JavaMethodInfo {
  name: string;
  returnType?: string;
  params: JavaParamInfo[];
  file: string;
  line: number;
  signature: string;
  annotations: string[];
  body: string;
  bodyStartLine: number;
  bodyEndLine: number;
  hasBody: boolean;
}

interface JavaParamInfo {
  name: string;
  typeName: string;
}

interface GraphTraceState {
  node: JavaEndpointCallGraphNode;
  type: JavaTypeInfo;
  method: JavaMethodInfo;
  depth: number;
}

const DEFAULT_MAX_DEPTH = 5;
const MAX_EDGES_PER_METHOD = 40;
const DEFAULT_MAX_TOTAL_EDGES = 600;
const JAVA_SKIP_DIRS = new Set([
  ".git",
  ".migration-guard",
  ".idea",
  ".gradle",
  "node_modules",
  "dist",
  "build",
  "target",
  "__pycache__"
]);
const HTTP_METHODS = new Set<JavaEndpointHttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"]);
const JAVA_KEYWORD_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "new",
  "super",
  "this",
  "do",
  "try",
  "else",
  "synchronized"
]);
const CONTEXT_SIGNALS = [
  "TenantContextHolder",
  "WebFrameworkUtils",
  "SecurityFrameworkUtils",
  "RequestContextHolder",
  "DeviceContextHolder",
  "DynamicDataSourceContextHolder",
  "LoginUserContextHolder"
];
const SIDE_EFFECT_SIGNALS = [
  "syncPageRefValue",
  "updateSyncTime",
  "updateDataTime",
  "clearUndoOperation",
  "savePageSize",
  "recordData",
  "tryLock",
  "unlock"
];
const DYNAMIC_SQL_SIGNALS = [
  "dynamicTableQueryRepository",
  "selectCount",
  "selectPage",
  "DynamicSelect",
  "SqlDynamic",
  "ViewMetaPageQueryPlan"
];

export async function analyzeJavaEndpoint(options: AnalyzeJavaEndpointOptions): Promise<JavaEndpointAnalysisReport> {
  const root = path.resolve(options.root);
  const analyzer = await createJavaEndpointAnalyzer(root, Boolean(options.includeTests));
  return analyzer.analyze(options);
}

export type JavaTypeRole = "controller" | "application-service" | "domain-service" | "service" | "repository" | "mapper" | "support" | "pipeline" | "processor" | "coordinator" | "adapter" | "infrastructure-client" | "policy" | "assembler" | "unknown";

export async function createJavaEndpointAnalyzer(rootValue: string, includeTests = false): Promise<JavaEndpointAnalyzer> {
  const root = path.resolve(rootValue);
  const project = await collectJavaProject(root, includeTests);
  const routes = extractSpringRoutes(project);
  const serviceMethods = extractServiceMethods(project);
  return {
    root,
    routes,
    serviceMethods,
    analyze: (options) => analyzeJavaEndpointModel(project, routes, options),
    analyzeServiceMethod: (candidate, options = {}) => analyzeJavaServiceMethodModel(project, routes, candidate, options),
    analyzeServiceMethodAdaptive: (candidate, options = {}) => analyzeJavaServiceMethodAdaptive(project, routes, candidate, options)
  };
}

function analyzeJavaServiceMethodAdaptive(
  project: JavaProjectModel,
  routes: JavaEndpointRouteCandidate[],
  candidate: JavaServiceMethodCandidate,
  options: AdaptiveJavaAnalysisOptions
): AdaptiveJavaAnalysisResult {
  let depth = positiveInteger(options.initialDepth, DEFAULT_MAX_DEPTH);
  let edges = positiveInteger(options.initialEdges, DEFAULT_MAX_TOTAL_EDGES);
  const maxDepth = positiveInteger(options.maxDepth, Math.max(depth, 16));
  const maxEdges = positiveInteger(options.maxEdges, Math.max(edges, 5000));
  const maxRounds = positiveInteger(options.maxRounds, 4);
  const rounds: AdaptiveJavaAnalysisResult["rounds"] = [];
  let report = analyzeJavaServiceMethodModel(project, routes, candidate, { maxDepth: depth, maxEdges: edges });
  for (let round = 1; round <= maxRounds; round += 1) {
    const truncation = report.callGraph.truncation;
    const complete = !truncation.edgeCapHit && !truncation.depthCapHit && truncation.unexpandedBoundaryNodes.length === 0;
    rounds.push({ round, maxDepth: depth, maxEdges: edges, nodes: report.callGraph.nodes.length, edges: report.callGraph.edges.length, unexpandedBoundaries: truncation.unexpandedBoundaryNodes.length, complete });
    if (complete) return { report, status: "complete", rounds };
    if (round === maxRounds) break;
    const nextDepth = truncation.depthCapHit ? Math.min(maxDepth, depth + Math.max(2, Math.ceil(depth / 2))) : depth;
    const nextEdges = truncation.edgeCapHit ? Math.min(maxEdges, Math.max(edges + 1, edges * 2)) : edges;
    if (nextDepth === depth && nextEdges === edges) break;
    depth = nextDepth;
    edges = nextEdges;
    report = analyzeJavaServiceMethodModel(project, routes, candidate, { maxDepth: depth, maxEdges: edges });
  }
  return { report, status: "budget-exhausted", rounds };
}

function extractServiceMethods(project: JavaProjectModel): JavaServiceMethodCandidate[] {
  return project.types
    .filter((type) => type.kind === "class" && nodeKind(type) === "service")
    .flatMap((type) => type.methods
      .filter((method) => method.hasBody && /^(public|protected)\s/.test(method.signature))
      .map((method) => ({
        id: methodId(type, method),
        className: type.name,
        qualifiedClassName: type.qualifiedName,
        methodName: method.name,
        signature: method.signature,
        returnType: method.returnType,
        parameterTypes: method.params.map((param) => param.typeName),
        annotations: [...type.annotations, ...method.annotations],
        file: method.file,
        line: method.line
      })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
}

function analyzeJavaServiceMethodModel(
  project: JavaProjectModel,
  routes: JavaEndpointRouteCandidate[],
  candidate: JavaServiceMethodCandidate,
  options: Pick<AnalyzeJavaEndpointOptions, "maxDepth" | "maxEdges">
): JavaEndpointAnalysisReport {
  const endpoint = normalizeRoutePath(`/__service/${candidate.qualifiedClassName}/${candidate.methodName}/${candidate.line}`);
  const selectedRoute: JavaEndpointRouteCandidate = {
    method: "ALL",
    path: endpoint,
    file: candidate.file,
    line: candidate.line,
    className: candidate.className,
    methodName: candidate.methodName,
    signature: candidate.signature,
    framework: "Spring",
    confidence: "high",
    annotations: candidate.annotations,
    entryKind: "service"
  };
  return analyzeJavaEndpointModel(project, routes, { endpoint, method: "ALL", ...options }, selectedRoute);
}

function analyzeJavaEndpointModel(
  project: JavaProjectModel,
  routes: JavaEndpointRouteCandidate[],
  options: Omit<AnalyzeJavaEndpointOptions, "root" | "includeTests">,
  selectedOverride?: JavaEndpointRouteCandidate
): JavaEndpointAnalysisReport {
  const root = project.root;
  const method = normalizeHttpMethod(options.method ?? "POST");
  const endpointPath = normalizeRoutePath(options.endpoint);
  const matches = selectedOverride ? [selectedOverride] : findRouteMatches(routes, method, endpointPath);
  const selectedRoute = selectedOverride ?? selectRoute(matches);
  const graph = selectedRoute
    ? buildCallGraph(
      project,
      selectedRoute,
      positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH),
      positiveInteger(options.maxEdges, DEFAULT_MAX_TOTAL_EDGES)
    )
    : emptyCallGraph(
      positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH),
      positiveInteger(options.maxEdges, DEFAULT_MAX_TOTAL_EDGES)
    );
  const requestModel = selectedRoute ? resolveRequestModel(project, selectedRoute) : undefined;
  const riskSignals = detectRiskSignals(project, routes, selectedRoute, graph, requestModel);
  const goldenCasePlan = createJavaEndpointGoldenCasePlan(method, endpointPath, selectedRoute, requestModel, riskSignals);
  const highRiskCount = riskSignals.filter((signal) => signal.severity === "high").length;
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    root,
    endpoint: {
      method,
      path: endpointPath
    },
    summary: {
      javaFileCount: project.files.length,
      routeCount: routes.length,
      exactMatchCount: selectedOverride ? 1 : matches.filter((match) => routeMatchesExactly(match, method, endpointPath)).length,
      callGraphNodeCount: graph.nodes.length,
      callGraphEdgeCount: graph.edges.length,
      highRiskCount,
      goldenCaseCount: goldenCasePlan.cases.length
    },
    matches,
    selectedRoute,
    callGraph: graph,
    requestModel,
    riskSignals,
    goldenCasePlan,
    recommendedNextActions: recommendedNextActions(riskSignals, selectedRoute, goldenCasePlan)
  };
}

export async function writeJavaEndpointAnalysisReport(
  report: JavaEndpointAnalysisReport,
  artifactsDir: string
): Promise<JavaEndpointAnalysisReport> {
  const slug = endpointSlug(report.endpoint.method, report.endpoint.path);
  const outputPath = path.join(artifactsDir, "java-endpoint", `${slug}.json`);
  const markdownPath = path.join(artifactsDir, "java-endpoint", `${slug}.md`);
  const withPaths: JavaEndpointAnalysisReport = {
    ...report,
    outputPath,
    markdownPath
  };
  await writeJsonFile(outputPath, withPaths);
  await writeTextFile(markdownPath, renderJavaEndpointAnalysisReport(withPaths));
  return withPaths;
}

export function renderJavaEndpointAnalysisReport(report: JavaEndpointAnalysisReport): string {
  const lines = [
    `# Java Endpoint Analysis: ${report.endpoint.method} ${report.endpoint.path}`,
    "",
    `- Root: ${report.root}`,
    `- Java files: ${report.summary.javaFileCount}`,
    `- Routes: ${report.summary.routeCount}`,
    `- Exact matches: ${report.summary.exactMatchCount}`,
    `- Call graph: ${report.summary.callGraphNodeCount} node(s), ${report.summary.callGraphEdgeCount} edge(s)`,
    `- Call graph limits: depth <= ${report.callGraph.truncation.maxDepth}, edges <= ${report.callGraph.truncation.maxTotalEdges}`,
    `- Call graph truncation: ${truncationSummary(report.callGraph.truncation)}`,
    `- Golden case model: ${report.goldenCasePlan.model}`,
    `- Golden cases: ${report.summary.goldenCaseCount}`,
    "",
    "## Selected Route",
    "",
    report.selectedRoute
      ? `- ${report.selectedRoute.method} ${report.selectedRoute.path} -> ${report.selectedRoute.className}.${report.selectedRoute.methodName} (${report.selectedRoute.file}:${report.selectedRoute.line})`
      : "- none",
    "",
    "## Call Graph",
    "",
    ...(report.callGraph.nodes.length > 0
      ? report.callGraph.nodes.map((node) => `- ${node.id} (${node.kind}) ${node.file}:${node.line}`)
      : ["- none"]),
    "",
    "## Call Graph Coverage",
    "",
    `- Max observed depth: ${report.callGraph.truncation.maxObservedDepth}`,
    `- Nodes by source depth: ${formatDepthCounts(report.callGraph.truncation.nodeDepthCounts)}`,
    `- Edges by source depth: ${formatDepthCounts(report.callGraph.truncation.edgeSourceDepthCounts)}`,
    ...(report.callGraph.truncation.unexpandedBoundaryNodes.length > 0
      ? [`- Unexpanded boundary nodes: ${report.callGraph.truncation.unexpandedBoundaryNodes.slice(0, 25).join(", ")}`]
      : []),
    "",
    "## Risks",
    "",
    ...(report.riskSignals.length > 0
      ? report.riskSignals.map((signal) => `- ${signal.severity} ${signal.id}: ${signal.summary}`)
      : ["- none"]),
    "",
    "## Golden Cases",
    "",
    ...(report.goldenCasePlan.cases.length > 0
      ? report.goldenCasePlan.cases.map((item) => `- ${item.id}: ${item.title}; focus=${item.requestFocus.join(", ")}; compare=${item.expectedComparison.join(", ")} (${item.reason})`)
      : ["- none"]),
    "",
    "## Comparison Dimensions",
    "",
    ...(report.goldenCasePlan.comparisonDimensions.length > 0
      ? report.goldenCasePlan.comparisonDimensions.map((dimension) => `- ${dimension}`)
      : ["- none"]),
    "",
    "## Recommended Next Actions",
    "",
    ...(report.recommendedNextActions.length > 0
      ? report.recommendedNextActions.map((action) => `- ${action}`)
      : ["- none"])
  ];
  if (report.outputPath || report.markdownPath) {
    lines.push("", "## Artifacts", "");
    if (report.outputPath) lines.push(`- JSON: ${report.outputPath}`);
    if (report.markdownPath) lines.push(`- Markdown: ${report.markdownPath}`);
  }
  return lines.join("\n");
}

async function collectJavaProject(root: string, includeTests: boolean): Promise<JavaProjectModel> {
  const absolutePaths = await walkJavaFiles(root);
  const files: JavaSourceFile[] = [];
  for (const absolutePath of absolutePaths) {
    const relativePath = toPosixPath(path.relative(root, absolutePath));
    const isTest = /(^|\/)src\/test\//.test(relativePath) || /Test\.java$/.test(relativePath);
    if (isTest && !includeTests) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    const content = stat.size <= 2 * 1024 * 1024 ? await fs.readFile(absolutePath, "utf8") : "";
    files.push({ absolutePath, relativePath, content, isTest });
  }

  const types = files.flatMap((file) => parseJavaTypes(file));
  const typesByName = new Map<string, JavaTypeInfo[]>();
  const implementationsByInterface = new Map<string, JavaTypeInfo[]>();
  for (const type of types) {
    pushMap(typesByName, type.name, type);
    pushMap(typesByName, type.qualifiedName, type);
    for (const implemented of type.implements) {
      pushMap(implementationsByInterface, simpleTypeName(implemented), type);
      pushMap(implementationsByInterface, implemented, type);
    }
  }
  return { root, files, types, typesByName, implementationsByInterface };
}

async function walkJavaFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (JAVA_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        files.push(absolutePath);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function parseJavaTypes(file: JavaSourceFile): JavaTypeInfo[] {
  const content = stripBlockComments(file.content.replace(/^\uFEFF/, ""));
  const lines = content.split(/\r?\n/);
  const packageName = content.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m)?.[1];
  const types: JavaTypeInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)*?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z0-9_.$<>,\s]+?))?(?:\s+implements\s+([^{]+))?\s*\{/);
    if (!match) {
      continue;
    }
    const bodyRange = findBraceRange(lines, index);
    const annotations = collectLeadingAnnotations(lines, index);
    const typeName = match[2];
    const type: JavaTypeInfo = {
      name: typeName,
      qualifiedName: packageName ? `${packageName}.${typeName}` : typeName,
      packageName,
      kind: match[1] as JavaTypeInfo["kind"],
      file: file.relativePath,
      line: index + 1,
      annotations,
      implements: parseImplements(match[4]),
      extends: parseImplements(match[3]),
      fields: [],
      plainFields: [],
      constants: new Map(),
      methods: []
    };
    parseTypeBody(lines, bodyRange.start, bodyRange.end, file, type);
    types.push(type);
    index = bodyRange.end;
  }

  return types;
}

function parseTypeBody(lines: string[], startLine: number, endLine: number, file: JavaSourceFile, type: JavaTypeInfo): void {
  for (let index = startLine + 1; index < endLine; index += 1) {
    const line = lines[index];
    const annotations = collectLeadingAnnotations(lines, index);
    const constant = line.match(/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?String\s+([A-Z0-9_]+)\s*=\s*(.+?)\s*;/);
    if (constant) {
      const value = evaluateJavaStringExpression(constant[2], type.constants);
      if (value !== undefined) {
        type.constants.set(constant[1], value);
      }
    }

    const field = line.match(/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?([A-Za-z0-9_.$<>?,\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?;/);
    const fieldTypeName = field ? simpleTypeName(field[1].trim()) : undefined;
    if (field) {
      type.plainFields.push({
        name: field[2],
        typeName: fieldTypeName as string,
        line: index + 1
      });
    }
    if (field && annotations.some((annotation) => /@(Resource|Autowired|Inject)\b/.test(annotation))) {
      type.fields.push({
        name: field[2],
        typeName: fieldTypeName as string,
        annotations,
        line: index + 1
      });
      continue;
    }

    const method = parseMethodAt(lines, index, endLine, file, type);
    if (method) {
      type.methods.push(method.method);
      index = method.endLine;
    }
  }
}

function parseMethodAt(
  lines: string[],
  index: number,
  typeEndLine: number,
  file: JavaSourceFile,
  type: JavaTypeInfo
): { method: JavaMethodInfo; endLine: number } | undefined {
  const signatureLines: string[] = [];
  let cursor = index;
  let foundTerminator = false;
  while (cursor < typeEndLine && cursor < index + 8) {
    const trimmed = lines[cursor].trim();
    if (!trimmed || (cursor === index && trimmed.startsWith("@"))) {
      return undefined;
    }
    const braceIndex = trimmed.indexOf("{");
    signatureLines.push(braceIndex >= 0 ? trimmed.slice(0, braceIndex + 1) : trimmed);
    if (braceIndex >= 0 || /;\s*$/.test(trimmed)) {
      foundTerminator = true;
      break;
    }
    cursor += 1;
  }
  if (!foundTerminator) {
    return undefined;
  }
  const signature = signatureLines.join(" ").replace(/\s+/g, " ");
  const hasExplicitAccess = /^(public|protected|private)\s/.test(signature);
  if (!hasExplicitAccess && type.kind !== "interface") {
    return undefined;
  }
  const methodMatch = signature.match(/^(?:(?:public|protected|private)\s+)?(?:static\s+)?(?:final\s+)?(?:<[^>]+>\s+)?(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*(?:throws\s+[^{;]+)?([;{])\s*$/);
  if (!methodMatch) {
    return undefined;
  }
  const name = methodMatch[2];
  const returnType = methodMatch[1].trim();
  const terminator = methodMatch[4];
  const annotations = collectLeadingAnnotations(lines, index);
  if (terminator === ";") {
    return {
      method: {
        name,
        returnType,
        params: parseParams(methodMatch[3]),
        file: file.relativePath,
        line: index + 1,
        signature,
        annotations,
        body: "",
        bodyStartLine: index + 1,
        bodyEndLine: index + 1,
        hasBody: false
      },
      endLine: cursor
    };
  }
  const bodyRange = findBraceRange(lines, cursor);
  const body = lines.slice(cursor, bodyRange.end + 1).join("\n");
  return {
    method: {
      name,
      returnType,
      params: parseParams(methodMatch[3]),
      file: file.relativePath,
      line: index + 1,
      signature,
      annotations,
      body,
      bodyStartLine: cursor + 1,
      bodyEndLine: bodyRange.end + 1,
      hasBody: true
    },
    endLine: bodyRange.end
  };
}

function extractSpringRoutes(project: JavaProjectModel): JavaEndpointRouteCandidate[] {
  const routes: JavaEndpointRouteCandidate[] = [];
  for (const type of project.types) {
    const classRoute = routePathFromAnnotations(type.annotations, type.constants)?.path;
    for (const method of type.methods) {
      const methodMapping = routePathFromAnnotations(method.annotations, type.constants);
      if (!methodMapping) {
        continue;
      }
      const routeMethod = methodMapping.method;
      const routePath = joinRoutes(classRoute, methodMapping.path);
      routes.push({
        method: routeMethod,
        path: routePath,
        file: type.file,
        line: method.line,
        className: type.name,
        methodName: method.name,
        signature: method.signature,
        classRoute,
        methodRoute: methodMapping.path,
        framework: "Spring",
        confidence: routeMethod === "ALL" ? "medium" : "high",
        annotations: [...type.annotations, ...method.annotations]
      });
    }
  }
  return routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function routePathFromAnnotations(
  annotations: string[],
  constants: Map<string, string>
): { method: JavaEndpointHttpMethod; path: string } | undefined {
  for (const annotation of annotations) {
    const direct = annotation.match(/@(Get|Post|Put|Patch|Delete)Mapping\b([\s\S]*)/);
    if (direct) {
      const method = normalizeHttpMethod(direct[1]);
      return {
        method,
        path: evaluateAnnotationPath(direct[2], constants) ?? "/"
      };
    }
    const request = annotation.match(/@RequestMapping\b([\s\S]*)/);
    if (request) {
      const args = request[1] ?? "";
      return {
        method: requestMappingMethod(args),
        path: evaluateAnnotationPath(args, constants) ?? "/"
      };
    }
  }
  return undefined;
}

function evaluateAnnotationPath(argsWithParens: string, constants: Map<string, string>): string | undefined {
  const args = annotationArgs(argsWithParens);
  if (!args.trim()) {
    return "/";
  }
  const pathAttr = args.match(/(?:value|path)\s*=\s*([^,]+)/)?.[1] ?? args.split(/\bmethod\s*=/)[0].replace(/,$/, "");
  const value = evaluateJavaStringExpression(pathAttr, constants);
  return value === undefined ? undefined : normalizeRoutePath(value);
}

function requestMappingMethod(argsWithParens: string): JavaEndpointHttpMethod {
  const args = annotationArgs(argsWithParens);
  const match = args.match(/RequestMethod\.([A-Z]+)/);
  return match ? normalizeHttpMethod(match[1]) : "ALL";
}

function annotationArgs(value: string): string {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open >= 0 && close > open) {
    return value.slice(open + 1, close);
  }
  return value;
}

function evaluateJavaStringExpression(expression: string, constants: Map<string, string>): string | undefined {
  const withoutBraces = expression.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  const parts = withoutBraces.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  let resolved = "";
  let sawValue = false;
  for (const part of parts) {
    const literal = part.match(/^["']([^"']*)["']$/);
    if (literal) {
      resolved += literal[1];
      sawValue = true;
      continue;
    }
    const constantName = part.replace(/[(),]/g, "").trim();
    const constant = constants.get(constantName) ?? constants.get(simpleTypeName(constantName));
    if (constant !== undefined) {
      resolved += constant;
      sawValue = true;
    }
  }
  return sawValue ? resolved : undefined;
}

function findRouteMatches(
  routes: JavaEndpointRouteCandidate[],
  method: JavaEndpointHttpMethod,
  endpointPath: string
): JavaEndpointRouteCandidate[] {
  return routes.filter((route) => routeMethodMatches(route.method, method)
    && (normalizeRoutePath(route.path) === endpointPath
      || endpointPath.endsWith(normalizeRoutePath(route.path))
      || normalizeRoutePath(route.path).endsWith(endpointPath)));
}

function selectRoute(matches: JavaEndpointRouteCandidate[]): JavaEndpointRouteCandidate | undefined {
  return [...matches].sort((a, b) => {
    const exactA = a.path.length;
    const exactB = b.path.length;
    if (exactA !== exactB) {
      return exactB - exactA;
    }
    const controllerA = /Controller$/.test(a.className) ? 1 : 0;
    const controllerB = /Controller$/.test(b.className) ? 1 : 0;
    return controllerB - controllerA;
  })[0];
}

function buildCallGraph(
  project: JavaProjectModel,
  route: JavaEndpointRouteCandidate,
  maxDepth: number,
  maxEdges: number
): JavaEndpointAnalysisReport["callGraph"] {
  const routeType = findType(project, route.className, route.file);
  const routeMethod = routeType?.methods.find((method) => method.name === route.methodName && method.line === route.line);
  if (!routeType || !routeMethod) {
    return emptyCallGraph(maxDepth, maxEdges);
  }
  const nodes = new Map<string, JavaEndpointCallGraphNode>();
  const nodeDepths = new Map<string, number>();
  const edges: JavaEndpointCallGraphEdge[] = [];
  const edgeSourceDepths: number[] = [];
  const queue: GraphTraceState[] = [];
  const unexpandedBoundaryNodes: string[] = [];
  let edgeCapHadRemainingWork = false;
  const rootNode = nodeFor(routeType, routeMethod, route);
  nodes.set(rootNode.id, rootNode);
  nodeDepths.set(rootNode.id, 0);
  queue.push({ node: rootNode, type: routeType, method: routeMethod, depth: 0 });

  while (queue.length > 0 && edges.length < maxEdges) {
    const current = queue.shift() as GraphTraceState;
    if (current.depth >= maxDepth) {
      if (current.method.hasBody) {
        unexpandedBoundaryNodes.push(current.node.id);
      }
      continue;
    }
    if (!current.method.hasBody) {
      continue;
    }
    const calls = extractMethodCalls(project, current.method, current.type).slice(0, MAX_EDGES_PER_METHOD);
    for (const [callIndex, call] of calls.entries()) {
      if (edges.length >= maxEdges) {
        edgeCapHadRemainingWork = true;
        break;
      }
      const resolved = resolveCallTargets(project, current.type, call);
      const targets = resolved.targets;
      if (targets.length === 0) {
        const externalNode = call.receiver && resolved.resolution === "external" ? externalNodeFor(current.method, call) : undefined;
        if (externalNode) nodes.set(externalNode.id, externalNode);
        edges.push({
          from: current.node.id,
          to: externalNode?.id,
          unresolvedTarget: call.receiver ? `${call.receiver}.${call.method}` : call.method,
          call: {
            receiver: call.receiver,
            method: call.method,
            expression: call.expression,
            file: current.method.file,
            line: call.line,
            argumentCount: call.argumentCount,
            argumentTypes: call.argumentTypes
          },
          resolution: resolved.resolution === "ambiguous" ? "ambiguous" : resolved.resolution === "external" ? "static-or-external" : "unresolved",
          resolutionCandidates: resolved.candidates
        });
        edgeSourceDepths.push(current.depth);
        if (edges.length >= maxEdges && (callIndex < calls.length - 1 || queue.length > 0)) {
          edgeCapHadRemainingWork = true;
          break;
        }
        continue;
      }
      for (const [targetIndex, target] of targets.entries()) {
        if (edges.length >= maxEdges) {
          edgeCapHadRemainingWork = true;
          break;
        }
        const targetNode = nodeFor(target.type, target.method);
        const alreadyVisited = nodes.has(targetNode.id);
        nodes.set(targetNode.id, targetNode);
        if (!alreadyVisited) {
          nodeDepths.set(targetNode.id, current.depth + 1);
        }
        edges.push({
          from: current.node.id,
          to: targetNode.id,
          call: {
            receiver: call.receiver,
            method: call.method,
            expression: call.expression,
            file: current.method.file,
            line: call.line,
            argumentCount: call.argumentCount,
            argumentTypes: call.argumentTypes
          },
          resolution: call.receiver ? "field-injection" : "same-class",
          resolutionCandidates: resolved.candidates
        });
        edgeSourceDepths.push(current.depth);
        if (!alreadyVisited) {
          queue.push({ node: targetNode, type: target.type, method: target.method, depth: current.depth + 1 });
        }
        if (edges.length >= maxEdges && (targetIndex < targets.length - 1 || callIndex < calls.length - 1 || queue.length > 0)) {
          edgeCapHadRemainingWork = true;
          break;
        }
      }
      if (edgeCapHadRemainingWork) {
        break;
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    truncation: createCallGraphTruncation(
      maxDepth,
      maxEdges,
      nodeDepths,
      edgeSourceDepths,
      unexpandedBoundaryNodes,
      edgeCapHadRemainingWork || (queue.length > 0 && edges.length >= maxEdges)
    )
  };
}

function externalNodeFor(
  source: JavaMethodInfo,
  call: { receiver?: string; method: string; line: number; expression?: string; feature?: "lambda" | "method-reference" }
): JavaEndpointCallGraphNode {
  const receiver = call.receiver as string;
  return {
    id: `external:${source.file}:${receiver}.${call.method}:${call.line}`,
    kind: /mapper|repository|dao/i.test(receiver) ? "repository" : "unknown",
    role: /mapper/i.test(receiver) ? "mapper" : /repository|dao/i.test(receiver) ? "repository" : /client|gateway|api/i.test(receiver) ? "infrastructure-client" : /manager|registry/i.test(receiver) ? "coordinator" : /support|helper|util/i.test(receiver) ? "support" : "unknown",
    className: receiver,
    methodName: call.method,
    file: source.file,
    line: call.line,
    signature: call.feature ? `${call.feature}: ${call.expression ?? `${receiver}.${call.method}`}` : `${receiver}.${call.method}(...)`
  };
}

function emptyCallGraph(maxDepth: number, maxEdges: number): JavaEndpointAnalysisReport["callGraph"] {
  return {
    nodes: [],
    edges: [],
    truncation: {
      maxDepth,
      maxTotalEdges: maxEdges,
      edgeCapHit: false,
      depthCapHit: false,
      maxObservedDepth: 0,
      nodeDepthCounts: {},
      edgeSourceDepthCounts: {},
      unexpandedBoundaryNodes: []
    }
  };
}

function createCallGraphTruncation(
  maxDepth: number,
  maxEdges: number,
  nodeDepths: Map<string, number>,
  edgeSourceDepths: number[],
  unexpandedBoundaryNodes: string[],
  edgeCapHit: boolean
): JavaEndpointAnalysisReport["callGraph"]["truncation"] {
  const nodeDepthCounts = countDepths([...nodeDepths.values()]);
  const edgeSourceDepthCounts = countDepths(edgeSourceDepths);
  return {
    maxDepth,
    maxTotalEdges: maxEdges,
    edgeCapHit,
    depthCapHit: unexpandedBoundaryNodes.length > 0,
    maxObservedDepth: Math.max(...nodeDepths.values(), 0),
    nodeDepthCounts,
    edgeSourceDepthCounts,
    unexpandedBoundaryNodes: [...new Set(unexpandedBoundaryNodes)]
  };
}

function countDepths(depths: number[]): Record<string, number> {
  return depths.reduce<Record<string, number>>((counts, depth) => {
    const key = String(depth);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function truncationSummary(truncation: JavaEndpointAnalysisReport["callGraph"]["truncation"]): string {
  const reasons = [
    truncation.edgeCapHit ? "edge-cap" : undefined,
    truncation.depthCapHit ? "depth-cap" : undefined
  ].filter((reason): reason is string => Boolean(reason));
  return reasons.length > 0 ? reasons.join(", ") : "none";
}

function formatDepthCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length > 0 ? entries.map(([depth, count]) => `d${depth}=${count}`).join(", ") : "none";
}

function extractMethodCalls(project: JavaProjectModel, method: JavaMethodInfo, type: JavaTypeInfo): Array<{
  receiver?: string;
  method: string;
  expression: string;
  line: number;
  argumentCount: number;
  argumentTypes: string[];
  feature?: "lambda" | "method-reference";
}> {
  const calls: Array<{ receiver?: string; method: string; expression: string; line: number; argumentCount: number; argumentTypes: string[]; feature?: "lambda" | "method-reference" }> = [];
  const injectedFields = new Set(type.fields.map((field) => field.name));
  const variableTypes = new Map(method.params.map((param) => [param.name, param.typeName]));
  const lines = method.body.split(/\r?\n/);
  for (const [offset, rawLine] of lines.entries()) {
    let line = stripLineComment(rawLine);
    if (offset === 0 && line.includes("{")) line = line.slice(line.indexOf("{") + 1);
    const lineNumber = method.bodyStartLine + offset;
    const local = line.match(/\b([A-Z][A-Za-z0-9_.$<>?,\[\]]*)\s+([a-zA-Z_][A-Za-z0-9_]*)\s*(?:=|;)/);
    if (local) variableTypes.set(local[2], simpleTypeName(local[1]));
    for (const reference of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)/g)) {
      calls.push({ receiver: reference[1], method: reference[2], expression: reference[0], line: lineNumber, argumentCount: -1, argumentTypes: [], feature: "method-reference" });
    }
    if (line.includes("->")) calls.push({ receiver: "$lambda", method: "invoke", expression: "lambda ->", line: lineNumber, argumentCount: -1, argumentTypes: [], feature: "lambda" });
    const qualifiedPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    for (const match of line.matchAll(qualifiedPattern)) {
      if (!injectedFields.has(match[1]) && isLowValueCall(match[2])) {
        continue;
      }
      const parsedArgs = extractCallArguments(line, (match.index ?? 0) + match[0].lastIndexOf("("));
      calls.push({
        receiver: match[1],
        method: match[2],
        expression: match[0],
        line: lineNumber,
        argumentCount: parsedArgs.complete ? parsedArgs.args.length : -1,
        argumentTypes: parsedArgs.args.map((argument) => inferArgumentType(argument, variableTypes))
      });
    }
    const selfPattern = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    for (const match of line.matchAll(selfPattern)) {
      const methodName = match[1];
      if (JAVA_KEYWORD_CALLS.has(methodName) || calls.some((call) => call.line === lineNumber && call.method === methodName)) {
        continue;
      }
      if (!methodsInHierarchy(project, type).some((candidate) => candidate.method.name === methodName)) {
        continue;
      }
      const parsedArgs = extractCallArguments(line, (match.index ?? 0) + match[0].lastIndexOf("("));
      calls.push({
        method: methodName,
        expression: `${methodName}(`,
        line: lineNumber,
        argumentCount: parsedArgs.complete ? parsedArgs.args.length : -1,
        argumentTypes: parsedArgs.args.map((argument) => inferArgumentType(argument, variableTypes))
      });
    }
  }
  return calls;
}

const LOW_VALUE_CALLS = new Set([
  "add",
  "addAll",
  "clear",
  "collect",
  "compareTo",
  "contains",
  "containsKey",
  "distinct",
  "entrySet",
  "equals",
  "filter",
  "forEach",
  "get",
  "hashCode",
  "hasNext",
  "isEmpty",
  "isPresent",
  "iterator",
  "keySet",
  "limit",
  "map",
  "next",
  "orElse",
  "parallelStream",
  "peek",
  "put",
  "putAll",
  "remove",
  "size",
  "skip",
  "sorted",
  "stream",
  "toString",
  "values"
]);

function isLowValueCall(methodName: string): boolean {
  return LOW_VALUE_CALLS.has(methodName) || /^(get|set|is)[A-Z]/.test(methodName);
}

function resolveCallTargets(
  project: JavaProjectModel,
  currentType: JavaTypeInfo,
  call: { receiver?: string; method: string; argumentCount: number; argumentTypes: string[]; feature?: "lambda" | "method-reference" }
): ResolvedJavaCall {
  if (!call.receiver || call.receiver === "this") {
    return selectOverload(methodsInHierarchy(project, currentType)
      .filter((item) => item.method.name === call.method)
      .map((item) => item), call);
  }

  if (call.receiver === "super") return selectOverload(parentTypes(project, currentType).flatMap((type) => type.methods.filter((method) => method.name === call.method).map((method) => ({ type, method }))), call);
  if (call.receiver === "$lambda") return { targets: [], resolution: "external", candidates: [] };

  const field = [currentType, ...parentTypes(project, currentType)].flatMap((type) => type.fields).find((candidate) => candidate.name === call.receiver);
  if (!field) {
    return { targets: [], resolution: "external", candidates: [] };
  }
  const candidateTypes = resolveTypesForField(project, field.typeName);
  if (!candidateTypes.length) return { targets: [], resolution: "external", candidates: [] };
  const targets: Array<{ type: JavaTypeInfo; method: JavaMethodInfo }> = [];
  for (const candidateType of candidateTypes) {
    let implementationTypes = candidateType.kind === "interface"
      ? [candidateType, ...(project.implementationsByInterface.get(candidateType.name) ?? [])]
      : [candidateType];
    const qualifier = field.annotations.join(" ").match(/@Qualifier\s*\(\s*["']([^"']+)["']\s*\)/)?.[1];
    if (qualifier) implementationTypes = implementationTypes.filter((type) => type.name.toLowerCase() === qualifier.toLowerCase() || lowerCamel(type.name.replace(/Impl$/, "")) === qualifier);
    for (const implementationType of implementationTypes) {
      for (const method of implementationType.methods.filter((candidate) => candidate.name === call.method && (implementationType.kind !== "interface" || candidate.hasBody))) {
        targets.push({ type: implementationType, method });
      }
    }
  }
  return selectOverload(targets.filter((target, index, all) => all.findIndex((other) => methodId(other.type, other.method) === methodId(target.type, target.method)) === index), call);
}

interface ResolvedJavaCall {
  targets: Array<{ type: JavaTypeInfo; method: JavaMethodInfo }>;
  resolution: "resolved" | "ambiguous" | "external" | "unresolved";
  candidates: Array<{ methodId: string; signature: string; score: number }>;
}

function selectOverload(
  candidates: Array<{ type: JavaTypeInfo; method: JavaMethodInfo }>,
  call: { argumentCount: number; argumentTypes: string[] }
): ResolvedJavaCall {
  const matchingArity = call.argumentCount < 0 ? candidates : candidates.filter((candidate) => candidate.method.params.length === call.argumentCount);
  if (!matchingArity.length) return { targets: [], resolution: "unresolved", candidates: candidates.map((candidate) => ({ methodId: methodId(candidate.type, candidate.method), signature: candidate.method.signature, score: -100 })) };
  const scored = matchingArity.map((candidate) => ({ candidate, score: overloadScore(candidate.method.params, call.argumentTypes) }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore).map((item) => item.candidate);
  const evidence = scored.map((item) => ({ methodId: methodId(item.candidate.type, item.candidate.method), signature: item.candidate.method.signature, score: item.score })).sort((a, b) => b.score - a.score || a.methodId.localeCompare(b.methodId));
  return best.length === 1 ? { targets: best, resolution: "resolved", candidates: evidence } : { targets: [], resolution: "ambiguous", candidates: evidence };
}

function parentTypes(project: JavaProjectModel, type: JavaTypeInfo, visited = new Set<string>()): JavaTypeInfo[] {
  const result: JavaTypeInfo[] = [];
  for (const name of type.extends) {
    if (visited.has(name)) continue;
    visited.add(name);
    for (const parent of project.typesByName.get(simpleTypeName(name)) ?? []) {
      result.push(parent, ...parentTypes(project, parent, visited));
    }
  }
  return result;
}

function methodsInHierarchy(project: JavaProjectModel, type: JavaTypeInfo): Array<{ type: JavaTypeInfo; method: JavaMethodInfo }> {
  return [type, ...parentTypes(project, type)].flatMap((owner) => owner.methods.map((method) => ({ type: owner, method })));
}

function lowerCamel(value: string): string { return value ? value[0].toLowerCase() + value.slice(1) : value; }

function overloadScore(params: JavaParamInfo[], argumentTypes: string[]): number {
  return params.reduce((score, param, index) => {
    const actual = simpleTypeName(argumentTypes[index] ?? "unknown");
    const expected = simpleTypeName(param.typeName);
    if (actual === "unknown" || actual === "null") return score + 1;
    if (actual === expected) return score + 5;
    if (primitiveWrapper(actual) === primitiveWrapper(expected)) return score + 4;
    if (expected === "Object" || expected === "Number" && /^(Byte|Short|Integer|Long|Float|Double)$/.test(actual)) return score + 2;
    return score - 5;
  }, 0);
}

function primitiveWrapper(value: string): string {
  return ({ int: "Integer", long: "Long", boolean: "Boolean", double: "Double", float: "Float", short: "Short", byte: "Byte", char: "Character" } as Record<string, string>)[value] ?? value;
}

function extractCallArguments(line: string, openIndex: number): { args: string[]; complete: boolean } {
  if (openIndex < 0 || line[openIndex] !== "(") return { args: [], complete: false };
  let depth = 0;
  let quote = "";
  let current = "";
  const args: string[] = [];
  for (let index = openIndex + 1; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      current += char;
      if (char === quote && line[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; current += char; continue; }
    if (char === "(") { depth += 1; current += char; continue; }
    if (char === ")" && depth > 0) { depth -= 1; current += char; continue; }
    if (char === ")" && depth === 0) { if (current.trim()) args.push(current.trim()); return { args, complete: true }; }
    if (char === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += char;
  }
  return { args: current.trim() ? [current.trim()] : [], complete: false };
}

function inferArgumentType(value: string, variableTypes: Map<string, string>): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  if (/^"[\s\S]*"$/.test(trimmed)) return "String";
  if (/^'[\s\S]'$/.test(trimmed)) return "char";
  if (/^(true|false)$/.test(trimmed)) return "boolean";
  if (/^-?\d+[lL]$/.test(trimmed)) return "long";
  if (/^-?\d+$/.test(trimmed)) return "int";
  if (/^-?\d+\.\d+[fF]$/.test(trimmed)) return "float";
  if (/^-?\d+\.\d+$/.test(trimmed)) return "double";
  if (trimmed === "null") return "null";
  const created = trimmed.match(/^new\s+([A-Za-z_][A-Za-z0-9_.$<>]*)/);
  if (created) return simpleTypeName(created[1]);
  return variableTypes.get(trimmed) ?? "unknown";
}

function resolveTypesForField(project: JavaProjectModel, typeName: string): JavaTypeInfo[] {
  return project.typesByName.get(simpleTypeName(typeName)) ?? project.typesByName.get(typeName) ?? [];
}

function nodeFor(
  type: JavaTypeInfo,
  method: JavaMethodInfo,
  route?: JavaEndpointRouteCandidate
): JavaEndpointCallGraphNode {
  return {
    id: methodId(type, method),
    kind: nodeKind(type, route),
    role: inferTypeRole(type, route),
    className: type.name,
    methodName: method.name,
    file: type.file,
    line: method.line,
    signature: `${method.annotations.join(" ")} ${method.signature}`.trim(),
    route: route ? { method: route.method, path: route.path } : undefined
  };
}

function inferTypeRole(type: JavaTypeInfo, route?: JavaEndpointRouteCandidate): JavaTypeRole {
  const text = `${type.qualifiedName} ${type.annotations.join(" ")}`;
  if (route?.entryKind !== "service" && (route || /Controller$|@(?:RestController|Controller)\b/.test(text))) return "controller";
  if (/ApplicationService(?:Impl)?$/.test(type.name) || /\.application\./i.test(text)) return "application-service";
  if (/DomainService(?:Impl)?$/.test(type.name) || /\.domain\./i.test(text)) return "domain-service";
  if (/Repository|Dao/i.test(type.name)) return "repository";
  if (/Mapper$/.test(type.name)) return "mapper";
  if (/Assembler$|Converter$/.test(type.name)) return "assembler";
  if (/Pipeline$/.test(type.name)) return "pipeline";
  if (/Processor$|Handler$/.test(type.name)) return "processor";
  if (/Coordinator$|Manager$|Registry$/.test(type.name)) return "coordinator";
  if (/Adapter$/.test(type.name)) return "adapter";
  if (/Client$|Gateway$|Api$/.test(type.name)) return "infrastructure-client";
  if (/Policy$|Rule$|Validator$/.test(type.name)) return "policy";
  if (/Support$|Helper$|Utils?$/.test(type.name)) return "support";
  if (/@Service\b/.test(text) || /Service(?:Impl)?$/.test(type.name)) return "service";
  return "unknown";
}

function nodeKind(type: JavaTypeInfo, route?: JavaEndpointRouteCandidate): JavaEndpointCallGraphNode["kind"] {
  if (route?.entryKind !== "service" && (route || type.annotations.some((annotation) => /@(RestController|Controller)\b/.test(annotation)) || /Controller$/.test(type.name))) {
    return "controller";
  }
  if (/Mapper$/.test(type.name)) {
    return "mapper";
  }
  if (/(Repository|Dao)$/.test(type.name)) {
    return "repository";
  }
  if (type.annotations.some((annotation) => /@Service\b/.test(annotation)) || /(Service|ServiceImpl|ApplicationService|ApplicationServiceImpl|Assembler)$/.test(type.name)) {
    return "service";
  }
  if (/(DTO|ReqVO|RespVO|VO)$/.test(type.name)) {
    return "dto";
  }
  return "unknown";
}

function resolveRequestModel(project: JavaProjectModel, route: JavaEndpointRouteCandidate): JavaEndpointAnalysisReport["requestModel"] | undefined {
  const type = findType(project, route.className, route.file);
  const method = type?.methods.find((candidate) => candidate.name === route.methodName && candidate.line === route.line);
  const requestParam = method?.params.find((param) => /(Req|Request|VO|DTO)$/.test(param.typeName)) ?? method?.params[0];
  if (!requestParam) {
    return undefined;
  }
  const requestType = resolveTypesForField(project, requestParam.typeName)[0];
  if (!requestType) {
    return {
      className: requestParam.typeName,
      file: "",
      fields: []
    };
  }
  return {
    className: requestType.name,
    file: requestType.file,
    fields: extractPlainFields(requestType)
  };
}

function detectRiskSignals(
  project: JavaProjectModel,
  routes: JavaEndpointRouteCandidate[],
  selectedRoute: JavaEndpointRouteCandidate | undefined,
  graph: JavaEndpointAnalysisReport["callGraph"],
  requestModel: JavaEndpointAnalysisReport["requestModel"] | undefined
): JavaEndpointRiskSignal[] {
  const signals: JavaEndpointRiskSignal[] = [];
  if (!selectedRoute) {
    signals.push({
      id: "endpoint-not-found",
      title: "Endpoint route not found",
      severity: "high",
      summary: "no Spring route candidate matched the requested endpoint",
      evidence: ["check class-level @RequestMapping and method-level mapping expressions"]
    });
    return signals;
  }

  const batchCommandEndpoint = isBatchCommandEndpoint(selectedRoute.method, selectedRoute.path, selectedRoute, requestModel);
  const exactDuplicates = routes.filter((route) => route.path === selectedRoute.path && route.method === selectedRoute.method);
  if (exactDuplicates.length > 1) {
    signals.push({
      id: "duplicate-route-candidates",
      title: "Duplicate route candidates",
      severity: "medium",
      summary: `${exactDuplicates.length} Spring route candidate(s) share this endpoint`,
      evidence: exactDuplicates.map((route) => `${route.className}.${route.methodName} ${route.file}:${route.line}`)
    });
  }

  const graphText = reachableMethodText(project, graph);
  const contextHits = CONTEXT_SIGNALS.filter((signal) => graphText.includes(signal));
  if (contextHits.length > 0) {
    signals.push({
      id: "implicit-runtime-context",
      title: "Implicit runtime context",
      severity: "high",
      summary: "reachable code reads framework/thread-local context that must be captured explicitly for cross-runtime replay",
      evidence: contextHits
    });
  }

  const sideEffectHits = SIDE_EFFECT_SIGNALS.filter((signal) => graphText.includes(signal));
  if (sideEffectHits.length > 0) {
    signals.push({
      id: "query-side-effects",
      title: "Endpoint side effects",
      severity: "high",
      summary: "reachable code appears to update sync state, locks, preferences, progress, or undo data during endpoint handling",
      evidence: sideEffectHits
    });
  }

  if (!batchCommandEndpoint && (requestModel?.fields.includes("operator") || graphText.includes("getOperator")) && !/OperatorEnum\.REFRESH|tryLock|syncBeforePage/.test(graphText)) {
    signals.push({
      id: "refresh-operator-unresolved",
      title: "REFRESH operator semantics unresolved",
      severity: "high",
      summary: "request carries operator semantics but reachable call graph did not expose equivalent REFRESH locking/sync handling",
      evidence: ["operator request field or getOperator() detected", "no reachable OperatorEnum.REFRESH / tryLock / syncBeforePage handling"]
    });
  }

  const dynamicSqlHits = DYNAMIC_SQL_SIGNALS.filter((signal) => graphText.includes(signal));
  if (dynamicSqlHits.length > 0) {
    signals.push({
      id: "dynamic-query-execution",
      title: "Dynamic query execution",
      severity: "medium",
      summary: "reachable code builds or executes dynamic SQL, so golden cases must compare SQL-sensitive dimensions",
      evidence: dynamicSqlHits
    });
  }

  const fields = new Set(requestModel?.fields ?? []);
  const legacyFields = [
    "qualityValues",
    "textFilterValue",
    "horizontalValues",
    "horizontalKeyValues",
    "horizontalDataPageTreeReqVOs",
    "fieldId"
  ].filter((field) => fields.has(field));
  if (legacyFields.length > 0) {
    signals.push({
      id: "legacy-request-fields",
      title: "Legacy request fields need compatibility coverage",
      severity: "medium",
      summary: "request model exposes legacy/shape-changing fields that should be covered before extracting a high-performance runtime boundary",
      evidence: legacyFields
    });
  }

  const similarRoutes = routes.filter((route) => route !== selectedRoute
    && route.method === selectedRoute.method
    && (route.path.endsWith(selectedRoute.path) || selectedRoute.path.endsWith(route.path)));
  if (similarRoutes.length > 0) {
    signals.push({
      id: "parallel-entrypoints",
      title: "Parallel endpoint entrypoints",
      severity: "medium",
      summary: "similar Spring mappings exist and may represent Web/RPC or compatibility entrypoints",
      evidence: similarRoutes.map((route) => `${route.method} ${route.path} -> ${route.className}.${route.methodName}`)
    });
  }

  if (graph.nodes.length >= 20 || graph.edges.length >= 30) {
    signals.push({
      id: "large-call-graph",
      title: "Large call graph",
      severity: "medium",
      summary: "endpoint spans a broad dependency graph; split orchestration from pure execution or command planning before runtime extraction",
      evidence: [`nodes=${graph.nodes.length}`, `edges=${graph.edges.length}`]
    });
  }

  return signals;
}

function createJavaEndpointGoldenCasePlan(
  method: JavaEndpointHttpMethod,
  endpointPath: string,
  selectedRoute: JavaEndpointRouteCandidate | undefined,
  requestModel: JavaEndpointAnalysisReport["requestModel"] | undefined,
  riskSignals: JavaEndpointRiskSignal[]
): JavaEndpointGoldenCasePlan {
  if (isSyncCommandEndpoint(method, endpointPath, selectedRoute, requestModel)) {
    return createSyncCommandGoldenCasePlan(method, endpointPath);
  }
  if (isBatchCommandEndpoint(method, endpointPath, selectedRoute, requestModel)) {
    return createBatchCommandGoldenCasePlan(method, endpointPath);
  }

  const fields = new Set(requestModel?.fields ?? []);
  const riskIds = new Set(riskSignals.map((risk) => risk.id));
  const cases: JavaEndpointGoldenCase[] = [
    goldenCase("standard-page", "Standard first-page query", ["pageNo", "pageSize", "usePageId", "panelId", "interId"], "baseline request/response shape for the endpoint")
  ];
  if (fields.has("operator") || riskIds.has("refresh-operator-unresolved") || riskIds.has("query-side-effects")) {
    cases.push(goldenCase("refresh-operator", "REFRESH operator query", ["operator=REFRESH", "pageId", "panelId"], "guards lock/sync semantics and side-effect boundaries"));
  }
  if (fields.has("dataId") || fields.has("childFormFieldId")) {
    cases.push(goldenCase("child-form-page", "Child-form scoped page query", ["dataId", "childFormFieldId", "headerValues"], "guards backend-computed parent/child filter behavior"));
  }
  if (fields.has("horizontalValues") || fields.has("horizontalKeyValues") || fields.has("horizontalDataPageTreeReqVOs")) {
    cases.push(goldenCase("horizontal-page", "Horizontal or pivoted page query", ["horizontalValues", "horizontalKeyValues", "horizontalDataPageTreeReqVOs"], "guards row-to-column view semantics"));
  }
  if (fields.has("qualityValues") || fields.has("textFilterValue")) {
    cases.push(goldenCase("quality-text-filter", "Quality/text filter page query", ["qualityValues", "textFilterValue", "headerValues"], "guards legacy filter fields that may not be represented by normal header filters"));
  }
  if (fields.has("uploadTmpTableName") || fields.has("uploadTmpFlag")) {
    cases.push(goldenCase("upload-preview-page", "Upload preview table query", ["uploadTmpTableName", "uploadTmpFlag", "postValues"], "guards temporary-table routing"));
  }
  if (riskIds.has("implicit-runtime-context")) {
    cases.push(goldenCase("tenant-auth-context", "Tenant/auth scoped page query", ["tenant header", "user identity", "role/dept permissions"], "guards hidden ThreadLocal/framework context capture"));
  }
  if (riskIds.has("parallel-entrypoints")) {
    cases.push(goldenCase("entrypoint-parity", "Web/RPC entrypoint parity", ["same body through each matching entrypoint"], "guards split behavior across compatibility endpoints"));
  }

  return {
    version: 1,
    model: "page-query",
    endpoint: { method, path: endpointPath },
    cases,
    fixtureTemplate: {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tenant-id": "<tenant-id>",
        authorization: "Bearer <token>"
      },
      body: {
        reqId: "<case-id>",
        pageNo: 1,
        pageSize: 100,
        usePageId: "<usePageId>",
        pageId: "<pageId>",
        panelId: "<panelId>",
        interId: "<interId>",
        headerValues: {},
        postValues: {},
        selectValues: {},
        orderValues: []
      }
    },
    comparisonDimensions: [
      "HTTP status and error code",
      "defRespKey and respData keys",
      "total, pageNo, and row count",
      "row id ordering and sorted page membership",
      "system fields and permission-filtered fields",
      "null/empty value shape",
      "side-effect evidence for refresh/sync paths"
    ]
  };
}

function createSyncCommandGoldenCasePlan(
  method: JavaEndpointHttpMethod,
  endpointPath: string
): JavaEndpointGoldenCasePlan {
  const cases = [
    goldenCase(
      "manual-refresh-success",
      "Manual REFRESH runs full sync",
      ["operator=REFRESH", "panelId", "usePageId", "pageId", "pageNo", "pageSize"],
      "guards the user-triggered full refresh branch before moving the compute-heavy sync kernel",
      ["status", "boolean result", "forceFull=true", "updated sync timestamp", "progress terminal frame"]
    ),
    goldenCase(
      "auto-refresh-incremental",
      "Automatic refresh runs incremental sync",
      ["operator omitted or non-REFRESH", "panelId", "pageId", "usePageId"],
      "guards the non-manual branch that should keep incremental semantics and avoid frontend reload loops",
      ["status", "boolean result", "forceFull=false", "should-sync decision", "refreshRequired=false"]
    ),
    goldenCase(
      "missing-id-resolution",
      "pageId/usePageId resolution and missing-key behavior",
      ["only pageId", "only usePageId", "missing panelId/usePageId/pageId"],
      "guards fallback id lookup and skip/failure semantics at the Java orchestration boundary",
      ["resolved pageId", "resolved usePageId", "return value", "error or skip logs", "no unexpected writes"]
    ),
    goldenCase(
      "batch-inflight-skip",
      "Same-panel batch update in flight skips refresh",
      ["panelId with active BatchUpdateInFlightRegistry", "operator=REFRESH and auto operator"],
      "guards target-owned concurrency coordination with batchUpdate so replacement execution does not duplicate conflicting writes",
      ["return value", "no sync execution", "no progress stream", "no sync timestamp update", "no undo clear"]
    ),
    goldenCase(
      "duplicate-refresh-dedup",
      "Duplicate manual or automatic refresh is deduplicated",
      ["same panelId concurrent requests", "manualRefreshingPanels", "autoRefreshingPanels"],
      "guards single-JVM de-duplication semantics before replacing the inner execution engine",
      ["first request runs", "second request skips", "return values", "single progress stream", "single write set"]
    ),
    goldenCase(
      "progress-event-shape",
      "Refresh progress event shape",
      ["pageNo", "pageSize", "progressPageRequest", "operationKind=PANEL_REFRESH"],
      "guards the observable WebSocket/progress protocol that the target implementation must own",
      ["batch id", "operation kind", "page metrics", "processed/total rows", "refreshRequired", "terminal event"]
    ),
    goldenCase(
      "snapshot-context-only",
      "Page context only affects progress snapshot",
      ["headerValues", "postValues", "selectValues", "orderValues", "childFormFieldId", "uploadTmpTableName"],
      "guards that page query context changes pushed cells, not the true sync calculation scope",
      ["sync target rows", "snapshot rows", "cell patch payload", "ordering", "child/upload scoped snapshot"]
    ),
    goldenCase(
      "sync-boundary-timestamp",
      "Sync timestamp uses pre-sync boundary",
      ["writes occurring during refresh window", "updateDataAndSyncTimeByPanelId"],
      "guards the lost-update prevention contract around lastSyncTime updates",
      ["captured boundary time", "post-sync lastSyncTime", "next incremental candidates", "no missed writes"]
    ),
    goldenCase(
      "manual-post-side-effects",
      "Manual refresh post side effects",
      ["operator=REFRESH", "clearUndoOperation", "reconcileBillOnlyUnarchived"],
      "guards timestamp, undo, and reconcile side effects that must be target-owned or explicit infrastructure ports",
      ["undo stack cleared", "sync/data time updated", "bill-only color shadow rows", "business field values unchanged"]
    ),
    goldenCase(
      "column-field-ignored",
      "Panel refresh ignores targetFieldId",
      ["targetFieldId present on /refreshSync", "same request on /refreshSyncColumn as contrast"],
      "guards the shared request DTO nuance: panel refresh remains full-panel while column refresh has a separate route",
      ["refreshed field set", "target column not used for scoping", "response parity except scoped endpoint contrast"]
    )
  ];

  return {
    version: 1,
    model: "sync-command",
    endpoint: { method, path: endpointPath },
    cases,
    fixtureTemplate: {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tenant-id": "<tenant-id>",
        authorization: "Bearer <token>"
      },
      body: {
        operator: "REFRESH",
        panelId: "<panelId>",
        pageId: "<pageId>",
        usePageId: "<usePageId>",
        pageNo: 1,
        pageSize: 50,
        headerValues: {},
        postValues: {},
        selectValues: {},
        orderValues: [],
        dataId: "<dataId>",
        childFormFieldId: "<childFormFieldId>",
        showArchived: false,
        uploadTmpTableName: "<uploadTmpTableName>",
        uploadTmpFlag: 0,
        targetFieldId: "<ignored-by-refreshSync>"
      }
    },
    comparisonDimensions: [
      "HTTP status, error code, and boolean result",
      "manual versus automatic branch selection",
      "forceFull, refreshRequired, and operationKind values",
      "sync timestamp/data timestamp updates and pre-sync boundary behavior",
      "progress events, batch id, page metrics, terminal frames, and cell patch payloads",
      "persisted derived/ref/calculated field snapshots before and after refresh",
      "undo stack clearing and color shadow-table reconciliation side effects",
      "batch/manual/auto concurrency skip and de-duplication behavior",
      "tenant, user, datasource, and request context propagation"
    ]
  };
}

function createBatchCommandGoldenCasePlan(
  method: JavaEndpointHttpMethod,
  endpointPath: string
): JavaEndpointGoldenCasePlan {
  const cases = [
    goldenCase(
      "batch-update-success",
      "Normal batch update succeeds",
      ["batchPostValueList", "batchPkFieldValue", "usePageId", "panelId", "domain"],
      "baseline write fixture for row mutation, response shape, and persisted data parity",
      ["status", "error shape", "changed row count", "persisted rows", "response payload"]
    ),
    goldenCase(
      "batch-partial-failure",
      "Mixed valid and invalid rows return partial failure",
      ["batchPostValueList with valid and invalid rows", "precheck errors", "expectedTotalRows"],
      "guards row-level validation and failed-row reporting before extracting a pure batch planner",
      ["status", "failed rows", "error messages by row and field", "persisted valid rows", "unchanged invalid rows"]
    ),
    goldenCase(
      "batch-row-limit-rejected",
      "More than 10000 rows are rejected",
      ["batchPostValueList length > 10000", "batchHeaderValueList length > 10000"],
      "guards the Java controller limit contract before moving high-volume handling out of process",
      ["HTTP status", "error code", "error message", "no persisted rows", "no progress side effects"]
    ),
    goldenCase(
      "batch-insert-header-defaults",
      "Insert rows receive headerValues defaults",
      ["rows without id", "headerValues", "postValues"],
      "guards backend default propagation for inserted rows",
      ["inserted row count", "defaulted field values", "generated ids", "response rows", "persisted rows"]
    ),
    goldenCase(
      "horizontal-batch-upsert",
      "Horizontal batch upsert",
      ["horizontalId", "horizontalValues", "batchPostValueList", "batchHeaderValueList"],
      "guards pivot/horizontal table resolution and flattened row write semantics",
      ["horizontal table target", "upsert keys", "insert/update split", "persisted horizontal rows", "failed horizontal rows"]
    ),
    goldenCase(
      "chunked-paste-progress",
      "Chunked paste preserves progress totals",
      ["clientSessionId", "isLastChunk", "expectedTotalRows", "enableProgress"],
      "guards multi-chunk aggregation and progress lifecycle contracts",
      ["chunk order", "accepted row totals", "final row totals", "batch id", "progress completion"]
    ),
    goldenCase(
      "web-rpc-entrypoint-parity",
      "Web/RPC entrypoint parity",
      ["same normalized body through Web and RPC entrypoints", "tenant/user/context envelope"],
      "guards behavior split across controller and RPC compatibility entrypoints",
      ["normalized request", "response payload", "error shape", "persisted rows", "side-effect records"]
    ),
    goldenCase(
      "undo-excludes-failed-rows",
      "Undo snapshot excludes failed rows",
      ["undo=true", "mixed valid and failed rows", "operationKind", "operationLabel"],
      "guards undo recording after precheck filters invalid rows",
      ["undo record row ids", "undo pending state", "failed row exclusion", "valid row snapshot", "operation metadata"]
    ),
    goldenCase(
      "progress-event-shape",
      "Progress event shape",
      ["enableProgress=true", "clientSessionId", "reqId", "expectedTotalRows"],
      "guards the observable progress protocol that the target implementation must own",
      ["event names", "batch id", "processed count", "failed count", "total count", "terminal event"]
    )
  ];

  return {
    version: 1,
    model: "batch-command",
    endpoint: { method, path: endpointPath },
    cases,
    fixtureTemplate: {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-tenant-id": "<tenant-id>",
        authorization: "Bearer <token>"
      },
      body: {
        reqId: "<case-id>",
        domain: "<domain>",
        usePageId: "<usePageId>",
        pageId: "<pageId>",
        panelId: "<panelId>",
        interId: "<interId>",
        clientSessionId: "<client-session-id>",
        enableProgress: true,
        expectedTotalRows: 2,
        isLastChunk: true,
        undo: true,
        operationKind: "<operation-kind>",
        operationLabel: "<operation-label>",
        batchPkFieldValue: "<pk-field>",
        batchHeaderValueList: [],
        batchPostValueList: [],
        headerValues: {},
        postValues: {},
        qualityValues: {},
        horizontalId: "<horizontal-id>"
      }
    },
    comparisonDimensions: [
      "HTTP status and error code",
      "response payload and failed-row shape",
      "requested, valid, failed, inserted, and updated row counts",
      "persisted row snapshots before and after the command",
      "precheck errors by row and field",
      "undo records and failed-row exclusion",
      "progress events, batch id, clientSessionId, stage names, and totals",
      "Web/RPC normalized request and response parity",
      "tenant, user, datasource, and request context propagation"
    ]
  };
}

function isSyncCommandEndpoint(
  method: JavaEndpointHttpMethod,
  endpointPath: string,
  selectedRoute: JavaEndpointRouteCandidate | undefined,
  requestModel: JavaEndpointAnalysisReport["requestModel"] | undefined
): boolean {
  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return false;
  }
  const fields = new Set(requestModel?.fields ?? []);
  const fieldHits = [
    "operator",
    "panelId",
    "pageId",
    "usePageId",
    "targetFieldId",
    "pageNo",
    "pageSize"
  ].filter((field) => fields.has(field));
  const routeText = [
    endpointPath,
    selectedRoute?.className ?? "",
    selectedRoute?.methodName ?? "",
    requestModel?.className ?? ""
  ].join(" ");
  return /refreshSync|RefreshSync/i.test(routeText) && fieldHits.length >= 3;
}

function isBatchCommandEndpoint(
  method: JavaEndpointHttpMethod,
  endpointPath: string,
  selectedRoute: JavaEndpointRouteCandidate | undefined,
  requestModel: JavaEndpointAnalysisReport["requestModel"] | undefined
): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return false;
  }
  const fields = new Set(requestModel?.fields ?? []);
  const fieldHits = [
    "batchHeaderValueList",
    "batchPostValueList",
    "batchPkFieldValue",
    "clientSessionId",
    "enableProgress",
    "expectedTotalRows",
    "isLastChunk",
    "undo",
    "operationKind",
    "operationLabel"
  ].filter((field) => fields.has(field));
  const routeText = [
    endpointPath,
    selectedRoute?.className ?? "",
    selectedRoute?.methodName ?? "",
    requestModel?.className ?? ""
  ].join(" ");
  return fieldHits.length >= 2 || /\bbatch(?:Update|Create|Delete|Save|Upsert)?\b|batchUpdate|WithProgress|BatchReqVO/i.test(routeText);
}

function goldenCase(
  id: string,
  title: string,
  requestFocus: string[],
  reason: string,
  expectedComparison?: string[]
): JavaEndpointGoldenCase {
  return {
    id,
    title,
    requestFocus,
    expectedComparison: expectedComparison ?? [
      "status",
      "error shape",
      "total",
      "data rows",
      "ordering",
      "system fields"
    ],
    reason,
    status: "draft"
  };
}

function recommendedNextActions(
  riskSignals: JavaEndpointRiskSignal[],
  selectedRoute: JavaEndpointRouteCandidate | undefined,
  goldenCasePlan: JavaEndpointGoldenCasePlan
): string[] {
  if (!selectedRoute) {
    return ["Add or fix Java route detection for the requested Spring endpoint before planning runtime extraction."];
  }
  const ids = new Set(riskSignals.map((risk) => risk.id));
  if (goldenCasePlan.model === "batch-command") {
    const actions = [
      "Capture the batch-command golden fixtures before choosing any Java-to-Rust boundary.",
      "Make tenant, user, datasource, request, progress, and undo context explicit in the command envelope.",
      "Map all orchestration, progress, context, undo, and reconciliation behavior to target ownership or declared infrastructure ports."
    ];
    if (ids.has("parallel-entrypoints")) {
      actions.unshift("Run Web/RPC entrypoint parity golden cases before moving shared batch behavior.");
    }
    if (ids.has("query-side-effects")) {
      actions.unshift("Keep progress, undo, registry, and persistence side effects in Java until their golden evidence is stable.");
    }
    if (ids.has("implicit-runtime-context")) {
      actions.unshift("Replace ThreadLocal/framework context reads with explicit fixture fields before cross-runtime replay.");
    }
    return actions;
  }
  if (goldenCasePlan.model === "sync-command") {
    const actions = [
      "Capture the sync-command golden fixtures before extracting the refresh calculation kernel.",
      "Keep routing, context capture, progress publishing, de-duplication, timestamp updates, undo clearing, and reconcile side effects in Java first.",
      "Define a Rust boundary around pure refresh planning/calculation: changed row discovery, derived-field recomputation, and cell patch/result generation."
    ];
    if (ids.has("query-side-effects")) {
      actions.unshift("Make post-refresh side effects explicit and prove them with golden evidence before moving computation out of process.");
    }
    if (ids.has("implicit-runtime-context")) {
      actions.unshift("Replace ThreadLocal/framework context reads with explicit fixture fields before cross-runtime replay.");
    }
    return actions;
  }
  const actions = [
    "Capture one golden request/response fixture for standard pagination before changing the endpoint.",
    "Store explicit tenant/user/device/context headers alongside every golden fixture.",
    "Use this call graph to prove complete target ownership before considering source-off readiness."
  ];
  if (ids.has("refresh-operator-unresolved") || ids.has("query-side-effects")) {
    actions.unshift("Map REFRESH/sync/pageSize/undo side effects to target-owned behavior or declared infrastructure ports.");
  }
  if (ids.has("legacy-request-fields")) {
    actions.unshift("Confirm every legacy request field is either mapped into the new query protocol or intentionally unsupported with a golden test.");
  }
  if (ids.has("parallel-entrypoints")) {
    actions.unshift("Unify Web/RPC entrypoint routing or add an entrypoint-parity golden case before runtime split work.");
  }
  return actions;
}

function reachableMethodText(project: JavaProjectModel, graph: JavaEndpointAnalysisReport["callGraph"]): string {
  const parts: string[] = [];
  for (const node of graph.nodes) {
    const type = findType(project, node.className, node.file);
    const method = type?.methods.find((candidate) => candidate.name === node.methodName && candidate.line === node.line);
    if (method) {
      parts.push(method.signature, method.body);
    }
  }
  return parts.join("\n");
}

function findType(project: JavaProjectModel, className: string, file?: string): JavaTypeInfo | undefined {
  const candidates = project.typesByName.get(className) ?? [];
  if (file) {
    return candidates.find((type) => type.file === file) ?? candidates[0];
  }
  return candidates[0];
}

function extractPlainFields(type: JavaTypeInfo): string[] {
  return [...new Set(type.plainFields.map((field) => field.name))].sort();
}

function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => match.split(/\r?\n/).map(() => "").join("\n"));
}

function stripLineComment(line: string): string {
  const index = line.indexOf("//");
  return index >= 0 ? line.slice(0, index) : line;
}

function collectLeadingAnnotations(lines: string[], index: number): string[] {
  const annotations: string[] = [];
  for (let cursor = index - 1; cursor >= 0;) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) {
      break;
    }
    if (trimmed.startsWith("@")) {
      annotations.unshift(trimmed);
      cursor -= 1;
      continue;
    }
    const block = collectMultilineAnnotationBlock(lines, cursor);
    if (!block) {
      break;
    }
    annotations.unshift(block.annotation);
    cursor = block.startLine - 1;
  }
  return annotations;
}

function collectMultilineAnnotationBlock(
  lines: string[],
  endLine: number
): { annotation: string; startLine: number } | undefined {
  const parts: string[] = [];
  for (let cursor = endLine; cursor >= 0; cursor -= 1) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) {
      return undefined;
    }
    parts.unshift(trimmed);
    if (trimmed.startsWith("@")) {
      return {
        annotation: parts.join(" ").replace(/\s+/g, " "),
        startLine: cursor
      };
    }
  }
  return undefined;
}

function findBraceRange(lines: string[], startLine: number): { start: number; end: number } {
  let depth = 0;
  let started = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index]);
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth === 0) {
          return { start: startLine, end: index };
        }
      }
    }
  }
  return { start: startLine, end: lines.length - 1 };
}

function parseImplements(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((part) => simpleTypeName(part.trim())).filter(Boolean);
}

function parseParams(value: string): JavaParamInfo[] {
  return splitJavaArgs(value).map((rawParam) => {
    const clean = rawParam
      .replace(/@\w+(?:\([^)]*\))?\s*/g, "")
      .replace(/\bfinal\s+/g, "")
      .trim();
    if (!clean) {
      return undefined;
    }
    const parts = clean.split(/\s+/);
    if (parts.length < 2) {
      return undefined;
    }
    const name = parts[parts.length - 1].replace(/\[\]$/, "");
    const typeName = simpleTypeName(parts.slice(0, -1).join(" "));
    return { name, typeName };
  }).filter((param): param is JavaParamInfo => Boolean(param));
}

function splitJavaArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of value) {
    if (char === "<" || char === "(" || char === "[") depth += 1;
    if (char === ">" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current);
  }
  return args;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function simpleTypeName(typeName: string): string {
  return typeName
    .replace(/\s+/g, " ")
    .replace(/<.*>/g, "")
    .replace(/\[\]/g, "")
    .split(".")
    .pop()
    ?.trim() ?? typeName.trim();
}

function normalizeHttpMethod(method: string): JavaEndpointHttpMethod {
  const normalized = method.toUpperCase() as JavaEndpointHttpMethod;
  return HTTP_METHODS.has(normalized) ? normalized : "ALL";
}

function normalizeRoutePath(routePath: string): string {
  const clean = routePath.trim().replace(/\\/g, "/");
  if (!clean || clean === "/") {
    return "/";
  }
  return clean.startsWith("/") ? clean.replace(/\/{2,}/g, "/") : `/${clean}`.replace(/\/{2,}/g, "/");
}

function joinRoutes(prefix: string | undefined, suffix: string | undefined): string {
  const cleanPrefix = prefix && prefix !== "/" ? normalizeRoutePath(prefix).replace(/\/$/, "") : "";
  const cleanSuffix = suffix && suffix !== "/" ? normalizeRoutePath(suffix) : "";
  return normalizeRoutePath(`${cleanPrefix}${cleanSuffix || "/"}`);
}

function routeMethodMatches(candidate: JavaEndpointHttpMethod, expected: JavaEndpointHttpMethod): boolean {
  return candidate === "ALL" || expected === "ALL" || candidate === expected;
}

function routeMatchesExactly(route: JavaEndpointRouteCandidate, method: JavaEndpointHttpMethod, endpointPath: string): boolean {
  return routeMethodMatches(route.method, method) && route.path === endpointPath;
}

function methodId(type: JavaTypeInfo, method: JavaMethodInfo): string {
  return `${type.qualifiedName}.${method.name}:${method.line}`;
}

function endpointSlug(method: string, endpointPath: string): string {
  const pathSlug = endpointPath.replace(/^\/+/, "").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/-+/g, "-") || "root";
  return `${method.toLowerCase()}-${pathSlug}`;
}
