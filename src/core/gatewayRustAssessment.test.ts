import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessJavaGatewayForRust, renderGatewayRustAssessment } from "./gatewayRustAssessment.js";

test("Gateway assessment models routes, filter order, continuation, headers, and streams", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-gateway-"));
  await mkdir(path.join(root, "src", "main", "resources"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "src", "main", "resources", "application.yaml"), [
    "spring:",
    "  application:",
    "    name: fixture",
    "  config:",
    "    import:",
    "      - optional:nacos:${spring.application.name}.yaml",
    "  cloud:",
    "    gateway:",
    "      routes:",
    "        - id: api-route",
    "          uri: grayLb://api-service",
    "          predicates:",
    "            - Path=/api/**",
    "          filters:",
    "            - RewritePath=/api/(?<segment>.*), /${segment}",
    "        - id: socket-route",
    "          uri: lb:ws://socket-service",
    "          predicates:",
    "            - Path=/ws/**",
    "knife4j:",
    "  gateway:",
    "    routes:",
    "      - name: must-not-be-a-gateway-route",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "Filters.java"), [
    "package demo;",
    "class Ordered {}",
    "class SafeFilter implements GlobalFilter, Ordered {",
    " public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  if (exchange == null) return Mono.empty();",
    "  return delegate(exchange, chain);",
    " }",
    " private Mono<Void> delegate(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  return chain.filter(exchange);",
    " }",
    " public int getOrder() { return -100; }",
    "}",
    "class IdentityFilter implements GlobalFilter, Ordered {",
    " public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  ServerWebExchange clean = removeLoginUser(exchange);",
    "  clean.mutate().request(builder -> builder.header(\"login-user\", \"trusted\").headers(headers -> headers.add(\"tenant-id\", \"derived\")));",
    "  return chain.filter(clean);",
    " }",
    " private ServerWebExchange removeLoginUser(ServerWebExchange exchange) {",
    "  exchange.getRequest().mutate().headers(headers -> headers.remove(\"login-user\"));",
    "  return exchange;",
    " }",
    " public int getOrder() { return -99; }",
    "}",
    "class DuplicateFilter implements GlobalFilter, Ordered {",
    " public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  return chain.filter(exchange).then(Mono.defer(() -> {",
    "   return chain.filter(exchange);",
    "  }));",
    " }",
    " public int getOrder() { return NettyWriteResponseFilter.WRITE_RESPONSE_FILTER_ORDER + 1; }",
    "}",
    "class BranchFilter implements GlobalFilter, Ordered {",
    " public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  return verify().flatMap(valid -> {",
    "   if (valid) return chain.filter(exchange);",
    "   return chain.filter(exchange);",
    "  }).onErrorResume(error -> chain.filter(exchange));",
    " }",
    " public int getOrder() { return 10; }",
    "}",
    "class LoggingFilter implements GlobalFilter, Ordered {",
    " public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  AccessLog log = new AccessLog();",
    "  log.setRequestHeaders(exchange.getRequest().getHeaders());",
    "  return withBody(exchange, chain);",
    " }",
    " private Mono<Void> withBody(ServerWebExchange exchange, GatewayFilterChain chain) {",
    "  ServerRequest request = ServerRequest.create(exchange, readers);",
    "  Mono<String> body = request.bodyToMono(String.class);",
    "  Flux.from(responseBody).buffer();",
    "  return chain.filter(exchange);",
    " }",
    " public int getOrder() { return Ordered.HIGHEST_PRECEDENCE; }",
    "}",
    "class CorsWebFilter implements WebFilter {",
    " public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) { return chain.filter(exchange); }",
    "}",
    ""
  ].join("\n"));

  const report = await assessJavaGatewayForRust({ root });
  assert.equal(report.routeCount, 2);
  assert.equal(report.filterCount, 6);
  assert.equal(report.externalConfigStatus, "unresolved");
  assert.deepEqual(report.summary.schemes, { "grayLb": 1, "lb:ws": 1 });
  assert.equal(report.summary.continuationViolations, 1);
  assert.equal(report.summary.requestAggregatingFilters, 1);
  assert.equal(report.summary.responseAggregatingFilters, 1);

  const duplicate = report.filters.find((item) => item.className === "DuplicateFilter");
  const branch = report.filters.find((item) => item.className === "BranchFilter");
  const safe = report.filters.find((item) => item.className === "SafeFilter");
  const identity = report.filters.find((item) => item.className === "IdentityFilter");
  assert.equal(duplicate?.continuation.status, "violated");
  assert.equal(branch?.continuation.status, "once-or-terminal");
  assert.equal(safe?.continuation.status, "once-or-terminal");
  assert.ok(identity?.findings.includes("GW-HEADER-SENSITIVE-APPEND-WITHOUT-REMOVE:tenant-id"));
  assert.ok(!identity?.findings.includes("GW-HEADER-SENSITIVE-APPEND-WITHOUT-REMOVE:login-user"));

  const websocket = report.routes.find((item) => item.id === "socket-route");
  assert.equal(websocket?.streamKind, "websocket");
  assert.equal(websocket?.streamContract.grayLoadBalancerBypassed, true);
  assert.equal(websocket?.status, "blocked");
  assert.equal(report.routes[0]?.filterChain[0], "web:CorsWebFilter@2147483647");
  assert.match(renderGatewayRustAssessment(report), /Gateway Rust Assessment/);
});

test("Gateway assessment accepts an explicit external config snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-guard-gateway-snapshot-"));
  const resources = path.join(root, "src", "main", "resources");
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, "application.yaml"), [
    "spring:",
    "  config:",
    "    import:",
    "      - optional:nacos:fixture.yaml",
    "  cloud:",
    "    gateway:",
    "      routes:",
    "        - id: local",
    "          uri: grayLb://local",
    "          predicates:",
    "            - Path=/local/**",
    ""
  ].join("\n"));
  const snapshot = path.join(root, "effective-nacos.yaml");
  await writeFile(snapshot, [
    "spring:",
    "  cloud:",
    "    gateway:",
    "      routes:",
    "        - id: local",
    "          uri: grayLb://snapshot-local",
    "          predicates:",
    "            - Path=/snapshot/**",
    ""
  ].join("\n"));
  const report = await assessJavaGatewayForRust({ root, configSnapshots: [snapshot] });
  assert.equal(report.externalConfigStatus, "snapshot-supplied");
  assert.equal(report.routeCount, 1);
  assert.equal(report.routes[0]?.uri, "grayLb://snapshot-local");
  assert.equal(report.summary.findings["GW-EFFECTIVE-CONFIG-EXTERNAL-UNRESOLVED"], undefined);
});
