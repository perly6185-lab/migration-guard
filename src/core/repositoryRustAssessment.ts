import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createJavaEndpointAnalyzer } from "./javaEndpointAnalysis.js";
import { createEndpointReplacementPlanFromJava } from "./endpointReplacementPlanner.js";
import type { EndpointWorkloadKind } from "./endpointReplacementModel.js";
import type { JavaSqlOperation, JavaSqlOwnershipContract, JavaSqlOwnershipEvidence, JavaSqlSourceInfo, JavaSqlSourceKind } from "./javaEndpointAnalysis.js";
import { captureAssessmentSourceIdentity, type AssessmentSourceIdentity } from "./assessmentSourceIdentity.js";

export interface RepositoryRustAssessmentOptions { root: string; maxDepth?: number; maxEdges?: number; limit?: number; includeTests?: boolean; adaptive?: boolean; maxExpansionDepth?: number; maxExpansionEdges?: number; maxExpansionRounds?: number; }
export interface RepositorySqlContractRecord {
  sourceId: string;
  source: JavaSqlSourceKind;
  operation: JavaSqlOperation;
  dynamic: boolean;
  dynamicTags: string[];
  tables: string[];
  contexts: string[];
  transactional: boolean;
  missingContracts: JavaSqlOwnershipContract[];
  unresolvedReasons: string[];
  reviewStatus: "reviewable" | "replay-contract-required";
}

export interface RepositorySqlMetrics {
  records: number;
  reviewableRecords: number;
  replayContractRequiredRecords: number;
  sourceKinds: Record<string, number>;
  operations: Record<string, number>;
  dynamicTags: Record<string, number>;
  tables: Record<string, number>;
  contexts: Record<string, number>;
  transactionParticipation: Record<string, number>;
  unresolvedReasons: Record<string, number>;
}

export interface RepositoryMethodAssessment {
  id: string;
  file: string;
  line: number;
  repository: string;
  method: string;
  signature: string;
  role: "repository" | "mapper" | "dao";
  implementation: "concrete" | "default" | "sql-source" | "generated-boundary";
  workload: EndpointWorkloadKind;
  operation: JavaSqlOperation;
  status: "ready" | "blocked";
  nodes: number;
  edges: number;
  externalBoundaries: number;
  unknownNodes: number;
  sqlSources: number;
  dynamicSqlSources: number;
  transactionalSqlSources: number;
  contextSqlSources: number;
  sqlSourceKinds: JavaSqlSourceKind[];
  missingSqlContracts: JavaSqlOwnershipContract[];
  sqlOwnershipEvidence: Array<{ sourceId: string; evidence: JavaSqlOwnershipEvidence }>;
  sqlContracts: RepositorySqlContractRecord[];
  findings: string[];
  expansionStatus?: "complete" | "budget-exhausted";
  expansionRounds?: number;
}

export interface RepositoryRustAssessmentReport {
  version: 1;
  createdAt: string;
  root: string;
  sourceIdentity: AssessmentSourceIdentity;
  assessmentScope: RepositoryRustAssessmentOptions;
  repositoryMethodCount: number;
  assessedCount: number;
  summary: {
    ready: number;
    blocked: number;
    generatedBoundaries: number;
    sqlBackedMethods: number;
    sqlSources: number;
    dynamicSqlSources: number;
    transactionalSqlSources: number;
    contextSqlSources: number;
    withUnknownNodes: number;
    adaptivelyExpanded: number;
    expansionBudgetExhausted: number;
    roles: Record<string, number>;
    operations: Record<string, number>;
    sqlSourceKinds: Record<string, number>;
    missingSqlContracts: Record<string, number>;
    findings: Record<string, number>;
  };
  sqlMetrics: RepositorySqlMetrics;
  methods: RepositoryMethodAssessment[];
  reportHash: string;
}

export async function assessJavaRepositoriesForRust(options: RepositoryRustAssessmentOptions): Promise<RepositoryRustAssessmentReport> {
  const analyzer = await createJavaEndpointAnalyzer(options.root, Boolean(options.includeTests));
  const sourceIdentity = await captureAssessmentSourceIdentity(analyzer.root);
  const candidates = analyzer.repositoryMethods.slice(0, positiveLimit(options.limit, analyzer.repositoryMethods.length));
  const methods = candidates.map((candidate): RepositoryMethodAssessment => {
    const expansion = options.adaptive ? analyzer.analyzeRepositoryMethodAdaptive(candidate, { initialDepth: options.maxDepth, initialEdges: options.maxEdges, maxDepth: options.maxExpansionDepth, maxEdges: options.maxExpansionEdges, maxRounds: options.maxExpansionRounds }) : undefined;
    const source = expansion?.report ?? analyzer.analyzeRepositoryMethod(candidate, { maxDepth: options.maxDepth, maxEdges: options.maxEdges });
    const { graph, plan } = createEndpointReplacementPlanFromJava(source);
    const sqlSources = source.sqlSources;
    const findings = [...plan.findings];
    if (candidate.implementation === "generated-boundary") findings.push("RP-REPOSITORY-GENERATED-IMPLEMENTATION");
    if (sqlSources.some((item) => item.source === "base-mapper")) findings.push("RP-SQL-BASE-MAPPER-GENERATED");
    if (sqlSources.some((item) => item.source === "provider")) findings.push("RP-SQL-PROVIDER-SOURCE");
    if (sqlSources.some((item) => item.dynamic)) findings.push("RP-SQL-DYNAMIC-SOURCE");
    if (expansion?.status === "budget-exhausted") findings.push("RP-GRAPH-EXPANSION-BUDGET-EXHAUSTED");
    const sqlContracts = sqlSources.map(toSqlContractRecord);
    return {
      id: candidate.id,
      file: candidate.file,
      line: candidate.line,
      repository: candidate.qualifiedClassName,
      method: candidate.methodName,
      signature: candidate.signature,
      role: candidate.role,
      implementation: candidate.implementation,
      workload: graph.workload,
      operation: classifyOperation(candidate.methodName, candidate.signature, sqlSources),
      status: candidate.implementation === "generated-boundary" ? "blocked" : plan.status,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externalBoundaries: graph.nodes.filter((node) => node.id.startsWith("external:")).length,
      unknownNodes: graph.nodes.filter((node) => node.kind === "unknown").length,
      sqlSources: sqlSources.length,
      dynamicSqlSources: sqlSources.filter((item) => item.dynamic).length,
      transactionalSqlSources: sqlSources.filter((item) => item.transactional).length,
      contextSqlSources: sqlSources.filter((item) => item.contextSignals.length > 0).length,
      sqlSourceKinds: [...new Set(sqlSources.map((item) => item.source))].sort(),
      missingSqlContracts: [...new Set(sqlSources.flatMap((item) => item.ownershipEvidence?.missingContracts ?? []))].sort(),
      sqlOwnershipEvidence: sqlSources
        .filter((item): item is typeof item & { ownershipEvidence: JavaSqlOwnershipEvidence } => Boolean(item.ownershipEvidence))
        .map((item) => ({ sourceId: item.id, evidence: item.ownershipEvidence })),
      sqlContracts,
      findings: [...new Set(findings)].sort(),
      expansionStatus: expansion?.status,
      expansionRounds: expansion?.rounds.length
    };
  });
  const sqlMetrics = createSqlMetrics(methods.flatMap((method) => method.sqlContracts));
  const assessmentScope = { ...options, root: analyzer.root };
  const base = { version: 1 as const, createdAt: new Date().toISOString(), root: analyzer.root, sourceIdentity, assessmentScope, repositoryMethodCount: analyzer.repositoryMethods.length, assessedCount: methods.length, summary: { ready: methods.filter((x) => x.status === "ready").length, blocked: methods.filter((x) => x.status === "blocked").length, generatedBoundaries: methods.filter((x) => x.implementation === "generated-boundary").length, sqlBackedMethods: methods.filter((x) => x.sqlSources > 0).length, sqlSources: methods.reduce((total, item) => total + item.sqlSources, 0), dynamicSqlSources: methods.reduce((total, item) => total + item.dynamicSqlSources, 0), transactionalSqlSources: methods.reduce((total, item) => total + item.transactionalSqlSources, 0), contextSqlSources: methods.reduce((total, item) => total + item.contextSqlSources, 0), withUnknownNodes: methods.filter((x) => x.unknownNodes > 0).length, adaptivelyExpanded: methods.filter((x) => (x.expansionRounds ?? 0) > 1).length, expansionBudgetExhausted: methods.filter((x) => x.expansionStatus === "budget-exhausted").length, roles: count(methods.map((x) => x.role)), operations: count(methods.map((x) => x.operation)), sqlSourceKinds: count(methods.flatMap((x) => x.sqlSourceKinds)), missingSqlContracts: count(methods.flatMap((x) => x.missingSqlContracts)), findings: count(methods.flatMap((x) => x.findings)) }, sqlMetrics, methods };
  return { ...base, reportHash: sha256(stableStringify({ ...base, createdAt: undefined })) };
}

export function renderRepositoryRustAssessment(report: RepositoryRustAssessmentReport): string {
  return ["# Repository Rust Assessment", "", `- Root: ${report.root}`, `- Repository methods: ${report.repositoryMethodCount}`, `- Assessed: ${report.assessedCount}`, `- Ready: ${report.summary.ready}`, `- Blocked: ${report.summary.blocked}`, `- Generated boundaries: ${report.summary.generatedBoundaries}`, `- SQL-backed methods: ${report.summary.sqlBackedMethods}`, `- SQL sources: ${report.summary.sqlSources}`, `- Dynamic SQL sources: ${report.summary.dynamicSqlSources}`, `- Transactional SQL sources: ${report.summary.transactionalSqlSources}`, `- Context SQL sources: ${report.summary.contextSqlSources}`, `- Report hash: ${report.reportHash}`, "", "## SQL contract metrics", "", `- Reviewable SQL records: ${report.sqlMetrics.reviewableRecords}`, `- Replay contract required: ${report.sqlMetrics.replayContractRequiredRecords}`, ...renderMetricGroup("Source kinds", report.sqlMetrics.sourceKinds), ...renderMetricGroup("Operations", report.sqlMetrics.operations), ...renderMetricGroup("Dynamic tags", report.sqlMetrics.dynamicTags), ...renderMetricGroup("Tables", report.sqlMetrics.tables), ...renderMetricGroup("Tenant and datasource context", report.sqlMetrics.contexts), ...renderMetricGroup("Transaction participation", report.sqlMetrics.transactionParticipation), ...renderMetricGroup("Unresolved SQL reasons", report.sqlMetrics.unresolvedReasons), "", "### Reviewable SQL records", "", ...renderSqlRecords(report.methods, "reviewable"), "", "### Replay contract required", "", ...renderSqlRecords(report.methods, "replay-contract-required"), "", "## Missing SQL contracts", "", ...renderCounts(report.summary.missingSqlContracts), "", "## Findings", "", ...renderCounts(report.summary.findings), ""].join("\n");
}

function toSqlContractRecord(source: JavaSqlSourceInfo): RepositorySqlContractRecord {
  const missingContracts: JavaSqlOwnershipContract[] = source.ownershipEvidence?.missingContracts ?? [];
  const unresolvedReasons = [
    ...missingContracts.map((contract) => `missing-${contract}`),
    ...(source.operation === "unknown" ? ["unknown-operation"] : []),
    ...(source.tables.length === 0 ? ["table-not-resolved"] : []),
    ...(source.source === "provider" && source.statementId === undefined ? ["provider-method-not-resolved"] : [])
  ];
  return { sourceId: source.id, source: source.source, operation: source.operation, dynamic: source.dynamic, dynamicTags: source.ownershipEvidence?.dynamicTags ?? [], tables: source.tables, contexts: source.contextSignals.filter((value: string) => value === "tenant" || value === "datasource"), transactional: source.transactional, missingContracts, unresolvedReasons: [...new Set(unresolvedReasons)].sort() as string[], reviewStatus: unresolvedReasons.length === 0 ? "reviewable" : "replay-contract-required" };
}

function createSqlMetrics(records: RepositorySqlContractRecord[]): RepositorySqlMetrics {
  return { records: records.length, reviewableRecords: records.filter((record) => record.reviewStatus === "reviewable").length, replayContractRequiredRecords: records.filter((record) => record.reviewStatus === "replay-contract-required").length, sourceKinds: count(records.map((record) => record.source)), operations: count(records.map((record) => record.operation)), dynamicTags: count(records.flatMap((record) => record.dynamicTags)), tables: count(records.flatMap((record) => record.tables)), contexts: count(records.flatMap((record) => record.contexts)), transactionParticipation: count(records.map((record) => record.transactional ? "transactional" : "not-transactional")), unresolvedReasons: count(records.flatMap((record) => record.unresolvedReasons)) };
}

function renderMetricGroup(title: string, values: Record<string, number>): string[] { return ["", `### ${title}`, "", ...(Object.keys(values).length > 0 ? renderCounts(values) : ["- none: 0"])]; }
function renderCounts(values: Record<string, number>): string[] { return Object.entries(values).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).map(([key,value]) => `- ${key}: ${value}`); }
function renderSqlRecords(methods: RepositoryMethodAssessment[], status: RepositorySqlContractRecord["reviewStatus"]): string[] {
  const lines = methods.flatMap((method) => method.sqlContracts.filter((record) => record.reviewStatus === status).map((record) => {
    const detail = status === "reviewable" ? `tables=${record.tables.join(",") || "none"}` : `missing=${record.unresolvedReasons.join(",")}`;
    return `- ${method.repository}.${method.method} -> ${record.sourceId} (${record.source}, ${record.operation}, ${detail})`;
  }));
  return lines.length > 0 ? lines : ["- none"];
}
function classifyOperation(name: string, signature: string, sqlSources: Array<{ operation: JavaSqlOperation; dynamic: boolean }>): JavaSqlOperation { if (sqlSources.some((source) => source.dynamic)) return "dynamic-sql"; const sqlOperations = [...new Set(sqlSources.map((source) => source.operation).filter((operation) => operation !== "unknown"))]; if (sqlOperations.length === 1) return sqlOperations[0] as JavaSqlOperation; const text = `${name} ${signature}`; if (/dynamic|sql/i.test(name) || /@(SelectProvider|InsertProvider|UpdateProvider|DeleteProvider)\b/.test(signature)) return "dynamic-sql"; if (/createTable|alterTable|dropTable|truncate/i.test(text)) return "ddl"; if (/delete|remove|purge/i.test(text)) return "delete"; if (/save|insert|update|upsert|batch|command|rename|recover|restore|clear|invalidate|backup/i.test(text)) return "write"; if (/find|get|query|select|list|page|count|exists|load|has|lookup|refField/i.test(text)) return "read"; return "unknown"; }
function count(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return Object.fromEntries(Object.entries(result).sort(([a],[b]) => a.localeCompare(b))); }
function positiveLimit(value: number | undefined, fallback: number): number { return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback; }
