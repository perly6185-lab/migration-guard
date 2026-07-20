import path from "node:path";
import { promises as fs } from "node:fs";
import ts from "typescript";
import { pathExists, readJsonFile, toPosixPath } from "./files.js";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import type { MethodExtractionContract, MethodExtractionPatchPlan, MethodExtractionValueContract } from "./methodExtraction.js";

export type MethodExtractionTestFramework = "vitest" | "jest" | "node-test" | "unknown";
export type MethodExtractionTestPlanReasonCode =
  | "test-ready"
  | "patch-blocked"
  | "symbol-not-exported"
  | "unsupported-input-type"
  | "unsupported-method-construction"
  | "unknown-test-framework";

export interface MethodExtractionTestPlan {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  contractHash: string;
  patchHash?: string;
  ready: boolean;
  reasonCode: MethodExtractionTestPlanReasonCode;
  findings: Array<{ code: MethodExtractionTestPlanReasonCode; message: string }>;
  framework: MethodExtractionTestFramework;
  testCommand?: string;
  existingTests: string[];
  generatedTest?: {
    targetPath: string;
    artifactFileName: string;
    content: string;
    contentHash: string;
    inputFixtures: Record<string, string>;
    observationMarker: string;
  };
  coverage: {
    callable: boolean;
    inputs: boolean;
    output: boolean;
    thrownOrRejected: boolean;
    sideEffects: boolean;
    structuralOnly: boolean;
  };
}

export async function createMethodExtractionTestPlan(
  contract: MethodExtractionContract,
  patchPlan: MethodExtractionPatchPlan
): Promise<MethodExtractionTestPlan> {
  const contractHash = sha256(stableStringify(contract));
  const discovery = await discoverTestFramework(contract.root);
  const existingTests = contract.selected
    ? await findRelatedTests(contract.root, contract.selected.file)
    : [];
  const base: Omit<MethodExtractionTestPlan, "ready" | "reasonCode" | "findings" | "coverage"> = {
    version: 1,
    createdAt: new Date().toISOString(),
    root: contract.root,
    requestedSymbol: contract.requestedSymbol,
    contractHash,
    patchHash: patchPlan.patchHash,
    framework: discovery.framework,
    testCommand: discovery.command,
    existingTests
  };
  if (!patchPlan.ready || patchPlan.contractHash !== contractHash) {
    return blocked(base, "patch-blocked", "A ready patch bound to the exact extraction contract is required.");
  }
  if (!contract.selected?.exported) return blocked(base, "symbol-not-exported", "The selected function or containing class is not exported and cannot be invoked by a generated external characterization test.");
  if (discovery.framework === "unknown") {
    return blocked(base, "unknown-test-framework", "No supported Vitest, Jest or Node Test command was detected.");
  }

  const fixtures: Record<string, string> = {};
  for (const input of contract.inputs) {
    const fixture = fixtureForType(input);
    if (!fixture) {
      return blocked(base, "unsupported-input-type", `No deterministic fixture can be generated for ${input.name}: ${input.type}.`);
    }
    fixtures[input.name] = fixture;
  }
  const invocation = contract.selected.kind === "method" ? await inspectMethodInvocation(contract) : { importName: contract.selected.name, expression: contract.selected.name };
  if (!invocation) return blocked(base, "unsupported-method-construction", "The exported class requires constructor dependencies or the selected method is not publicly callable.");
  const generated = generateCharacterizationTest(contract, discovery.framework, fixtures, invocation);
  return {
    ...base,
    ready: true,
    reasonCode: "test-ready",
    findings: [{
      code: "test-ready",
      message: "Generated an executable characterization test that records returned or thrown behavior for baseline comparison."
    }],
    generatedTest: generated,
    coverage: {
      callable: true,
      inputs: true,
      output: true,
      thrownOrRejected: true,
      sideEffects: false,
      structuralOnly: false
    }
  };
}

export function renderMethodExtractionTestPlan(plan: MethodExtractionTestPlan): string {
  return [
    "# Method Extraction Test Plan",
    "",
    `- Status: ${plan.ready ? "ready" : "blocked"}`,
    `- Reason: ${plan.reasonCode}`,
    `- Symbol: ${plan.requestedSymbol}`,
    `- Framework: ${plan.framework}`,
    `- Test command: ${plan.testCommand ?? "unavailable"}`,
    `- Contract hash: ${plan.contractHash}`,
    `- Patch hash: ${plan.patchHash ?? "unavailable"}`,
    `- Structural only: ${plan.coverage.structuralOnly}`,
    "",
    "## Coverage",
    "",
    `- Callable: ${plan.coverage.callable}`,
    `- Inputs: ${plan.coverage.inputs}`,
    `- Output: ${plan.coverage.output}`,
    `- Thrown/rejected: ${plan.coverage.thrownOrRejected}`,
    `- Side effects: ${plan.coverage.sideEffects}`,
    "",
    "## Existing Tests",
    "",
    ...(plan.existingTests.length ? plan.existingTests.map((file) => `- ${file}`) : ["- none"]),
    "",
    "## Generated Test",
    "",
    ...(plan.generatedTest ? [
      `- Target path: ${plan.generatedTest.targetPath}`,
      `- Artifact file: ${plan.generatedTest.artifactFileName}`,
      `- Content hash: ${plan.generatedTest.contentHash}`,
      `- Observation marker: ${plan.generatedTest.observationMarker}`
    ] : ["- none"]),
    "",
    "## Findings",
    "",
    ...plan.findings.map((finding) => `- ${finding.code}: ${finding.message}`),
    ""
  ].join("\n");
}

async function discoverTestFramework(root: string): Promise<{ framework: MethodExtractionTestFramework; command?: string }> {
  const packageJson = await readJsonFile<{
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(root, "package.json")).catch(() => undefined);
  const test = packageJson?.scripts?.test;
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  if (test?.includes("vitest") || dependencies.vitest) return { framework: "vitest", command: "npm test" };
  if (test?.includes("jest") || dependencies.jest) return { framework: "jest", command: "npm test" };
  if (test?.includes("node --test")) return { framework: "node-test", command: "npm test" };
  return { framework: "unknown", command: test ? "npm test" : undefined };
}

async function findRelatedTests(root: string, sourceFile: string): Promise<string[]> {
  const parsed = path.posix.parse(toPosixPath(sourceFile));
  const candidates = [
    `${parsed.dir}/${parsed.name}.test.ts`,
    `${parsed.dir}/${parsed.name}.spec.ts`,
    `${parsed.dir}/__tests__/${parsed.name}.test.ts`
  ].map((candidate) => candidate.replace(/^\//, ""));
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) matches.push(candidate);
  }
  return matches;
}

function fixtureForType(input: MethodExtractionValueContract): string | undefined {
  const type = input.type.replace(/\s+/g, " ").trim();
  if (type === "string") return JSON.stringify("migration-guard");
  if (type === "number") return "7";
  if (type === "boolean") return "true";
  if (type === "bigint") return "7n";
  if (type === "undefined" || type.endsWith(" | undefined")) return "undefined";
  if (type === "null" || type.endsWith(" | null")) return "null";
  if (/^(readonly )?[^|]+\[\]$/.test(type) || /^ReadonlyArray<.+>$/.test(type) || /^Array<.+>$/.test(type)) return "[]";
  return undefined;
}

function generateCharacterizationTest(
  contract: MethodExtractionContract,
  framework: Exclude<MethodExtractionTestFramework, "unknown">,
  fixtures: Record<string, string>,
  invocation: { importName: string; expression: string }
): NonNullable<MethodExtractionTestPlan["generatedTest"]> {
  const selected = contract.selected!;
  const parsed = path.posix.parse(toPosixPath(selected.file));
  const targetPath = `${parsed.dir ? `${parsed.dir}/` : ""}${parsed.name}.migration-guard-contract.test.ts`;
  const modulePath = framework === "node-test" ? `./${parsed.name}.ts` : `./${parsed.name}.js`;
  const args = contract.inputs.map((input) => fixtures[input.name]).join(", ");
  const marker = `migration-guard-method-contract:${selected.symbol}`;
  const imports = framework === "vitest"
    ? `import { expect, test } from "vitest";`
    : framework === "jest"
      ? ""
      : `import test from "node:test";\nimport assert from "node:assert/strict";`;
  const assertion = framework === "vitest"
    ? "  expect(observation.status).toMatch(/^(returned|threw)$/);"
    : framework === "jest"
      ? "  expect(observation.status).toMatch(/^(returned|threw)$/);"
      : "  assert.match(observation.status, /^(returned|threw)$/);";
  const content = [
    imports,
    `import { ${invocation.importName} } from ${JSON.stringify(modulePath)};`,
    "",
    `test(${JSON.stringify(`characterizes ${selected.symbol} for method extraction`)}, async () => {`,
    "  let observation: { status: \"returned\" | \"threw\"; value: unknown };",
    "  try {",
    `    observation = { status: "returned", value: await ${invocation.expression}(${args}) };`,
    "  } catch (error) {",
    "    observation = { status: \"threw\", value: error instanceof Error ? { name: error.name, message: error.message } : error };",
    "  }",
    assertion,
    `  console.log(${JSON.stringify(marker)}, JSON.stringify(observation));`,
    "});",
    ""
  ].filter((line, index) => line || index > 0).join("\n");
  return {
    targetPath,
    artifactFileName: "method-extraction-generated-contract.test.ts",
    content,
    contentHash: sha256(content),
    inputFixtures: fixtures,
    observationMarker: marker
  };
}

async function inspectMethodInvocation(contract: MethodExtractionContract): Promise<{ importName: string; expression: string } | undefined> {
  const selected = contract.selected!;
  if (!selected.container) return undefined;
  const source = await fs.readFile(path.join(contract.root, selected.file), "utf8");
  const sourceFile = ts.createSourceFile(selected.file, source, ts.ScriptTarget.Latest, true, selected.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let result: { importName: string; expression: string } | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== selected.container) continue;
    const exported = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return undefined;
    const method = statement.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member)
      && ts.isIdentifier(member.name) && member.name.text === selected.name);
    if (!method || ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) return undefined;
    const isStatic = ts.getModifiers(method)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
    if (isStatic) return { importName: selected.container, expression: `${selected.container}.${selected.name}` };
    const constructor = statement.members.find(ts.isConstructorDeclaration);
    if (constructor?.parameters.some((parameter) => !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken)) return undefined;
    result = { importName: selected.container, expression: `new ${selected.container}().${selected.name}` };
  }
  return result;
}

function blocked(
  base: Omit<MethodExtractionTestPlan, "ready" | "reasonCode" | "findings" | "coverage">,
  code: Exclude<MethodExtractionTestPlanReasonCode, "test-ready">,
  message: string
): MethodExtractionTestPlan {
  return {
    ...base,
    ready: false,
    reasonCode: code,
    findings: [{ code, message }],
    coverage: {
      callable: false,
      inputs: false,
      output: false,
      thrownOrRejected: false,
      sideEffects: false,
      structuralOnly: true
    }
  };
}
