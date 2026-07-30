import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export interface RustProductionPathRequirements {
  requiredTraits: string[];
  requiredRouteFragments: string[];
  projectId?: string;
  requireVerificationEvidence?: boolean;
  verificationEvidencePath?: string;
}

export interface RustProductionPathAttestation {
  schemaVersion: 1;
  targetRoot: string;
  targetSourceHash: string;
  deployableService: boolean;
  concreteAdapters: boolean;
  buildVerified: boolean;
  runtimeVerified: boolean;
  productionEligible: boolean;
  evidence: {
    rustSourceFiles: number;
    httpRuntimeDetected: boolean;
    routeFragments: Record<string, boolean>;
    traitImplementations: Record<string, boolean>;
    verification: {
      required: boolean;
      path?: string;
      present: boolean;
      protocolValid: boolean;
      sourceHashMatches: boolean;
      buildLogVerified: boolean;
      runtimeLogVerified: boolean;
      routesExercised: Record<string, boolean>;
      referencedFiles: string[];
    };
  };
  findings: string[];
}

export interface RustProductionVerificationEvidence {
  protocol: "migration-guard.rust-production-verification/v1";
  projectId: string;
  targetSourceHash: string;
  synthetic: false;
  producer: {
    name: string;
    tool: string;
  };
  build: {
    command: string[];
    exitCode: number;
    finishedAt: string;
    logPath: string;
    logSha256: string;
  };
  runtime: {
    startedAt: string;
    observedAt: string;
    healthStatus: number;
    exercisedRoutes: string[];
    logPath: string;
    logSha256: string;
  };
}

const HTTP_RUNTIME_PATTERN = /\b(?:axum|actix_web|rocket|hyper|warp|poem)\b/;

export async function inspectRustProductionPath(
  targetRoot: string,
  requirements: RustProductionPathRequirements
): Promise<RustProductionPathAttestation> {
  const resolvedRoot = path.resolve(targetRoot);
  const findings: string[] = [];
  const cargoPath = path.join(resolvedRoot, "Cargo.toml");
  const sourceRoot = path.join(resolvedRoot, "src");
  const rustFiles = await listRustFiles(sourceRoot);
  const cargo = await readIfPresent(cargoPath);
  const productionSources = await Promise.all(rustFiles.map(async (file) =>
    productionOnlySource(await fs.readFile(file, "utf8"))
  ));
  const targetSourceHash = sha256(stableStringify([
    { file: "Cargo.toml", content: cargo },
    ...rustFiles.map((file, index) => ({
      file: path.relative(resolvedRoot, file).replaceAll("\\", "/"),
      content: productionSources[index]
    }))
  ]));
  const combined = `${cargo}\n${productionSources.join("\n")}`;
  const httpRuntimeDetected = HTTP_RUNTIME_PATTERN.test(combined);
  const routeFragments = Object.fromEntries(requirements.requiredRouteFragments.map((fragment) => [
    fragment,
    productionSources.some((source) => source.includes(fragment))
  ]));
  const traitImplementations = Object.fromEntries(requirements.requiredTraits.map((traitName) => [
    traitName,
    productionSources.some((source) => concreteTraitImplementationPattern(traitName).test(source))
  ]));
  if (!await pathExists(cargoPath)) findings.push("MG-PRODUCTION-PATH-CARGO-MISSING");
  if (rustFiles.length === 0) findings.push("MG-PRODUCTION-PATH-RUST-SOURCE-MISSING");
  if (!httpRuntimeDetected) findings.push("MG-PRODUCTION-PATH-HTTP-RUNTIME-MISSING");
  for (const [fragment, present] of Object.entries(routeFragments)) {
    if (!present) findings.push(`MG-PRODUCTION-PATH-ROUTE-MISSING:${fragment}`);
  }
  for (const [traitName, present] of Object.entries(traitImplementations)) {
    if (!present) findings.push(`MG-PRODUCTION-PATH-CONCRETE-ADAPTER-MISSING:${traitName}`);
  }
  const verification = await inspectVerificationEvidence(
    requirements,
    targetSourceHash
  );
  findings.push(...verification.findings);
  const deployableService = httpRuntimeDetected && Object.values(routeFragments).every(Boolean);
  const concreteAdapters = Object.values(traitImplementations).every(Boolean);
  return {
    schemaVersion: 1,
    targetRoot: resolvedRoot,
    targetSourceHash,
    deployableService,
    concreteAdapters,
    buildVerified: verification.buildVerified,
    runtimeVerified: verification.runtimeVerified,
    productionEligible: findings.length === 0,
    evidence: {
      rustSourceFiles: rustFiles.length,
      httpRuntimeDetected,
      routeFragments,
      traitImplementations,
      verification: verification.evidence
    },
    findings: [...new Set(findings)].sort()
  };
}

export function createRustProductionVerificationTemplate(
  projectId: string,
  targetSourceHash: string,
  requiredRouteFragments: string[]
): Omit<RustProductionVerificationEvidence, "synthetic"> & { synthetic: true } {
  return {
    protocol: "migration-guard.rust-production-verification/v1",
    projectId,
    targetSourceHash,
    synthetic: true,
    producer: {
      name: "replace-with-producer-identity",
      tool: "replace-with-build-and-runtime-harness"
    },
    build: {
      command: ["cargo", "build", "--locked"],
      exitCode: 1,
      finishedAt: "replace-with-ISO-8601",
      logPath: "production-build.log",
      logSha256: "replace-with-sha256"
    },
    runtime: {
      startedAt: "replace-with-ISO-8601",
      observedAt: "replace-with-ISO-8601",
      healthStatus: 0,
      exercisedRoutes: [...requiredRouteFragments],
      logPath: "production-runtime.log",
      logSha256: "replace-with-sha256"
    }
  };
}

async function inspectVerificationEvidence(
  requirements: RustProductionPathRequirements,
  targetSourceHash: string
): Promise<{
  buildVerified: boolean;
  runtimeVerified: boolean;
  evidence: RustProductionPathAttestation["evidence"]["verification"];
  findings: string[];
}> {
  const required = Boolean(requirements.requireVerificationEvidence);
  const evidencePath = requirements.verificationEvidencePath
    ? path.resolve(requirements.verificationEvidencePath)
    : undefined;
  const findings: string[] = [];
  const base = {
    required,
    ...(evidencePath ? { path: evidencePath } : {}),
    present: false,
    protocolValid: false,
    sourceHashMatches: false,
    buildLogVerified: false,
    runtimeLogVerified: false,
    routesExercised: Object.fromEntries(requirements.requiredRouteFragments.map((route) => [route, false])),
    referencedFiles: []
  };
  if (!evidencePath || !await pathExists(evidencePath)) {
    if (required) findings.push("MG-PRODUCTION-PATH-VERIFICATION-EVIDENCE-MISSING");
    return { buildVerified: false, runtimeVerified: false, evidence: base, findings };
  }
  let value: Partial<RustProductionVerificationEvidence>;
  try {
    value = await readJsonFile<Partial<RustProductionVerificationEvidence>>(evidencePath);
  } catch {
    findings.push("MG-PRODUCTION-PATH-VERIFICATION-EVIDENCE-INVALID");
    return { buildVerified: false, runtimeVerified: false, evidence: { ...base, present: true }, findings };
  }
  const protocolValid = value.protocol === "migration-guard.rust-production-verification/v1"
    && value.synthetic === false
    && typeof value.projectId === "string"
    && (!requirements.projectId || value.projectId === requirements.projectId)
    && Boolean(value.producer?.name?.trim())
    && Boolean(value.producer?.tool?.trim());
  if (!protocolValid) findings.push("MG-PRODUCTION-PATH-VERIFICATION-PROTOCOL-INVALID");
  const sourceHashMatches = value.targetSourceHash === targetSourceHash;
  if (!sourceHashMatches) findings.push("MG-PRODUCTION-PATH-VERIFICATION-SOURCE-HASH-MISMATCH");
  const buildShapeValid = Array.isArray(value.build?.command)
    && value.build.command[0] === "cargo"
    && value.build.command.includes("build")
    && value.build.command.includes("--locked")
    && value.build.exitCode === 0
    && validIsoTime(value.build.finishedAt);
  if (!buildShapeValid) findings.push("MG-PRODUCTION-PATH-BUILD-NOT-VERIFIED");
  const buildLogVerified = buildShapeValid
    && await verifyAdjacentLog(evidencePath, value.build?.logPath, value.build?.logSha256);
  if (buildShapeValid && !buildLogVerified) findings.push("MG-PRODUCTION-PATH-BUILD-LOG-INVALID");
  const observedAt = Date.parse(value.runtime?.observedAt ?? "");
  const startedAt = Date.parse(value.runtime?.startedAt ?? "");
  const runtimeShapeValid = validIsoTime(value.runtime?.startedAt)
    && validIsoTime(value.runtime?.observedAt)
    && observedAt >= startedAt
    && Number.isInteger(value.runtime?.healthStatus)
    && (value.runtime?.healthStatus ?? 0) >= 200
    && (value.runtime?.healthStatus ?? 0) < 400
    && Array.isArray(value.runtime?.exercisedRoutes);
  const routesExercised = Object.fromEntries(requirements.requiredRouteFragments.map((route) => [
    route,
    value.runtime?.exercisedRoutes?.includes(route) ?? false
  ]));
  if (!runtimeShapeValid || !Object.values(routesExercised).every(Boolean)) {
    findings.push("MG-PRODUCTION-PATH-RUNTIME-NOT-VERIFIED");
  }
  const runtimeLogVerified = runtimeShapeValid
    && await verifyAdjacentLog(evidencePath, value.runtime?.logPath, value.runtime?.logSha256);
  if (runtimeShapeValid && !runtimeLogVerified) findings.push("MG-PRODUCTION-PATH-RUNTIME-LOG-INVALID");
  const buildVerified = protocolValid && sourceHashMatches && buildShapeValid && buildLogVerified;
  const runtimeVerified = protocolValid
    && sourceHashMatches
    && runtimeShapeValid
    && runtimeLogVerified
    && Object.values(routesExercised).every(Boolean);
  return {
    buildVerified,
    runtimeVerified,
    evidence: {
      ...base,
      present: true,
      protocolValid,
      sourceHashMatches,
      buildLogVerified,
      runtimeLogVerified,
      routesExercised,
      referencedFiles: [
        evidencePath,
        adjacentLogPath(evidencePath, value.build?.logPath),
        adjacentLogPath(evidencePath, value.runtime?.logPath)
      ].filter((item): item is string => Boolean(item))
    },
    findings
  };
}

async function verifyAdjacentLog(
  evidencePath: string,
  relativePath: string | undefined,
  expectedHash: string | undefined
): Promise<boolean> {
  if (!relativePath || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const resolved = adjacentLogPath(evidencePath, relativePath);
  if (!resolved || !await pathExists(resolved)) return false;
  const content = await fs.readFile(resolved);
  return sha256(content.toString("base64")) === expectedHash;
}

function adjacentLogPath(evidencePath: string, relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const parent = path.dirname(evidencePath);
  const resolved = path.resolve(parent, relativePath);
  const relative = path.relative(parent, resolved);
  return !relative || relative.startsWith("..") || path.isAbsolute(relative) ? undefined : resolved;
}

function validIsoTime(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function productionOnlySource(source: string): string {
  const firstTestModule = source.search(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
  return firstTestModule >= 0 ? source.slice(0, firstTestModule) : source;
}

function concreteTraitImplementationPattern(traitName: string): RegExp {
  const escaped = traitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bimpl(?:\\s*<[^>{}]*>)?\\s+${escaped}\\s+for\\s+[A-Za-z_][A-Za-z0-9_:<> ,]*\\{`);
}

async function listRustFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listRustFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(child);
  }
  return files.sort();
}

async function readIfPresent(file: string): Promise<string> {
  return await pathExists(file) ? fs.readFile(file, "utf8") : "";
}
