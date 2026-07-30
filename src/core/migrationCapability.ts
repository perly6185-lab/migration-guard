export type MigrationCapabilityLevel =
  | "L0"
  | "L1"
  | "L2"
  | "L3"
  | "L4-A"
  | "L4-B"
  | "L4-C"
  | "L4";

export interface MigrationCapabilitySignals {
  sourceReadOnlyGuardPassed: boolean;
  analysisComplete: boolean;
  offlineContractPassed: boolean;
  implementationChecksPassed: boolean;
  scenarioContractPassed: boolean;
  dependencyProtocolChecksPassed: boolean;
  concreteAdaptersAttested: boolean;
  deployableServiceAttested: boolean;
  realEvidencePassed: boolean;
  dualReplayPassed: boolean;
  unifiedRealGatePassed: boolean;
}

export interface MigrationCapabilityAssessment {
  schemaVersion: 1;
  achieved: MigrationCapabilityLevel;
  next: MigrationCapabilityLevel | null;
  claims: Array<{
    level: MigrationCapabilityLevel;
    passed: boolean;
    blockers: string[];
  }>;
}

const LEVELS: MigrationCapabilityLevel[] = [
  "L0",
  "L1",
  "L2",
  "L3",
  "L4-A",
  "L4-B",
  "L4-C",
  "L4"
];

export function assessMigrationCapability(
  signals: MigrationCapabilitySignals
): MigrationCapabilityAssessment {
  const requirements: Record<MigrationCapabilityLevel, Array<[keyof MigrationCapabilitySignals, string]>> = {
    L0: [],
    L1: [
      ["sourceReadOnlyGuardPassed", "MG-CAPABILITY-SOURCE-GUARD-MISSING"],
      ["analysisComplete", "MG-CAPABILITY-ANALYSIS-INCOMPLETE"]
    ],
    L2: [
      ["offlineContractPassed", "MG-CAPABILITY-OFFLINE-CONTRACT-BLOCKED"]
    ],
    L3: [
      ["implementationChecksPassed", "MG-CAPABILITY-IMPLEMENTATION-CHECKS-BLOCKED"],
      ["scenarioContractPassed", "MG-CAPABILITY-SCENARIO-CONTRACT-BLOCKED"]
    ],
    "L4-A": [
      ["dependencyProtocolChecksPassed", "MG-CAPABILITY-DEPENDENCY-PROTOCOL-BLOCKED"]
    ],
    "L4-B": [
      ["concreteAdaptersAttested", "MG-CAPABILITY-CONCRETE-ADAPTERS-MISSING"],
      ["deployableServiceAttested", "MG-CAPABILITY-DEPLOYABLE-SERVICE-MISSING"]
    ],
    "L4-C": [
      ["realEvidencePassed", "MG-CAPABILITY-REAL-EVIDENCE-BLOCKED"],
      ["dualReplayPassed", "MG-CAPABILITY-DUAL-REPLAY-BLOCKED"]
    ],
    L4: [
      ["unifiedRealGatePassed", "MG-CAPABILITY-UNIFIED-REAL-GATE-BLOCKED"]
    ]
  };
  let achieved: MigrationCapabilityLevel = "L0";
  let priorPassed = true;
  const claims = LEVELS.map((level) => {
    const blockers = requirements[level]
      .filter(([signal]) => !signals[signal])
      .map(([, finding]) => finding);
    const passed = priorPassed && blockers.length === 0;
    if (passed) achieved = level;
    priorPassed = passed;
    return { level, passed, blockers };
  });
  const achievedIndex = LEVELS.indexOf(achieved);
  return {
    schemaVersion: 1,
    achieved,
    next: LEVELS[achievedIndex + 1] ?? null,
    claims
  };
}

export function migrationCapabilityRank(level: MigrationCapabilityLevel): number {
  return LEVELS.indexOf(level);
}
