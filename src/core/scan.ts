import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE } from "./config.js";
import { pathExists, readJsonFile, toPosixPath } from "./files.js";
import type { DependencyEdge, LoadedConfig, RiskFile, ScanSummary } from "../types.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".java",
  ".go",
  ".cs",
  ".php",
  ".rb"
]);

const JS_LIKE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);

interface FileInfo {
  absolutePath: string;
  relativePath: string;
  ext: string;
  lines: number;
  isSource: boolean;
  isTest: boolean;
}

export async function scanProject(loaded: LoadedConfig): Promise<ScanSummary> {
  const files = await walkFiles(loaded.targetRoot, loaded.config.ignore);
  const fileInfos: FileInfo[] = [];
  const fileTypes: Record<string, number> = {};
  let totalLines = 0;

  for (const absolutePath of files) {
    const relativePath = toPosixPath(path.relative(loaded.targetRoot, absolutePath));
    const ext = path.extname(absolutePath).toLowerCase() || "[none]";
    const stat = await fs.stat(absolutePath);
    const shouldCountLines = stat.size <= 1024 * 1024;
    const content = shouldCountLines ? await fs.readFile(absolutePath, "utf8") : "";
    const lines = shouldCountLines ? countLines(content) : 0;
    const isSource = SOURCE_EXTENSIONS.has(ext);
    const isTest = isTestFile(relativePath);

    fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
    totalLines += lines;
    fileInfos.push({
      absolutePath,
      relativePath,
      ext,
      lines,
      isSource,
      isTest
    });
  }

  const dependencyEdges = await collectDependencyEdges(loaded.targetRoot, fileInfos);
  const importerCounts = dependencyEdges.reduce<Record<string, number>>((acc, edge) => {
    acc[edge.to] = (acc[edge.to] ?? 0) + 1;
    return acc;
  }, {});

  const riskFiles = calculateRiskFiles(fileInfos, importerCounts);

  return {
    root: loaded.targetRoot,
    scannedAt: new Date().toISOString(),
    totalFiles: fileInfos.length,
    sourceFiles: fileInfos.filter((file) => file.isSource).length,
    testFiles: fileInfos.filter((file) => file.isTest).length,
    totalLines,
    fileTypes,
    packageManager: await detectPackageManager(loaded.targetRoot),
    stackHints: await detectStackHints(loaded.targetRoot),
    riskFiles,
    dependencyEdges
  };
}

async function walkFiles(root: string, ignore: string[]): Promise<string[]> {
  const normalizedIgnore = [...DEFAULT_IGNORE, ...ignore];
  const result: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));

      if (isIgnored(relativePath, normalizedIgnore)) {
        continue;
      }

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

function isIgnored(relativePath: string, ignore: string[]): boolean {
  const normalized = relativePath.replace(/^\.\//, "");

  return ignore.some((pattern) => {
    const cleanPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

    if (cleanPattern.includes("*")) {
      const escaped = cleanPattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*");
      return new RegExp(`^${escaped}($|/)`).test(normalized);
    }

    return normalized === cleanPattern
      || normalized.startsWith(`${cleanPattern}/`)
      || normalized.split("/").includes(cleanPattern);
  });
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).length;
}

function isTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|test|tests)\//.test(relativePath)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    || /\.(test|spec)\.vue$/.test(relativePath);
}

async function collectDependencyEdges(root: string, files: FileInfo[]): Promise<DependencyEdge[]> {
  const fileSet = new Set(files.map((file) => file.absolutePath));
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    if (!JS_LIKE_EXTENSIONS.has(file.ext)) {
      continue;
    }

    const content = await fs.readFile(file.absolutePath, "utf8");
    const imports = extractRelativeImports(content);
    for (const importPath of imports) {
      const resolved = resolveImportPath(path.dirname(file.absolutePath), importPath, fileSet);
      if (resolved) {
        edges.push({
          from: file.relativePath,
          to: toPosixPath(path.relative(root, resolved))
        });
      }
    }
  }

  return edges;
}

function extractRelativeImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1];
      if (value.startsWith(".")) {
        imports.add(value);
      }
    }
  }

  return [...imports];
}

function resolveImportPath(fromDir: string, importPath: string, fileSet: Set<string>): string | undefined {
  const base = path.resolve(fromDir, importPath);
  const parsed = path.parse(base);
  const extensionAliases = [".js", ".jsx", ".mjs", ".cjs"].includes(parsed.ext)
    ? [
        path.join(parsed.dir, `${parsed.name}.ts`),
        path.join(parsed.dir, `${parsed.name}.tsx`)
      ]
    : [];
  const candidates = [
    base,
    ...extensionAliases,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx")
  ];

  return candidates.find((candidate) => fileSet.has(candidate));
}

function calculateRiskFiles(files: FileInfo[], importerCounts: Record<string, number>): RiskFile[] {
  return files
    .filter((file) => file.isSource && !file.isTest)
    .map((file) => {
      const importerCount = importerCounts[file.relativePath] ?? 0;
      const reasons: string[] = [];
      let score = 0;

      if (file.lines >= 500) {
        score += 30;
        reasons.push("large source file");
      } else if (file.lines >= 250) {
        score += 15;
        reasons.push("medium-large source file");
      }

      if (importerCount >= 10) {
        score += 30;
        reasons.push("widely imported");
      } else if (importerCount >= 3) {
        score += 15;
        reasons.push("shared module");
      }

      if (!hasNearbyTest(file.relativePath, files)) {
        score += 10;
        reasons.push("no nearby test detected");
      }

      return {
        path: file.relativePath,
        score,
        reasons,
        lines: file.lines,
        importerCount
      };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || b.importerCount - a.importerCount)
    .slice(0, 30);
}

function hasNearbyTest(relativePath: string, files: FileInfo[]): boolean {
  const parsed = path.posix.parse(relativePath);
  const baseName = parsed.name.replace(/\.(test|spec)$/, "");
  const dir = parsed.dir;

  return files.some((file) => {
    if (!file.isTest) {
      return false;
    }
    const testParsed = path.posix.parse(file.relativePath);
    return testParsed.dir === dir && testParsed.name.startsWith(baseName);
  });
}

async function detectPackageManager(root: string): Promise<ScanSummary["packageManager"]> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(path.join(root, "bun.lockb")) || await pathExists(path.join(root, "bun.lock"))) {
    return "bun";
  }
  if (await pathExists(path.join(root, "package-lock.json"))) {
    return "npm";
  }
  return "unknown";
}

async function detectStackHints(root: string): Promise<string[]> {
  const packageJsonPath = path.join(root, "package.json");
  if (!await pathExists(packageJsonPath)) {
    return [];
  }

  const packageJson = await readJsonFile<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(packageJsonPath);
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  const hints: string[] = [];

  for (const name of ["react", "vue", "svelte", "next", "nuxt", "vite", "webpack", "typescript", "jest", "vitest", "playwright", "eslint"]) {
    if (deps[name]) {
      hints.push(name);
    }
  }

  return hints;
}
