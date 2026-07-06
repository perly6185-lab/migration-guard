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
  proposalGate: ProposalGateConfig;
  variables?: Record<string, string>;
}

export interface OutputConfig {
  maxOutputBytes: number;
}

export interface ComparePolicy {
  failOnCheckRegression: boolean;
  failOnProbeDiff: boolean;
}

export interface ProposalGateConfig {
  defaultPolicy: ProposalGatePolicyMode;
  batchPolicy: ProposalGatePolicyMode;
  retry?: Partial<Record<ProposalCheckKind, ProposalCheckRetryPolicy>>;
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
    | "contract"
    | "proposal";
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
export type ProposalCheckKind = "unit-test" | "type-check" | "ui-probe" | "contract-probe" | "build" | "lint" | "other";
export type ProposalCheckPhase = "pre-preview" | "preview" | "post-preview";
export type ProposalCheckResourceProfile = "default" | "cpu-bound" | "io-bound" | "browser";
export type ProposalCheckFailureCategory = "command-failed" | "timeout" | "error" | "flake-suspected";
export type ProposalGatePolicyMode = "fail-fast" | "collect-all";
export type ProposalGateEventType = "patch-check" | "check" | "preview";
export type ProposalGateEventStatus = "passed" | "failed" | "skipped";

export interface MigrationAction {
  id: string;
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  affectedFiles: string[];
  recommendedChecks: string[];
  patchMode: MigrationActionPatchMode;
  patchTemplate?: MigrationActionPatchTemplate;
  preview?: ProposalPreviewConfig;
  checkPlan?: ProposalCheckPlanItem[];
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
  checkPlan?: ProposalCheckPlanItem[];
  preview?: ProposalPreviewConfig;
  patchKind?: "task-placeholder" | "action-probe";
  applyState:
    | "proposed"
    | "verified"
    | "verification-failed"
    | "applied"
    | "applied-with-failed-checks"
    | "rolled-back"
    | "rollback-failed"
    | "rejected";
  lastVerificationPath?: string;
  lastRollbackPath?: string;
}

export interface ProposalPatchCheck {
  command: string;
  cwd: string;
  skipped: boolean;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ProposalCheckPlanItem {
  command: string;
  kind: ProposalCheckKind;
  phase: ProposalCheckPhase;
  timeoutMs?: number;
  critical?: boolean;
  retry?: ProposalCheckRetryPolicy;
  resourceProfile?: ProposalCheckResourceProfile;
  reason?: string;
}

export interface ProposalCheckRetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  retryOn?: ProposalCheckFailureCategory[];
}

export interface ProposalCheckAttempt {
  attempt: number;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: string;
  failureCategory?: ProposalCheckFailureCategory;
  flakeSuspected?: boolean;
}

export interface ProposalGatePolicy {
  mode: ProposalGatePolicyMode;
}

export interface ProposalCommandCheck {
  command: string;
  cwd: string;
  kind?: ProposalCheckKind;
  phase?: ProposalCheckPhase;
  critical?: boolean;
  resourceProfile?: ProposalCheckResourceProfile;
  retry?: ProposalCheckRetryPolicy;
  attemptCount?: number;
  attempts?: ProposalCheckAttempt[];
  failureCategory?: ProposalCheckFailureCategory;
  flakeSuspected?: boolean;
  remediationHints?: string[];
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: string;
}

export interface ProposalPreviewConfig {
  command: string;
  url: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ProposalPreviewResult {
  command: string;
  cwd: string;
  url: string;
  ready: boolean;
  status: number | null;
  durationMs: number;
  startedAt?: string;
  readyAt?: string;
  endedAt?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stopped: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  outputPath?: string;
}

export interface ProposalGateEvent {
  type: ProposalGateEventType;
  status: ProposalGateEventStatus;
  label: string;
  phase?: ProposalCheckPhase;
  kind?: ProposalCheckKind;
  command?: string;
  url?: string;
  outputPath?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  message?: string;
}

export interface ProposalVerificationReport {
  version: 1;
  id: string;
  runId: string;
  proposalId: string;
  mode: "verify" | "apply";
  createdAt: string;
  patchPath: string;
  applied: boolean;
  passed: boolean;
  patchCheck: ProposalPatchCheck;
  checkPlan?: ProposalCheckPlanItem[];
  gatePolicy?: ProposalGatePolicy;
  preview?: ProposalPreviewResult;
  checks: ProposalCommandCheck[];
  timeline: ProposalGateEvent[];
  replanIssueId?: string;
  replanTaskId?: string;
  outputPath: string;
}

export interface ProposalBatchItem {
  proposalId: string;
  title: string;
  risk: "low" | "medium" | "high";
  applyState: ProposedPatch["applyState"];
  checkPlan: Array<{
    kind: ProposalCheckKind;
    phase: ProposalCheckPhase;
    command: string;
  }>;
}

export interface ProposalBatchPlan {
  version: 1;
  id: string;
  runId: string;
  createdAt: string;
  proposals: ProposalBatchItem[];
  outputPath: string;
}

export interface ProposalBatchResult {
  proposalId: string;
  passed: boolean;
  state: ProposedPatch["applyState"];
  verificationPath?: string;
  rollbackPath?: string;
  firstFailedCheck?: {
    command: string;
    kind?: ProposalCheckKind;
    phase?: ProposalCheckPhase;
    failureCategory?: ProposalCheckFailureCategory;
    remediationHints?: string[];
  };
  error?: string;
}

export interface ProposalBatchSkippedItem {
  proposalId: string;
  reason: string;
}

export interface ProposalBatchReport {
  version: 1;
  id: string;
  runId: string;
  createdAt: string;
  planId: string;
  gatePolicy?: ProposalGatePolicy;
  passed: boolean;
  executedCount: number;
  skippedCount: number;
  firstFailedProposalId?: string;
  firstFailedVerificationPath?: string;
  results: ProposalBatchResult[];
  skipped: ProposalBatchSkippedItem[];
  stopReason?: string;
  nextCommand?: string;
  recommendedNextActions?: string[];
  outputPath: string;
}

export interface ProposalRollbackReport {
  version: 1;
  id: string;
  runId: string;
  proposalId: string;
  createdAt: string;
  patchPath: string;
  passed: boolean;
  reverseCheck: ProposalPatchCheck;
  reverseApply?: ProposalCommandCheck;
  outputPath: string;
}
