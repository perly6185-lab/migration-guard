import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { sha256 } from "./hash.js";
import { inspectRustProductionPath } from "./productionPathAttestation.js";

test("production path inspection rejects trait implementations that exist only in tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "production-path-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), "[dependencies]\n");
    await writeFile(path.join(root, "src", "main.rs"), [
      "trait MysqlBatchExecutor {}",
      "#[cfg(test)]",
      "mod tests {",
      "  struct RecordingExecutor;",
      "  impl MysqlBatchExecutor for RecordingExecutor {}",
      "}"
    ].join("\n"));
    const report = await inspectRustProductionPath(root, {
      requiredTraits: ["MysqlBatchExecutor"],
      requiredRouteFragments: ["/batch"]
    });
    assert.equal(report.productionEligible, false);
    assert.ok(report.findings.includes(
      "MG-PRODUCTION-PATH-CONCRETE-ADAPTER-MISSING:MysqlBatchExecutor"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production path inspection requires HTTP runtime, route and concrete adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "production-path-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), "[dependencies]\naxum = \"0.8\"\n");
    await writeFile(path.join(root, "src", "main.rs"), [
      "struct MysqlExecutor;",
      "trait MysqlBatchExecutor {}",
      "impl MysqlBatchExecutor for MysqlExecutor {}",
      "const ROUTE: &str = \"/batch\";",
      "fn main() { let _ = axum::Router::new(); }"
    ].join("\n"));
    const report = await inspectRustProductionPath(root, {
      requiredTraits: ["MysqlBatchExecutor"],
      requiredRouteFragments: ["/batch"]
    });
    assert.equal(report.productionEligible, true);
    assert.equal(report.deployableService, true);
    assert.equal(report.concreteAdapters, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production path verification is bound to source, build/runtime logs and routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "production-path-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "Cargo.toml"), "[dependencies]\naxum = \"0.8\"\n");
    await writeFile(path.join(root, "src", "main.rs"), [
      "struct MysqlExecutor;",
      "trait MysqlBatchExecutor {}",
      "impl MysqlBatchExecutor for MysqlExecutor {}",
      "const ROUTE: &str = \"/batch\";",
      "fn main() { let _ = axum::Router::new(); }"
    ].join("\n"));
    const evidencePath = path.join(root, "evidence", "production-verification.json");
    await mkdir(path.dirname(evidencePath), { recursive: true });
    const initial = await inspectRustProductionPath(root, {
      requiredTraits: ["MysqlBatchExecutor"],
      requiredRouteFragments: ["/batch"]
    });
    const buildLog = Buffer.from("cargo build --locked: ok");
    const runtimeLog = Buffer.from("GET /batch: 200");
    await writeFile(path.join(root, "evidence", "build.log"), buildLog);
    await writeFile(path.join(root, "evidence", "runtime.log"), runtimeLog);
    await writeFile(evidencePath, JSON.stringify({
      protocol: "migration-guard.rust-production-verification/v1",
      projectId: "fixture",
      targetSourceHash: initial.targetSourceHash,
      synthetic: false,
      producer: { name: "ci", tool: "fixture-harness" },
      build: {
        command: ["cargo", "build", "--locked"],
        exitCode: 0,
        finishedAt: "2026-07-30T00:00:00.000Z",
        logPath: "build.log",
        logSha256: sha256(buildLog.toString("base64"))
      },
      runtime: {
        startedAt: "2026-07-30T00:00:01.000Z",
        observedAt: "2026-07-30T00:00:02.000Z",
        healthStatus: 200,
        exercisedRoutes: ["/batch"],
        logPath: "runtime.log",
        logSha256: sha256(runtimeLog.toString("base64"))
      }
    }));
    const verified = await inspectRustProductionPath(root, {
      requiredTraits: ["MysqlBatchExecutor"],
      requiredRouteFragments: ["/batch"],
      projectId: "fixture",
      requireVerificationEvidence: true,
      verificationEvidencePath: evidencePath
    });
    assert.equal(verified.productionEligible, true);
    assert.equal(verified.buildVerified, true);
    assert.equal(verified.runtimeVerified, true);
    assert.deepEqual(
      verified.evidence.verification.referencedFiles.map((file) => path.basename(file)).sort(),
      ["build.log", "production-verification.json", "runtime.log"]
    );
    await writeFile(path.join(root, "evidence", "runtime.log"), "tampered");
    const tampered = await inspectRustProductionPath(root, {
      requiredTraits: ["MysqlBatchExecutor"],
      requiredRouteFragments: ["/batch"],
      projectId: "fixture",
      requireVerificationEvidence: true,
      verificationEvidencePath: evidencePath
    });
    assert.equal(tampered.productionEligible, false);
    assert.ok(tampered.findings.includes("MG-PRODUCTION-PATH-RUNTIME-LOG-INVALID"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
