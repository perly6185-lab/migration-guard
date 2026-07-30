import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { pathExists, writeJsonFile } from "./files.js";
import {
  initMigrationProject,
  loadMigrationProject,
  validateMigrationProject
} from "./migrationProject.js";

test("migration project init creates a reusable case package without overwriting by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-"));
  try {
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "orders-service",
      sourceRoot: path.join(root, "java"),
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/orders",
      method: "GET"
    });
    assert.equal(pkg.profile.projectId, "orders-service");
    assert.equal(pkg.profile.source.adapter, "java-spring");
    assert.equal(pkg.profile.source.access, "read-only");
    assert.equal(pkg.profile.entrypoints[0]?.path, "/api/orders");
    assert.deepEqual(pkg.semanticRules.runtimeGates, []);
    assert.equal(validateMigrationProject(pkg).valid, true);
    assert.equal(await pathExists(pkg.fixturesDir), true);
    assert.equal(await pathExists(pkg.evidenceDir), true);
    await assert.rejects(
      initMigrationProject({
        casesRoot: path.join(root, "cases"),
        projectId: "orders-service",
        sourceRoot: path.join(root, "java"),
        targetRoot: path.join(root, "rust")
      }),
      /already exists/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project rejects writable or overlapping reference source roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-read-only-"));
  try {
    const sourceRoot = path.join(root, "java");
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "read-only-source",
      sourceRoot,
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/update",
      method: "PUT"
    });
    await writeJsonFile(pkg.profilePath, {
      ...pkg.profile,
      source: { ...pkg.profile.source, access: "read-write" }
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-SOURCE-ACCESS-NOT-READ-ONLY/);

    await writeJsonFile(pkg.profilePath, {
      ...pkg.profile,
      target: { ...pkg.profile.target, root: path.join(sourceRoot, "generated") }
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-SOURCE-TARGET-OVERLAP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project rejects a reference source nested inside its case package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-case-overlap-"));
  try {
    await assert.rejects(
      initMigrationProject({
        casesRoot: path.join(root, "cases"),
        projectId: "nested-reference",
        sourceRoot: path.join(root, "cases", "nested-reference", "reference"),
        targetRoot: path.join(root, "rust"),
        endpoint: "/api/read",
        method: "GET"
      }),
      /MP-SOURCE-CASE-DIR-OVERLAP/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project validates runtime semantic gate bindings fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-runtime-gates-"));
  try {
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "runtime-gates",
      sourceRoot: path.join(root, "java"),
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/page"
    });
    await writeJsonFile(pkg.semanticRulesPath, {
      schemaVersion: 1,
      ownershipPolicy: { version: 1, rules: [] },
      classifications: [],
      runtimeGates: [{
        id: "bad-page-gate",
        entrypointId: "missing-entrypoint",
        scenarioPattern: "[",
        collectors: ["unsafe"],
        gates: {},
        decisionIds: ["missing-decision"]
      }]
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-RUNTIME-GATE-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project validates configured runtime scenarios fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-runtime-scenarios-"));
  try {
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "runtime-scenarios",
      sourceRoot: path.join(root, "java"),
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/calendar"
    });
    await writeJsonFile(pkg.semanticRulesPath, {
      ...pkg.semanticRules,
      runtimeScenarios: [{
        id: "calendar-view",
        entrypointId: pkg.profile.entrypoints[0]!.id,
        title: "Calendar view workflow",
        category: "compatibility",
        requiredDimensions: ["http", "decisions", "performance"],
        reason: "Preserve calendar-specific request and response semantics."
      }]
    });
    assert.equal((await loadMigrationProject(pkg.caseDir)).semanticRules.runtimeScenarios?.length, 1);

    await writeJsonFile(pkg.semanticRulesPath, {
      ...pkg.semanticRules,
      runtimeScenarios: [{
        id: "",
        entrypointId: "missing-entrypoint",
        title: "",
        category: "unknown",
        requiredDimensions: ["unknown"],
        reason: ""
      }]
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-RUNTIME-SCENARIO-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project validation fails closed on invalid project semantic rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-rules-"));
  try {
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "semantic-case",
      sourceRoot: path.join(root, "java"),
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/run"
    });
    await writeJsonFile(pkg.semanticRulesPath, {
      schemaVersion: 1,
      ownershipPolicy: { version: 1, rules: [] },
      classifications: [{
        id: "broken-rule",
        symbolPattern: "[",
        behavior: "not-a-behavior",
        reason: ""
      }]
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-SEMANTIC-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration project validation rejects unsafe semantic package selections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-project-packages-"));
  try {
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "package-case",
      sourceRoot: path.join(root, "java"),
      targetRoot: path.join(root, "rust"),
      endpoint: "/api/run"
    });
    await writeJsonFile(pkg.semanticRulesPath, {
      ...pkg.semanticRules,
      packageIds: ["builtin-java-zboss-compatibility"]
    });
    await assert.rejects(loadMigrationProject(pkg.caseDir), /MP-SEMANTIC-PACKAGES-INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
