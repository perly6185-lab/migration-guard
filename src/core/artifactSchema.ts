export const CURRENT_ARTIFACT_SCHEMA_VERSION = 1;

export type ArtifactSchemaKind =
  | "proposal"
  | "proposal-verification-report"
  | "proposal-batch-plan"
  | "proposal-batch-report"
  | "proposal-replan-context"
  | "proposal-repair-acceptance";

export interface ArtifactSchemaKindDefinition {
  kind: ArtifactSchemaKind;
  requiredFields: string[];
  backfillRules: string[];
}

export interface ArtifactSchemaRegistry {
  version: 1;
  currentArtifactSchemaVersion: 1;
  frozenAtPhase: 72;
  kinds: ArtifactSchemaKindDefinition[];
}

export const ARTIFACT_SCHEMA_V1: ArtifactSchemaRegistry = {
  version: 1,
  currentArtifactSchemaVersion: CURRENT_ARTIFACT_SCHEMA_VERSION,
  frozenAtPhase: 72,
  kinds: [
    {
      kind: "proposal",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "id",
        "runId",
        "createdAt",
        "title",
        "summary",
        "risk",
        "patchPath",
        "affectedFiles",
        "generatedFiles",
        "recommendedChecks",
        "applyState"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill generatedFiles as []",
        "backfill exclusion metadata for rejected/ignored proposal"
      ]
    },
    {
      kind: "proposal-verification-report",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "id",
        "runId",
        "proposalId",
        "mode",
        "createdAt",
        "patchPath",
        "applied",
        "passed",
        "patchCheck",
        "checks",
        "timeline",
        "outputPath"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill timeline as []"
      ]
    },
    {
      kind: "proposal-batch-plan",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "id",
        "runId",
        "createdAt",
        "proposals",
        "excludedCount",
        "excluded",
        "outputPath"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill excluded as []",
        "backfill excludedCount"
      ]
    },
    {
      kind: "proposal-batch-report",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "id",
        "runId",
        "createdAt",
        "planId",
        "passed",
        "executedCount",
        "skippedCount",
        "excludedCount",
        "results",
        "skipped",
        "excluded",
        "outputPath"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill executedCount",
        "backfill skippedCount",
        "backfill skipped as []",
        "backfill excluded as []",
        "backfill excludedCount"
      ]
    },
    {
      kind: "proposal-replan-context",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "createdAt",
        "run",
        "proposal",
        "failure",
        "commands",
        "paths",
        "acceptanceChecklist"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill proposal.sourceSnippets as []",
        "backfill failure.latestFailedOutput from firstFailedCheck",
        "backfill acceptanceChecklist"
      ]
    },
    {
      kind: "proposal-repair-acceptance",
      requiredFields: [
        "version",
        "artifactSchemaVersion",
        "id",
        "runId",
        "createdAt",
        "sourceProposalId",
        "retryProposalId",
        "accepted",
        "retryVerificationPath",
        "checklist",
        "outputPath"
      ],
      backfillRules: [
        "set artifactSchemaVersion to 1",
        "backfill checklist as []",
        "backfill accepted"
      ]
    }
  ]
};

export function artifactSchemaDefinition(kind: ArtifactSchemaKind): ArtifactSchemaKindDefinition {
  const definition = ARTIFACT_SCHEMA_V1.kinds.find((item) => item.kind === kind);
  if (!definition) {
    throw new Error(`Unknown artifact schema kind: ${kind}`);
  }
  return definition;
}

export function unsupportedArtifactSchemaVersion(value: Record<string, unknown>): string | undefined {
  const version = value.artifactSchemaVersion;
  if (version === undefined) {
    return undefined;
  }
  if (version !== CURRENT_ARTIFACT_SCHEMA_VERSION) {
    return `unsupported artifactSchemaVersion ${String(version)}; current supported version is ${CURRENT_ARTIFACT_SCHEMA_VERSION}`;
  }
  return undefined;
}

export function missingFrozenArtifactFields(kind: ArtifactSchemaKind, value: Record<string, unknown>): string[] {
  const definition = artifactSchemaDefinition(kind);
  return definition.requiredFields.filter((field) => value[field] === undefined);
}
