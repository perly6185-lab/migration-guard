import path from "node:path";
import { promises as fs } from "node:fs";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface GatewayRustAssessmentOptions {
  root: string;
  includeTests?: boolean;
  configSnapshots?: string[];
}

export type GatewayRouteStreamKind = "http" | "sse-candidate" | "websocket" | "long-running";
export type GatewayFilterKind = "web-filter" | "global-filter";

export interface GatewayHeaderOperation {
  header: string;
  action: "read" | "remove" | "append" | "replace" | "capture-all";
  provenance: "client" | "sanitized" | "validated" | "client-derived" | "constant" | "unknown";
  file: string;
  line: number;
  via?: string;
}

export interface GatewayContinuationContract {
  calls: number;
  maxCallsInReturnExpression: number;
  terminalReturns: number;
  status: "once-or-terminal" | "violated" | "unproven";
  evidenceLines: number[];
}

export interface GatewayStreamEffect {
  requestBodyAggregation: boolean;
  requestAggregationCondition?: string;
  responseBodyAggregation: boolean;
  responseAggregationCondition?: string;
  completionHook: boolean;
}

export interface GatewayFilterContract {
  className: string;
  file: string;
  line: number;
  kind: GatewayFilterKind;
  order: number;
  orderExpression: string;
  orderCertainty: "exact" | "framework-constant" | "default";
  continuation: GatewayContinuationContract;
  headerOperations: GatewayHeaderOperation[];
  streamEffect: GatewayStreamEffect;
  findings: string[];
}

export interface GatewayRouteContract {
  id: string;
  file: string;
  line: number;
  uri: string;
  scheme: string;
  serviceId: string;
  predicates: string[];
  filters: string[];
  pathPatterns: string[];
  metadata: Record<string, string>;
  streamKind: GatewayRouteStreamKind;
  filterChain: string[];
  headerChain: GatewayHeaderOperation[];
  streamContract: {
    requestBodyAggregation: boolean;
    requestAggregationCondition?: string;
    responseBodyAggregation: boolean;
    responseAggregationCondition?: string;
    responseTimeoutMs?: number;
    grayLoadBalancerBypassed: boolean;
  };
  status: "ready" | "blocked";
  findings: string[];
}

export interface GatewayRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: GatewayRustAssessmentOptions;
  configFiles: string[];
  externalConfigImports: string[];
  externalConfigStatus: "not-declared" | "snapshot-supplied" | "unresolved";
  routeCount: number;
  filterCount: number;
  summary: {
    ready: number;
    blocked: number;
    schemes: Record<string, number>;
    streamKinds: Record<string, number>;
    filterKinds: Record<string, number>;
    findings: Record<string, number>;
    continuationViolations: number;
    sensitiveHeaderFindings: number;
    requestAggregatingFilters: number;
    responseAggregatingFilters: number;
  };
  filters: GatewayFilterContract[];
  routes: GatewayRouteContract[];
  reportHash: string;
}

interface ParsedGatewayRoute {
  id: string;
  file: string;
  line: number;
  uri: string;
  predicates: string[];
  filters: string[];
  metadata: Record<string, string>;
}

interface JavaMethodModel {
  className: string;
  methodName: string;
  file: string;
  line: number;
  params: string;
  body: string;
  bodyStart: number;
  constants: Map<string, string>;
}

interface JavaClassModel {
  className: string;
  file: string;
  line: number;
  header: string;
  body: string;
  constants: Map<string, string>;
  methods: JavaMethodModel[];
}

const ORDERED_HIGHEST_PRECEDENCE = -2147483648;
const ORDERED_LOWEST_PRECEDENCE = 2147483647;
const KNOWN_ORDER_EXPRESSIONS = new Map<string, number>([
  ["Ordered.HIGHEST_PRECEDENCE", ORDERED_HIGHEST_PRECEDENCE],
  ["Ordered.LOWEST_PRECEDENCE", ORDERED_LOWEST_PRECEDENCE],
  ["NettyWriteResponseFilter.WRITE_RESPONSE_FILTER_ORDER", -1],
  ["NettyWriteResponseFilter.WRITE_RESPONSE_FILTER_ORDER + 1", 0],
  ["ReactiveLoadBalancerClientFilter.LOAD_BALANCER_CLIENT_FILTER_ORDER", 10150]
]);
const FRAMEWORK_FILTER_ANCHORS = [
  { name: "NettyWriteResponseFilter", order: -1 },
  { name: "RouteToRequestUrlFilter", order: 10000 },
  { name: "ReactiveLoadBalancerClientFilter", order: 10150 },
  { name: "WebsocketRoutingFilter", order: 2147483646 },
  { name: "NettyRoutingFilter", order: 2147483647 }
] as const;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "tenant-id",
  "sop-tenant-id",
  "login-user",
  "col-source-tenant-id",
  "col-data-id",
  "col-use-page-id",
  "col-ency-str",
  "x-internal-api-key"
]);

export async function assessJavaGatewayForRust(
  options: GatewayRustAssessmentOptions
): Promise<GatewayRustAssessmentReport> {
  const root = path.resolve(options.root);
  const [sourceIdentity, projectFiles] = await Promise.all([
    captureAssessmentSourceIdentity(root),
    collectProjectFiles(root, Boolean(options.includeTests))
  ]);
  const snapshotPaths = (options.configSnapshots ?? []).map((item) => path.resolve(item));
  const configPaths = [...projectFiles.yaml, ...snapshotPaths];
  const configInputs = await Promise.all(configPaths.map(async (file) => ({
    file,
    content: await fs.readFile(file, "utf8")
  })));
  const routeLayers = configInputs.map((input) =>
    parseGatewayRoutes(root, input.file, input.content));
  const parsedRoutes = mergeGatewayRouteLayers(routeLayers);
  const externalConfigImports = unique(configInputs.flatMap((input) =>
    extractExternalConfigImports(input.content))).sort();
  const externalConfigStatus = externalConfigImports.length === 0
    ? "not-declared" as const
    : snapshotPaths.length > 0
      ? "snapshot-supplied" as const
      : "unresolved" as const;

  const javaInputs = await Promise.all(projectFiles.java.map(async (file) => ({
    file,
    content: await fs.readFile(file, "utf8")
  })));
  const classes = javaInputs.flatMap((input) => parseJavaClasses(root, input.file, input.content));
  const filters = extractGatewayFilters(classes);
  const orderedWebFilters = filters.filter((item) => item.kind === "web-filter")
    .sort(compareFilters);
  const orderedGlobalFilters = filters.filter((item) => item.kind === "global-filter")
    .sort(compareFilters);
  const duplicateRouteIds = new Set(routeLayers.flatMap((layer) =>
    [...duplicateValues(layer.map((route) => route.id))]));
  const sharedFilterFindings = unique(filters.flatMap((filter) => filter.findings)).sort();
  const sharedBlockingFindings = sharedFilterFindings.filter(isBlockingFinding);

  const routes = parsedRoutes.map((candidate): GatewayRouteContract => {
    const scheme = routeScheme(candidate.uri);
    const serviceId = routeServiceId(candidate.uri);
    const pathPatterns = candidate.predicates.flatMap((predicate) =>
      predicateName(predicate) === "Path" ? predicateArguments(predicate) : []);
    const streamKind = inferRouteStreamKind(candidate, pathPatterns);
    const responseTimeoutMs = numericMetadata(candidate.metadata, "response-timeout");
    const streamEffects = filters.map((item) => item.streamEffect);
    const findings = new Set(sharedBlockingFindings);
    if (externalConfigStatus === "unresolved") findings.add("GW-EFFECTIVE-CONFIG-EXTERNAL-UNRESOLVED");
    if (duplicateRouteIds.has(candidate.id)) findings.add(`GW-ROUTE-ID-DUPLICATE:${candidate.id}`);
    for (const finding of analyzeRouteConfiguredHeaders(candidate)) findings.add(finding);
    if (streamKind === "websocket" && scheme === "lb:ws") {
      findings.add("GW-STREAM-WEBSOCKET-GRAY-BYPASS");
    }
    if (streamKind === "sse-candidate" && responseTimeoutMs !== undefined) {
      findings.add("GW-STREAM-SSE-RESPONSE-TIMEOUT-CONFIGURED");
    }
    const responseAggregationCondition = filters
      .map((item) => item.streamEffect.responseAggregationCondition)
      .find((item): item is string => Boolean(item));
    const requestAggregationCondition = filters
      .map((item) => item.streamEffect.requestAggregationCondition)
      .find((item): item is string => Boolean(item));
    const routeFindings = [...findings].sort();
    return {
      id: candidate.id,
      file: candidate.file,
      line: candidate.line,
      uri: candidate.uri,
      scheme,
      serviceId,
      predicates: candidate.predicates,
      filters: candidate.filters,
      pathPatterns,
      metadata: candidate.metadata,
      streamKind,
      filterChain: createRouteFilterChain(orderedWebFilters, orderedGlobalFilters, candidate.filters),
      headerChain: filters.slice().sort(compareFilters).flatMap((item) => item.headerOperations),
      streamContract: {
        requestBodyAggregation: streamEffects.some((item) => item.requestBodyAggregation),
        ...(requestAggregationCondition ? { requestAggregationCondition } : {}),
        responseBodyAggregation: streamEffects.some((item) => item.responseBodyAggregation),
        ...(responseAggregationCondition ? { responseAggregationCondition } : {}),
        ...(responseTimeoutMs !== undefined ? { responseTimeoutMs } : {}),
        grayLoadBalancerBypassed: scheme === "lb:ws"
      },
      status: routeFindings.some(isBlockingFinding) ? "blocked" : "ready",
      findings: routeFindings
    };
  });
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root,
    sourceIdentity,
    assessmentScope: { ...options, root, configSnapshots: snapshotPaths },
    configFiles: configInputs.map((item) => relativePath(root, item.file)).sort(),
    externalConfigImports,
    externalConfigStatus,
    routeCount: routes.length,
    filterCount: filters.length,
    summary: {
      ready: routes.filter((route) => route.status === "ready").length,
      blocked: routes.filter((route) => route.status === "blocked").length,
      schemes: countValues(routes.map((route) => route.scheme)),
      streamKinds: countValues(routes.map((route) => route.streamKind)),
      filterKinds: countValues(filters.map((filter) => filter.kind)),
      findings: countValues(routes.flatMap((route) => route.findings)),
      continuationViolations: filters.filter((filter) => filter.continuation.status === "violated").length,
      sensitiveHeaderFindings: filters.reduce((total, filter) =>
        total + filter.findings.filter((finding) => finding.startsWith("GW-HEADER-")).length, 0),
      requestAggregatingFilters: filters.filter((filter) => filter.streamEffect.requestBodyAggregation).length,
      responseAggregatingFilters: filters.filter((filter) => filter.streamEffect.responseBodyAggregation).length
    },
    filters,
    routes
  };
  return {
    ...base,
    reportHash: sha256(stableStringify({ ...base, createdAt: undefined }))
  };
}

export function renderGatewayRustAssessment(report: GatewayRustAssessmentReport): string {
  return [
    "# Gateway Rust Assessment", "",
    `- Root: ${report.root}`,
    `- Routes: ${report.routeCount}`,
    `- Filters: ${report.filterCount}`,
    `- Ready: ${report.summary.ready}`,
    `- Blocked: ${report.summary.blocked}`,
    `- External config: ${report.externalConfigStatus}`,
    `- Continuation violations: ${report.summary.continuationViolations}`,
    `- Sensitive header findings: ${report.summary.sensitiveHeaderFindings}`,
    `- Request aggregating filters: ${report.summary.requestAggregatingFilters}`,
    `- Response aggregating filters: ${report.summary.responseAggregatingFilters}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Filter order", "",
    "| Layer | Filter | Order | Continuation | Header ops | Stream effects | Findings |",
    "| --- | --- | ---: | --- | ---: | --- | --- |",
    ...report.filters.slice().sort(compareFilters).map((filter) =>
      `| ${filter.kind} | ${filter.className} | ${filter.order} (${filter.orderExpression}) | ${filter.continuation.status} (${filter.continuation.calls}) | ${filter.headerOperations.length} | ${renderStreamEffect(filter.streamEffect)} | ${filter.findings.join(", ")} |`), "",
    "## Header identity chain", "",
    "| Filter | Header | Action | Provenance | Evidence | Via |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.filters.slice().sort(compareFilters).flatMap((filter) =>
      filter.headerOperations.map((operation) =>
        `| ${filter.className} | ${operation.header} | ${operation.action} | ${operation.provenance} | ${operation.file}:${operation.line} | ${operation.via ?? ""} |`)), "",
    "## Streaming contracts", "",
    "| Route | Kind | Request aggregation | Request condition | Response aggregation | Response condition | Timeout ms | Gray bypass |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    ...report.routes.filter((route) => route.streamKind !== "http").map((route) =>
      `| ${route.id} | ${route.streamKind} | ${route.streamContract.requestBodyAggregation} | ${route.streamContract.requestAggregationCondition ?? ""} | ${route.streamContract.responseBodyAggregation} | ${route.streamContract.responseAggregationCondition ?? ""} | ${route.streamContract.responseTimeoutMs ?? ""} | ${route.streamContract.grayLoadBalancerBypassed} |`), "",
    "## Common route-chain anchors", "",
    ...(report.routes[0]?.filterChain.filter((item) => !item.startsWith("route:")).map((item) => `- ${item}`) ?? ["- none"]), "",
    "## Findings", "",
    ...Object.entries(report.summary.findings)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([finding, count]) => `- ${finding}: ${count}`), "",
    "## Routes", "",
    "| Route | URI | Stream | Status | Paths | Findings |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.routes.map((route) =>
      `| ${route.id} | ${route.uri} | ${route.streamKind} | ${route.status} | ${route.pathPatterns.join(", ")} | ${route.findings.join(", ")} |`), "",
    "## External config imports", "",
    ...(report.externalConfigImports.length
      ? report.externalConfigImports.map((item) => `- ${item}`)
      : ["- none"])
  ].join("\n");
}

function parseGatewayRoutes(root: string, filePath: string, content: string): ParsedGatewayRoute[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const stack: Array<{ indent: number; key: string }> = [];
  const sections: Array<{ indent: number; start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const withoutComment = stripYamlComment(lines[index] ?? "");
    if (!withoutComment.trim() || withoutComment.trim() === "---") {
      if (withoutComment.trim() === "---") stack.length = 0;
      continue;
    }
    const indent = leadingSpaces(withoutComment);
    const trimmed = withoutComment.trim();
    const mapping = trimmed.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!mapping) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = mapping[1] as string;
    const parentPath = [...stack.map((item) => item.key), key];
    if (parentPath.slice(-4).join(".") === "spring.cloud.gateway.routes") {
      let end = lines.length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = stripYamlComment(lines[cursor] ?? "");
        if (!candidate.trim()) continue;
        if (candidate.trim() === "---" || leadingSpaces(candidate) <= indent) {
          end = cursor;
          break;
        }
      }
      sections.push({ indent, start: index + 1, end });
    }
    if (!mapping[2]?.trim()) stack.push({ indent, key });
  }
  const routes: ParsedGatewayRoute[] = [];
  for (const section of sections) {
    const starts: Array<{ index: number; indent: number; id: string }> = [];
    for (let index = section.start; index < section.end; index += 1) {
      const value = stripYamlComment(lines[index] ?? "");
      const match = value.trim().match(/^-\s+id:\s*(.+)$/);
      if (match && leadingSpaces(value) > section.indent) {
        starts.push({ index, indent: leadingSpaces(value), id: unquoteYaml(match[1] as string) });
      }
    }
    for (let offset = 0; offset < starts.length; offset += 1) {
      const start = starts[offset] as { index: number; indent: number; id: string };
      const end = starts[offset + 1]?.index ?? section.end;
      routes.push(parseGatewayRouteBlock(root, filePath, lines, start, end));
    }
  }
  return routes;
}

function mergeGatewayRouteLayers(layers: ParsedGatewayRoute[][]): ParsedGatewayRoute[] {
  const order: string[] = [];
  const routes = new Map<string, ParsedGatewayRoute>();
  for (const layer of layers) {
    for (const route of layer) {
      if (!routes.has(route.id)) order.push(route.id);
      routes.set(route.id, route);
    }
  }
  return order.flatMap((id) => {
    const route = routes.get(id);
    return route ? [route] : [];
  });
}

function parseGatewayRouteBlock(
  root: string,
  filePath: string,
  lines: string[],
  start: { index: number; indent: number; id: string },
  end: number
): ParsedGatewayRoute {
  let uri = "";
  let section: "predicates" | "filters" | "metadata" | undefined;
  let sectionIndent = -1;
  const predicates: string[] = [];
  const filters: string[] = [];
  const metadata: Record<string, string> = {};
  for (let index = start.index + 1; index < end; index += 1) {
    const line = stripYamlComment(lines[index] ?? "");
    if (!line.trim()) continue;
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    if (section && indent <= sectionIndent) section = undefined;
    const uriMatch = trimmed.match(/^uri:\s*(.+)$/);
    if (uriMatch) {
      uri = unquoteYaml(uriMatch[1] as string);
      continue;
    }
    const sectionMatch = trimmed.match(/^(predicates|filters|metadata):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1] as "predicates" | "filters" | "metadata";
      sectionIndent = indent;
      continue;
    }
    if (section === "predicates") {
      const item = trimmed.match(/^-\s*(.+)$/);
      if (item) predicates.push(unquoteYaml(item[1] as string));
    } else if (section === "filters") {
      const item = trimmed.match(/^-\s*(.+)$/);
      if (item) filters.push(unquoteYaml(item[1] as string));
    } else if (section === "metadata") {
      const item = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.+)$/);
      if (item) metadata[item[1] as string] = unquoteYaml(item[2] as string);
    }
  }
  return {
    id: start.id,
    file: relativePath(root, filePath),
    line: start.index + 1,
    uri,
    predicates,
    filters,
    metadata
  };
}

function extractExternalConfigImports(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    const value = stripYamlComment(line).trim().match(/^-\s*((?:optional:)?nacos:.+)$/i)?.[1];
    return value ? [unquoteYaml(value)] : [];
  });
}

function parseJavaClasses(root: string, filePath: string, content: string): JavaClassModel[] {
  const code = stripJavaComments(content);
  const classes: JavaClassModel[] = [];
  const classPattern = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*([^{};]*)\{/g;
  for (const match of code.matchAll(classPattern)) {
    const openBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closeBrace = findMatchingBrace(code, openBrace);
    if (closeBrace < 0) continue;
    const className = match[1] as string;
    const classSource = content.slice(openBrace + 1, closeBrace);
    const constants = extractStringConstants(classSource);
    const file = relativePath(root, filePath);
    classes.push({
      className,
      file,
      line: lineNumberAt(content, match.index ?? 0),
      header: match[2] ?? "",
      body: classSource,
      constants,
      methods: parseJavaMethods(className, file, classSource, openBrace + 1, content, constants)
    });
  }
  return classes;
}

function parseJavaMethods(
  className: string,
  file: string,
  classBody: string,
  classBodyOffset: number,
  fullContent: string,
  constants: Map<string, string>
): JavaMethodModel[] {
  const code = stripJavaComments(classBody);
  const pattern = /\b(?:public|protected|private)\s+(?:static\s+)?[A-Za-z0-9_$<>,?.\[\]\s]+\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^;{}]*)\)\s*\{/g;
  const methods: JavaMethodModel[] = [];
  for (const match of code.matchAll(pattern)) {
    const openBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closeBrace = findMatchingBrace(code, openBrace);
    if (closeBrace < 0) continue;
    const absoluteStart = classBodyOffset + openBrace + 1;
    methods.push({
      className,
      methodName: match[1] as string,
      file,
      line: lineNumberAt(fullContent, classBodyOffset + (match.index ?? 0)),
      params: match[2] ?? "",
      body: classBody.slice(openBrace + 1, closeBrace),
      bodyStart: absoluteStart,
      constants
    });
  }
  return methods;
}

function extractGatewayFilters(classes: JavaClassModel[]): GatewayFilterContract[] {
  const allMethods = classes.flatMap((item) => item.methods);
  const methodsByKey = new Map(allMethods.map((method) => [`${method.className}.${method.methodName}`, method]));
  const methodsByName = groupBy(allMethods, (method) => method.methodName);
  return classes.flatMap((model): GatewayFilterContract[] => {
    const kind = /\bGlobalFilter\b/.test(model.header)
      ? "global-filter" as const
      : /\bWebFilter\b/.test(model.header)
        ? "web-filter" as const
        : undefined;
    if (!kind) return [];
    const filterMethod = model.methods.find((method) =>
      method.methodName === "filter" && /\b(?:GatewayFilterChain|WebFilterChain)\b/.test(method.params));
    if (!filterMethod) return [];
    const order = extractFilterOrder(model);
    const continuation = analyzeContinuation(filterMethod, methodsByKey, methodsByName);
    const headerOperations = analyzeMethodHeaderOperations(filterMethod, methodsByKey, methodsByName);
    const streamEffect = analyzeStreamEffect(model.body);
    const findings = new Set<string>();
    if (continuation.status === "violated") {
      findings.add(`GW-CONTINUATION-MULTIPLE:${model.className}`);
    } else if (continuation.status === "unproven") {
      findings.add(`GW-CONTINUATION-UNPROVEN:${model.className}`);
    }
    for (const finding of analyzeHeaderFindings(model.className, headerOperations)) findings.add(finding);
    if (streamEffect.requestBodyAggregation) findings.add(`GW-STREAM-REQUEST-BODY-AGGREGATED:${model.className}`);
    if (streamEffect.responseBodyAggregation) findings.add(`GW-STREAM-RESPONSE-BODY-AGGREGATED:${model.className}`);
    return [{
      className: model.className,
      file: model.file,
      line: model.line,
      kind,
      ...order,
      continuation,
      headerOperations,
      streamEffect,
      findings: [...findings].sort()
    }];
  });
}

function extractFilterOrder(model: JavaClassModel): Pick<GatewayFilterContract, "order" | "orderExpression" | "orderCertainty"> {
  const method = model.methods.find((item) => item.methodName === "getOrder");
  if (!method) {
    return { order: ORDERED_LOWEST_PRECEDENCE, orderExpression: "default", orderCertainty: "default" };
  }
  const expression = stripJavaComments(method.body).match(/\breturn\s+([^;]+);/)?.[1]?.trim() ?? "default";
  if (/^-?\d+$/.test(expression)) {
    return { order: Number(expression), orderExpression: expression, orderCertainty: "exact" };
  }
  const known = KNOWN_ORDER_EXPRESSIONS.get(expression);
  if (known !== undefined) {
    return { order: known, orderExpression: expression, orderCertainty: "framework-constant" };
  }
  return { order: ORDERED_LOWEST_PRECEDENCE, orderExpression: expression, orderCertainty: "default" };
}

function analyzeContinuation(
  rootMethod: JavaMethodModel,
  methodsByKey: Map<string, JavaMethodModel>,
  methodsByName: Map<string, JavaMethodModel[]>
): GatewayContinuationContract {
  const evidenceLines: number[] = [];
  let calls = 0;
  let terminalReturns = 0;
  let violated = false;
  const visit = (method: JavaMethodModel, seen: Set<string>): void => {
    const key = `${method.className}.${method.methodName}`;
    if (seen.has(key) || seen.size >= 24) return;
    const nextSeen = new Set(seen).add(key);
    const chainName = method.params.match(/\b(?:GatewayFilterChain|WebFilterChain)\s+([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1];
    const masked = maskJavaNonCode(method.body);
    if (chainName) {
      const callPattern = new RegExp(`\\b${escapeRegex(chainName)}\\.filter\\s*\\(`, "g");
      const positions = [...masked.matchAll(callPattern)].map((match) => match.index ?? 0);
      calls += positions.length;
      evidenceLines.push(...positions.map((position) => method.line + lineNumberAt(method.body, position) - 1));
      const expressions = extractReturnExpressions(masked);
      const callPresencePattern = new RegExp(`\\b${escapeRegex(chainName)}\\.filter\\s*\\(`);
      terminalReturns += expressions.filter((expression) => !callPresencePattern.test(expression.text)).length;
      const sequentialPattern = new RegExp(
        `\\b${escapeRegex(chainName)}\\.filter\\s*\\([\\s\\S]*?\\)\\s*\\.then(?:Many)?\\s*\\([\\s\\S]*?\\b${escapeRegex(chainName)}\\.filter\\s*\\(`
      );
      if (expressions.some((expression) => sequentialPattern.test(expression.text))) violated = true;
    }
    const callPattern = /\b(?:(this|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    for (const match of masked.matchAll(callPattern)) {
      const qualifier = match[1];
      const methodName = match[2] as string;
      if (JAVA_CALL_KEYWORDS.has(methodName)) continue;
      const target = qualifier && qualifier !== "this"
        ? methodsByKey.get(`${qualifier}.${methodName}`)
        : methodsByKey.get(`${method.className}.${methodName}`)
          ?? (methodsByName.get(methodName)?.length === 1 ? methodsByName.get(methodName)?.[0] : undefined);
      if (target) visit(target, nextSeen);
    }
  };
  visit(rootMethod, new Set());
  return {
    calls,
    maxCallsInReturnExpression: violated ? 2 : calls > 0 ? 1 : 0,
    terminalReturns,
    status: violated ? "violated" : calls > 0 ? "once-or-terminal" : "unproven",
    evidenceLines: [...new Set(evidenceLines)].sort((left, right) => left - right)
  };
}

function analyzeMethodHeaderOperations(
  rootMethod: JavaMethodModel,
  methodsByKey: Map<string, JavaMethodModel>,
  methodsByName: Map<string, JavaMethodModel[]>
): GatewayHeaderOperation[] {
  const operations: GatewayHeaderOperation[] = [];
  const visit = (method: JavaMethodModel, callerLine: number | undefined, via: string | undefined, seen: Set<string>): void => {
    const key = `${method.className}.${method.methodName}`;
    if (seen.has(key) || seen.size >= 24) return;
    const nextSeen = new Set(seen).add(key);
    for (const operation of extractDirectHeaderOperations(method)) {
      operations.push({
        ...operation,
        ...(callerLine !== undefined ? { file: rootMethod.file, line: callerLine } : {}),
        ...(via ? { via } : {})
      });
    }
    const code = stripJavaComments(method.body);
    const callPattern = /\b(?:(this|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    for (const match of code.matchAll(callPattern)) {
      const qualifier = match[1];
      const methodName = match[2] as string;
      if (JAVA_CALL_KEYWORDS.has(methodName)) continue;
      const target = qualifier && qualifier !== "this"
        ? methodsByKey.get(`${qualifier}.${methodName}`)
        : methodsByKey.get(`${method.className}.${methodName}`)
          ?? (methodsByName.get(methodName)?.length === 1 ? methodsByName.get(methodName)?.[0] : undefined);
      if (!target) continue;
      const line = callerLine ?? method.line + lineNumberAt(method.body, match.index ?? 0) - 1;
      visit(target, line, key, nextSeen);
    }
  };
  visit(rootMethod, undefined, undefined, new Set());
  return uniqueBy(operations, (item) =>
    `${item.header}|${item.action}|${item.file}|${item.line}|${item.via ?? ""}`)
    .sort((left, right) => left.line - right.line || left.action.localeCompare(right.action) || left.header.localeCompare(right.header));
}

function extractDirectHeaderOperations(method: JavaMethodModel): GatewayHeaderOperation[] {
  const code = stripJavaComments(method.body);
  const operations: GatewayHeaderOperation[] = [];
  const patterns: Array<{
    action: GatewayHeaderOperation["action"];
    regex: RegExp;
    expressionGroup: number;
    receiverGroup?: number;
    builderHeader?: boolean;
  }> = [
    { action: "read", regex: /\b(?:getFirst|containsKey)\s*\(\s*("(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*\)/g, expressionGroup: 1 },
    { action: "remove", regex: /\b([A-Za-z_$][A-Za-z0-9_$]*)\.remove\s*\(\s*("(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*\)/g, expressionGroup: 2, receiverGroup: 1 },
    { action: "replace", regex: /\.header\s*\(\s*("(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*,/g, expressionGroup: 1, builderHeader: true },
    { action: "append", regex: /\b([A-Za-z_$][A-Za-z0-9_$]*)\.add\s*\(\s*("(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*,/g, expressionGroup: 2, receiverGroup: 1 },
    { action: "replace", regex: /\b([A-Za-z_$][A-Za-z0-9_$]*)\.set\s*\(\s*("(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*,/g, expressionGroup: 2, receiverGroup: 1 }
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern.regex)) {
      const receiver = pattern.receiverGroup ? match[pattern.receiverGroup] : undefined;
      if (receiver && !pattern.builderHeader && !isLikelyHeaderReceiver(receiver)) continue;
      const header = resolveHeaderExpression(match[pattern.expressionGroup] as string, method.constants);
      if (!header) continue;
      operations.push({
        header,
        action: pattern.action,
        provenance: inferHeaderOperationProvenance(pattern.action, code, match.index ?? 0),
        file: method.file,
        line: method.line + lineNumberAt(method.body, match.index ?? 0) - 1
      });
    }
  }
  for (const match of code.matchAll(/\bsetRequestHeaders\s*\(\s*[^;]*?getHeaders\s*\(\s*\)/g)) {
    operations.push({
      header: "*",
      action: "capture-all",
      provenance: "client",
      file: method.file,
      line: method.line + lineNumberAt(method.body, match.index ?? 0) - 1
    });
  }
  return operations;
}

function analyzeHeaderFindings(className: string, operations: GatewayHeaderOperation[]): string[] {
  const findings = new Set<string>();
  const removed = new Set<string>();
  for (const operation of operations) {
    const header = operation.header.toLowerCase();
    if (operation.action === "capture-all") {
      findings.add(`GW-HEADER-SENSITIVE-CAPTURE-ALL:${className}`);
    } else if (operation.action === "remove") {
      removed.add(header);
    } else if (operation.action === "append" && SENSITIVE_HEADERS.has(header) && !removed.has(header)) {
      findings.add(`GW-HEADER-SENSITIVE-APPEND-WITHOUT-REMOVE:${header}`);
    }
  }
  return [...findings].sort();
}

function analyzeStreamEffect(classBody: string): GatewayStreamEffect {
  const code = stripJavaComments(classBody);
  const requestBodyAggregation = /\bCachedBodyOutputMessage\b/.test(code)
    || /\bServerRequest\.create\s*\([\s\S]{0,500}?bodyToMono\s*\(\s*String\.class\s*\)/.test(code);
  const requestAggregationCondition = requestBodyAggregation
    && /APPLICATION_FORM_URLENCODED[\s\S]{0,300}?APPLICATION_JSON|APPLICATION_JSON[\s\S]{0,300}?APPLICATION_FORM_URLENCODED/.test(code)
    ? "application/json|application/x-www-form-urlencoded"
    : requestBodyAggregation ? "bodyToMono(String)" : undefined;
  const responseBodyAggregation = /\bFlux\.from\s*\([^)]*\)[\s\S]{0,500}?\.buffer\s*\(\s*\)/.test(code)
    || /\bDataBufferFactory\b[\s\S]{0,500}?\.join\s*\(/.test(code);
  const responseAggregationCondition = responseBodyAggregation && /application\/json|MediaType\.APPLICATION_JSON/i.test(code)
    ? "application/json"
    : undefined;
  return {
    requestBodyAggregation,
    ...(requestAggregationCondition ? { requestAggregationCondition } : {}),
    responseBodyAggregation,
    ...(responseAggregationCondition ? { responseAggregationCondition } : {}),
    completionHook: /\.then\s*\(\s*Mono\.(?:fromRunnable|defer)/.test(code)
  };
}

function analyzeRouteConfiguredHeaders(route: ParsedGatewayRoute): string[] {
  const findings = new Set<string>();
  for (const filter of route.filters) {
    const name = predicateName(filter).toLowerCase();
    const [header] = predicateArguments(filter);
    if (!header || !SENSITIVE_HEADERS.has(header.toLowerCase())) continue;
    if (name === "addrequestheader") findings.add(`GW-HEADER-SENSITIVE-ROUTE-APPEND:${header.toLowerCase()}`);
  }
  return [...findings];
}

function isBlockingFinding(finding: string): boolean {
  return finding.startsWith("GW-CONTINUATION-")
    || finding.startsWith("GW-HEADER-SENSITIVE-")
    || finding === "GW-EFFECTIVE-CONFIG-EXTERNAL-UNRESOLVED"
    || finding.startsWith("GW-ROUTE-ID-DUPLICATE");
}

function inferRouteStreamKind(route: ParsedGatewayRoute, paths: string[]): GatewayRouteStreamKind {
  if (/^(?:lb:)?wss?(?::|$)/i.test(route.uri)) return "websocket";
  const value = `${route.id} ${paths.join(" ")} ${route.filters.join(" ")}`;
  if (/\b(?:sse|stream|event-stream|assistant)\b/i.test(value)) return "sse-candidate";
  if (/\b(?:export|pull|download|upload|import)\b/i.test(value)
      || numericMetadata(route.metadata, "response-timeout") !== undefined) return "long-running";
  return "http";
}

function routeScheme(uri: string): string {
  const match = uri.match(/^([A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)?):\/\//);
  return match?.[1] ?? "unknown";
}

function routeServiceId(uri: string): string {
  return uri.match(/^[A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)?:\/\/([^/?#\s]+)/)?.[1] ?? "";
}

function predicateName(value: string): string {
  return value.split("=", 1)[0]?.trim() ?? value.trim();
}

function predicateArguments(value: string): string[] {
  const equals = value.indexOf("=");
  if (equals < 0) return [];
  return splitDelimited(value.slice(equals + 1), ",").map((item) => item.trim()).filter(Boolean);
}

function numericMetadata(metadata: Record<string, string>, key: string): number | undefined {
  const value = metadata[key];
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function extractStringConstants(content: string): Map<string, string> {
  const constants = new Map<string, string>();
  const code = stripJavaComments(content);
  for (const match of code.matchAll(/\bstatic\s+final\s+String\s+([A-Z_][A-Z0-9_]*)\s*=\s*"((?:\\.|[^"])*)"\s*;/g)) {
    constants.set(match[1] as string, decodeJavaString(match[2] as string));
  }
  return constants;
}

function resolveHeaderExpression(expression: string, constants: Map<string, string>): string | undefined {
  if (expression.startsWith("\"")) return decodeJavaString(expression.slice(1, -1));
  const standard = new Map([
    ["AUTHORIZATION", "Authorization"],
    ["COOKIE", "Cookie"],
    ["SET_COOKIE", "Set-Cookie"],
    ["ACCESS_CONTROL_ALLOW_ORIGIN", "Access-Control-Allow-Origin"],
    ["ACCESS_CONTROL_ALLOW_CREDENTIALS", "Access-Control-Allow-Credentials"]
  ]);
  return constants.get(expression) ?? standard.get(expression);
}

function inferHeaderOperationProvenance(
  action: GatewayHeaderOperation["action"],
  code: string,
  index: number
): GatewayHeaderOperation["provenance"] {
  if (action === "read" || action === "capture-all") return "client";
  if (action === "remove") return "sanitized";
  const lineEnd = code.indexOf("\n", index);
  const context = code.slice(index, lineEnd < 0 ? Math.min(code.length, index + 240) : lineEnd);
  if (/\b(?:result|remoteUser|tokenInfo|sourceTenantId|collaborationDataId|userStr|LoginUser)\b/.test(context)) return "validated";
  if (/\b(?:tenantId|collaborationTenantId|authorization|token)\b/.test(context)) return "client-derived";
  if (/,\s*(?:"(?:\\.|[^"])*"|[A-Z_][A-Z0-9_]*)\s*\)/.test(context)) return "constant";
  return "unknown";
}

function extractReturnExpressions(code: string): Array<{ start: number; text: string }> {
  const expressions: Array<{ start: number; text: string }> = [];
  const pattern = /\breturn\b/g;
  for (const match of code.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    let parens = 0;
    let braces = 0;
    let brackets = 0;
    for (let index = start; index < code.length; index += 1) {
      const char = code[index];
      if (char === "(") parens += 1;
      else if (char === ")") parens -= 1;
      else if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets -= 1;
      else if (char === ";" && parens === 0 && braces === 0 && brackets === 0) {
        expressions.push({ start, text: code.slice(start, index) });
        break;
      }
    }
  }
  return expressions;
}

function findMatchingBrace(code: string, openBrace: number): number {
  let depth = 0;
  let state: "code" | "string" | "char" | "line-comment" | "block-comment" | "text-block" = "code";
  for (let index = openBrace; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string" || state === "char") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if ((state === "string" && char === "\"") || (state === "char" && char === "'")) state = "code";
      continue;
    }
    if (state === "text-block") {
      if (code.slice(index, index + 3) === "\"\"\"") {
        state = "code";
        index += 2;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (code.slice(index, index + 3) === "\"\"\"") {
      state = "text-block";
      index += 2;
    } else if (char === "\"") state = "string";
    else if (char === "'") state = "char";
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripJavaComments(content: string): string {
  let output = "";
  let state: "code" | "string" | "char" | "line-comment" | "block-comment" | "text-block" = "code";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string;
    const next = content[index + 1];
    if (state === "line-comment") {
      if (char === "\n") {
        output += "\n";
        state = "code";
      } else output += " ";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        state = "code";
        index += 1;
      } else output += char === "\n" ? "\n" : " ";
    } else if (state === "string" || state === "char") {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 1;
      } else if ((state === "string" && char === "\"") || (state === "char" && char === "'")) state = "code";
    } else if (state === "text-block") {
      output += char;
      if (content.slice(index, index + 3) === "\"\"\"") {
        output += "\"\"";
        state = "code";
        index += 2;
      }
    } else if (char === "/" && next === "/") {
      output += "  ";
      state = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      output += "  ";
      state = "block-comment";
      index += 1;
    } else if (content.slice(index, index + 3) === "\"\"\"") {
      output += "\"\"\"";
      state = "text-block";
      index += 2;
    } else {
      output += char;
      if (char === "\"") state = "string";
      else if (char === "'") state = "char";
    }
  }
  return output;
}

function maskJavaNonCode(content: string): string {
  const withoutComments = stripJavaComments(content);
  let output = "";
  let state: "code" | "string" | "char" | "text-block" = "code";
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index] as string;
    const next = withoutComments[index + 1];
    if (state === "string" || state === "char") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\\") {
        output += next === "\n" ? "\n" : " ";
        index += 1;
      } else if ((state === "string" && char === "\"") || (state === "char" && char === "'")) state = "code";
    } else if (state === "text-block") {
      output += char === "\n" ? "\n" : " ";
      if (withoutComments.slice(index, index + 3) === "\"\"\"") {
        output += "  ";
        state = "code";
        index += 2;
      }
    } else if (withoutComments.slice(index, index + 3) === "\"\"\"") {
      output += "   ";
      state = "text-block";
      index += 2;
    } else if (char === "\"") {
      output += " ";
      state = "string";
    } else if (char === "'") {
      output += " ";
      state = "char";
    } else output += char;
  }
  return output;
}

async function collectProjectFiles(
  root: string,
  includeTests: boolean
): Promise<{ java: string[]; yaml: string[] }> {
  const java: string[] = [];
  const yaml: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = relativePath(root, fullPath);
      if (entry.isDirectory()) {
        if ([".git", "target", "build", "out", "node_modules", ".migration-guard"].includes(entry.name)) continue;
        if (!includeTests && /(?:^|\/)src\/test(?:\/|$)/.test(relative)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".java")) java.push(fullPath);
        if (/\.(?:ya?ml)$/i.test(entry.name) && /(?:^|\/)src\/main\/resources\//.test(relative)) yaml.push(fullPath);
      }
    }
  };
  await visit(root);
  return { java: java.sort(), yaml: yaml.sort() };
}

function stripYamlComment(value: string): string {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = undefined;
    } else if (char === "'" || char === "\"") quote = char;
    else if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value;
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function splitDelimited(value: string, delimiter: string): string[] {
  const result: string[] = [];
  let quote: "'" | "\"" | undefined;
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== "\\") quote = undefined;
    } else if (char === "'" || char === "\"") {
      quote = char;
      current += char;
    } else if (char === delimiter) {
      result.push(current);
      current = "";
    } else current += char;
  }
  result.push(current);
  return result;
}

function renderStreamEffect(effect: GatewayStreamEffect): string {
  const values: string[] = [];
  if (effect.requestBodyAggregation) values.push(`request-buffer${effect.requestAggregationCondition ? `:${effect.requestAggregationCondition}` : ""}`);
  if (effect.responseBodyAggregation) values.push(`response-buffer${effect.responseAggregationCondition ? `:${effect.responseAggregationCondition}` : ""}`);
  if (effect.completionHook) values.push("completion-hook");
  return values.join(", ") || "pass-through";
}

function isLikelyHeaderReceiver(value: string): boolean {
  return /^(?:h|headers?|httpHeaders)$/i.test(value);
}

function createRouteFilterChain(
  webFilters: GatewayFilterContract[],
  globalFilters: GatewayFilterContract[],
  routeFilters: string[]
): string[] {
  const gateway = [
    ...globalFilters.map((item) => ({ order: item.order, label: `gateway:${item.className}@${item.order}` })),
    ...FRAMEWORK_FILTER_ANCHORS.map((item) => ({ order: item.order, label: `gateway:anchor:${item.name}@${item.order}` }))
  ].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  return [
    ...webFilters.map((item) => `web:${item.className}@${item.order}`),
    "handler:RoutePredicateHandlerMapping",
    ...gateway.map((item) => item.label),
    ...routeFilters.map((item, index) => `route:declared[${index}]:${item}`)
  ];
}

function compareFilters(left: GatewayFilterContract, right: GatewayFilterContract): number {
  const layer = filterLayerRank(left.kind) - filterLayerRank(right.kind);
  return layer || left.order - right.order || left.className.localeCompare(right.className);
}

function filterLayerRank(kind: GatewayFilterKind): number {
  return kind === "web-filter" ? 0 : 1;
}

function relativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? path.resolve(filePath).replaceAll("\\", "/") : relative;
}

function leadingSpaces(value: string): number {
  return value.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0;
}

function lineNumberAt(value: string, index: number): number {
  return value.slice(0, Math.max(0, index)).split("\n").length;
}

function decodeJavaString(value: string): string {
  return value.replace(/\\(["\\bnrtf])/g, (_match, char: string) => {
    const mapping: Record<string, string> = { b: "\b", n: "\n", r: "\r", t: "\t", f: "\f" };
    return mapping[char] ?? char;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function duplicateValues(values: string[]): Set<string> {
  const counts = countValues(values);
  return new Set(Object.entries(counts).filter(([, count]) => count > 1).map(([value]) => value));
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const current = key(value);
    groups.set(current, [...(groups.get(current) ?? []), value]);
  }
  return groups;
}

const JAVA_CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "throw", "super", "this",
  "filter", "flatMap", "map", "then", "defer", "just", "empty", "error", "get", "set", "add", "remove"
]);
