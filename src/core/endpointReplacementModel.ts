export type EndpointWorkloadKind = "query" | "query-with-effects" | "command" | "batch" | "sync" | "unknown";
export type BehaviorKind =
  | "entrypoint"
  | "validation"
  | "context-resolution"
  | "decision"
  | "calculation"
  | "state-read"
  | "state-write"
  | "external-call"
  | "transaction"
  | "event-publish"
  | "compensation"
  | "unknown";

export interface EndpointIdentity {
  runtime: string;
  method: string;
  path: string;
  symbol: string;
  file: string;
  line: number;
}

export interface BehaviorEvidence {
  file: string;
  line: number;
  symbol: string;
  detail?: string;
}

export interface BehaviorNode {
  id: string;
  kind: BehaviorKind;
  sourceKind: string;
  evidence: BehaviorEvidence;
  stateful: boolean;
  sideEffecting: boolean;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

export interface BehaviorEdge {
  from: string;
  to?: string;
  kind: "call" | "data" | "state" | "effect" | "unresolved";
  evidence: BehaviorEvidence;
}

export interface BehaviorGraphCompleteness {
  complete: boolean;
  edgeCapHit: boolean;
  depthCapHit: boolean;
  unresolvedEdges: number;
  unexpandedNodes: string[];
  findings: string[];
}

export interface BehaviorGraph {
  version: 1;
  createdAt: string;
  endpoint: EndpointIdentity;
  workload: EndpointWorkloadKind;
  nodes: BehaviorNode[];
  edges: BehaviorEdge[];
  completeness: BehaviorGraphCompleteness;
  graphHash: string;
}

export interface ContextRequirement {
  name: string;
  provenance: string;
  required: boolean;
  consumers: string[];
  source: "explicit" | "ambient" | "inferred";
}

export interface StateRequirement {
  resource: string;
  operations: Array<"read" | "write" | "delete" | "lock">;
  consumers: string[];
  transactional: boolean;
}

export interface EffectRequirement {
  kind: "database" | "cache" | "lock" | "event" | "transaction" | "sequence" | "audit" | "undo" | "external" | "clock" | "unknown";
  operation: string;
  sourceNode: string;
  orderingRequired: boolean;
  compensationRequired: boolean;
}

export interface EndpointReplacementContracts {
  contexts: ContextRequirement[];
  states: StateRequirement[];
  effects: EffectRequirement[];
  contractHash: string;
}

export type ReplacementOwnership = "target-owned" | "infrastructure-port" | "source-owned" | "reviewed-exclusion" | "unresolved";

export interface ReplacementBoundaryCandidate {
  id: string;
  title: string;
  nodeIds: string[];
  ownership: ReplacementOwnership;
  benefit: number;
  coupling: number;
  stateRisk: number;
  effectRisk: number;
  executable: boolean;
  blockers: string[];
}

export interface ReplacementScenario {
  id: string;
  title: string;
  category: "success" | "validation" | "context" | "branch" | "concurrency" | "fault" | "compatibility" | "scale";
  sourceNodes: string[];
  requiredDimensions: Array<"http" | "context" | "decisions" | "effects" | "state" | "events" | "concurrency" | "failures" | "performance">;
  reason: string;
}

export interface ReplacementImplementationWave {
  index: number;
  title: string;
  objective: string;
  boundaryIds: string[];
  requiredEvidence: string[];
  rollbackBoundary: string;
}

export interface EndpointReplacementPlan {
  version: 1;
  createdAt: string;
  endpoint: EndpointIdentity;
  workload: EndpointWorkloadKind;
  status: "ready" | "blocked";
  behaviorGraphHash: string;
  contracts: EndpointReplacementContracts;
  boundaries: ReplacementBoundaryCandidate[];
  scenarios: ReplacementScenario[];
  waves: ReplacementImplementationWave[];
  findings: string[];
  nextAction?: string;
  planHash: string;
}

export type ReplacementReadinessLevel = "RP0" | "RP1" | "RP2" | "RP3" | "RP4" | "RP5" | "RP6";

export interface EndpointReplacementEvidence {
  graphComplete: boolean;
  contractsComplete: boolean;
  ownershipComplete: boolean;
  replayPassed: boolean;
  concurrencyPassed: boolean;
  faultPassed: boolean;
  performancePassed: boolean;
  sourceOffPassed: boolean;
  rollbackPassed: boolean;
  evidenceCreatedAt: string;
  maxEvidenceAgeMs: number;
}

export interface EndpointReplacementReadiness {
  version: 1;
  status: "ready" | "blocked";
  achievedLevel: ReplacementReadinessLevel;
  levels: Array<{ level: Exclude<ReplacementReadinessLevel, "RP0">; passed: boolean; findings: string[] }>;
  issuePlan: Array<{ id: string; level: string; finding: string; title: string }>;
  nextAction?: string;
}
