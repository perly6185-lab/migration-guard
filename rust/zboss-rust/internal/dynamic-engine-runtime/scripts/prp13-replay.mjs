import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const workspaceRoot = path.resolve(serviceRoot, "..", "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const fixtureRoot = path.join(serviceRoot, "fixtures", "prp13");
const artifactRoot = path.join(repositoryRoot, "artifacts", "page-rust");
const outputPath =
  process.env.PRP13_REPLAY_OUTPUT
  ?? path.join(artifactRoot, "prp13-replay.json");
const binary =
  process.env.PRP13_MEMORY_DRIVER
  ?? path.join(
    workspaceRoot,
    "target",
    "debug",
    process.platform === "win32"
      ? "prp13-memory-driver.exe"
      : "prp13-memory-driver",
  );

await mkdir(artifactRoot, { recursive: true });
await writeJson(outputPath, {
  schemaVersion: 1,
  stage: "page-rust-prp13-replay",
  status: "running",
});

try {
  const inputs = await readJson("replay-inputs.json");
  const javaStub = await readJson("java-reference-stub.json");
  const decisions = await readJson("compatibility-decisions.json");
  validateContracts(inputs, javaStub, decisions);
  if (process.env.PRP13_INJECT_UNCLASSIFIED === "1") {
    javaStub.cases[0].response.total += 1;
  }

  const cases = [];
  for (const replayCase of inputs.cases) {
    const request = JSON.parse(
      await readFile(path.join(fixtureRoot, replayCase.requestFile), "utf8"),
    );
    const hashes = {
      requestHash: stableHash(request),
      snapshotHash: stableHash({
        metadata: inputs.metadata,
        snapshot: replayCase.snapshot,
      }),
      contextHash: stableHash(inputs.context),
    };
    const sourceCase = javaStub.cases.find(
      (candidate) => candidate.caseId === replayCase.caseId,
    );
    const rustRaw = runRustDriver(replayCase.caseId);
    const rustCase = normalizeRustObservation(rustRaw);
    const rustHashes = {
      requestHash: stableHash(rustRaw.inputEvidence.request),
      snapshotHash: stableHash(rustRaw.inputEvidence.snapshot),
      contextHash: stableHash(rustRaw.inputEvidence.context),
    };
    const inputEvidenceMatches =
      hashes.requestHash === rustHashes.requestHash
      && hashes.snapshotHash === rustHashes.snapshotHash
      && hashes.contextHash === rustHashes.contextHash;
    const contextMatches =
      stableStringify(rustRaw.context) === stableStringify(inputs.context)
      && stableStringify(rustRaw.inputEvidence.context)
        === stableStringify(inputs.context);
    const lineageValid = rustRaw.queryPlans.every(
      (plan) =>
        plan.lineageUnified === true
        && /^sha256:[0-9a-f]{64}$/.test(plan.queryFingerprint),
    );
    const differences = compareValues(sourceCase, rustCase)
      .filter((difference) => difference.path !== "caseId")
      .map((difference) => ({
        ...difference,
        ...classifyDifference(
          replayCase.caseId,
          difference,
          decisions.decisions,
        ),
      }));
    if (!contextMatches) {
      differences.push({
        path: "context",
        source: inputs.context,
        target: rustRaw.context,
        classification: "unclassified",
        decisionId: null,
      });
    }
    if (!inputEvidenceMatches) {
      differences.push({
        path: "inputEvidence",
        source: hashes,
        target: rustHashes,
        classification: "unclassified",
        decisionId: null,
      });
    }
    if (!lineageValid) {
      differences.push({
        path: "queryPlans[*].lineage",
        source: "unified-sha256",
        target: "invalid",
        classification: "unclassified",
        decisionId: null,
      });
    }
    const unclassified = differences.filter(
      (difference) => difference.classification === "unclassified",
    );
    cases.push({
      caseId: replayCase.caseId,
      status: unclassified.length === 0 ? "pass" : "fail",
      classification:
        differences.length === 0
          ? "compatible"
          : unclassified.length === 0
            ? "approved-correction"
            : "unclassified",
      inputHashes: hashes,
      hashParity: {
        javaRequestHash: hashes.requestHash,
        rustRequestHash: rustHashes.requestHash,
        javaSnapshotHash: hashes.snapshotHash,
        rustSnapshotHash: rustHashes.snapshotHash,
        javaContextHash: hashes.contextHash,
        rustContextHash: rustHashes.contextHash,
      },
      inputEvidenceMatches,
      contextMatches,
      responseCompared: true,
      queryPlanCompared: true,
      eventTraceCompared: true,
      javaObservation: {
        driverId: javaStub.driverId,
        provenance: javaStub.provenance,
        realJavaEvidence: false,
        response: sourceCase.response,
        queryPlans: sourceCase.queryPlans,
        eventTrace: sourceCase.eventTrace,
      },
      rustObservation: {
        driverId: rustRaw.driverId,
        provenance: rustRaw.provenance,
        transport: rustRaw.transport,
        response: rustCase.response,
        queryPlans: rustCase.queryPlans,
        queryFingerprints: rustRaw.queryPlans.map(
          (plan) => plan.queryFingerprint,
        ),
        lineageValid,
        eventTrace: rustCase.eventTrace,
      },
      differences,
      unclassifiedDifferences: unclassified.length,
    });
  }

  const usedDecisionIds = new Set(
    cases.flatMap((entry) =>
      entry.differences
        .map((difference) => difference.decisionId)
        .filter(Boolean)
    ),
  );
  const unusedDecisionIds = decisions.decisions
    .map((decision) => decision.decisionId)
    .filter((decisionId) => !usedDecisionIds.has(decisionId));
  if (unusedDecisionIds.length > 0) {
    throw new Error(
      `unused compatibility decisions: ${unusedDecisionIds.join(", ")}`,
    );
  }

  const unclassifiedDifferences = cases.reduce(
    (total, replayCase) =>
      total + replayCase.unclassifiedDifferences,
    0,
  );
  const failedCases = cases.filter(
    (replayCase) => replayCase.status !== "pass",
  ).length;
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp13-replay",
    status:
      failedCases === 0 && unclassifiedDifferences === 0
        ? "pass"
        : "fail",
    decision:
      failedCases === 0 && unclassifiedDifferences === 0
        ? "offline-replay-accepted"
        : "offline-replay-rejected",
    drivers: [
      {
        driverId: javaStub.driverId,
        provenance: javaStub.provenance,
        realEvidence: false,
      },
      {
        driverId: "rust-page-memory",
        provenance: "synthetic-offline-memory-execution",
        realEvidence: false,
      },
    ],
    fixtureHashes: {
      replayInputs: stableHash(inputs),
      javaReferenceStub: stableHash(javaStub),
      compatibilityDecisions: stableHash(decisions),
    },
    metrics: {
      casesPassed: cases.length - failedCases,
      casesFailed: failedCases,
      exactCompatibleCases: cases.filter(
        (replayCase) => replayCase.classification === "compatible",
      ).length,
      approvedCorrectionCases: cases.filter(
        (replayCase) =>
          replayCase.classification === "approved-correction",
      ).length,
      classifiedDifferences: cases.reduce(
        (total, replayCase) =>
          total
          + replayCase.differences.filter(
            (difference) =>
              difference.classification !== "unclassified",
          ).length,
        0,
      ),
      unclassifiedDifferences,
    },
    cases,
    limitations: [
      "java-reference-stub is frozen synthetic provenance and is not real Java runtime evidence",
      "rust-page-memory uses deterministic in-process adapters rather than real MySQL or Redis",
    ],
  };
  const report = {
    ...payload,
    reportHash: stableHash(payload),
  };
  await writeJson(outputPath, report);
  if (report.status !== "pass") process.exitCode = 1;
} catch (error) {
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-prp13-replay",
    status: "fail",
    decision: "offline-replay-rejected",
    error: error instanceof Error ? error.message : String(error),
  };
  await writeJson(outputPath, {
    ...payload,
    reportHash: stableHash(payload),
  });
  process.exitCode = 1;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(fixtureRoot, file), "utf8"));
}

function validateContracts(inputs, javaStub, decisions) {
  const expectedCases = [
    "standard-page",
    "refresh-operator",
    "child-form-page",
    "horizontal-page",
    "quality-text-filter",
    "upload-preview-page",
    "tenant-auth-context",
    "entrypoint-parity",
  ];
  if (
    inputs.schemaVersion !== 1
    || inputs.stage !== "PRP-13"
    || JSON.stringify(inputs.cases?.map((entry) => entry.caseId))
      !== JSON.stringify(expectedCases)
    || javaStub.schemaVersion !== 1
    || javaStub.stage !== "PRP-13"
    || javaStub.driverId !== "java-reference-stub"
    || javaStub.provenance
      !== "synthetic-frozen-stub-not-real-java-evidence"
    || JSON.stringify(javaStub.cases?.map((entry) => entry.caseId))
      !== JSON.stringify(expectedCases)
    || decisions.schemaVersion !== 1
    || decisions.stage !== "PRP-13"
    || !Array.isArray(decisions.decisions)
    || decisions.decisions.length !== 1
    || decisions.decisions[0].decisionId !== "PRP13-QUERY-ENGINE-001"
    || decisions.decisions[0].classification !== "approved-correction"
    || decisions.decisions[0].caseId !== "*"
    || decisions.decisions[0].path !== "queryPlans[*].engine"
    || decisions.decisions[0].source !== "mybatis-dynamic"
    || decisions.decisions[0].target !== "typed-query-plan"
    || decisions.decisions[0].approvedBy
      !== "page-rust-offline-completion-plan"
  ) {
    throw new Error("PRP-13 replay fixture contract is invalid");
  }
}

function runRustDriver(caseId) {
  const result = spawnSync(binary, ["--case", caseId], {
    cwd: serviceRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `rust-page-memory ${caseId} failed: ${
        result.error?.message ?? result.stderr
      }`,
    );
  }
  const observation = JSON.parse(result.stdout.trim());
  if (
    observation.schemaVersion !== 1
    || observation.driverId !== "rust-page-memory"
    || observation.caseId !== caseId
    || !observation.inputEvidence
    || typeof observation.inputEvidence !== "object"
  ) {
    throw new Error(`rust-page-memory ${caseId} returned invalid evidence`);
  }
  return observation;
}

function normalizeRustObservation(observation) {
  const responseData = observation.response.data;
  const pageItem = responseData?.respData?.[0];
  return {
    caseId: observation.caseId,
    response: {
      httpStatus: observation.httpStatus,
      code: observation.response.code,
      msg: observation.response.msg,
      reqId: responseData?.reqId ?? null,
      total: pageItem?.total ?? null,
      data: pageItem?.data ?? [],
      uploadTmpTableName:
        responseData?.uploadTmpTableName ?? null,
    },
    queryPlans: observation.queryPlans.map((plan) => ({
      engine: plan.engine,
      table: plan.table,
      wherePredicates: plan.wherePredicates,
      havingPredicates: plan.havingPredicates,
      groupBy: plan.groupBy,
      aggregates: plan.aggregates,
    })),
    eventTrace: observation.events.map((event) => event.kind),
  };
}

function compareValues(source, target, pathPrefix = "") {
  if (stableStringify(source) === stableStringify(target)) return [];
  if (
    source === null
    || target === null
    || typeof source !== "object"
    || typeof target !== "object"
  ) {
    return [{ path: pathPrefix, source, target }];
  }
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target)) {
      return [{ path: pathPrefix, source, target }];
    }
    const differences = [];
    const length = Math.max(source.length, target.length);
    for (let index = 0; index < length; index += 1) {
      differences.push(
        ...compareValues(
          source[index],
          target[index],
          `${pathPrefix}[${index}]`,
        ),
      );
    }
    return differences;
  }
  const keys = [...new Set([
    ...Object.keys(source),
    ...Object.keys(target),
  ])].sort();
  return keys.flatMap((key) =>
    compareValues(
      source[key],
      target[key],
      pathPrefix ? `${pathPrefix}.${key}` : key,
    ),
  );
}

function classifyDifference(caseId, difference, decisions) {
  const matching = decisions.filter(
    (candidate) =>
      (candidate.caseId === "*" || candidate.caseId === caseId)
      && wildcardPathMatches(candidate.path, difference.path)
      && stableStringify(candidate.source)
        === stableStringify(difference.source)
      && stableStringify(candidate.target)
        === stableStringify(difference.target),
  );
  const decision = matching.length === 1 ? matching[0] : null;
  return decision
    ? {
      classification: decision.classification,
      decisionId: decision.decisionId,
    }
    : {
      classification: "unclassified",
      decisionId: null,
    };
}

function wildcardPathMatches(pattern, actual) {
  const expression = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\[\\*\\]", "\\[\\d+\\]");
  return new RegExp(`^${expression}$`).test(actual);
}

function stableHash(value) {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
