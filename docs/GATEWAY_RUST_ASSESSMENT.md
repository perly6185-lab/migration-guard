# Gateway Rust assessment

Use the Gateway assessment when Spring Cloud Gateway routes and filters are the production entrypoints:

```powershell
node dist/cli.js java-endpoint assess-gateway `
  --root D:\path\to\gateway `
  --apply `
  --artifacts-dir D:\path\to\artifacts
```

The report treats the following as first-class migration evidence:

- `spring.cloud.gateway.routes` IDs, URIs, predicates, filters, metadata, target services and declaration order;
- `WebFilter` and `GlobalFilter` layers, custom order values and framework filter anchors;
- path-sensitive `GatewayFilterChain` / `WebFilterChain` continuation use, including downstream re-entry from a post-completion callback;
- sensitive request-header reads, removal, replacement, append, capture and inferred provenance;
- request/response aggregation, SSE candidates, WebSocket routes, long-running routes, timeouts and gray-load-balancer bypass.

An unresolved Nacos import fails closed because source YAML alone does not prove the effective production route catalog. Supply exported configuration snapshots when available:

```powershell
node dist/cli.js java-endpoint assess-gateway `
  --root D:\path\to\gateway `
  --config-snapshots D:\evidence\nacos-prod.yaml,D:\evidence\nacos-common.yaml `
  --apply
```

The command writes `gateway-rust-assessment.json` and its Markdown rendering when `--apply` is used. A non-zero exit code means at least one route remains strictly blocked.
