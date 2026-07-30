import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";

export type JavaStructuredParserMode = "off" | "preferred" | "required";

export interface JavaStructuredParserDiagnostic {
  kind: "ERROR" | "WARNING" | "MANDATORY_WARNING" | "NOTE" | "OTHER";
  file?: string;
  line?: number;
  column?: number;
  code: string;
}

export interface JavaStructuredParserAttestation {
  protocol: "migration-guard.java-structure/v1";
  backend: "jdk-compiler-tree-api";
  mode: JavaStructuredParserMode;
  status: "disabled" | "parsed" | "unavailable" | "failed";
  javaVersion?: string;
  fileCount: number;
  parsedFileCount: number;
  typeDeclarationCount: number;
  methodDeclarationCount: number;
  syntaxErrorCount: number;
  diagnostics: JavaStructuredParserDiagnostic[];
  findings: string[];
}

interface JavaHelperResult {
  protocol: "migration-guard.java-structure-helper/v1";
  javaVersion: string;
  fileCount: number;
  parsedFileCount: number;
  typeDeclarationCount: number;
  methodDeclarationCount: number;
  syntaxErrorCount: number;
  diagnostics: JavaStructuredParserDiagnostic[];
}

const HELPER_SOURCE = String.raw`
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;

public final class MigrationGuardJavaStructure {
  private static final Set<String> SKIP_DIRS = Set.of(
    ".git", ".migration-guard", ".idea", ".gradle", "node_modules", "dist", "build", "target", "__pycache__"
  );

  public static void main(String[] args) throws Exception {
    if (args.length != 2) {
      System.err.println("usage: MigrationGuardJavaStructure <root> <include-tests>");
      System.exit(64);
    }
    Path root = Path.of(args[0]).toAbsolutePath().normalize();
    boolean includeTests = Boolean.parseBoolean(args[1]);
    List<Path> files = collect(root, includeTests);
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.err.println("JDK compiler API is unavailable");
      System.exit(69);
    }
    DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
    int[] counts = new int[] {0, 0, 0};
    try (StandardJavaFileManager manager = compiler.getStandardFileManager(collector, null, null)) {
      Iterable<? extends JavaFileObject> inputs = manager.getJavaFileObjectsFromPaths(files);
      JavacTask task = (JavacTask) compiler.getTask(
        null, manager, collector, List.of("-proc:none", "-Xlint:none"), null, inputs
      );
      Iterable<? extends CompilationUnitTree> units = task.parse();
      TreeScanner<Void, Void> scanner = new TreeScanner<>() {
        @Override public Void visitClass(ClassTree node, Void unused) {
          counts[1] += 1;
          return super.visitClass(node, unused);
        }
        @Override public Void visitMethod(MethodTree node, Void unused) {
          counts[2] += 1;
          return super.visitMethod(node, unused);
        }
      };
      for (CompilationUnitTree unit : units) {
        counts[0] += 1;
        scanner.scan(unit, null);
      }
    }
    List<Diagnostic<? extends JavaFileObject>> diagnostics = collector.getDiagnostics();
    long errors = diagnostics.stream().filter(item -> item.getKind() == Diagnostic.Kind.ERROR).count();
    StringBuilder out = new StringBuilder();
    out.append("{");
    field(out, "protocol", "migration-guard.java-structure-helper/v1").append(",");
    field(out, "javaVersion", System.getProperty("java.version")).append(",");
    number(out, "fileCount", files.size()).append(",");
    number(out, "parsedFileCount", counts[0]).append(",");
    number(out, "typeDeclarationCount", counts[1]).append(",");
    number(out, "methodDeclarationCount", counts[2]).append(",");
    number(out, "syntaxErrorCount", errors).append(",");
    out.append("\"diagnostics\":[");
    int limit = Math.min(diagnostics.size(), 50);
    for (int index = 0; index < limit; index += 1) {
      if (index > 0) out.append(",");
      Diagnostic<? extends JavaFileObject> item = diagnostics.get(index);
      out.append("{");
      field(out, "kind", item.getKind().name()).append(",");
      String file = item.getSource() == null ? null : root.relativize(Path.of(item.getSource().toUri())).toString().replace('\\', '/');
      if (file != null) field(out, "file", file).append(",");
      number(out, "line", item.getLineNumber()).append(",");
      number(out, "column", item.getColumnNumber()).append(",");
      field(out, "code", item.getCode());
      out.append("}");
    }
    out.append("]}");
    System.out.println(out);
  }

  private static List<Path> collect(Path root, boolean includeTests) throws IOException {
    List<Path> files = new ArrayList<>();
    try (var stream = Files.walk(root)) {
      stream.filter(Files::isRegularFile)
        .filter(file -> file.getFileName().toString().endsWith(".java"))
        .filter(file -> {
          for (Path segment : root.relativize(file)) {
            if (SKIP_DIRS.contains(segment.toString())) return false;
          }
          if (includeTests) return true;
          String relative = root.relativize(file).toString().replace('\\', '/');
          return !relative.contains("/src/test/") && !relative.startsWith("src/test/") && !relative.endsWith("Test.java");
        })
        .forEach(files::add);
    }
    files.sort(Comparator.comparing(Path::toString));
    return files;
  }

  private static StringBuilder field(StringBuilder out, String name, String value) {
    return out.append("\"").append(escape(name)).append("\":\"").append(escape(value)).append("\"");
  }
  private static StringBuilder number(StringBuilder out, String name, long value) {
    return out.append("\"").append(escape(name)).append("\":").append(value);
  }
  private static String escape(String value) {
    StringBuilder out = new StringBuilder();
    for (int index = 0; index < value.length(); index += 1) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (ch < 32) out.append(String.format("\\u%04x", (int) ch));
          else out.append(ch);
      }
    }
    return out.toString();
  }
}
`;

export async function inspectJavaStructure(
  root: string,
  includeTests: boolean,
  mode: JavaStructuredParserMode,
  cacheIdentity?: string
): Promise<JavaStructuredParserAttestation> {
  if (mode === "off") return emptyAttestation(mode, "disabled");
  const cachePath = cacheIdentity
    ? structuredParserCachePath(root, includeTests, cacheIdentity)
    : undefined;
  if (cachePath) {
    const cached = await readCachedHelperResult(cachePath);
    if (cached) return helperToAttestation(cached, mode);
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "migration-guard-java-structure-"));
  const helperPath = path.join(temporaryRoot, "MigrationGuardJavaStructure.java");
  try {
    await writeFile(helperPath, HELPER_SOURCE, "utf8");
    const execution = await runJavaHelper(helperPath, path.resolve(root), includeTests);
    if (execution.error) {
      const report = {
        ...emptyAttestation(mode, "unavailable" as const),
        findings: ["MG-JAVA-STRUCTURED-PARSER-UNAVAILABLE"]
      };
      if (mode === "required") throw structuredParserError(report, execution.error);
      return report;
    }
    if (execution.exitCode !== 0) {
      const report = {
        ...emptyAttestation(mode, "failed" as const),
        findings: ["MG-JAVA-STRUCTURED-PARSER-FAILED"]
      };
      if (mode === "required") throw structuredParserError(report, execution.stderr);
      return report;
    }
    const helper = parseHelperResult(execution.stdout);
    if (cachePath) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(helper), "utf8");
    }
    return helperToAttestation(helper, mode);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function seedJavaStructureCache(
  root: string,
  includeTests: boolean,
  cacheIdentity: string,
  attestation: JavaStructuredParserAttestation
): Promise<void> {
  if (attestation.status !== "parsed"
    || attestation.backend !== "jdk-compiler-tree-api"
    || attestation.syntaxErrorCount !== 0
    || attestation.fileCount !== attestation.parsedFileCount
    || !attestation.javaVersion) {
    throw new Error("Only a complete parsed JDK structure attestation can seed the cache.");
  }
  const helper: JavaHelperResult = {
    protocol: "migration-guard.java-structure-helper/v1",
    javaVersion: attestation.javaVersion,
    fileCount: attestation.fileCount,
    parsedFileCount: attestation.parsedFileCount,
    typeDeclarationCount: attestation.typeDeclarationCount,
    methodDeclarationCount: attestation.methodDeclarationCount,
    syntaxErrorCount: attestation.syntaxErrorCount,
    diagnostics: attestation.diagnostics
  };
  const cachePath = structuredParserCachePath(root, includeTests, cacheIdentity);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(helper), "utf8");
}

function helperToAttestation(
  helper: JavaHelperResult,
  mode: JavaStructuredParserMode
): JavaStructuredParserAttestation {
  const findings: string[] = [];
  if (helper.parsedFileCount !== helper.fileCount) {
    findings.push(`MG-JAVA-STRUCTURED-PARSER-INCOMPLETE:${helper.parsedFileCount}/${helper.fileCount}`);
  }
  if (helper.syntaxErrorCount > 0) {
    findings.push(`MG-JAVA-STRUCTURED-PARSER-SYNTAX-ERRORS:${helper.syntaxErrorCount}`);
  }
  const report: JavaStructuredParserAttestation = {
    protocol: "migration-guard.java-structure/v1",
    backend: "jdk-compiler-tree-api",
    mode,
    status: findings.length === 0 ? "parsed" : "failed",
    javaVersion: helper.javaVersion,
    fileCount: helper.fileCount,
    parsedFileCount: helper.parsedFileCount,
    typeDeclarationCount: helper.typeDeclarationCount,
    methodDeclarationCount: helper.methodDeclarationCount,
    syntaxErrorCount: helper.syntaxErrorCount,
    diagnostics: helper.diagnostics,
    findings
  };
  if (mode === "required" && report.status !== "parsed") {
    throw structuredParserError(report, findings.join(", "));
  }
  return report;
}

function structuredParserCachePath(root: string, includeTests: boolean, cacheIdentity: string): string {
  const key = sha256(stableStringify({
    protocol: "migration-guard.java-structure-cache/v1",
    helperHash: sha256(HELPER_SOURCE),
    root: path.resolve(root),
    includeTests,
    cacheIdentity
  }));
  return path.join(os.tmpdir(), "migration-guard-java-structure-cache", `${key}.json`);
}

async function readCachedHelperResult(cachePath: string): Promise<JavaHelperResult | undefined> {
  try {
    return parseHelperResult(await readFile(cachePath, "utf8"));
  } catch {
    return undefined;
  }
}

function emptyAttestation(
  mode: JavaStructuredParserMode,
  status: JavaStructuredParserAttestation["status"]
): JavaStructuredParserAttestation {
  return {
    protocol: "migration-guard.java-structure/v1",
    backend: "jdk-compiler-tree-api",
    mode,
    status,
    fileCount: 0,
    parsedFileCount: 0,
    typeDeclarationCount: 0,
    methodDeclarationCount: 0,
    syntaxErrorCount: 0,
    diagnostics: [],
    findings: []
  };
}

function parseHelperResult(stdout: string): JavaHelperResult {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("JDK structured parser returned no result.");
  const value = JSON.parse(line) as Partial<JavaHelperResult>;
  if (value.protocol !== "migration-guard.java-structure-helper/v1"
    || !Number.isInteger(value.fileCount)
    || !Number.isInteger(value.parsedFileCount)
    || !Number.isInteger(value.typeDeclarationCount)
    || !Number.isInteger(value.methodDeclarationCount)
    || !Number.isInteger(value.syntaxErrorCount)
    || !Array.isArray(value.diagnostics)) {
    throw new Error("JDK structured parser returned an invalid result.");
  }
  return value as JavaHelperResult;
}

function structuredParserError(report: JavaStructuredParserAttestation, details: string): Error {
  const suffix = details.trim() ? ` ${details.trim().slice(0, 500)}` : "";
  return new Error(`${report.findings.join(",") || "MG-JAVA-STRUCTURED-PARSER-FAILED"}.${suffix}`);
}

function runJavaHelper(
  helperPath: string,
  root: string,
  includeTests: boolean
): Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("java", [helperPath, root, String(includeTests)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: { exitCode: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish({ exitCode: null, error: error.message }));
    child.on("close", (exitCode) => finish({ exitCode }));
  });
}
