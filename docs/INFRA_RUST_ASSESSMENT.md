# Infrastructure Rust Assessment

`assess-infra` inventories infrastructure-specific migration contracts that are
not fully represented by ordinary Controller, Service, and Repository call
graphs.

```bash
node dist/cli.js java-endpoint assess-infra \
  --root ../java-service \
  --apply \
  --artifacts-dir .migration-guard
```

The command emits `infra-rust-assessment.json` and
`infra-rust-assessment.md`. It currently covers:

- locally implemented Feign routes, implementation binding, fallback evidence,
  identity headers, and `permitAll` exposure;
- WebSocket listeners, scheduled jobs, async methods, runners,
  `@PostConstruct` hooks, and servlet filters;
- file storage enum registration, reflected client/config types, and provider
  upload, delete, read, and presigned-URL capabilities;
- non-atomic cache refresh/create patterns, mutable provider refresh, and
  multipart init/part/complete concurrency protection.

The assessment fails closed. An outbound-only Feign client is not treated as a
local route, and a local Feign contract is included only when a source
Controller implementation can be bound. A detected provider capability means
that source evidence exists; it does not prove remote consistency, retry,
latency, failure, or multi-instance behavior.

Exit code `1` means at least one contract is blocked. Resolve those findings
with source changes or runtime evidence; do not use broad exclusions to turn
them into ready results.
