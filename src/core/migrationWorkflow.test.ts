import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathExists, readJsonFile, writeJsonFile } from "./files.js";
import type { BehaviorGraph } from "./endpointReplacementModel.js";
import { initMigrationProject } from "./migrationProject.js";
import {
  analyzeMigrationProject,
  evaluateMigrationOfflineGate,
  evaluateMigrationRealGate,
  scaffoldRustMigrationProject
} from "./migrationWorkflow.js";
import {
  assembleJavaRuntimeEvidence,
  gateJavaRuntimeBaseline,
  generateSyntheticJavaRuntimeEvidence,
  preflightJavaRuntimeEvidence,
  prepareJavaRuntimeEvidence,
  runJavaRuntimeEvidence
} from "./javaRuntimeEvidence.js";
import {
  prepareJavaRuntimeAuthoring,
  promoteJavaRuntimeFixture
} from "./javaRuntimeAuthoring.js";

test("project workflow analyzes Spring, scaffolds Rust and keeps both gates fail-closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-workflow-"));
  try {
    const sourceRoot = path.join(root, "java");
    const javaDir = path.join(sourceRoot, "src", "main", "java", "example");
    await mkdir(javaDir, { recursive: true });
    await writeFile(path.join(javaDir, "OrderController.java"), [
      "package example;",
      "import org.springframework.web.bind.annotation.GetMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "@RestController",
      "@RequestMapping(\"/api\")",
      "public class OrderController {",
      "  @GetMapping(\"/orders\")",
      "  public Object listOrders() { return \"ok\"; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(sourceRoot, "driver.mjs"), [
      "const [operation, scenarioId] = process.argv.slice(2);",
      "if (operation === 'collect') console.log(JSON.stringify({",
      "  protocol: 'migration-guard.runtime-observation/v1', fixtureKind: 'real-runtime',",
      "  scenarioId, fixtureHash: 'runtime-fixture', cleanup: { passed: true },",
      "  dimensions: {",
      "    http: { status: 200 }, context: {}, decisions: [], effects: [], state: {},",
      "    events: [], concurrency: {}, failures: {}, performance: {}",
      "  },",
      "  semantics: { page: { response: {",
      "    status: 200, pageNumber: 1, pageSize: 1, total: 1, returnedRows: 1,",
      "    rowKeys: ['row-1'], rowsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
      "    orderHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
      "  } } },",
      "}));"
    ].join("\n"));
    execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.email", "migration-guard@example.test"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.name", "Migration Guard"], { cwd: sourceRoot });
    execFileSync("git", ["add", "."], { cwd: sourceRoot });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: sourceRoot });
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "orders",
      sourceRoot,
      targetRoot: path.join(root, "rust-orders"),
      endpoint: "/api/orders",
      method: "GET"
    });
    const before = await evaluateMigrationOfflineGate(pkg.caseDir);
    assert.equal(before.status, "blocked");
    assert.ok(before.findings.includes("MG-OFFLINE-SPEC-FIXTURES-MISSING"));
    assert.ok(before.findings.some((item) => item.startsWith("MG-OFFLINE-GRAPH-MISSING")));

    await writeJsonFile(path.join(pkg.fixturesDir, "standard-success.json"), {
      schemaVersion: 1,
      fixtureKind: "specification",
      status: "ready",
      realEvidenceEligible: false,
      id: "standard-success",
      request: {},
      expected: { status: 200 }
    });
    await writeJsonFile(pkg.semanticRulesPath, {
      ...pkg.semanticRules,
      runtimeGates: [{
        id: "orders-page-baseline",
        entrypointId: pkg.profile.entrypoints[0]!.id,
        scenarioPattern: ".*",
        collectors: [],
        gates: { page: { requirePagination: true, expectedStatus: 200 } },
        decisionIds: []
      }]
    });
    const sourceStatusBefore = execFileSync("git", ["status", "--porcelain=v1"], { cwd: sourceRoot, encoding: "utf8" });
    const analysis = await analyzeMigrationProject(pkg.caseDir);
    assert.equal(analysis.entries.length, 1);
    assert.equal(analysis.sourceAccess, "read-only");
    assert.equal(analysis.semanticRulePackages?.length, 2);
    assert.equal(analysis.semanticRulePackages?.[0]?.packageId, "builtin-java-zboss-compatibility");
    assert.match(analysis.semanticRulePackages?.[0]?.packageVersion ?? "", /^\d+\.\d+\.\d+$/);
    assert.equal(analysis.semanticRulePackages?.[1]?.packageId, "builtin-java-core");
    assert.equal(analysis.semanticRulePackages?.[1]?.packageVersion, "1.0.0");
    assert.equal(await pathExists(analysis.entries[0]!.graphPath), true);
    assert.equal(await pathExists(analysis.entries[0]!.planPath), true);
    const behaviorGraph = await readJsonFile<BehaviorGraph>(analysis.entries[0]!.graphPath);
    assert.equal(behaviorGraph.classificationCoverage?.highRiskExplainablePercent, 100);
    assert.equal(behaviorGraph.nodes[0]?.classification?.source, "entrypoint");
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: sourceRoot, encoding: "utf8" }), sourceStatusBefore);

    const analysisIndexPath = path.join(pkg.evidenceDir, "analysis", "index.json");
    const originalIndex = await readJsonFile<Record<string, unknown>>(analysisIndexPath);
    const staleIndex = structuredClone(originalIndex) as {
      semanticRulePackages: Array<{ packageId: string; packageHash: string }>;
    };
    staleIndex.semanticRulePackages.find((item) =>
      item.packageId === "builtin-java-zboss-compatibility"
    )!.packageHash = "stale-semantic-package";
    await writeJsonFile(analysisIndexPath, staleIndex);
    const semanticDrift = await evaluateMigrationOfflineGate(pkg.caseDir);
    assert.ok(semanticDrift.findings.includes(
      "MG-OFFLINE-SEMANTIC-PACKAGE-MISMATCH:builtin-java-zboss-compatibility"
    ));
    await writeJsonFile(analysisIndexPath, originalIndex);
    const missingCoreIndex = structuredClone(originalIndex) as {
      semanticRulePackages: Array<{ packageId: string; packageHash: string }>;
    };
    missingCoreIndex.semanticRulePackages = missingCoreIndex.semanticRulePackages.filter((item) =>
      item.packageId !== "builtin-java-core"
    );
    await writeJsonFile(analysisIndexPath, missingCoreIndex);
    const missingCorePackage = await evaluateMigrationOfflineGate(pkg.caseDir);
    assert.ok(missingCorePackage.findings.includes(
      "MG-OFFLINE-SEMANTIC-PACKAGE-MISMATCH:builtin-java-core"
    ));
    await writeJsonFile(analysisIndexPath, originalIndex);

    const scaffold = await scaffoldRustMigrationProject(pkg.caseDir);
    assert.equal(scaffold.created.length, 5);
    assert.equal(await pathExists(path.join(scaffold.targetRoot, "Cargo.toml")), true);
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: sourceRoot, encoding: "utf8" }), sourceStatusBefore);
    await assert.rejects(scaffoldRustMigrationProject(pkg.caseDir), /would overwrite/);

    const offline = await evaluateMigrationOfflineGate(pkg.caseDir);
    assert.equal(offline.status, analysis.status === "ready" ? "passed" : "blocked");

    const runtimeContract = await prepareJavaRuntimeEvidence(pkg.caseDir);
    assert.equal(runtimeContract.entries.length, 1);
    assert.ok(runtimeContract.entries[0]!.scenarios.length > 0);
    assert.ok(runtimeContract.entries[0]!.scenarios.every((scenario) =>
      scenario.semanticGates.includes("page") && scenario.requiredCollectors.length === 0));
    const runtimeSchema = await readJsonFile<Record<string, unknown>>(
      path.join(pkg.evidenceDir, "runtime", "java", "runtime-evidence.schema.json")
    );
    assert.ok((runtimeSchema.$defs as Record<string, unknown>).pageEvidence);
    await writeJsonFile(path.join(pkg.evidenceDir, "runtime", "java", "deployment-observation.json"), {
      schemaVersion: 1,
      protocol: "migration-guard.runtime-environment-observation/v1",
      observedAt: new Date().toISOString(),
      redactionComplete: true,
      service: { host: "example.test", port: 8080 }
    });
    const authoring = await prepareJavaRuntimeAuthoring(pkg.caseDir);
    assert.equal(authoring.authoringReady, true);
    assert.equal(authoring.draftCount, runtimeContract.entries[0]!.scenarios.length);
    assert.equal(authoring.deploymentObservation?.path, "evidence/runtime/java/deployment-observation.json");
    const firstDraft = authoring.scenarios[0]!;
    const firstDraftPath = path.join(pkg.caseDir, firstDraft.draftFixture);
    const authoredFixture = await readJsonFile<Record<string, unknown>>(firstDraftPath);
    const firstScenarioContract = runtimeContract.entries
      .find((entry) => entry.id === firstDraft.entrypointId)!
      .scenarios.find((scenario) => scenario.id === firstDraft.scenarioId)!;
    const firstTemplate = await readJsonFile<Record<string, unknown>>(
      path.join(pkg.caseDir, firstScenarioContract.fixtureTemplate.path)
    );
    authoredFixture.request = { authored: "preserve-me" };
    authoredFixture.projectHash = "stale";
    authoredFixture.expectations = {};
    await writeJsonFile(firstDraftPath, authoredFixture);
    await prepareJavaRuntimeAuthoring(pkg.caseDir);
    const refreshedFixture = await readJsonFile<Record<string, unknown>>(firstDraftPath);
    assert.deepEqual(refreshedFixture.request, { authored: "preserve-me" });
    assert.equal(refreshedFixture.projectHash, runtimeContract.projectHash);
    assert.deepEqual(refreshedFixture.expectations, firstTemplate.expectations);
    refreshedFixture.request = {};
    refreshedFixture.expectations = { page: { requirePagination: true, expectedStatus: 200 } };
    await writeJsonFile(firstDraftPath, refreshedFixture);
    const promotion = await promoteJavaRuntimeFixture(
      pkg.caseDir,
      firstDraft.entrypointId,
      firstDraft.scenarioId,
      "migration-workflow-test"
    );
    assert.equal(await pathExists(promotion.fixturePath), true);
    for (const entry of runtimeContract.entries) {
      const fixtureDir = path.join(pkg.fixturesDir, "java-runtime", entry.id);
      await mkdir(fixtureDir, { recursive: true });
      for (const scenario of entry.scenarios) {
        if (entry.id === firstDraft.entrypointId && scenario.id === firstDraft.scenarioId) continue;
        const fixture = {
          schemaVersion: 1,
          fixtureKind: "real-runtime",
          status: "ready",
          realEvidenceEligible: true,
          projectId: pkg.profile.projectId,
          projectHash: runtimeContract.projectHash,
          entrypointId: entry.id,
          scenarioId: scenario.id,
          request: { headers: {}, body: { caseId: scenario.id } },
          expectations: { page: { requirePagination: true, expectedStatus: 200 } }
        };
        await writeJsonFile(path.join(fixtureDir, `${scenario.id}.json`), fixture);
      }
    }
    const environmentBlocked = await preflightJavaRuntimeEvidence(pkg.caseDir, {});
    assert.equal(environmentBlocked.staticReady, true);
    assert.equal(environmentBlocked.authoringReady, true);
    assert.equal(environmentBlocked.fixturesReady, true);
    assert.equal(environmentBlocked.environmentReady, false);
    const configuredEnvironment = Object.fromEntries(runtimeContract.requiredEnvironment.map((name) => {
      const operation = name.match(/^MG_JAVA_DRIVER_(.+)_COMMAND$/)?.[1]?.toLowerCase().replaceAll("_", "-");
      return [name, operation ? `node driver.mjs ${operation} {scenarioId} {fault}` : "configured"];
    }));
    const readyToRun = await preflightJavaRuntimeEvidence(pkg.caseDir, configuredEnvironment);
    assert.equal(readyToRun.status, "ready-to-run");

    const synthetic = await generateSyntheticJavaRuntimeEvidence(pkg.caseDir);
    assert.equal(synthetic.validation.valid, true);
    assert.equal(synthetic.validation.realEligible, false);
    assert.equal((await gateJavaRuntimeBaseline(pkg.caseDir, synthetic.outputPath)).status, "blocked");
    const syntheticRealGate = await evaluateMigrationRealGate(pkg.caseDir, synthetic.outputPath);
    assert.equal(syntheticRealGate.status, "blocked");
    assert.ok(syntheticRealGate.findings.includes("MG-JAVA-EVIDENCE-SYNTHETIC-NOT-REAL"));

    const missingReal = await evaluateMigrationRealGate(pkg.caseDir);
    assert.equal(missingReal.status, "blocked");
    assert.ok(missingReal.findings.includes("MG-REAL-EVIDENCE-MISSING"));
    const relabeled = await assembleJavaRuntimeEvidence(pkg.caseDir, "real", synthetic.bundle.entries);
    assert.equal(relabeled.validation.realEligible, false);
    assert.ok(relabeled.validation.findings.some((item) => item.includes("SYNTHETIC-CONTENT")));
    assert.ok(relabeled.validation.findings.some((item) => item.includes("PAGE-SEMANTICS-MISSING")));

    const runtime = await runJavaRuntimeEvidence(pkg.caseDir, configuredEnvironment);
    assert.equal(runtime.validation.realEligible, true);
    assert.equal(runtime.validation.findings.some((item) => item.includes("PAGE")), false);
    assert.ok(runtime.driverResults.every((item) => item.status === "passed"));
    assert.equal((await gateJavaRuntimeBaseline(pkg.caseDir, runtime.outputPath)).status, "passed");
    const real = await evaluateMigrationRealGate(pkg.caseDir, runtime.outputPath);
    assert.equal(real.status, "blocked");
    assert.ok(real.findings.some((item) => item.startsWith("RP3-OWNERSHIP-INCOMPLETE")));

    await writeFile(path.join(javaDir, "NewSource.java"), "package example; class NewSource {}\n");
    const stale = await preflightJavaRuntimeEvidence(pkg.caseDir, configuredEnvironment);
    assert.equal(stale.staticReady, false);
    assert.ok(stale.findings.some((item) => item.includes("source-identity")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real batch evidence requires declared collectors and batch semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-batch-evidence-"));
  try {
    const sourceRoot = path.join(root, "java");
    const javaDir = path.join(sourceRoot, "src", "main", "java", "example");
    await mkdir(javaDir, { recursive: true });
    await writeFile(path.join(javaDir, "BatchController.java"), [
      "package example;",
      "@RestController",
      "@RequestMapping(\"/api\")",
      "public class BatchController {",
      "  private OrderRepository orderRepository;",
      "  @PostMapping(\"/batch\")",
      "  public Object batchUpdate() { orderRepository.update(); return \"ok\"; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(javaDir, "OrderRepository.java"), [
      "package example;",
      "public class OrderRepository {",
      "  public void update() {}",
      "}"
    ].join("\n"));
    execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.email", "migration-guard@example.test"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.name", "Migration Guard"], { cwd: sourceRoot });
    execFileSync("git", ["add", "."], { cwd: sourceRoot });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: sourceRoot });
    const pkg = await initMigrationProject({
      casesRoot: path.join(root, "cases"),
      projectId: "batch-orders",
      sourceRoot,
      targetRoot: path.join(root, "unused-target"),
      endpoint: "/api/batch",
      method: "POST"
    });
    await writeJsonFile(path.join(pkg.fixturesDir, "contract.json"), {
      schemaVersion: 1,
      fixtureKind: "specification",
      status: "ready",
      realEvidenceEligible: false
    });
    await analyzeMigrationProject(pkg.caseDir);
    const contract = await prepareJavaRuntimeEvidence(pkg.caseDir);
    assert.equal(contract.entries[0]?.workload, "batch");
    assert.ok(contract.entries[0]?.requiredCollectors.includes("mysql"));
    const authoring = await prepareJavaRuntimeAuthoring(pkg.caseDir);
    const firstDraft = authoring.scenarios[0]!;
    const authoredFixture = await readJsonFile<Record<string, unknown>>(
      path.join(pkg.caseDir, firstDraft.draftFixture)
    );
    authoredFixture.request = {};
    await writeJsonFile(path.join(pkg.caseDir, firstDraft.draftFixture), authoredFixture);
    for (const [collector, relativePath] of Object.entries(firstDraft.collectorSpecs)) {
      const specPath = path.join(pkg.caseDir, relativePath!);
      const spec = await readJsonFile<Record<string, unknown>>(specPath);
      spec.status = "ready";
      if (collector === "mysql") spec.queries = [{ id: "snapshot", sql: "SELECT 1 AS snapshot" }];
      if (collector === "redis") spec.probes = [{ id: "lease", command: ["GET", "batch:lease"] }];
      await writeJsonFile(specPath, spec);
    }
    const promoted = await promoteJavaRuntimeFixture(
      pkg.caseDir,
      firstDraft.entrypointId,
      firstDraft.scenarioId,
      "batch-evidence-test"
    );
    for (const reference of Object.values(promoted.collectorSpecs)) {
      assert.ok(reference?.path.includes(".collectors/"));
      assert.equal(await pathExists(path.join(pkg.caseDir, reference!.path)), true);
    }
    for (const entry of contract.entries) {
      const fixtureDir = path.join(pkg.fixturesDir, "java-runtime", entry.id);
      await mkdir(fixtureDir, { recursive: true });
      for (const scenario of entry.scenarios) {
        if (entry.id === firstDraft.entrypointId && scenario.id === firstDraft.scenarioId) continue;
        await writeJsonFile(path.join(fixtureDir, `${scenario.id}.json`), {
          schemaVersion: 1,
          fixtureKind: "real-runtime",
          status: "ready",
          realEvidenceEligible: true,
          projectId: pkg.profile.projectId,
          projectHash: contract.projectHash,
          entrypointId: entry.id,
          scenarioId: scenario.id,
          request: {},
          expectations: {
            batch: {
              requireUndoCorrespondence: true,
              requireProgressTerminal: true,
              requireSharedLock: false,
              requireChunkIdempotency: false,
              requireTransactionTerminalOrdering: false
            }
          }
        });
      }
    }
    const synthetic = await generateSyntheticJavaRuntimeEvidence(pkg.caseDir);
    const relabeled = await assembleJavaRuntimeEvidence(pkg.caseDir, "real", synthetic.bundle.entries);
    assert.equal(relabeled.validation.realEligible, false);
    assert.ok(relabeled.validation.findings.some((item) => item.includes("MG-JAVA-EVIDENCE-COLLECTOR-MISSING")));
    assert.ok(relabeled.validation.findings.some((item) => item.includes("MG-JAVA-EVIDENCE-BATCH-SEMANTICS-MISSING")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
