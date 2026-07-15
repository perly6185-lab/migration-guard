export type UiActionId = "readiness" | "verify" | "issue-control-dry-run";
export type UiJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type UiJobEventType = "queued" | "started" | "succeeded" | "failed" | "cancelled" | "recovered";

export interface UiJobEvent {
  at: string;
  type: UiJobEventType;
  message: string;
  artifactPaths?: string[];
}

export interface UiJob {
  version: 1;
  id: string;
  retryOf?: string;
  ownerPid?: number;
  ownerId?: string;
  attempt?: number;
  commandFingerprint?: string;
  fencingToken?: string;
  heartbeatAt?: string;
  leaseDurationMs?: number;
  recoveryReason?: UiJobRecoveryReason;
  action: UiActionId;
  status: UiJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  params: Record<string, string | number | string[] | undefined>;
  result?: unknown;
  error?: string;
  artifactPaths: string[];
  events: UiJobEvent[];
}

export type UiJobRecoveryReason = "process-dead" | "host-mismatch" | "heartbeat-stale" | "lease-expired" | "claim-missing";

export interface UiJobClaim {
  version: 2;
  ownerId: string;
  ownerPid: number;
  hostname: string;
  fencingToken: string;
  attempt: number;
  commandFingerprint: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseDurationMs: number;
}

export interface UiJobCreateResponse {
  version: 1;
  jobId: string;
  jobPath: string;
  job: UiJob;
}

export interface UiJobsReport {
  version: 1;
  filters: {
    status: "all" | "active" | UiJobStatus;
    runId?: string;
    limit: number;
  };
  totalCount: number;
  activeCount: number;
  jobs: UiJob[];
}

export interface CreateUiActionJobOptions {
  retryOf?: string;
}

export interface UiJobArtifact {
  path: string;
  kind: "json" | "markdown" | "log" | "text" | "other";
  label: string;
}

export interface UiJobDetailReport {
  version: 1;
  job: UiJob;
  retryRootId: string;
  retryChain: UiJob[];
  retryChildren: UiJob[];
  artifacts: UiJobArtifact[];
}

export interface UiJobGcReport {
  version: 1;
  apply: boolean;
  keepLatest: number;
  status: "terminal" | "all" | UiJobStatus;
  scannedCount: number;
  candidateCount: number;
  deletedCount: number;
  candidates: Array<{
    id: string;
    status: UiJobStatus;
    updatedAt: string;
    path: string;
  }>;
}
