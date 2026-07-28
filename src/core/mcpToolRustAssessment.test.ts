import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createJavaEndpointAnalyzer } from "./javaEndpointAnalysis.js";
import { inventoryJavaProtocolEntrypoints } from "./javaProtocolInventory.js";
import { assessJavaMcpToolsForRust, renderMcpToolRustAssessment } from "./mcpToolRustAssessment.js";

test("MCP tools are first-class entries with provider, schema, and Feign identity evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-mcp-tools-"));
  try {
    const source = path.join(root, "src", "main", "java", "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "ToolConfig.java"), [
      "package demo;",
      "class ToolConfig {",
      " @Bean",
      " public ToolCallbackProvider accountTools(AccountTool accountTool) {",
      "  return MethodToolCallbackProvider.builder().toolObjects(accountTool).build();",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "AccountTool.java"), [
      "package demo;",
      "@Service",
      "class AccountTool {",
      " @Resource private RemoteClient remoteClient;",
      " @Tool(",
      "   name = \"createAccount\",",
      "   description = \"Create an account with JSON {name,value}, while preserving (tenant) identity.\"",
      " )",
      " public String createAccount(",
      "   @ToolParam(description = \"tenant-id, injected by system\") String tenantId,",
      "   @ToolParam(description = \"Authorization token, injected by system\") String authorization,",
      "   @ToolParam(required = false, description = \"labels, such as {a,b}\") List<String> labels) {",
      "  return remoteClient.create(tenantId, labels);",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "DormantTool.java"), [
      "package demo;",
      "class DormantTool {",
      " // @Tool(name = \"commentedOut\")",
      " @Tool(name = \"lookup\", description = \"lookup\")",
      " public String lookup(@ToolParam(required = false, description = \"key\") String key) { return key; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "RemoteClient.java"), [
      "package demo;",
      "@FeignClient(name = \"remote\", fallback = WrongFallback.class)",
      "interface RemoteClient {",
      " @PostMapping(\"/accounts\")",
      " String create(@RequestHeader(\"tenant-id\") String tenantId, @RequestBody List<String> labels);",
      "}",
      "interface OtherClient {}",
      "class WrongFallback implements OtherClient {}"
    ].join("\n"));

    const analyzer = await createJavaEndpointAnalyzer(root);
    assert.equal(analyzer.mcpToolMethods.length, 2);
    assert.equal(analyzer.mcpToolMethods.filter((method) => method.registration === "registered").length, 1);
    assert.equal(analyzer.mcpToolProviders[0]?.providerBean, "accountTools");
    const tool = analyzer.mcpToolMethods.find((method) => method.toolName === "createAccount");
    assert.ok(tool);
    assert.equal(tool.description?.includes("{name,value}"), true);
    assert.deepEqual(tool.parameters.map((parameter) => [parameter.name, parameter.required, parameter.jsonType, parameter.identity]), [
      ["tenantId", true, "string", "tenant"],
      ["authorization", true, "string", "authorization"],
      ["labels", false, "array", undefined]
    ]);
    assert.equal(analyzer.feignClients[0]?.fallbackCompatible, false);
    assert.deepEqual(analyzer.feignClients[0]?.methods[0]?.headers.map((header) => header.identity), ["tenant"]);

    const inventory = await inventoryJavaProtocolEntrypoints(root);
    assert.equal(inventory.summary.kinds["mcp-tool"], 2);
    assert.deepEqual(inventory.entries.filter((entry) => entry.kind === "mcp-tool").map((entry) => entry.symbol).sort(), [
      "createAccount",
      "lookup"
    ]);

    const report = await assessJavaMcpToolsForRust({
      root,
      maxDepth: 6,
      maxEdges: 200,
      adaptive: true,
      maxExpansionDepth: 10,
      maxExpansionEdges: 500,
      maxExpansionRounds: 2
    });
    assert.equal(report.registeredToolCount, 1);
    assert.equal(report.annotatedOnlyToolCount, 1);
    const assessed = report.methods.find((method) => method.toolName === "createAccount");
    assert.equal(assessed?.workload, "command");
    assert.equal(assessed?.feignHops[0]?.headers[0]?.status, "proven");
    assert.deepEqual(assessed?.feignHops[0]?.droppedIdentities, ["authorization"]);
    assert.ok(assessed?.findings.includes("MCP-FEIGN-IDENTITY-DROPPED:authorization"));
    assert.ok(assessed?.findings.includes("MCP-FEIGN-FALLBACK-INCOMPATIBLE:RemoteClient"));
    assert.match(renderMcpToolRustAssessment(report), /Registered tools/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
