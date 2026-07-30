import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { assessJavaInfraForRust, renderInfraRustAssessment } from "./infraRustAssessment.js";

test("infra assessment binds local Feign RPC and inventories providers, lifecycle, and concurrency risks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-infra-"));
  try {
    const source = path.join(root, "src", "main", "java", "sample");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "AuditApi.java"), [
      "package sample;",
      "@FeignClient(name = \"infra\")",
      "public interface AuditApi {",
      " @PostMapping(\"/rpc-api/infra/audit/create\")",
      " Object create(String value);",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "AuditApiImpl.java"), [
      "package sample;",
      "@RestController",
      "public class AuditApiImpl implements AuditApi {",
      " public Object create(String value) { return value; }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "SecurityConfig.java"), [
      "package sample;",
      "class SecurityConfig {",
      " void configure(Registry registry) { registry.requestMatchers(ApiConstants.PREFIX + \"/**\").permitAll(); }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "Providers.java"), [
      "package sample;",
      "enum FileStorageEnum {",
      " LOCAL(10, LocalConfig.class, LocalClient.class),",
      " S3(20, S3Config.class, S3Client.class);",
      "}",
      "class LocalClient extends AbstractFileClient<LocalConfig> {",
      " void upload() {} void delete() {} void getContent() {}",
      "}",
      "class S3Client extends AbstractFileClient<S3Config> {",
      " void upload() {} void delete() {} void getContent() {} void getPresignedObjectUrl() {}",
      "}",
      "class Factory { Object make(Storage storage) { return ReflectUtil.newInstance(storage.getClientClass()); } }"
    ].join("\n"));
    await writeFile(path.join(source, "RuntimeEntries.java"), [
      "package sample;",
      "class SocketEntry implements WebSocketMessageListener<Message> {",
      " public void onMessage(WebSocketSession session, Message message) {}",
      " public String getType() { return \"message\"; }",
      "}",
      "class Startup implements ApplicationRunner {",
      " public void run(ApplicationArguments args) { repository.save(value); }",
      "}",
      "class AuditFilter extends OncePerRequestFilter {}",
      "class FilterConfig {",
      " FilterRegistrationBean<AuditFilter> auditFilter() {",
      "  FilterRegistrationBean<AuditFilter> bean = new FilterRegistrationBean<>();",
      "  bean.setOrder(10); return bean;",
      " }",
      "}"
    ].join("\n"));
    await writeFile(path.join(source, "PackageService.java"), [
      "package sample;",
      "class PackageService {",
      " private final Map<String, Session> cache = new ConcurrentHashMap<>();",
      " void refreshPackageCache() { cache.clear(); cache.put(\"x\", new Session()); }",
      " void initializeMultipartUpload(String id) { Session value = cache.get(id); if (value == null) cache.put(id, new Session()); }",
      " void uploadMultipartPart(String id) { Files.write(path, bytes); }",
      " void completeMultipartUpload(String id) { Files.move(tmp, target); }",
      "}"
    ].join("\n"));

    const report = await assessJavaInfraForRust({ root });
    assert.equal(report.rpcEndpoints.length, 1);
    assert.equal(report.rpcEndpoints[0]?.implementation, "AuditApiImpl.create");
    assert.ok(report.rpcEndpoints[0]?.findings.includes("IR-FEIGN-IDENTITY-PROTECTION-UNPROVEN"));
    assert.equal(report.storageProviders.length, 2);
    assert.equal(report.storageProviders.find((item) => item.storage === "S3")?.capabilities.presignedUpload, true);
    assert.equal(report.providerRegistryResolved, true);
    assert.ok(report.entrypoints.some((item) => item.kind === "websocket"));
    assert.ok(report.entrypoints.some((item) => item.kind === "lifecycle-hook"));
    assert.ok(report.entrypoints.some((item) => item.kind === "servlet-filter" && item.status === "ready"));
    assert.ok(report.concurrencyRisks.some((item) => item.finding === "IR-CACHE-CLEAR-THEN-REFILL-NONATOMIC"));
    assert.ok(report.concurrencyRisks.some((item) => item.finding === "IR-MULTIPART-COMPLETE-CONCURRENCY-UNPROVEN"));
    assert.equal(report.status, "blocked");
    assert.match(renderInfraRustAssessment(report), /Storage provider capability matrix/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
