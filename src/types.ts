export type SnapshotKind = "baseline" | "run";

export interface MigrationGuardConfig {
  schemaVersion: 1;
  targetRoot: string;
  artifactsDir: string;
  ignore: string[];
  checks: CheckConfig[];
  probes: BehaviorProbeConfig[];
  output: OutputConfig;
  compare: ComparePolicy;
  variables?: Record<string, string>;
}

export interface OutputConfig {
  maxOutputBytes: number;
}

export interface ComparePolicy {
  failOnCheckRegression: boolean;
  failOnProbeDiff: boolean;
}

export interface CheckConfig {
  name: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  critical?: boolean;
  enabled?: boolean;
  normalize?: CheckNormalizeConfig;
}

export interface CheckNormalizeConfig {
  stripAnsi?: boolean;
  trimWhitespace?: boolean;
  lineEndings?: "lf";
  presets?: Array<"vitest" | "vite" | "paths" | "timing">;
  replace?: Array<{
    pattern: string;
    replacement: string;
  }>;
}

export type BehaviorProbeConfig = CommandProbeConfig | HttpProbeConfig;

export interface BaseProbeConfig {
  name: string;
  timeoutMs?: number;
  normalize?: ProbeNormalizeConfig;
  enabled?: boolean;
}

export interface CommandProbeConfig extends BaseProbeConfig {
  type: "command";
  command: string;
  cwd?: string;
}

export interface HttpProbeConfig extends BaseProbeConfig {
  type: "http";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProbeNormalizeConfig {
  stripAnsi?: boolean;
  trimWhitespace?: boolean;
  lineEndings?: "lf";
  json?: {
    sortKeys?: boolean;
    ignoreFields?: string[];
  };
}

export interface LoadedConfig {
  path: string;
  baseDir: string;
  targetRoot: string;
  artifactsDir: string;
  config: MigrationGuardConfig;
}

export interface CommandExecutionResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface Snapshot {
  version: 1;
  kind: SnapshotKind;
  id: string;
  createdAt: string;
  root: string;
  configHash: string;
  scan: ScanSummary;
  checks: CheckResult[];
  probes: ProbeResult[];
}

export interface CheckResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "timed_out" | "error" | "skipped";
  critical: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutHash: string;
  stderrHash: string;
  normalizedStdoutHash?: string;
  normalizedStderrHash?: string;
  normalizedStdout?: string;
  normalizedStderr?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export type ProbeResult = CommandProbeResult | HttpProbeResult | SkippedProbeResult;

export interface BaseProbeResult {
  name: string;
  type: "command" | "http";
  status: "passed" | "failed" | "timed_out" | "error" | "skipped";
  durationMs: number;
  outputHash: string;
  normalizedOutput: string;
  error?: string;
}

export interface CommandProbeResult extends BaseProbeResult {
  type: "command";
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface HttpProbeResult extends BaseProbeResult {
  type: "http";
  url: string;
  method: string;
  httpStatus: number | null;
  responseHeaders: Record<string, string>;
  body: string;
}

export interface SkippedProbeResult extends BaseProbeResult {
  type: "command" | "http";
}

export interface ScanSummary {
  root: string;
  scannedAt: string;
  totalFiles: number;
  sourceFiles: number;
  testFiles: number;
  totalLines: number;
  fileTypes: Record<string, number>;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  stackHints: string[];
  riskFiles: RiskFile[];
  dependencyEdges: DependencyEdge[];
}

export interface RiskFile {
  path: string;
  score: number;
  reasons: string[];
  lines: number;
  importerCount: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface Difference {
  severity: "error" | "warn" | "info";
  area: "check" | "probe" | "scan";
  name: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

export interface CompareReport {
  passed: boolean;
  baselineId: string;
  currentId: string;
  createdAt: string;
  differences: Difference[];
}

export type MigrationRunStatus =
  | "initialized"
  | "planned"
  | "running"
  | "paused"
  | "verifying"
  | "replanning"
  | "completed"
  | "failed"
  | "blocked";

export type MigrationAutomationMode = "init-only" | "dry-run" | "manual" | "auto";

export interface MigrationRun {
  version: 1;
  id: string;
  goal: string;
  sourceRoot: string;
  targetRoot: string;
  artifactsDir: string;
  status: MigrationRunStatus;
  mode: MigrationAutomationMode;
  adapter?: string;
  issueProvider: "local" | "github" | "gitlab" | "jira" | "linear";
  createdAt: string;
  updatedAt: string;
  estimate: MigrationEstimate;
  latestCheckpointId?: string;
  latestBaselineId?: string;
  latestVerificationId?: string;
  finalReportPath?: string;
}

export interface MigrationEstimate {
  sourceFiles: number;
  testFiles: number;
  taskCount: number;
  riskLevel: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  estimatedVerificationRounds: number;
  notes: string[];
  updatedAt: string;
}

export type MigrationTaskStatus =
  | "discovered"
  | "planned"
  | "ready"
  | "running"
  | "changed"
  | "verifying"
  | "failed"
  | "replanned"
  | "blocked"
  | "rolled-back"
  | "accepted-diff"
  | "done";

export type MigrationTaskType =
  | "analyze"
  | "baseline"
  | "plan"
  | "code-change"
  | "verify"
  | "replan"
  | "report"
  | "adapter"
  | "contract";

export interface MigrationTask {
  id: string;
  title: string;
  description: string;
  type: MigrationTaskType;
  status: MigrationTaskStatus;
  priority: number;
  risk: "low" | "medium" | "high";
  owner: "engine" | "ai" | "human";
  dependsOn: string[];
  affectedFiles: string[];
  verificationCommands: string[];
  acceptanceCriteria: string[];
  executor?: string;
  issueId?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationTaskGraph {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  tasks: MigrationTask[];
}

export type MigrationIssueType = "epic" | "phase" | "task" | "risk" | "diff" | "failure";

export interface MigrationIssue {
  id: string;
  runId: string;
  taskId?: string;
  type: MigrationIssueType;
  title: string;
  body: string;
  status: MigrationTaskStatus | "open" | "closed";
  risk: "low" | "medium" | "high";
  owner: "engine" | "ai" | "human";
  affectedFiles: string[];
  externalUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceEvent {
  id: string;
  runId: string;
  taskId?: string;
  issueId?: string;
  type:
    | "run-created"
    | "task-created"
    | "task-updated"
    | "checkpoint-created"
    | "verification"
    | "failure"
    | "replan"
    | "rollback"
    | "sync"
    | "contract";
  message: string;
  data?: unknown;
  createdAt: string;
}

export interface MigrationCheckpoint {
  version: 1;
  id: string;
  runId: string;
  taskId?: string;
  createdAt: string;
  root: string;
  patchPath: string;
  verificationPath?: string;
  gitStatus: string;
  note?: string;
}

export interface ContractRequest {
  name: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ContractExchange {
  request: ContractRequest;
  status: number | null;
  headers: Record<string, string>;
  body: string;
  normalizedBody: string;
  bodyHash: string;
  durationMs: number;
  error?: string;
}

export interface ContractCorpus {
  version: 1;
  id: string;
  createdAt: string;
  source: string;
  exchanges: ContractExchange[];
}

export interface DualRunDifference {
  name: string;
  severity: "error" | "warn" | "info";
  message: string;
  source?: unknown;
  target?: unknown;
}

export interface DualRunReport {
  version: 1;
  id: string;
  createdAt: string;
  source: string;
  target: string;
  passed: boolean;
  sourceExchanges: ContractExchange[];
  targetExchanges: ContractExchange[];
  differences: DualRunDifference[];
}

export type MigrationActionPatchMode = "dry-run-only" | "manual-approval-required";
export type MigrationActionPatchTemplate = "renderer-probe" | "api-contract-probe" | "ui-smoke-probe";

export interface MigrationAction {
  id: string;
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  affectedFiles: string[];
  recommendedChecks: string[];
  patchMode: MigrationActionPatchMode;
  patchTemplate?: MigrationActionPatchTemplate;
}

export interface MigrationActionPlan {
  version: 1;
  runId: string;
  createdAt: string;
  goal: string;
  actions: MigrationAction[];
}

export interface ProposedPatch {
  version: 1;
  id: string;
  runId: string;
  taskId?: string;
  actionId?: string;
  createdAt: string;
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  patchPath: string;
  affectedFiles: string[];
  generatedFiles?: string[];
  recommendedChecks: string[];
  patchKind?: "task-placeholder" | "action-probe";
  applyState: "proposed" | "applied" | "rejected";
}
