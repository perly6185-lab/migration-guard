import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { toPosixPath } from "./files.js";

export type MethodExtractionEligibilityReasonCode =
  | "eligible"
  | "invalid-range"
  | "no-body"
  | "partial-statement-range"
  | "range-outside-body"
  | "symbol-ambiguous"
  | "symbol-not-found"
  | "unsupported-control-flow";

export interface MethodExtractionRange {
  startLine: number;
  endLine: number;
}

export interface MethodExtractionSymbol {
  symbol: string;
  name: string;
  container?: string;
  kind: "function" | "method" | "arrow-function";
  exported: boolean;
  file: string;
  line: number;
  endLine: number;
  bodyStartLine?: number;
  bodyEndLine?: number;
}

export interface MethodExtractionFinding {
  code: MethodExtractionEligibilityReasonCode;
  message: string;
  line?: number;
}

export interface MethodExtractionEligibility {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  requestedRange: MethodExtractionRange;
  eligible: boolean;
  reasonCode: MethodExtractionEligibilityReasonCode;
  findings: MethodExtractionFinding[];
  selected?: MethodExtractionSymbol;
  selectedStatements: Array<{
    kind: string;
    startLine: number;
    endLine: number;
    text: string;
  }>;
  sourceHash?: string;
  compilerOptionsHash: string;
  tsconfigPath?: string;
}

export type MethodExtractionContractReasonCode =
  | "contract-eligible"
  | "eligibility-blocked"
  | "incompatible-exit"
  | "source-drift"
  | "unsafe-nested-closure";

export interface MethodExtractionValueContract {
  name: string;
  type: string;
  declarationLine: number;
  useLines: number[];
  mode: "input" | "declared-output" | "reassigned-output";
}

export interface MethodExtractionContract {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  requestedRange: MethodExtractionRange;
  selected?: MethodExtractionSymbol;
  eligibilityHash: string;
  sourceHash?: string;
  eligible: boolean;
  reasonCode: MethodExtractionContractReasonCode;
  findings: Array<{ code: MethodExtractionContractReasonCode; message: string; line?: number }>;
  inputs: MethodExtractionValueContract[];
  outputs: MethodExtractionValueContract[];
  captures: { this: boolean; super: boolean; nestedClosure: boolean };
  controlFlow: {
    async: boolean;
    awaitLines: number[];
    throwLines: number[];
    returnLines: number[];
  };
}

export type MethodExtractionPatchReasonCode =
  | "patch-ready"
  | "contract-blocked"
  | "diagnostics-failed"
  | "invalid-extracted-name"
  | "source-drift"
  | "unsupported-declaration"
  | "unsupported-output-shape";

export interface MethodExtractionPatchPlan {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  extractedName: string;
  contractHash: string;
  sourceHash?: string;
  transformedSourceHash?: string;
  patchHash?: string;
  file?: string;
  ready: boolean;
  reasonCode: MethodExtractionPatchReasonCode;
  findings: Array<{ code: MethodExtractionPatchReasonCode; message: string }>;
  patch?: string;
  diagnostics: string[];
}

interface AstSymbolCandidate {
  descriptor: MethodExtractionSymbol;
  sourceFile: ts.SourceFile;
  declaration: ts.FunctionLikeDeclaration;
  body?: ts.ConciseBody;
}

export function extractMethodExtractionRangeFromGoal(goal: string): MethodExtractionRange | undefined {
  const match = goal.match(/\b(?:extract-lines|extract-range)\s*=\s*(\d+)\s*[-:]\s*(\d+)\b/i);
  if (!match) return undefined;
  return { startLine: Number(match[1]), endLine: Number(match[2]) };
}

export async function createMethodExtractionEligibility(
  root: string,
  requestedSymbol: string,
  requestedRange: MethodExtractionRange
): Promise<MethodExtractionEligibility> {
  const project = await loadTypeScriptProject(root);
  const compilerOptionsHash = sha256(stableStringify(project.compilerOptions));
  const base = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    root,
    requestedSymbol,
    requestedRange,
    selectedStatements: [],
    compilerOptionsHash,
    tsconfigPath: project.tsconfigPath
  };
  if (!validRange(requestedRange)) {
    return blocked(base, "invalid-range", "Extraction lines must be positive and startLine must not exceed endLine.");
  }

  const symbolCandidates = collectAstSymbols(project.program, root)
    .filter((candidate) => symbolMatches(candidate.descriptor, requestedSymbol));
  const implementations = symbolCandidates.filter((candidate) => candidate.body);
  const candidates = implementations.length === 1 ? implementations : symbolCandidates;
  if (candidates.length === 0) {
    return blocked(base, "symbol-not-found", `TypeScript symbol not found: ${requestedSymbol}`);
  }
  if (candidates.length > 1) {
    return blocked(base, "symbol-ambiguous", `TypeScript symbol is ambiguous: ${requestedSymbol}`);
  }

  const candidate = candidates[0]!;
  const selected = candidate.descriptor;
  const sourceHash = sha256(candidate.sourceFile.text);
  const selectedBase = { ...base, selected, sourceHash };
  if (!candidate.body || !ts.isBlock(candidate.body)) {
    return blocked(selectedBase, "no-body", "The selected declaration does not have a block body that can contain a reviewed statement range.");
  }

  if (requestedRange.startLine < selected.bodyStartLine! || requestedRange.endLine > selected.bodyEndLine!) {
    return blocked(selectedBase, "range-outside-body", "The extraction range must stay inside the selected function body.");
  }

  const statements = candidate.body.statements.filter((statement) => {
    const range = nodeLineRange(candidate.sourceFile, statement);
    return range.startLine >= requestedRange.startLine && range.endLine <= requestedRange.endLine;
  });
  const statementDetails = statements.map((statement) => statementDetail(candidate.sourceFile, statement));
  if (statements.length === 0
    || statementDetails[0]!.startLine !== requestedRange.startLine
    || statementDetails.at(-1)!.endLine !== requestedRange.endLine) {
    return blocked(
      { ...selectedBase, selectedStatements: statementDetails },
      "partial-statement-range",
      "The reviewed range must align exactly with one or more complete top-level statements in the selected body."
    );
  }

  const unsupported = findUnsupportedControlFlow(candidate.sourceFile, statements);
  if (unsupported.length > 0) {
    return {
      ...selectedBase,
      eligible: false,
      reasonCode: "unsupported-control-flow",
      findings: unsupported,
      selectedStatements: statementDetails
    };
  }

  return {
    ...selectedBase,
    eligible: true,
    reasonCode: "eligible",
    findings: [{ code: "eligible", message: "The symbol and extraction range are structurally eligible for data-flow analysis." }],
    selectedStatements: statementDetails
  };
}

export async function createMethodExtractionContract(
  eligibility: MethodExtractionEligibility
): Promise<MethodExtractionContract> {
  const eligibilityHash = sha256(stableStringify(eligibility));
  const base: Omit<MethodExtractionContract, "eligible" | "reasonCode" | "findings"> = {
    version: 1,
    createdAt: new Date().toISOString(),
    root: eligibility.root,
    requestedSymbol: eligibility.requestedSymbol,
    requestedRange: eligibility.requestedRange,
    selected: eligibility.selected,
    eligibilityHash,
    sourceHash: eligibility.sourceHash,
    inputs: [],
    outputs: [],
    captures: { this: false, super: false, nestedClosure: false },
    controlFlow: { async: false, awaitLines: [], throwLines: [], returnLines: [] }
  };
  if (!eligibility.eligible || !eligibility.selected) {
    return blockedContract(base, "eligibility-blocked", "AST eligibility must pass before extraction contract analysis.");
  }

  const project = await loadTypeScriptProject(eligibility.root);
  const candidates = collectAstSymbols(project.program, eligibility.root).filter((candidate) =>
    candidate.descriptor.symbol === eligibility.selected!.symbol
    && candidate.descriptor.file === eligibility.selected!.file
    && candidate.body && ts.isBlock(candidate.body));
  if (candidates.length !== 1) {
    return blockedContract(base, "source-drift", "The eligible AST symbol can no longer be resolved uniquely.");
  }
  const candidate = candidates[0]!;
  if (sha256(candidate.sourceFile.text) !== eligibility.sourceHash) {
    return blockedContract(base, "source-drift", "The source changed after eligibility analysis; recreate eligibility before continuing.");
  }

  const body = candidate.body as ts.Block;
  const selectedStatements = body.statements.filter((statement) => {
    const range = nodeLineRange(candidate.sourceFile, statement);
    return range.startLine >= eligibility.requestedRange.startLine && range.endLine <= eligibility.requestedRange.endLine;
  });
  const selectedStart = selectedStatements[0]!.getStart(candidate.sourceFile);
  const selectedEnd = selectedStatements.at(-1)!.getEnd();
  const checker = project.program.getTypeChecker();
  const declaredInside = collectDeclaredSymbols(selectedStatements, checker);
  const reads = new Map<ts.Symbol, { node: ts.Identifier; lines: Set<number> }>();
  const writes = new Map<ts.Symbol, { node: ts.Identifier; lines: Set<number> }>();
  const awaitLines = new Set<number>();
  const throwLines = new Set<number>();
  const returnLines = new Set<number>();
  let capturesThis = false;
  let capturesSuper = false;
  let nestedClosure = false;

  const visitSelected = (node: ts.Node, nestedFunctionDepth: number): void => {
    const line = nodeLineRange(candidate.sourceFile, node).startLine;
    if (node.kind === ts.SyntaxKind.ThisKeyword) capturesThis = true;
    if (node.kind === ts.SyntaxKind.SuperKeyword) capturesSuper = true;
    if (ts.isAwaitExpression(node)) awaitLines.add(line);
    if (ts.isThrowStatement(node)) throwLines.add(line);
    if (ts.isReturnStatement(node)) returnLines.add(line);
    const nextDepth = ts.isFunctionLike(node) && node !== candidate.declaration ? nestedFunctionDepth + 1 : nestedFunctionDepth;
    if (nextDepth > 0 && ts.isIdentifier(node) && identifierIsValueReference(node)) nestedClosure = true;
    if (ts.isIdentifier(node) && identifierIsValueReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) addSymbolUse(isWriteIdentifier(node) ? writes : reads, symbol, node, line);
    }
    ts.forEachChild(node, (child) => visitSelected(child, nextDepth));
  };
  selectedStatements.forEach((statement) => visitSelected(statement, 0));

  const laterUses = collectLaterSymbolUses(body, selectedEnd, checker, candidate.sourceFile);
  const functionScoped = new Set<ts.Symbol>();
  collectFunctionScopedSymbols(candidate.declaration, checker, functionScoped);
  const inputs: MethodExtractionValueContract[] = [];
  const outputs: MethodExtractionValueContract[] = [];

  for (const [symbol, use] of reads) {
    if (declaredInside.has(symbol) || !functionScoped.has(symbol)) continue;
    inputs.push(valueContract(symbol, use.node, use.lines, checker, candidate.sourceFile, "input"));
  }
  for (const symbol of declaredInside) {
    const later = laterUses.get(symbol);
    if (!later) continue;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const declarationName = (declaration as ts.NamedDeclaration | undefined)?.name;
    if (!declaration || !declarationName || !ts.isIdentifier(declarationName)) continue;
    outputs.push(valueContract(symbol, declarationName, later.lines, checker, candidate.sourceFile, "declared-output"));
  }
  for (const [symbol, use] of writes) {
    if (declaredInside.has(symbol) || !functionScoped.has(symbol) || !laterUses.has(symbol)) continue;
    outputs.push(valueContract(symbol, use.node, laterUses.get(symbol)!.lines, checker, candidate.sourceFile, "reassigned-output"));
    if (!inputs.some((input) => input.name === symbol.getName())) {
      inputs.push(valueContract(symbol, use.node, use.lines, checker, candidate.sourceFile, "input"));
    }
  }

  const controlFlow = {
    async: awaitLines.size > 0 || hasAsyncModifier(candidate.declaration),
    awaitLines: [...awaitLines].sort(numberSort),
    throwLines: [...throwLines].sort(numberSort),
    returnLines: [...returnLines].sort(numberSort)
  };
  const analyzed = {
    ...base,
    inputs: uniqueValueContracts(inputs),
    outputs: uniqueValueContracts(outputs),
    captures: { this: capturesThis, super: capturesSuper, nestedClosure },
    controlFlow
  };
  if (nestedClosure) {
    return blockedContract(analyzed, "unsafe-nested-closure", "The selected range contains a nested function closure that requires a later dedicated data-flow model.");
  }
  if (returnLines.size > 0 && selectedStatements.at(-1) !== body.statements.at(-1)) {
    return blockedContract(analyzed, "incompatible-exit", "A return inside a non-terminal extraction range cannot yet be represented safely.", [...returnLines][0]);
  }
  return {
    ...analyzed,
    eligible: true,
    reasonCode: "contract-eligible",
    findings: [{ code: "contract-eligible", message: "Inputs, outputs, captures and control-flow requirements were derived from TypeScript symbols." }]
  };
}

export function renderMethodExtractionContract(contract: MethodExtractionContract): string {
  return [
    "# Method Extraction Contract",
    "",
    `- Status: ${contract.eligible ? "eligible" : "blocked"}`,
    `- Reason: ${contract.reasonCode}`,
    `- Symbol: ${contract.requestedSymbol}`,
    `- Range: ${contract.requestedRange.startLine}-${contract.requestedRange.endLine}`,
    `- Eligibility hash: ${contract.eligibilityHash}`,
    `- Source hash: ${contract.sourceHash ?? "unavailable"}`,
    `- Async: ${contract.controlFlow.async}`,
    `- Captures this: ${contract.captures.this}`,
    `- Captures super: ${contract.captures.super}`,
    "",
    "## Inputs",
    "",
    ...(contract.inputs.length ? contract.inputs.map(renderValueContract) : ["- none"]),
    "",
    "## Outputs",
    "",
    ...(contract.outputs.length ? contract.outputs.map(renderValueContract) : ["- none"]),
    "",
    "## Control Flow",
    "",
    `- Await lines: ${contract.controlFlow.awaitLines.join(", ") || "none"}`,
    `- Throw lines: ${contract.controlFlow.throwLines.join(", ") || "none"}`,
    `- Return lines: ${contract.controlFlow.returnLines.join(", ") || "none"}`,
    "",
    "## Findings",
    "",
    ...contract.findings.map((finding) => `- ${finding.code}${finding.line ? ` at line ${finding.line}` : ""}: ${finding.message}`),
    ""
  ].join("\n");
}

export function extractMethodExtractionNameFromGoal(goal: string): string | undefined {
  return goal.match(/\b(?:extract-name|extracted-name)\s*=\s*([A-Za-z_$][\w$]*)\b/i)?.[1];
}

export async function createMethodExtractionPatchPlan(
  contract: MethodExtractionContract,
  extractedName: string
): Promise<MethodExtractionPatchPlan> {
  const contractHash = sha256(stableStringify(contract));
  const base: Omit<MethodExtractionPatchPlan, "ready" | "reasonCode" | "findings"> = {
    version: 1,
    createdAt: new Date().toISOString(),
    root: contract.root,
    requestedSymbol: contract.requestedSymbol,
    extractedName,
    contractHash,
    sourceHash: contract.sourceHash,
    diagnostics: []
  };
  if (!contract.eligible || !contract.selected) {
    return blockedPatch(base, "contract-blocked", "A passing extraction contract is required before patch generation.");
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(extractedName)) {
    return blockedPatch(base, "invalid-extracted-name", `Invalid extracted method name: ${extractedName}`);
  }
  if (contract.outputs.length > 1) {
    return blockedPatch(base, "unsupported-output-shape", "The first patch generator supports at most one value crossing the extraction boundary.");
  }

  const project = await loadTypeScriptProject(contract.root);
  const candidates = collectAstSymbols(project.program, contract.root).filter((candidate) =>
    candidate.descriptor.symbol === contract.selected!.symbol
    && candidate.descriptor.file === contract.selected!.file
    && candidate.body && ts.isBlock(candidate.body));
  if (candidates.length !== 1) {
    return blockedPatch(base, "source-drift", "The contracted AST symbol can no longer be resolved uniquely.");
  }
  const candidate = candidates[0]!;
  if (sha256(candidate.sourceFile.text) !== contract.sourceHash) {
    return blockedPatch(base, "source-drift", "The source changed after contract analysis; recreate the extraction artifacts.");
  }
  if (candidate.descriptor.kind === "arrow-function") {
    return blockedPatch(base, "unsupported-declaration", "Arrow-function extraction remains analysis-only in the first atomic patch boundary.");
  }
  if (collectAstSymbols(project.program, contract.root).some((item) =>
    item.descriptor.file === candidate.descriptor.file
    && item.descriptor.container === candidate.descriptor.container
    && item.descriptor.name === extractedName)) {
    return blockedPatch(base, "invalid-extracted-name", `The extracted name already exists in the target container: ${extractedName}`);
  }

  const transformed = transformExtractionSource(candidate, contract, extractedName);
  const diagnostics = validateTransformedSource(project, candidate.sourceFile.fileName, transformed);
  if (diagnostics.length > 0) {
    return blockedPatch(
      { ...base, file: candidate.descriptor.file, diagnostics },
      "diagnostics-failed",
      "The transformed source introduces TypeScript diagnostics."
    );
  }
  const patch = createReplaceFilePatch(candidate.descriptor.file, candidate.sourceFile.text, transformed);
  return {
    ...base,
    file: candidate.descriptor.file,
    transformedSourceHash: sha256(transformed),
    patchHash: sha256(patch),
    ready: true,
    reasonCode: "patch-ready",
    findings: [{ code: "patch-ready", message: "The atomic insertion and call-site replacement passed TypeScript diagnostics." }],
    patch,
    diagnostics: []
  };
}

export function renderMethodExtractionPatchPlan(plan: MethodExtractionPatchPlan): string {
  return [
    "# Method Extraction Patch Plan",
    "",
    `- Status: ${plan.ready ? "ready" : "blocked"}`,
    `- Reason: ${plan.reasonCode}`,
    `- Symbol: ${plan.requestedSymbol}`,
    `- Extracted name: ${plan.extractedName}`,
    `- File: ${plan.file ?? "unresolved"}`,
    `- Contract hash: ${plan.contractHash}`,
    `- Source hash: ${plan.sourceHash ?? "unavailable"}`,
    `- Transformed source hash: ${plan.transformedSourceHash ?? "unavailable"}`,
    `- Patch hash: ${plan.patchHash ?? "unavailable"}`,
    "",
    "## Findings",
    "",
    ...plan.findings.map((finding) => `- ${finding.code}: ${finding.message}`),
    "",
    "## Diagnostics",
    "",
    ...(plan.diagnostics.length ? plan.diagnostics.map((diagnostic) => `- ${diagnostic}`) : ["- none"]),
    ""
  ].join("\n");
}

export function renderMethodExtractionEligibility(result: MethodExtractionEligibility): string {
  return [
    "# Method Extraction Eligibility",
    "",
    `- Status: ${result.eligible ? "eligible" : "blocked"}`,
    `- Reason: ${result.reasonCode}`,
    `- Symbol: ${result.requestedSymbol}`,
    `- Range: ${result.requestedRange.startLine}-${result.requestedRange.endLine}`,
    `- Location: ${result.selected ? `${result.selected.file}:${result.selected.line}-${result.selected.endLine}` : "unresolved"}`,
    `- Source hash: ${result.sourceHash ?? "unavailable"}`,
    `- Compiler options hash: ${result.compilerOptionsHash}`,
    `- tsconfig: ${result.tsconfigPath ?? "defaults"}`,
    "",
    "## Findings",
    "",
    ...result.findings.map((finding) => `- ${finding.code}${finding.line ? ` at line ${finding.line}` : ""}: ${finding.message}`),
    "",
    "## Selected Statements",
    "",
    ...(result.selectedStatements.length > 0
      ? result.selectedStatements.map((statement) => `- ${statement.kind} ${statement.startLine}-${statement.endLine}: ${statement.text}`)
      : ["- none"]),
    ""
  ].join("\n");
}

async function loadTypeScriptProject(root: string): Promise<{
  program: ts.Program;
  compilerOptions: ts.CompilerOptions;
  tsconfigPath?: string;
}> {
  const tsconfigPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (tsconfigPath) {
    const loaded = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (loaded.error) throw new Error(formatDiagnostic(loaded.error));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(tsconfigPath));
    if (parsed.errors.length > 0) throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
    return {
      program: createProgramWithParents(parsed.fileNames, parsed.options),
      compilerOptions: parsed.options,
      tsconfigPath: toPosixPath(path.relative(root, tsconfigPath)) || "tsconfig.json"
    };
  }
  const rootNames = await collectTypeScriptFiles(root);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true
  };
  return { program: createProgramWithParents(rootNames, compilerOptions), compilerOptions };
}

function createProgramWithParents(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  sourceOverrides: ReadonlyMap<string, string> = new Map()
): ts.Program {
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const text = sourceOverrides.get(path.resolve(fileName)) ?? ts.sys.readFile(fileName);
    if (text === undefined) {
      onError?.(`Cannot read TypeScript source file: ${fileName}`);
      return undefined;
    }
    return ts.createSourceFile(fileName, text, languageVersion, true, scriptKindForFile(fileName));
  };
  return ts.createProgram({ rootNames, options, host });
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && [".git", ".migration-guard", "build", "dist", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort();
}

function collectAstSymbols(program: ts.Program, root: string): AstSymbolCandidate[] {
  const candidates: AstSymbolCandidate[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isInsideRoot(root, sourceFile.fileName)) continue;
    const visit = (node: ts.Node, classContainer?: string): void => {
      const candidate = astSymbolCandidate(root, sourceFile, node, classContainer);
      if (candidate) candidates.push(candidate);
      const nextContainer = (ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name
        ? node.name.text
        : classContainer;
      ts.forEachChild(node, (child) => visit(child, nextContainer));
    };
    visit(sourceFile);
  }
  return candidates;
}

function astSymbolCandidate(
  root: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  classContainer?: string
): AstSymbolCandidate | undefined {
  let name: string | undefined;
  let container: string | undefined;
  let kind: MethodExtractionSymbol["kind"] = "function";
  let declaration: ts.FunctionLikeDeclaration | undefined;

  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.text;
    declaration = node;
  } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    name = node.name.text;
    container = classContainer;
    kind = "method";
    declaration = node;
  } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    name = node.name.text;
    kind = "arrow-function";
    declaration = node.initializer;
  } else if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)
    && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    name = node.name.text;
    container = classContainer;
    kind = "arrow-function";
    declaration = node.initializer;
  }
  if (!name || !declaration) return undefined;

  const declarationRange = nodeLineRange(sourceFile, node);
  const body = declaration.body;
  const bodyRange = body ? nodeLineRange(sourceFile, body) : undefined;
  return {
    descriptor: {
      symbol: container ? `${container}.${name}` : name,
      name,
      container,
      kind,
      exported: isExportedDeclaration(node),
      file: toPosixPath(path.relative(root, sourceFile.fileName)),
      line: declarationRange.startLine,
      endLine: declarationRange.endLine,
      bodyStartLine: bodyRange?.startLine,
      bodyEndLine: bodyRange?.endLine
    },
    sourceFile,
    declaration,
    body
  };
}

function findUnsupportedControlFlow(sourceFile: ts.SourceFile, statements: readonly ts.Statement[]): MethodExtractionFinding[] {
  const findings: MethodExtractionFinding[] = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    let label: string | undefined;
    if (ts.isBreakStatement(node)) label = "break";
    else if (ts.isContinueStatement(node)) label = "continue";
    else if (ts.isLabeledStatement(node)) label = "labeled statement";
    else if (ts.isYieldExpression(node)) label = "yield";
    if (label) {
      const line = nodeLineRange(sourceFile, node).startLine;
      const key = `${label}:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          code: "unsupported-control-flow",
          line,
          message: `${label} is not supported by the first extraction eligibility boundary.`
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  statements.forEach(visit);
  return findings;
}

function statementDetail(sourceFile: ts.SourceFile, statement: ts.Statement) {
  const range = nodeLineRange(sourceFile, statement);
  return {
    kind: ts.SyntaxKind[statement.kind],
    ...range,
    text: statement.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180)
  };
}

function nodeLineRange(sourceFile: ts.SourceFile, node: ts.Node): MethodExtractionRange {
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  };
}

function blocked<T extends Omit<MethodExtractionEligibility, "eligible" | "reasonCode" | "findings">>(
  base: T,
  code: Exclude<MethodExtractionEligibilityReasonCode, "eligible">,
  message: string
): MethodExtractionEligibility {
  return { ...base, eligible: false, reasonCode: code, findings: [{ code, message }] };
}

function blockedContract(
  base: Omit<MethodExtractionContract, "eligible" | "reasonCode" | "findings">,
  code: Exclude<MethodExtractionContractReasonCode, "contract-eligible">,
  message: string,
  line?: number
): MethodExtractionContract {
  return { ...base, eligible: false, reasonCode: code, findings: [{ code, message, line }] };
}

function blockedPatch(
  base: Omit<MethodExtractionPatchPlan, "ready" | "reasonCode" | "findings">,
  code: Exclude<MethodExtractionPatchReasonCode, "patch-ready">,
  message: string
): MethodExtractionPatchPlan {
  return { ...base, ready: false, reasonCode: code, findings: [{ code, message }] };
}

function transformExtractionSource(
  candidate: AstSymbolCandidate,
  contract: MethodExtractionContract,
  extractedName: string
): string {
  const sourceFile = candidate.sourceFile;
  const source = sourceFile.text;
  const body = candidate.body as ts.Block;
  const statements = body.statements.filter((statement) => {
    const range = nodeLineRange(sourceFile, statement);
    return range.startLine >= contract.requestedRange.startLine && range.endLine <= contract.requestedRange.endLine;
  });
  const first = statements[0]!;
  const last = statements.at(-1)!;
  const startLineIndex = contract.requestedRange.startLine - 1;
  const replaceStart = sourceFile.getPositionOfLineAndCharacter(startLineIndex, 0);
  const replaceEnd = last.getEnd();
  const statementIndent = " ".repeat(sourceFile.getLineAndCharacterOfPosition(first.getStart(sourceFile)).character);
  const selectedSource = source.slice(replaceStart, replaceEnd);
  const terminalReturn = ts.isReturnStatement(last) && last === body.statements.at(-1);
  const callTarget = candidate.descriptor.kind === "method" ? `this.${extractedName}` : extractedName;
  const call = `${contract.controlFlow.async ? "await " : ""}${callTarget}(${contract.inputs.map((input) => input.name).join(", ")})`;
  const output = contract.outputs[0];
  let replacement: string;
  if (terminalReturn) replacement = `${statementIndent}return ${call};`;
  else if (output?.mode === "declared-output") replacement = `${statementIndent}const ${output.name} = ${call};`;
  else if (output?.mode === "reassigned-output") replacement = `${statementIndent}${output.name} = ${call};`;
  else replacement = `${statementIndent}${call};`;

  const declarationIndent = " ".repeat(sourceFile.getLineAndCharacterOfPosition(candidate.declaration.getStart(sourceFile)).character);
  const bodyIndent = `${declarationIndent}  `;
  let helperBody = reindentBlock(selectedSource, bodyIndent);
  if (output && !terminalReturn) helperBody = `${helperBody}\n${bodyIndent}return ${output.name};`;
  const parameters = contract.inputs.map((input) => `${input.name}: ${input.type}`).join(", ");
  const asyncKeyword = contract.controlFlow.async ? "async " : "";
  const helper = candidate.descriptor.kind === "method"
    ? `\n\n${declarationIndent}private ${asyncKeyword}${extractedName}(${parameters}) {\n${helperBody}\n${declarationIndent}}`
    : `\n\n${declarationIndent}${asyncKeyword}function ${extractedName}(${parameters}) {\n${helperBody}\n${declarationIndent}}`;
  const replaced = source.slice(0, replaceStart) + replacement + source.slice(replaceEnd);
  const insertionShift = replacement.length - (replaceEnd - replaceStart);
  const insertAt = candidate.declaration.getEnd() + insertionShift;
  return replaced.slice(0, insertAt) + helper + replaced.slice(insertAt);
}

function reindentBlock(value: string, indent: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const nonEmpty = lines.filter((line) => line.trim());
  const minimum = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
    : 0;
  return lines.map((line) => line.trim() ? `${indent}${line.slice(minimum)}` : "").join("\n");
}

function validateTransformedSource(
  project: { program: ts.Program; compilerOptions: ts.CompilerOptions },
  fileName: string,
  transformed: string
): string[] {
  const resolvedFile = path.resolve(fileName);
  const originalDiagnostics = diagnosticsForFile(project.program, resolvedFile);
  const transformedProgram = createProgramWithParents(
    project.program.getRootFileNames(),
    project.compilerOptions,
    new Map([[resolvedFile, transformed]])
  );
  const transformedDiagnostics = diagnosticsForFile(transformedProgram, resolvedFile);
  const originalKeys = new Set(originalDiagnostics.map(diagnosticKey));
  return transformedDiagnostics
    .filter((diagnostic) => !originalKeys.has(diagnosticKey(diagnostic)))
    .map(formatDiagnosticWithLocation);
}

function diagnosticsForFile(program: ts.Program, resolvedFile: string): readonly ts.Diagnostic[] {
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.file && path.resolve(diagnostic.file.fileName) === resolvedFile);
}

function diagnosticKey(diagnostic: ts.Diagnostic): string {
  return `${diagnostic.code}:${formatDiagnostic(diagnostic)}`;
}

function formatDiagnosticWithLocation(diagnostic: ts.Diagnostic): string {
  if (!diagnostic.file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${formatDiagnostic(diagnostic)}`;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `TS${diagnostic.code} at ${location.line + 1}:${location.character + 1}: ${formatDiagnostic(diagnostic)}`;
}

function createReplaceFilePatch(relativeFile: string, before: string, after: string): string {
  const normalized = toPosixPath(relativeFile);
  const beforeFile = diffFileLines(before);
  const afterFile = diffFileLines(after);
  return [
    `diff --git a/${normalized} b/${normalized}`,
    `--- a/${normalized}`,
    `+++ b/${normalized}`,
    `@@ -1,${beforeFile.lines.length} +1,${afterFile.lines.length} @@`,
    ...renderDiffFileLines(beforeFile, "-"),
    ...renderDiffFileLines(afterFile, "+"),
    ""
  ].join("\n");
}

function diffFileLines(value: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = value.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const content = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: content ? content.split("\n") : [], trailingNewline };
}

function renderDiffFileLines(file: { lines: string[]; trailingNewline: boolean }, prefix: "-" | "+"): string[] {
  const rendered = file.lines.map((line) => `${prefix}${line}`);
  if (file.lines.length > 0 && !file.trailingNewline) rendered.push("\\ No newline at end of file");
  return rendered;
}

function collectDeclaredSymbols(statements: readonly ts.Statement[], checker: ts.TypeChecker): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (isDeclarationName(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) symbols.add(symbol);
    }
    ts.forEachChild(node, visit);
  };
  statements.forEach(visit);
  return symbols;
}

function collectFunctionScopedSymbols(
  declaration: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  symbols: Set<ts.Symbol>
): void {
  for (const parameter of declaration.parameters) collectBindingSymbols(parameter.name, checker, symbols);
  if (!declaration.body) return;
  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (isDeclarationName(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) symbols.add(symbol);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
}

function collectBindingSymbols(name: ts.BindingName, checker: ts.TypeChecker, symbols: Set<ts.Symbol>): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) symbols.add(symbol);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingSymbols(element.name, checker, symbols);
  }
}

function collectLaterSymbolUses(
  body: ts.Block,
  selectedEnd: number,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): Map<ts.Symbol, { node: ts.Identifier; lines: Set<number> }> {
  const uses = new Map<ts.Symbol, { node: ts.Identifier; lines: Set<number> }>();
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) <= selectedEnd) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isIdentifier(node) && identifierIsValueReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) addSymbolUse(uses, symbol, node, nodeLineRange(sourceFile, node).startLine);
    }
    ts.forEachChild(node, visit);
  };
  body.statements.forEach(visit);
  return uses;
}

function addSymbolUse(
  target: Map<ts.Symbol, { node: ts.Identifier; lines: Set<number> }>,
  symbol: ts.Symbol,
  node: ts.Identifier,
  line: number
): void {
  const existing = target.get(symbol);
  if (existing) existing.lines.add(line);
  else target.set(symbol, { node, lines: new Set([line]) });
}

function valueContract(
  symbol: ts.Symbol,
  node: ts.Identifier,
  lines: Set<number>,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  mode: MethodExtractionValueContract["mode"]
): MethodExtractionValueContract {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? node;
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  return {
    name: symbol.getName(),
    type: checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope),
    declarationLine: nodeLineRange(sourceFile, declaration).startLine,
    useLines: [...lines].sort(numberSort),
    mode
  };
}

function uniqueValueContracts(values: MethodExtractionValueContract[]): MethodExtractionValueContract[] {
  const byKey = new Map<string, MethodExtractionValueContract>();
  for (const value of values) byKey.set(`${value.mode}:${value.name}`, value);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.mode.localeCompare(b.mode));
}

function identifierIsValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (isDeclarationName(node)) return false;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isTypeReferenceNode(parent) && parent.typeName === node)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)) return false;
  return !isInTypeNode(node);
}

function isDeclarationName(node: ts.Node): node is ts.Identifier {
  if (!ts.isIdentifier(node) || !node.parent) return false;
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node);
}

function isInTypeNode(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
    current = current.parent;
  }
  return false;
}

function isWriteIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  }
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
}

function hasAsyncModifier(declaration: ts.FunctionLikeDeclaration): boolean {
  return ts.canHaveModifiers(declaration)
    && Boolean(ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function renderValueContract(value: MethodExtractionValueContract): string {
  return `- ${value.name}: ${value.type} (${value.mode}, declaration ${value.declarationLine}, uses ${value.useLines.join(", ") || "none"})`;
}

function numberSort(a: number, b: number): number {
  return a - b;
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".json") return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function isExportedDeclaration(node: ts.Node): boolean {
  let declaration: ts.Node = node;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    declaration = node.parent.parent?.parent ?? node.parent;
  } else if (ts.isVariableDeclaration(node)) {
    declaration = node.parent?.parent ?? node;
  }
  return ts.canHaveModifiers(declaration)
    && Boolean(ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function validRange(range: MethodExtractionRange): boolean {
  return Number.isInteger(range.startLine) && Number.isInteger(range.endLine)
    && range.startLine > 0 && range.endLine >= range.startLine;
}

function symbolMatches(candidate: MethodExtractionSymbol, requested: string): boolean {
  const normalized = requested.replace(/#/g, ".");
  return candidate.symbol === normalized || candidate.name === normalized;
}

function isInsideRoot(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
