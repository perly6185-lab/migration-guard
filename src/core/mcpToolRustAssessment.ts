import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import {
  createJavaEndpointAnalyzer,
  type AdaptiveExpansionTopology,
  type JavaEndpointAnalyzer,
  type JavaFeignClientContract,
  type JavaFeignMethodContract,
  type JavaMcpIdentityKind,
  type JavaMcpToolMethodCandidate,
  type JavaMethodSummaryCall,
  type JavaMethodSummaryTarget,
  type JavaServiceMethodCandidate
} from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import type { EndpointWorkloadKind } from "./endpointReplacementModel.js";
import type { AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

export interface McpToolRustAssessmentOptions {
  root: string;
  maxDepth?: number;
  maxEdges?: number;
  includeTests?: boolean;
  adaptive?: boolean;
  maxExpansionDepth?: number;
  maxExpansionEdges?: number;
  maxExpansionRounds?: number;
}

export interface McpFeignIdentityHop {
  client: string;
  method: string;
  file: string;
  line: number;
  httpMethod?: string;
  path?: string;
  headers: Array<{
    header: string;
    identity?: JavaMcpIdentityKind;
    argument?: string;
    provenance?: JavaMcpIdentityKind;
    status: "proven" | "missing-source" | "mismatched" | "unclassified";
  }>;
  droppedIdentities: JavaMcpIdentityKind[];
  fallbackClassName?: string;
  fallbackCompatible: JavaFeignClientContract["fallbackCompatible"];
}

export interface McpToolMethodAssessment {
  id: string;
  toolName: string;
  className: string;
  methodName: string;
  file: string;
  line: number;
  registration: JavaMcpToolMethodCandidate["registration"];
  providerBeans: string[];
  schemaHash: string;
  parameters: JavaMcpToolMethodCandidate["parameters"];
  workload: EndpointWorkloadKind;
  status: "ready" | "blocked" | "inactive";
  nodes: number;
  edges: number;
  unknownNodes: number;
  feignHops: McpFeignIdentityHop[];
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionTopology?: AdaptiveExpansionTopology;
  expansionRounds?: number;
}

export interface McpToolRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: McpToolRustAssessmentOptions;
  annotatedToolCount: number;
  registeredToolCount: number;
  annotatedOnlyToolCount: number;
  providerCount: number;
  feignClientCount: number;
  feignContracts: JavaFeignClientContract[];
  summary: {
    ready: number;
    blocked: number;
    inactive: number;
    truncated: number;
    workloads: Record<string, number>;
    findings: Record<string, number>;
    identityHops: number;
    identityHopsWithFindings: number;
    incompatibleFallbacks: number;
  };
  methods: McpToolMethodAssessment[];
  reportHash: string;
}

export async function assessJavaMcpToolsForRust(
  options: McpToolRustAssessmentOptions
): Promise<McpToolRustAssessmentReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const duplicateToolNames = new Set(
    [...countValues(analyzer.mcpToolMethods.filter((tool) => tool.registration === "registered").map((tool) => tool.toolName)).entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
  );
  const methods = analyzer.mcpToolMethods.map((candidate): McpToolMethodAssessment => {
    if (candidate.registration === "annotated-only") {
      return {
        id: candidate.id,
        toolName: candidate.toolName,
        className: candidate.className,
        methodName: candidate.methodName,
        file: candidate.file,
        line: candidate.line,
        registration: candidate.registration,
        providerBeans: [],
        schemaHash: candidate.schemaHash,
        parameters: candidate.parameters,
        workload: inferMcpWorkload(candidate, []),
        status: "inactive",
        nodes: 0,
        edges: 0,
        unknownNodes: 0,
        feignHops: [],
        findings: ["MCP-TOOL-ANNOTATED-NOT-REGISTERED"]
      };
    }
    const expansion = options.adaptive ? analyzer.analyzeMcpToolMethodAdaptive(candidate, {
      initialDepth: options.maxDepth,
      initialEdges: options.maxEdges,
      maxDepth: options.maxExpansionDepth,
      maxEdges: options.maxExpansionEdges,
      maxRounds: options.maxExpansionRounds
    }) : undefined;
    const source = expansion?.report ?? analyzer.analyzeMcpToolMethod(candidate, {
      maxDepth: options.maxDepth,
      maxEdges: options.maxEdges
    });
    const { graph, plan } = createEndpointReplacementPlanFromJava(source);
    const identity = analyzeMcpFeignIdentity(analyzer, candidate);
    const workload = inferMcpWorkload(candidate, identity.hops);
    const findings = [...new Set([
      ...plan.findings,
      ...identity.findings,
      ...(duplicateToolNames.has(candidate.toolName) ? ["MCP-TOOL-NAME-DUPLICATE"] : []),
      ...(candidate.parameters.some((parameter) => !parameter.name || !parameter.javaType)
        ? ["MCP-TOOL-SCHEMA-INCOMPLETE"]
        : []),
      ...(expansion?.status === "budget-exhausted" ? ["MCP-TOOL-GRAPH-EXPANSION-BUDGET-EXHAUSTED"] : [])
    ])].sort();
    return {
      id: candidate.id,
      toolName: candidate.toolName,
      className: candidate.className,
      methodName: candidate.methodName,
      file: candidate.file,
      line: candidate.line,
      registration: candidate.registration,
      providerBeans: candidate.providers.map((provider) => provider.providerBean).sort(),
      schemaHash: candidate.schemaHash,
      parameters: candidate.parameters,
      workload,
      status: findings.length ? "blocked" : "ready",
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unknownNodes: graph.nodes.filter((node) => node.kind === "unknown").length,
      feignHops: identity.hops,
      findings,
      expansionStatus: expansion?.status,
      expansionTopology: expansion?.topology,
      expansionRounds: expansion?.rounds.length
    };
  });
  const registered = methods.filter((method) => method.registration === "registered");
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root: analyzer.root,
    sourceIdentity: analyzer.sourceIdentity,
    assessmentScope: { ...options, root: analyzer.root },
    annotatedToolCount: analyzer.mcpToolMethods.length,
    registeredToolCount: registered.length,
    annotatedOnlyToolCount: methods.length - registered.length,
    providerCount: analyzer.mcpToolProviders.length,
    feignClientCount: analyzer.feignClients.length,
    summary: {
      ready: registered.filter((method) => method.status === "ready").length,
      blocked: registered.filter((method) => method.status === "blocked").length,
      inactive: methods.filter((method) => method.status === "inactive").length,
      truncated: registered.filter((method) => method.findings.some((finding) => /GRAPH-(?:EDGE|DEPTH|UNEXPANDED|EXPANSION)/.test(finding))).length,
      workloads: Object.fromEntries(countValues(registered.map((method) => method.workload))),
      findings: Object.fromEntries(countValues(registered.flatMap((method) => method.findings))),
      identityHops: registered.reduce((total, method) => total + method.feignHops.length, 0),
      identityHopsWithFindings: registered.reduce((total, method) =>
        total + method.feignHops.filter((hop) =>
          hop.droppedIdentities.length > 0
          || hop.headers.some((header) => header.status === "missing-source" || header.status === "mismatched")
          || hop.fallbackCompatible === false
          || hop.fallbackCompatible === "unresolved").length, 0),
      incompatibleFallbacks: analyzer.feignClients.filter((client) => client.fallbackCompatible === false).length
    },
    feignContracts: analyzer.feignClients,
    methods
  };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function renderMcpToolRustAssessment(report: McpToolRustAssessmentReport): string {
  return [
    "# MCP Tool Rust Assessment", "",
    `- Root: ${report.root}`,
    `- Annotated tools: ${report.annotatedToolCount}`,
    `- Registered tools: ${report.registeredToolCount}`,
    `- Annotated only: ${report.annotatedOnlyToolCount}`,
    `- Providers: ${report.providerCount}`,
    `- Feign clients: ${report.feignClientCount}`,
    `- Ready: ${report.summary.ready}`,
    `- Blocked: ${report.summary.blocked}`,
    `- Inactive: ${report.summary.inactive}`,
    `- Identity hops: ${report.summary.identityHops}`,
    `- Identity hops with findings: ${report.summary.identityHopsWithFindings}`,
    `- Globally incompatible Feign fallbacks: ${report.summary.incompatibleFallbacks}`,
    `- Report hash: ${report.reportHash}`, "",
    "## Workloads", "",
    ...Object.entries(report.summary.workloads).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([workload, count]) => `- ${workload}: ${count}`), "",
    "## Findings", "",
    ...Object.entries(report.summary.findings).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([finding, count]) => `- ${finding}: ${count}`), "",
    "## Registered tools", "",
    "| Tool | Workload | Status | Provider | Feign hops | Findings |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...report.methods.filter((method) => method.registration === "registered").map((method) =>
      `| ${method.toolName} | ${method.workload} | ${method.status} | ${method.providerBeans.join(", ")} | ${method.feignHops.length} | ${method.findings.join(", ")} |`), "",
    "## Annotated but inactive", "",
    ...report.methods.filter((method) => method.registration === "annotated-only")
      .map((method) => `- ${method.className}.${method.methodName} (${method.toolName})`)
  ].join("\n");
}

function analyzeMcpFeignIdentity(
  analyzer: JavaEndpointAnalyzer,
  tool: JavaMcpToolMethodCandidate
): { hops: McpFeignIdentityHop[]; findings: string[] } {
  const globalIdentities = new Set(tool.parameters.flatMap((parameter) => parameter.identity ? [parameter.identity] : []));
  const initialProvenance = new Map(tool.parameters.flatMap((parameter) =>
    parameter.identity ? [[parameter.name, parameter.identity] as const] : []));
  const queue: Array<{ candidate: JavaServiceMethodCandidate; provenance: Map<string, JavaMcpIdentityKind> }> = [
    { candidate: tool, provenance: initialProvenance }
  ];
  const visited = new Set<string>();
  const hops = new Map<string, McpFeignIdentityHop>();
  const findings = new Set<string>();
  while (queue.length && visited.size < 500) {
    const state = queue.shift() as { candidate: JavaServiceMethodCandidate; provenance: Map<string, JavaMcpIdentityKind> };
    const stateKey = `${state.candidate.id}|${[...state.provenance].sort().map(([name, kind]) => `${name}:${kind}`).join(",")}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);
    const summary = analyzer.summarizeMethod(state.candidate);
    for (const call of summary.calls) {
      const feign = matchFeignCall(analyzer.feignClients, call);
      if (feign) {
        const hop = createIdentityHop(feign.client, feign.method, call, state.provenance, globalIdentities);
        const key = `${hop.client}.${hop.method}:${hop.line}`;
        const existing = hops.get(key);
        hops.set(key, existing ? mergeIdentityHops(existing, hop) : hop);
      }
      for (const target of call.targets) {
        const provenance = propagateIdentity(call, target, state.provenance);
        queue.push({ candidate: targetCandidate(target), provenance });
      }
    }
  }
  if (queue.length) findings.add("MCP-FEIGN-IDENTITY-STATE-BUDGET-EXHAUSTED");
  for (const hop of hops.values()) {
    for (const identity of hop.droppedIdentities) findings.add(`MCP-FEIGN-IDENTITY-DROPPED:${identity}`);
    for (const header of hop.headers) {
      if (header.status === "missing-source") findings.add(`MCP-FEIGN-IDENTITY-SOURCE-MISSING:${header.identity ?? header.header}`);
      if (header.status === "mismatched") findings.add(`MCP-FEIGN-IDENTITY-FLOW-UNPROVEN:${header.identity ?? header.header}`);
    }
    if (hop.fallbackCompatible === false) findings.add(`MCP-FEIGN-FALLBACK-INCOMPATIBLE:${hop.client}`);
    if (hop.fallbackCompatible === "unresolved") findings.add(`MCP-FEIGN-FALLBACK-UNRESOLVED:${hop.client}`);
  }
  return {
    hops: [...hops.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.client.localeCompare(right.client)),
    findings: [...findings].sort()
  };
}

function matchFeignCall(
  clients: JavaFeignClientContract[],
  call: JavaMethodSummaryCall
): { client: JavaFeignClientContract; method: JavaFeignMethodContract } | undefined {
  const receiver = call.receiver ?? "";
  const candidates = clients.filter((client) =>
    client.methods.some((method) => method.methodName === call.method)
    && (call.receiverType === client.className
      || call.receiverType === client.qualifiedClassName
      || receiver === lowerCamel(client.className)));
  const pool = candidates.length ? candidates : clients.filter((client) =>
    client.methods.some((method) => method.methodName === call.method));
  if (pool.length !== 1) return undefined;
  const client = pool[0];
  const method = client.methods.find((candidate) => candidate.methodName === call.method);
  return method ? { client, method } : undefined;
}

function createIdentityHop(
  client: JavaFeignClientContract,
  method: JavaFeignMethodContract,
  call: JavaMethodSummaryCall,
  provenance: Map<string, JavaMcpIdentityKind>,
  globalIdentities: Set<JavaMcpIdentityKind>
): McpFeignIdentityHop {
  const declaredIdentities = new Set(method.headers.flatMap((header) => header.identity ? [header.identity] : []));
  return {
    client: client.className,
    method: method.methodName,
    file: client.file,
    line: method.line,
    ...(method.httpMethod ? { httpMethod: method.httpMethod } : {}),
    ...(method.path ? { path: method.path } : {}),
    headers: method.headers.map((header) => {
      const argument = call.argumentIdentifiers[header.parameterIndex];
      const source = argument ? provenance.get(argument) : undefined;
      const status = !header.identity
        ? "unclassified" as const
        : !globalIdentities.has(header.identity)
          ? "missing-source" as const
          : source === header.identity
            ? "proven" as const
            : "mismatched" as const;
      return {
        header: header.header,
        ...(header.identity ? { identity: header.identity } : {}),
        ...(argument ? { argument } : {}),
        ...(source ? { provenance: source } : {}),
        status
      };
    }),
    droppedIdentities: [...globalIdentities].filter((identity) =>
      identity !== "conversation" && !declaredIdentities.has(identity)).sort(),
    ...(client.fallbackClassName ? { fallbackClassName: client.fallbackClassName } : {}),
    fallbackCompatible: client.fallbackCompatible
  };
}

function mergeIdentityHops(left: McpFeignIdentityHop, right: McpFeignIdentityHop): McpFeignIdentityHop {
  const headerMap = new Map(left.headers.map((header) => [`${header.header}:${header.identity ?? ""}`, header]));
  const rank = { proven: 3, unclassified: 2, mismatched: 1, "missing-source": 0 };
  for (const header of right.headers) {
    const key = `${header.header}:${header.identity ?? ""}`;
    const existing = headerMap.get(key);
    if (!existing || rank[header.status] > rank[existing.status]) headerMap.set(key, header);
  }
  return {
    ...left,
    headers: [...headerMap.values()],
    droppedIdentities: [...new Set([...left.droppedIdentities, ...right.droppedIdentities])].sort()
  };
}

function propagateIdentity(
  call: JavaMethodSummaryCall,
  target: JavaMethodSummaryTarget,
  provenance: Map<string, JavaMcpIdentityKind>
): Map<string, JavaMcpIdentityKind> {
  const result = new Map<string, JavaMcpIdentityKind>();
  target.parameterNames.forEach((parameter, index) => {
    const argument = call.argumentIdentifiers[index];
    const identity = argument ? provenance.get(argument) : undefined;
    if (identity) result.set(parameter, identity);
  });
  return result;
}

function targetCandidate(target: JavaMethodSummaryTarget): JavaServiceMethodCandidate {
  return {
    id: target.methodId,
    className: target.qualifiedClassName.split(".").pop() ?? target.qualifiedClassName,
    qualifiedClassName: target.qualifiedClassName,
    methodName: target.methodName,
    signature: target.signature,
    returnType: target.returnType,
    parameterTypes: target.parameterTypes,
    annotations: target.annotations,
    file: target.file,
    line: target.line
  };
}

function inferMcpWorkload(
  candidate: JavaMcpToolMethodCandidate,
  hops: McpFeignIdentityHop[]
): EndpointWorkloadKind {
  const value = `${candidate.toolName} ${candidate.methodName}`;
  if (/upload|import/i.test(value)) return "upload";
  if (/^(?:cancel|disable|enable|archive|restore)/i.test(value)) return "idempotent-command";
  if (/^(?:create|add|edit|apply|update|delete|remove|save|submit|approve|reject|build)/i.test(value)) return "command";
  if (hops.some((hop) => hop.httpMethod && ["PUT", "PATCH", "DELETE"].includes(hop.httpMethod))) return "command";
  return "query";
}

function lowerCamel(value: string): string {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
