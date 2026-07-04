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
