import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, readJsonFile, toPosixPath } from "./files.js";
import type { MigrationAction, MigrationActionPlan } from "../types.js";

export type MethodLanguageId = "typescript-node" | "python" | "java" | "go" | "unknown";
export type MethodSymbolKind = "function" | "method" | "constructor";

export interface MethodSymbolCandidate {
  symbol: string;
  name: string;
  container?: string;
  language: MethodLanguageId;
  kind: MethodSymbolKind;
  file: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
  confidence: "low" | "medium" | "high";
}

export interface MethodReference {
  file: string;
  line: number;
  excerpt: string;
}

export interface MethodRefactorCallDepth {
  requested: number;
  applied: number;
  max: number;
}

export interface MethodCallSite {
  callName: string;
  receiver?: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface MethodCallGraphNode {
  depth: number;
  candidate: MethodSymbolCandidate;
  referenceCount: number;
  sideEffectHints: string[];
  risk: "low" | "medium" | "high";
}

export interface MethodCallGraphEdge {
  from: string;
  to: string;
  callName: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface MethodUnresolvedCall {
  from: string;
  callName: string;
  receiver?: string;
  file: string;
  line: number;
  excerpt: string;
  reason: string;
}

export interface MethodRefactorInventory {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  symbolCount: number;
  matchStatus: "matched" | "ambiguous" | "missing";
  matches: MethodSymbolCandidate[];
}

export interface MethodRefactorPlan {
  version: 1;
  createdAt: string;
  root: string;
  requestedSymbol: string;
  selected: MethodSymbolCandidate;
  callDepth: MethodRefactorCallDepth;
  callGraph: {
    nodes: MethodCallGraphNode[];
    edges: MethodCallGraphEdge[];
    unresolvedCalls: MethodUnresolvedCall[];
    truncated: boolean;
  };
  impact: {
    referenceCount: number;
    references: MethodReference[];
    risk: "low" | "medium" | "high";
    reasons: string[];
  };
  contract: {
    signature: string;
    sideEffectHints: string[];
    recommendedProbe: string;
  };
  recommendedChecks: string[];
  acceptanceCriteria: string[];
}

export interface MethodRefactorPlanOptions {
  callDepth?: number;
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  ext: string;
  content: string;
  language: MethodLanguageId;
}

export const MAX_METHOD_CALL_DEPTH = 6;

const MAX_METHOD_GRAPH_NODES = 64;
const SOURCE_EXTENSIONS = new Set([".cjs", ".go", ".java", ".js", ".jsx", ".mjs", ".py", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", ".migration-guard", "node_modules", "dist", "build", "target", "__pycache__", "coverage"]);
const JS_METHOD_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return"]);
const CALL_NAME_BLOCKLIST = new Set([
  "Array", "Boolean", "Date", "Error", "JSON", "Map", "Math", "Number", "Object", "Promise", "Set", "String",
  "append", "catch", "console", "delete", "entries", "filter", "finally", "for", "forEach", "get", "if", "includes",
  "join", "keys", "log", "map", "parse", "push", "raise", "reduce", "return", "set", "slice", "sort", "switch",
  "then", "throw", "values", "while"
]);

export function extractMethodSymbolFromGoal(goal: string): string | undefined {
  return goal.match(/\bsymbol\s*=\s*([A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*)/i)?.[1]
    ?? goal.match(/\bmethod\s+([A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*)/i)?.[1]
    ?? goal.match(/\bfunction\s+([A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*)/i)?.[1];
}

export function extractMethodCallDepthFromGoal(goal: string): number | undefined {
  const match = goal.match(/\b(?:call-depth|callDepth|depth)\s*=\s*(\d+)\b/i);
  return match ? Number(match[1]) : undefined;
}

export async function createMethodRefactorInventory(root: string, requestedSymbol: string): Promise<MethodRefactorInventory> {
  const files = await collectSourceFiles(root);
  const symbols = files.flatMap((file) => extractSymbolsFromFile(file));
  const matches = symbols.filter((symbol) => methodSymbolMatches(symbol, requestedSymbol));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    root,
    requestedSymbol,
    symbolCount: symbols.length,
    matchStatus: matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "missing",
    matches
  };
}

export async function createMethodRefactorPlan(
  root: string,
  requestedSymbol: string,
  options: MethodRefactorPlanOptions = {}
): Promise<MethodRefactorPlan> {
  const files = await collectSourceFiles(root);
  const symbols = files.flatMap((file) => extractSymbolsFromFile(file));
  const matches = symbols.filter((symbol) => methodSymbolMatches(symbol, requestedSymbol));
  if (matches.length === 0) {
    throw new Error(`Method symbol not found: ${requestedSymbol}`);
  }
  if (matches.length > 1) {
    throw new Error(`Method symbol is ambiguous: ${requestedSymbol}`);
  }

  const selected = matches[0]!;
  const references = collectReferences(files, selected).slice(0, 50);
  const sideEffectHints = collectSideEffectHints(files.find((file) => file.relativePath === selected.file)?.content ?? "", selected);
  const callDepth = normalizeMethodCallDepth(options.callDepth);
  const callGraph = createMethodCallGraph(files, symbols, selected, callDepth.applied);
  const risk = riskForCallGraph(selected, references, sideEffectHints, callGraph);
  const checks = await recommendedChecksForMethod(root, selected.language);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    root,
    requestedSymbol,
    selected,
    callDepth,
    callGraph,
    impact: {
      referenceCount: references.length,
      references,
      risk,
      reasons: impactReasons(selected, references, sideEffectHints, callGraph)
    },
    contract: {
      signature: selected.signature,
      sideEffectHints,
      recommendedProbe: "method-contract-probe"
    },
    recommendedChecks: checks,
    acceptanceCriteria: [
      "only the selected method and directly required local helpers are modified",
      "downstream call-chain changes stay within the planned call-depth budget",
      "method signature and documented behavior stay stable unless intentionally changed",
      "call-site references remain valid",
      "recommended checks pass before applying the proposal"
    ]
  };
}

export function createMethodRefactorActionPlan(runId: string, goal: string, plan: MethodRefactorPlan): MigrationActionPlan {
  const nodes = plan.callGraph?.nodes?.length
    ? plan.callGraph.nodes
    : [{
      depth: 0,
      candidate: plan.selected,
      referenceCount: plan.impact.referenceCount,
      sideEffectHints: plan.contract.sideEffectHints,
      risk: plan.impact.risk
    }];
  const actions = nodes.map((node) => createMethodAction(plan, node));
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    goal,
    actions
  };
}

export function renderMethodRefactorInventory(inventory: MethodRefactorInventory): string {
  return [
    "# Method Refactor Inventory",
    "",
    `- Root: ${inventory.root}`,
    `- Requested symbol: ${inventory.requestedSymbol}`,
    `- Symbol count: ${inventory.symbolCount}`,
    `- Match status: ${inventory.matchStatus}`,
    "",
    "## Matches",
    "",
    inventory.matches.length > 0
      ? inventory.matches.map((symbol) => `- ${symbol.symbol} [${symbol.language}/${symbol.kind}] ${symbol.file}:${symbol.line}-${symbol.endLine}`).join("\n")
      : "No matching method symbols found."
  ].join("\n");
}

export function renderMethodRefactorPlan(plan: MethodRefactorPlan): string {
  return [
    "# Method Refactor Plan",
    "",
    `- Requested symbol: ${plan.requestedSymbol}`,
    `- Selected: ${plan.selected.symbol}`,
    `- Location: ${plan.selected.file}:${plan.selected.line}-${plan.selected.endLine}`,
    `- Risk: ${plan.impact.risk}`,
    `- References: ${plan.impact.referenceCount}`,
    `- Call depth: ${plan.callDepth.applied}/${plan.callDepth.max} (requested ${plan.callDepth.requested})`,
    "",
    "## Contract",
    "",
    `- Signature: ${plan.contract.signature}`,
    `- Recommended probe: ${plan.contract.recommendedProbe}`,
    `- Side-effect hints: ${plan.contract.sideEffectHints.join(", ") || "none"}`,
    "",
    "## Checks",
    "",
    ...(plan.recommendedChecks.length > 0 ? plan.recommendedChecks.map((command) => `- ${command}`) : ["- none"]),
    "",
    "## Call Graph",
    "",
    ...(plan.callGraph.nodes.length > 0
      ? plan.callGraph.nodes.map((node) => `- depth ${node.depth}: ${node.candidate.symbol} [${node.risk}] ${node.candidate.file}:${node.candidate.line}-${node.candidate.endLine}`)
      : ["- none"]),
    "",
    "## Call Edges",
    "",
    ...(plan.callGraph.edges.length > 0
      ? plan.callGraph.edges.map((edge) => `- ${edge.from} -> ${edge.to} via ${edge.callName} at ${edge.file}:${edge.line}`)
      : ["- none"]),
    "",
    "## Unresolved Calls",
    "",
    ...(plan.callGraph.unresolvedCalls.length > 0
      ? plan.callGraph.unresolvedCalls.slice(0, 25).map((call) => `- ${call.from} -> ${call.receiver ? `${call.receiver}.` : ""}${call.callName} at ${call.file}:${call.line}: ${call.reason}`)
      : ["- none"]),
    "",
    "## Acceptance",
    "",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`)
  ].join("\n");
}

export function renderMethodRefactorActionPlan(plan: MigrationActionPlan): string {
  return [
    "# Method Refactor Action Plan",
    "",
    `- Run: ${plan.runId}`,
    `- Goal: ${plan.goal}`,
    `- Actions: ${plan.actions.length}`,
    "",
    ...plan.actions.map((action) => [
      `## ${action.id}`,
      "",
      `- Title: ${action.title}`,
      `- Risk: ${action.risk}`,
      `- Patch mode: ${action.patchMode}`,
      `- Template: ${action.patchTemplate ?? "auto"}`,
      `- Affected files: ${action.affectedFiles.join(", ")}`,
      "- Checks:",
      ...(action.recommendedChecks.length > 0 ? action.recommendedChecks.map((command) => `  - ${command}`) : ["  - none"])
    ].join("\n"))
  ].join("\n\n");
}

function createMethodAction(plan: MethodRefactorPlan, node: MethodCallGraphNode): MigrationAction {
  const candidate = node.candidate;
  return {
    id: `method-action-${sanitizeId(candidate.symbol)}`,
    title: `Refactor method ${candidate.symbol}`,
    summary: [
      `Refactor ${candidate.symbol} in ${candidate.file}:${candidate.line}-${candidate.endLine}.`,
      `Call-chain depth: ${node.depth}/${plan.callDepth.applied}.`,
      `Reference count: ${node.referenceCount}.`,
      `Contract probe: ${plan.contract.recommendedProbe}.`
    ].join(" "),
    risk: node.risk,
    affectedFiles: [candidate.file],
    recommendedChecks: plan.recommendedChecks,
    checkReadiness: plan.recommendedChecks.map((command) => ({
      command,
      status: "ready",
      reason: "detected from target project manifests"
    })),
    patchMode: "manual-approval-required",
    patchTemplate: "method-contract-probe"
  };
}

async function collectSourceFiles(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const absolutePath of await walkFiles(root)) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    const content = stat.size <= 1024 * 1024 ? await fs.readFile(absolutePath, "utf8") : "";
    files.push({
      absolutePath,
      relativePath: toPosixPath(path.relative(root, absolutePath)),
      ext,
      content,
      language: languageForExtension(ext)
    });
  }
  return files;
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        result.push(absolutePath);
      }
    }
  }
  await visit(root);
  return result;
}

function languageForExtension(ext: string): MethodLanguageId {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return "typescript-node";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".java") {
    return "java";
  }
  if (ext === ".go") {
    return "go";
  }
  return "unknown";
}

function extractSymbolsFromFile(file: SourceFile): MethodSymbolCandidate[] {
  switch (file.language) {
    case "typescript-node":
      return extractJavascriptSymbols(file);
    case "python":
      return extractPythonSymbols(file);
    case "java":
      return extractJavaSymbols(file);
    case "go":
      return extractGoSymbols(file);
    default:
      return [];
  }
}

function extractJavascriptSymbols(file: SourceFile): MethodSymbolCandidate[] {
  const lines = file.content.split(/\r?\n/);
  const symbols: MethodSymbolCandidate[] = [];
  let currentClass: string | undefined;
  for (const [index, line] of lines.entries()) {
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      currentClass = classMatch[1];
    }
    const functionMatch = line.match(/^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (functionMatch) {
      symbols.push(symbolCandidate(file, index, functionMatch[2], undefined, "function", line, Boolean(functionMatch[1])));
      continue;
    }
    const arrowMatch = line.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (arrowMatch) {
      symbols.push(symbolCandidate(file, index, arrowMatch[2], undefined, "function", line, Boolean(arrowMatch[1])));
      continue;
    }
    const methodMatch = line.match(/^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:A-Za-z0-9_$<>,\s.[\]|?]*\{/);
    if (methodMatch && currentClass && !JS_METHOD_KEYWORDS.has(methodMatch[1])) {
      symbols.push(symbolCandidate(file, index, methodMatch[1], currentClass, methodMatch[1] === "constructor" ? "constructor" : "method", line, false));
    }
  }
  return symbols;
}

function extractPythonSymbols(file: SourceFile): MethodSymbolCandidate[] {
  const lines = file.content.split(/\r?\n/);
  const symbols: MethodSymbolCandidate[] = [];
  const classStack: Array<{ name: string; indent: number }> = [];
  for (const [index, line] of lines.entries()) {
    const indent = leadingSpaces(line);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent && line.trim()) {
      classStack.pop();
    }
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\b/);
    if (classMatch) {
      classStack.push({ name: classMatch[2], indent: classMatch[1].length });
      continue;
    }
    const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (defMatch) {
      const container = findInnermostClass(classStack, defMatch[1].length);
      symbols.push(symbolCandidate(file, index, defMatch[2], container, container ? "method" : "function", line, false));
    }
  }
  return symbols;
}

function findInnermostClass(classStack: Array<{ name: string; indent: number }>, indent: number): string | undefined {
  for (let index = classStack.length - 1; index >= 0; index -= 1) {
    if (classStack[index]!.indent < indent) {
      return classStack[index]!.name;
    }
  }
  return undefined;
}

function extractJavaSymbols(file: SourceFile): MethodSymbolCandidate[] {
  const lines = file.content.split(/\r?\n/);
  const symbols: MethodSymbolCandidate[] = [];
  let currentClass: string | undefined;
  for (const [index, line] of lines.entries()) {
    const classMatch = line.match(/\b(?:class|interface|record)\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      currentClass = classMatch[1];
    }
    const methodMatch = line.match(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:[A-Za-z_<>\[\],.?]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{/);
    if (methodMatch && currentClass && !["if", "for", "while", "switch", "catch"].includes(methodMatch[2])) {
      symbols.push(symbolCandidate(file, index, methodMatch[2], currentClass, methodMatch[2] === currentClass ? "constructor" : "method", line, methodMatch[1] === "public"));
    }
  }
  return symbols;
}

function extractGoSymbols(file: SourceFile): MethodSymbolCandidate[] {
  const lines = file.content.split(/\r?\n/);
  const symbols: MethodSymbolCandidate[] = [];
  for (const [index, line] of lines.entries()) {
    const methodMatch = line.match(/^\s*func\s+\((?:\w+\s+)?\*?([A-Za-z_]\w*)\)\s+([A-Za-z_]\w*)\s*\(/);
    if (methodMatch) {
      symbols.push(symbolCandidate(file, index, methodMatch[2], methodMatch[1], "method", line, startsUpper(methodMatch[2])));
      continue;
    }
    const functionMatch = line.match(/^\s*func\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      symbols.push(symbolCandidate(file, index, functionMatch[1], undefined, "function", line, startsUpper(functionMatch[1])));
    }
  }
  return symbols;
}

function symbolCandidate(
  file: SourceFile,
  zeroBasedLine: number,
  name: string,
  container: string | undefined,
  kind: MethodSymbolKind,
  signature: string,
  exported: boolean
): MethodSymbolCandidate {
  return {
    symbol: container ? `${container}.${name}` : name,
    name,
    container,
    language: file.language,
    kind,
    file: file.relativePath,
    line: zeroBasedLine + 1,
    endLine: estimateEndLine(file.content, zeroBasedLine, file.language),
    signature: signature.trim(),
    exported,
    confidence: container || exported ? "high" : "medium"
  };
}

function estimateEndLine(content: string, startLine: number, language: MethodLanguageId): number {
  const lines = content.split(/\r?\n/);
  if (language === "python") {
    const startIndent = leadingSpaces(lines[startLine] ?? "");
    for (let index = startLine + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim() && leadingSpaces(line) <= startIndent) {
        return index;
      }
    }
    return lines.length;
  }

  let depth = 0;
  let sawOpen = false;
  for (let index = startLine; index < lines.length; index += 1) {
    for (const char of lines[index] ?? "") {
      if (char === "{") {
        depth += 1;
        sawOpen = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawOpen && depth <= 0) {
      return index + 1;
    }
  }
  return Math.min(lines.length, startLine + 40);
}

function methodSymbolMatches(candidate: MethodSymbolCandidate, requested: string): boolean {
  const normalized = requested.replace(/#/g, ".");
  return candidate.symbol === normalized || candidate.name === normalized;
}

function collectReferences(files: SourceFile[], selected: MethodSymbolCandidate): MethodReference[] {
  const pattern = new RegExp(`\\b${escapeRegExp(selected.name)}\\b`);
  const refs: MethodReference[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (!pattern.test(line)) {
        continue;
      }
      if (file.relativePath === selected.file && lineNumber >= selected.line && lineNumber <= selected.endLine) {
        continue;
      }
      refs.push({
        file: file.relativePath,
        line: lineNumber,
        excerpt: line.trim().slice(0, 180)
      });
    }
  }
  return refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function createMethodCallGraph(
  files: SourceFile[],
  symbols: MethodSymbolCandidate[],
  selected: MethodSymbolCandidate,
  maxDepth: number
): MethodRefactorPlan["callGraph"] {
  const nodes: MethodCallGraphNode[] = [];
  const edges: MethodCallGraphEdge[] = [];
  const unresolvedCalls: MethodUnresolvedCall[] = [];
  const visited = new Set<string>();
  const queued = new Set<string>([selected.symbol]);
  const queue: Array<{ candidate: MethodSymbolCandidate; depth: number }> = [{ candidate: selected, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    queued.delete(current.candidate.symbol);
    if (visited.has(current.candidate.symbol)) {
      continue;
    }
    visited.add(current.candidate.symbol);

    const references = collectReferences(files, current.candidate);
    const sideEffectHints = collectSideEffectHints(sourceContentForCandidate(files, current.candidate), current.candidate);
    const node: MethodCallGraphNode = {
      depth: current.depth,
      candidate: current.candidate,
      referenceCount: references.length,
      sideEffectHints,
      risk: riskForMethod(current.candidate, references, sideEffectHints)
    };
    nodes.push(node);

    if (current.depth >= maxDepth) {
      continue;
    }

    const calls = collectMethodCalls(files, current.candidate);
    for (const call of calls) {
      const resolved = resolveMethodCall(symbols, current.candidate, call);
      if (!resolved.candidate) {
        unresolvedCalls.push({
          from: current.candidate.symbol,
          callName: call.callName,
          receiver: call.receiver,
          file: call.file,
          line: call.line,
          excerpt: call.excerpt,
          reason: resolved.reason
        });
        continue;
      }
      if (resolved.candidate.symbol === current.candidate.symbol) {
        continue;
      }

      edges.push({
        from: current.candidate.symbol,
        to: resolved.candidate.symbol,
        callName: call.callName,
        file: call.file,
        line: call.line,
        excerpt: call.excerpt
      });

      if (!visited.has(resolved.candidate.symbol) && !queued.has(resolved.candidate.symbol)) {
        if (nodes.length + queue.length >= MAX_METHOD_GRAPH_NODES) {
          truncated = true;
          continue;
        }
        queue.push({ candidate: resolved.candidate, depth: current.depth + 1 });
        queued.add(resolved.candidate.symbol);
      }
    }
  }

  return {
    nodes: nodes.sort((a, b) => a.depth - b.depth || a.candidate.symbol.localeCompare(b.candidate.symbol)),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.line - b.line),
    unresolvedCalls: unresolvedCalls.sort((a, b) => a.from.localeCompare(b.from) || a.file.localeCompare(b.file) || a.line - b.line),
    truncated
  };
}

function collectMethodCalls(files: SourceFile[], selected: MethodSymbolCandidate): MethodCallSite[] {
  const file = files.find((item) => item.relativePath === selected.file);
  if (!file) {
    return [];
  }
  const calls: MethodCallSite[] = [];
  for (const line of methodBodyLines(file, selected)) {
    for (const call of callsFromLine(file.language, line.text)) {
      calls.push({
        ...call,
        file: selected.file,
        line: line.line,
        excerpt: line.text.trim().slice(0, 180)
      });
    }
  }
  return uniqueCalls(calls);
}

function callsFromLine(language: MethodLanguageId, line: string): Array<Pick<MethodCallSite, "callName" | "receiver">> {
  const withoutStrings = stripStringLiterals(line);
  const pattern = language === "python"
    ? /\b(?:(self|cls|[A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/g
    : /\b(?:(this|super|[A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*\(/g;
  const calls: Array<Pick<MethodCallSite, "callName" | "receiver">> = [];
  for (const match of withoutStrings.matchAll(pattern)) {
    const callName = match[2] ?? "";
    const receiver = match[1];
    if (!callName || CALL_NAME_BLOCKLIST.has(callName)) {
      continue;
    }
    calls.push({ callName, receiver });
  }
  return calls;
}

function resolveMethodCall(
  symbols: MethodSymbolCandidate[],
  current: MethodSymbolCandidate,
  call: MethodCallSite
): { candidate?: MethodSymbolCandidate; reason: string } {
  const matches = symbols.filter((symbol) => symbol.name === call.callName);
  if (matches.length === 0) {
    return { reason: "not a known local method/function symbol" };
  }

  const sameContainer = matches.filter((symbol) => symbol.container && symbol.container === current.container);
  if ((call.receiver === "this" || call.receiver === "self" || call.receiver === "cls" || call.receiver === "super") && sameContainer.length === 1) {
    return { candidate: sameContainer[0], reason: "resolved in the current class container" };
  }

  if (call.receiver) {
    const containerMatches = matches.filter((symbol) => symbol.container === call.receiver);
    if (containerMatches.length === 1) {
      return { candidate: containerMatches[0], reason: "resolved by explicit receiver name" };
    }
  }

  if (matches.length === 1) {
    return { candidate: matches[0], reason: "resolved by unique local symbol name" };
  }

  return { reason: `ambiguous local symbol name; candidates: ${matches.map((symbol) => symbol.symbol).sort().join(", ")}` };
}

function methodBodyLines(file: SourceFile, selected: MethodSymbolCandidate): Array<{ line: number; text: string }> {
  const lines = file.content.split(/\r?\n/);
  const startIndex = Math.min(lines.length, selected.line);
  const endIndex = Math.max(startIndex, selected.endLine - 1);
  return lines.slice(startIndex, endIndex).map((text, index) => ({
    line: startIndex + index + 1,
    text
  }));
}

function sourceContentForCandidate(files: SourceFile[], selected: MethodSymbolCandidate): string {
  return files.find((file) => file.relativePath === selected.file)?.content ?? "";
}

function uniqueCalls(calls: MethodCallSite[]): MethodCallSite[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.file}:${call.line}:${call.receiver ?? ""}:${call.callName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripStringLiterals(value: string): string {
  return value.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
}

function collectSideEffectHints(content: string, selected: MethodSymbolCandidate): string[] {
  const lines = content.split(/\r?\n/).slice(selected.line - 1, selected.endLine).join("\n").toLowerCase();
  const hints: string[] = [];
  for (const [needle, label] of [
    ["fetch(", "network"],
    ["axios.", "network"],
    ["http.", "network"],
    ["fs.", "filesystem"],
    ["writefile", "filesystem"],
    ["save", "persistence"],
    ["insert", "persistence"],
    ["update", "persistence"],
    ["delete", "persistence"],
    ["throw", "exception"],
    ["raise", "exception"],
    ["process.env", "environment"]
  ] as const) {
    if (lines.includes(needle)) {
      hints.push(label);
    }
  }
  return [...new Set(hints)].sort();
}

function riskForMethod(
  selected: MethodSymbolCandidate,
  references: MethodReference[],
  sideEffectHints: string[]
): "low" | "medium" | "high" {
  const methodLines = Math.max(1, selected.endLine - selected.line + 1);
  if (references.length > 20 || sideEffectHints.length >= 2 || methodLines > 120) {
    return "high";
  }
  if (references.length > 5 || sideEffectHints.length > 0 || methodLines > 50) {
    return "medium";
  }
  return "low";
}

function riskForCallGraph(
  selected: MethodSymbolCandidate,
  references: MethodReference[],
  sideEffectHints: string[],
  callGraph: MethodRefactorPlan["callGraph"]
): "low" | "medium" | "high" {
  const rootRisk = riskForMethod(selected, references, sideEffectHints);
  if (rootRisk === "high" || callGraph.nodes.some((node) => node.risk === "high")) {
    return "high";
  }
  if (callGraph.nodes.length > 10 || callGraph.unresolvedCalls.length > 0 || rootRisk === "medium" || callGraph.nodes.some((node) => node.risk === "medium")) {
    return "medium";
  }
  return "low";
}

function impactReasons(
  selected: MethodSymbolCandidate,
  references: MethodReference[],
  sideEffectHints: string[],
  callGraph: MethodRefactorPlan["callGraph"]
): string[] {
  return [
    `${Math.max(1, selected.endLine - selected.line + 1)} line method range`,
    `${references.length} reference(s) found`,
    `call graph nodes: ${callGraph.nodes.length}, edges: ${callGraph.edges.length}, unresolved: ${callGraph.unresolvedCalls.length}`,
    callGraph.truncated ? `call graph truncated at ${MAX_METHOD_GRAPH_NODES} nodes` : "call graph not truncated",
    sideEffectHints.length > 0 ? `side-effect hints: ${sideEffectHints.join(", ")}` : "no side-effect hints detected"
  ];
}

function normalizeMethodCallDepth(value: number | undefined): MethodRefactorCallDepth {
  const requested = Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
  return {
    requested,
    applied: Math.min(requested, MAX_METHOD_CALL_DEPTH),
    max: MAX_METHOD_CALL_DEPTH
  };
}

async function recommendedChecksForMethod(root: string, language: MethodLanguageId): Promise<string[]> {
  switch (language) {
    case "typescript-node":
      return recommendedNodeChecks(root);
    case "python":
      return ["python -m compileall .", "python -m pytest"];
    case "java":
      if (await pathExists(path.join(root, "pom.xml"))) {
        return ["mvn test"];
      }
      if (await pathExists(path.join(root, "build.gradle")) || await pathExists(path.join(root, "build.gradle.kts"))) {
        return ["./gradlew test"];
      }
      return ["javac <sources>"];
    case "go":
      return ["go test ./..."];
    default:
      return [];
  }
}

async function recommendedNodeChecks(root: string): Promise<string[]> {
  const packageJson = await readJsonFile<{ scripts?: Record<string, unknown> }>(path.join(root, "package.json")).catch(() => undefined);
  const scripts = typeof packageJson?.scripts === "object" && packageJson.scripts !== null
    ? Object.keys(packageJson.scripts as Record<string, unknown>)
    : [];
  const pm = await detectNodePackageManager(root);
  return ["type-check", "test", "build"]
    .filter((script) => scripts.includes(script))
    .map((script) => pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
}

async function detectNodePackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function leadingSpaces(value: string): number {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function startsUpper(value: string): boolean {
  return /^[A-Z]/.test(value);
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "method";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
