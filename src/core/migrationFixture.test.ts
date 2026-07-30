import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeJsonFile } from "./files.js";
import {
  classifyMigrationFixture,
  inspectMigrationFixtures,
  validateMigrationFixture
} from "./migrationFixture.js";

test("fixture classification separates specification, template and real runtime evidence", () => {
  assert.equal(classifyMigrationFixture({ fixtureKind: "specification" }), "specification");
  assert.equal(classifyMigrationFixture({ fixtureKind: "template" }), "template");
  assert.equal(classifyMigrationFixture({ fixtureKind: "draft-runtime" }), "draft-runtime");
  assert.equal(classifyMigrationFixture({ request: {} }), "unclassified");
});

test("draft runtime fixtures are typed but cannot claim real evidence eligibility", () => {
  const draft = {
    schemaVersion: 1,
    fixtureKind: "draft-runtime",
    status: "draft",
    realEvidenceEligible: false,
    request: {}
  };
  assert.deepEqual(validateMigrationFixture(draft, { kind: "draft-runtime" }), []);
  assert.ok(validateMigrationFixture({ ...draft, realEvidenceEligible: true })
    .includes("MG-FIXTURE-NONREAL-CLAIMS-ELIGIBILITY"));
});

test("real runtime fixtures require lineage, readiness, expectations and redaction", () => {
  const fixture = {
    schemaVersion: 1,
    fixtureKind: "real-runtime",
    status: "ready",
    realEvidenceEligible: true,
    projectId: "p1",
    projectHash: "hash",
    entrypointId: "entry",
    scenarioId: "scenario",
    request: { body: {} },
    expectations: { batch: { requireProgressTerminal: true } },
    writeSafety: {
      mode: "disposable",
      disposable: true,
      writeApproved: true,
      allowedTenantIds: ["tenant-test"],
      allowedPanelIds: ["panel-test"],
      allowedTables: ["fixture_rows"],
      maxAffectedRows: 100,
      markerKey: "migration_guard_case_id",
      cleanupPredicate: "migration_guard_case_id = :caseId",
      cleanupVerificationRequired: true,
      expiresAt: "2999-01-01T00:00:00.000Z"
    }
  };
  assert.deepEqual(validateMigrationFixture(fixture, {
    kind: "real-runtime",
    projectId: "p1",
    projectHash: "hash",
    entrypointId: "entry",
    scenarioId: "scenario",
    batch: true,
    writeSafety: true
  }), []);
  assert.ok(validateMigrationFixture({ ...fixture, request: { password: "persisted" } })
    .includes("MG-FIXTURE-SENSITIVE-CONTENT"));
  assert.ok(validateMigrationFixture({ ...fixture, expectations: {} }, { kind: "real-runtime", batch: true })
    .includes("MG-FIXTURE-BATCH-EXPECTATION-MISSING"));
  assert.ok(validateMigrationFixture({ ...fixture, expectations: {} }, { kind: "real-runtime", page: true })
    .includes("MG-FIXTURE-PAGE-EXPECTATION-MISSING"));
  assert.ok(validateMigrationFixture({ ...fixture, writeSafety: undefined }, {
    kind: "real-runtime",
    batch: true,
    writeSafety: true
  }).includes("MG-FIXTURE-WRITE-SAFETY-MISSING"));
  assert.ok(validateMigrationFixture({
    ...fixture,
    writeSafety: { ...fixture.writeSafety, disposable: false, mode: "read-only" as const }
  }, {
    kind: "real-runtime",
    batch: true,
    writeSafety: true
  }).includes("MG-FIXTURE-WRITE-SCOPE-NOT-DISPOSABLE"));
});

test("fixture inspection excludes nested runtime collector specifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-fixtures-"));
  try {
    await writeJsonFile(path.join(root, "scenario", "fixture.draft.json"), {
      schemaVersion: 1,
      fixtureKind: "draft-runtime",
      status: "draft",
      realEvidenceEligible: false,
      request: {}
    });
    await mkdir(path.join(root, "scenario", "collectors"), { recursive: true });
    await writeJsonFile(path.join(root, "scenario", "collectors", "mysql.draft.json"), {
      protocol: "migration-guard.mysql-collector-spec/v1"
    });
    await mkdir(path.join(root, "java-runtime", "entry", "scenario.collectors"), { recursive: true });
    await writeJsonFile(path.join(root, "java-runtime", "entry", "scenario.collectors", "mysql.json"), {
      protocol: "migration-guard.mysql-collector-spec/v1"
    });
    await mkdir(path.join(root, "real-candidates", "bundle"), { recursive: true });
    await writeJsonFile(path.join(root, "real-candidates", "bundle", "request.json"), {
      rawRequest: true
    });

    const inspections = await inspectMigrationFixtures(root);
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0]?.kind, "draft-runtime");
    assert.equal(inspections[0]?.valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
