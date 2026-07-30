import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { inspectJavaStructure } from "./javaStructuredParser.js";

test("structured Java parser reports compiler-tree declaration coverage when a JDK is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-structure-"));
  try {
    await mkdir(path.join(root, "src", "main", "java"), { recursive: true });
    await writeFile(path.join(root, "src", "main", "java", "OrderService.java"), [
      "package example;",
      "final class OrderService {",
      "  record Request(String id) {}",
      "  String load(Request request) { return request.id(); }",
      "}"
    ].join("\n"));
    const report = await inspectJavaStructure(root, false, "preferred");
    if (report.status === "unavailable") {
      assert.ok(report.findings.includes("MG-JAVA-STRUCTURED-PARSER-UNAVAILABLE"));
      return;
    }
    assert.equal(report.status, "parsed");
    assert.equal(report.fileCount, 1);
    assert.equal(report.parsedFileCount, 1);
    assert.ok(report.typeDeclarationCount >= 2);
    assert.ok(report.methodDeclarationCount >= 1);
    assert.equal(report.syntaxErrorCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured Java parser fails closed on syntax errors in required mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-structure-"));
  try {
    await writeFile(path.join(root, "Broken.java"), "class Broken { void run( { }");
    const preferred = await inspectJavaStructure(root, false, "preferred");
    if (preferred.status === "unavailable") return;
    assert.equal(preferred.status, "failed");
    assert.ok(preferred.syntaxErrorCount > 0);
    await assert.rejects(
      inspectJavaStructure(root, false, "required"),
      /MG-JAVA-STRUCTURED-PARSER-SYNTAX-ERRORS/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
