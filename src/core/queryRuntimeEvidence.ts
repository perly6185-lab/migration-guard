const HASH = /^[a-f0-9]{64}$/;

export interface QueryRuntimeEvidenceInput {
  effects?: {
    writeCount: number;
    committed: boolean;
    rolledBackOnFailure: boolean;
    transactionFingerprint?: string;
    idempotencyKeyFingerprint?: string;
    duplicateWriteCount?: number;
  };
  cache?: {
    cacheKeyFingerprint: string;
    cachedBaselineHash: string;
    responseBeforeEnrichmentHash: string;
    responseAfterEnrichmentHash: string;
    cachedValueAfterEnrichmentHash: string;
  };
  async?: {
    timedOut: boolean;
    cancellationRequested: boolean;
    activeTasksAfterReturn: number;
    writesAfterReturn: number;
    eventsAfterReturn: number;
  };
  compatibility?: {
    entrypointResponseHashes?: string[];
    entrypointEffectHashes?: string[];
    legacyRequestSemanticHash?: string;
    targetRequestSemanticHash?: string;
  };
}

export interface QueryGateRequirements {
  requireEffectAtomicity?: boolean;
  requireIdempotency?: boolean;
  requireCacheIsolation?: boolean;
  requireAsyncQuiescence?: boolean;
  requireEntrypointParity?: boolean;
  requireRequestSemanticParity?: boolean;
}

export interface QueryGateReport {
  passed: boolean;
  blockers: string[];
}

export function gateQueryEvidence(
  input: QueryRuntimeEvidenceInput,
  requirements: QueryGateRequirements
): QueryGateReport {
  const blockers: string[] = [];
  if (requirements.requireEffectAtomicity || requirements.requireIdempotency) {
    validateEffects(input.effects, requirements, blockers);
  }
  if (requirements.requireCacheIsolation) validateCache(input.cache, blockers);
  if (requirements.requireAsyncQuiescence) validateAsync(input.async, blockers);
  if (requirements.requireEntrypointParity || requirements.requireRequestSemanticParity) {
    validateCompatibility(input.compatibility, requirements, blockers);
  }
  const unique = [...new Set(blockers)].sort();
  return { passed: unique.length === 0, blockers: unique };
}

function validateEffects(
  effects: QueryRuntimeEvidenceInput["effects"],
  requirements: QueryGateRequirements,
  blockers: string[]
): void {
  if (!effects) {
    blockers.push("query-effects-evidence-missing");
    return;
  }
  if (!Number.isInteger(effects.writeCount) || effects.writeCount < 0) blockers.push("query-write-count-invalid");
  if (requirements.requireEffectAtomicity) {
    if (effects.writeCount > 0 && !effects.committed) blockers.push("query-write-not-committed");
    if (!effects.rolledBackOnFailure) blockers.push("query-rollback-unproven");
    if (effects.writeCount > 0 && !HASH.test(effects.transactionFingerprint ?? "")) {
      blockers.push("query-transaction-fingerprint-missing");
    }
  }
  if (requirements.requireIdempotency) {
    if (!HASH.test(effects.idempotencyKeyFingerprint ?? "")) blockers.push("query-idempotency-key-missing");
    if (!Number.isInteger(effects.duplicateWriteCount) || Number(effects.duplicateWriteCount) !== 0) {
      blockers.push("query-idempotent-replay-failed");
    }
  }
}

function validateCache(cache: QueryRuntimeEvidenceInput["cache"], blockers: string[]): void {
  if (!cache) {
    blockers.push("query-cache-evidence-missing");
    return;
  }
  const hashes = [
    cache.cacheKeyFingerprint,
    cache.cachedBaselineHash,
    cache.responseBeforeEnrichmentHash,
    cache.responseAfterEnrichmentHash,
    cache.cachedValueAfterEnrichmentHash
  ];
  if (hashes.some((value) => !HASH.test(value))) {
    blockers.push("query-cache-hash-invalid");
    return;
  }
  if (cache.cachedBaselineHash !== cache.responseBeforeEnrichmentHash) {
    blockers.push("query-cache-baseline-mismatch");
  }
  if (cache.cachedBaselineHash !== cache.cachedValueAfterEnrichmentHash) {
    blockers.push("query-cache-mutated-by-response");
  }
}

function validateAsync(asyncEvidence: QueryRuntimeEvidenceInput["async"], blockers: string[]): void {
  if (!asyncEvidence) {
    blockers.push("query-async-evidence-missing");
    return;
  }
  if (!Number.isInteger(asyncEvidence.activeTasksAfterReturn) || asyncEvidence.activeTasksAfterReturn < 0
    || !Number.isInteger(asyncEvidence.writesAfterReturn) || asyncEvidence.writesAfterReturn < 0
    || !Number.isInteger(asyncEvidence.eventsAfterReturn) || asyncEvidence.eventsAfterReturn < 0) {
    blockers.push("query-async-count-invalid");
    return;
  }
  if (asyncEvidence.timedOut && !asyncEvidence.cancellationRequested) {
    blockers.push("query-timeout-cancellation-missing");
  }
  if (asyncEvidence.activeTasksAfterReturn !== 0) blockers.push("query-async-task-after-return");
  if (asyncEvidence.writesAfterReturn !== 0) blockers.push("query-write-after-return");
  if (asyncEvidence.eventsAfterReturn !== 0) blockers.push("query-event-after-return");
}

function validateCompatibility(
  compatibility: QueryRuntimeEvidenceInput["compatibility"],
  requirements: QueryGateRequirements,
  blockers: string[]
): void {
  if (!compatibility) {
    blockers.push("query-compatibility-evidence-missing");
    return;
  }
  if (requirements.requireEntrypointParity) {
    validateEqualHashSet(compatibility.entrypointResponseHashes, "query-entrypoint-response", blockers);
    validateEqualHashSet(compatibility.entrypointEffectHashes, "query-entrypoint-effect", blockers);
  }
  if (requirements.requireRequestSemanticParity) {
    if (!HASH.test(compatibility.legacyRequestSemanticHash ?? "")
      || !HASH.test(compatibility.targetRequestSemanticHash ?? "")) {
      blockers.push("query-request-semantic-hash-missing");
    } else if (compatibility.legacyRequestSemanticHash !== compatibility.targetRequestSemanticHash) {
      blockers.push("query-request-semantic-drift");
    }
  }
}

function validateEqualHashSet(values: string[] | undefined, label: string, blockers: string[]): void {
  if (!values || values.length < 2 || values.some((value) => !HASH.test(value))) {
    blockers.push(`${label}-hashes-missing`);
  } else if (new Set(values).size !== 1) {
    blockers.push(`${label}-mismatch`);
  }
}
