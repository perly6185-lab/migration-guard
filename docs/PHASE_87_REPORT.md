# Phase 87 Report: One-Shot Guard Coverage

生成日期：2026-07-09

## Goal

在打开一次性重构窗口前，补齐 `md.git` 的 web/MCP 守护覆盖，并建立一条更接近 one-shot 改造前置门槛的 full guard lane。

## Added Coverage

New MCP render probe:

```text
scripts/probes/md-mcp-render-probe.mjs
```

Probe contract:

```text
style wrapper: checked
heading render: checked
alert render: checked
KaTeX block render: checked
code block render: checked
Mac code sign: checked
line-number signal: checked
custom CSS injection: checked
front matter title: checked
reading time: checked
remote CSS fetch avoided: checked
```

Config updates:

```text
configs/md-full.migration-guard.json
configs/md-one-shot.migration-guard.json
```

`md-one-shot` includes these critical checks:

```text
core-test
web-test
packages-type-check
web-type-check
web-build
```

`md-one-shot` includes these probes:

```text
md-renderer-behavior
md-api-contract
md-web-static-contract
md-mcp-render-contract
```

The MCP probe runs from target root, then re-enters the `@md/mcp-server` package context so the package tsconfig path mapping is active. This keeps the probe stable without changing target source.

## Verification

Direct MCP probe:

```text
node ..\..\migration-guard\scripts\probes\md-mcp-render-probe.mjs
```

Result:

```text
passed
remoteFetchCount: 0
```

Migration Guard self-test:

```text
npm test
```

Result:

```text
44 tests passed
```

One-shot baseline:

```text
baseline-2026-07-09T07-45-17-196Z
```

One-shot verify:

```text
run-2026-07-09T07-46-16-727Z
```

Checks:

```text
core-test: passed
web-test: passed
packages-type-check: passed
web-type-check: passed
web-build: passed
```

Probes:

```text
md-renderer-behavior: passed
md-api-contract: passed
md-web-static-contract: passed
md-mcp-render-contract: passed
```

Compare:

```text
Passed: yes
No differences detected.
```

Compare artifact:

```text
.migration-guard/external-targets/md-one-shot/compare/1783583176748.json
```

Target status after validation:

```text
## main...origin/main
```

## Notes

- Initial MCP probe execution exposed an execution-context mismatch: `@md/core/theme/cssProcessor` resolves in the MCP package tsconfig context, not from the monorepo root import context.
- The final probe keeps the target source unchanged and makes the guard script responsible for entering the MCP package context.
- `web-build` normalization now removes non-deterministic `run-p` subtask prelude order and local engine-warning noise so compare reports stay behavior-focused.

## Exit Criteria

- Web static contract is part of the one-shot lane: passed.
- MCP render contract is part of the one-shot lane: passed.
- Web build is critical in the one-shot lane: passed.
- One-shot baseline and verify both passed all checks/probes: passed.
- One-shot compare showed no differences: passed.
- Target repository remained clean and aligned with `origin/main`: passed.

## Next

Define the first tightly bounded one-shot refactor budget and hard gates:

```text
fresh md-one-shot baseline
bounded file/risk budget
pre-PR md-one-shot verify/compare
rollback rehearsal
PR merge
post-merge md-one-shot verify/compare
```
