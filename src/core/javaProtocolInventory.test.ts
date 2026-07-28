import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { inventoryJavaProtocolEntrypoints } from "./javaProtocolInventory.js";

test("Java protocol inventory finds non-HTTP and streaming entrypoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-protocols-"));
  try {
    const source = path.join(root, "src", "main", "java", "sample");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "Entrypoints.java"), `
      @FeignClient(name = "remote")
      interface RemoteClient {}
      class SocketHandler extends TextWebSocketHandler {}
      class SocketListener implements WebSocketMessageListener<TaskMessage> {}
      class Startup implements ApplicationRunner { public void run(ApplicationArguments args) {} }
      class AuditFilter extends OncePerRequestFilter {}
      class LocalStore extends AbstractFileClient<LocalConfig> {}
      class Config { void bind() { registry.addHandler(handler, "/ws/tasks"); } }
      class Jobs {
        @PostConstruct
        public void initialize() {}
        @Scheduled(cron = "0 * * * * *")
        public void refresh() {}
        @Async
        public void rebuild() {}
        @KafkaListener(topics = "events")
        public void consume(String event) {}
        @Tool(description = "lookup")
        public String lookup(String key) { return key; }
        public SseEmitter stream() { return new SseEmitter(); }
      }
    `);
    const report = await inventoryJavaProtocolEntrypoints(root);
    assert.equal(report.summary.kinds["feign-client"], 1);
    assert.equal(report.summary.kinds.websocket, 3);
    assert.equal(report.summary.kinds["scheduled-job"], 1);
    assert.equal(report.summary.kinds["async-method"], 1);
    assert.equal(report.summary.kinds["message-listener"], 1);
    assert.equal(report.summary.kinds["mcp-tool"], 1);
    assert.equal(report.summary.kinds["http-sse"], 1);
    assert.equal(report.summary.kinds["lifecycle-hook"], 2);
    assert.equal(report.summary.kinds["servlet-filter"], 1);
    assert.equal(report.summary.kinds["storage-provider"], 1);
    assert.ok(report.entries.some((entry) => entry.path === "/ws/tasks"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
