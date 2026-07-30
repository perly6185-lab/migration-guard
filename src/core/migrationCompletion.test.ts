import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonFile, writeJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import {
  createMigrationCompletionContract,
  evaluateMigrationCompletionGate,
  prepareMigrationCompletion,
  validateMigrationCompletionContract,
  type MigrationCompletionControlArtifact,
  type MigrationCompletionContract,
  type MigrationCompletionEvidenceBundle
} from "./migrationCompletion.js";
import {
  initMigrationProject,
  loadMigrationProject,
  migrationProjectHash,
  type MigrationSemanticRules
} from "./migrationProject.js";

test("completion contract covers every capability signal and adds batch production controls", async () => {
  const fixture = await createProjectFixture();
  try {
    const pkg = await loadMigrationProject(fixture.caseDir);
    const semanticRules = await readJsonFile<MigrationSemanticRules>(pkg.semanticRulesPath);
    semanticRules.runtimeGates = [{
      id: "batch",
      entrypointId: pkg.profile.entrypoints[0].id,
      scenarioPattern: ".*",
      collectors: ["mysql"],
      gates: { batch: {} }
    }];
    await writeJsonFile(pkg.semanticRulesPath, semanticRules);
    const updated = await loadMigrationProject(fixture.caseDir);
    const contract = createMigrationCompletionContract(updated);
    assert.deepEqual(validateMigrationCompletionContract(contract, updated.profile.projectId), []);
    assert.ok(contract.controls.some((item) => item.id === "schema-transition.lease"));
    assert.ok(contract.controls.some((item) => item.id === "real.disposable-write-scope"));
    assert.ok(contract.controls.some((item) => item.id === "release.rollback-rehearsal"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("completion gate requires distinct typed evidence before reaching L4", async () => {
  const fixture = await createProjectFixture();
  try {
    const prepared = await prepareMigrationCompletion(fixture.caseDir);
    const pkg = await loadMigrationProject(fixture.caseDir);
    const contract = await readJsonFile<MigrationCompletionContract>(prepared.contractPath);
    const observedAt = new Date().toISOString();
    const evidencePath = path.join(fixture.caseDir, "completion-evidence.json");
    const sharedProofPath = path.join(pkg.evidenceDir, "completion-proof.json");
    await writeFile(sharedProofPath, JSON.stringify({ status: "passed", redactionComplete: true }));
    const sharedProofHash = sha256((await readFile(sharedProofPath)).toString("base64"));
    const unsafeBundle: MigrationCompletionEvidenceBundle = {
      schemaVersion: 1,
      projectId: pkg.profile.projectId,
      projectHash: migrationProjectHash(pkg),
      generatedAt: observedAt,
      controls: Object.fromEntries(contract.controls.map((item) => [
        item.id,
        {
          status: "passed",
          observedAt,
          artifacts: [{
            path: path.relative(fixture.caseDir, sharedProofPath),
            sha256: sharedProofHash,
            controlId: item.id,
            evidenceKind: item.evidenceKind
          }]
        }
      ]))
    };
    await writeJsonFile(evidencePath, unsafeBundle);
    const unsafe = await evaluateMigrationCompletionGate(fixture.caseDir, evidencePath);
    assert.equal(unsafe.status, "blocked");
    assert.ok(unsafe.findings.some((item) =>
      item.startsWith("MG-COMPLETION-CONTROL-ARTIFACT-REUSED:")
    ));
    assert.ok(unsafe.findings.some((item) =>
      item.startsWith("MG-COMPLETION-CONTROL-ARTIFACT-PROTOCOL-INVALID:")
    ));

    const controls: MigrationCompletionEvidenceBundle["controls"] = {};
    for (const item of contract.controls) {
      const proofPath = path.join(pkg.evidenceDir, "completion", `${item.id}.json`);
      await mkdir(path.dirname(proofPath), { recursive: true });
      const proof: MigrationCompletionControlArtifact = {
        schemaVersion: 1,
        protocol: "migration-guard.completion-control-evidence/v1",
        projectId: pkg.profile.projectId,
        projectHash: migrationProjectHash(pkg),
        controlId: item.id,
        evidenceKind: item.evidenceKind,
        status: "passed",
        observedAt,
        synthetic: false,
        realEligible: true,
        producer: {
          tool: "migration-guard-test",
          version: "1.0.0",
          command: `verify ${item.id}`,
          identity: "test-producer"
        },
        review: item.level === "L4-C" || item.level === "L4"
          ? {
              decision: "approved",
              identity: "independent-reviewer",
              reviewedAt: observedAt
            }
          : undefined,
        claims: { [claimForControl(item.id)]: true }
      };
      await writeFile(proofPath, JSON.stringify(proof));
      controls[item.id] = {
        status: "passed",
        observedAt,
        artifacts: [{
          path: path.relative(fixture.caseDir, proofPath),
          sha256: sha256((await readFile(proofPath)).toString("base64")),
          controlId: item.id,
          evidenceKind: item.evidenceKind
        }]
      };
    }
    const bundle: MigrationCompletionEvidenceBundle = {
      schemaVersion: 1,
      projectId: pkg.profile.projectId,
      projectHash: migrationProjectHash(pkg),
      generatedAt: observedAt,
      controls
    };
    await writeJsonFile(evidencePath, bundle);
    const passed = await evaluateMigrationCompletionGate(fixture.caseDir, evidencePath);
    assert.equal(passed.status, "passed");
    assert.equal(passed.capability.achieved, "L4");
    assert.equal(passed.controlSummary.passed, contract.controls.length);
    assert.ok(passed.reportHash);

    const firstArtifact = bundle.controls[contract.controls[0]!.id]!.artifacts[0]!;
    const proofPath = path.resolve(fixture.caseDir, firstArtifact.path);
    await writeFile(proofPath, JSON.stringify({ status: "changed" }));
    const blocked = await evaluateMigrationCompletionGate(fixture.caseDir, evidencePath);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.capability.achieved, "L0");
    assert.ok(blocked.findings.some((item) =>
      item.startsWith("MG-COMPLETION-CONTROL-ARTIFACT-HASH-MISMATCH:")
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("completion gate rejects stale project lineage and reference-source evidence paths", async () => {
  const fixture = await createProjectFixture();
  try {
    const prepared = await prepareMigrationCompletion(fixture.caseDir);
    const pkg = await loadMigrationProject(fixture.caseDir);
    const contract = await readJsonFile<MigrationCompletionContract>(prepared.contractPath);
    const sourceProof = path.join(fixture.sourceRoot, "source-proof.json");
    await writeFile(sourceProof, JSON.stringify({ status: "passed" }));
    const sourceHash = sha256((await readFile(sourceProof)).toString("base64"));
    const observedAt = new Date().toISOString();
    const evidencePath = path.join(fixture.caseDir, "completion-evidence.json");
    await writeJsonFile(evidencePath, {
      schemaVersion: 1,
      projectId: pkg.profile.projectId,
      projectHash: "stale",
      generatedAt: observedAt,
      controls: Object.fromEntries(contract.controls.map((item) => [
        item.id,
        {
          status: "passed",
          observedAt,
          artifacts: [{
            path: sourceProof,
            sha256: sourceHash,
            controlId: item.id,
            evidenceKind: item.evidenceKind
          }],
          note: item.id === contract.controls[0].id
            ? "Bearer abcdefghijklmnopqrstuvwxyz123456"
            : undefined
        }
      ]))
    } satisfies MigrationCompletionEvidenceBundle);
    const report = await evaluateMigrationCompletionGate(fixture.caseDir, evidencePath);
    assert.equal(report.status, "blocked");
    assert.ok(report.findings.includes("MG-COMPLETION-EVIDENCE-PROJECT-HASH-STALE"));
    assert.ok(report.findings.some((item) =>
      item.startsWith("MG-COMPLETION-CONTROL-ARTIFACT-PATH-UNSAFE:")
    ));
    assert.ok(report.findings.some((item) =>
      item.startsWith("MG-COMPLETION-ARTIFACT-SECRET:")
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createProjectFixture(): Promise<{
  root: string;
  caseDir: string;
  sourceRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-completion-"));
  const sourceRoot = path.join(root, "reference");
  const targetRoot = path.join(root, "target");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const pkg = await initMigrationProject({
    casesRoot: path.join(root, "cases"),
    projectId: "completion-fixture",
    sourceRoot,
    targetRoot,
    endpoint: "/batch"
  });
  return { root, caseDir: pkg.caseDir, sourceRoot };
}

function claimForControl(controlId: string): string {
  if (controlId.startsWith("production.adapter.")) return "productionEligible";
  return ({
    "source.read-only-snapshot": "sourceSnapshotUnchanged",
    "analysis.complete": "analysisComplete",
    "offline.contract": "offlineContractPassed",
    "implementation.checks": "implementationChecksPassed",
    "scenario.contract": "scenarioContractPassed",
    "dependency.protocol": "integrationPassed",
    "production.concrete-adapters": "productionEligible",
    "production.http-service": "productionEligible",
    "production.configuration": "integrationPassed",
    "production.health-readiness": "integrationPassed",
    "real.runtime-evidence": "realEvidencePassed",
    "real.dual-replay": "dualReplayPassed",
    "release.unified-real-gate": "unifiedRealGatePassed",
    "release.observability": "observabilityVerified",
    "release.canary": "canaryRehearsed",
    "release.rollback-rehearsal": "rollbackRehearsed",
    "release.source-off": "sourceOffVerified"
  } as Record<string, string>)[controlId] ?? "integrationPassed";
}
