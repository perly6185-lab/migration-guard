# Phase 76 Report: Real md.git Readiness To Go

生成日期：2026-07-08

## Goal

把真实 `md.git` validation lane 从 Phase 75 的 `readiness: hold` 推进到 `readiness: go`，并验证通过后的 proposal rollback 仍能被 readiness 作为有效 batch evidence 识别。

## Target

```text
https://github.com/perly6185-lab/md.git
```

Local target:

```text
D:/learn/migration-guard-targets/md
```

Run id:

```text
run-2026-07-08T04-10-31-670Z-btbcxw
```

## Execution

Resume completed the dry-run migration:

```text
Status: completed
Mode: auto (md-monorepo)
Tasks: done:7
Action check readiness: actions:9 checks:14 tracked:14 ready:14 no-op-risk:0 unknown:0
```

Generated proposals:

```text
patch-2026-07-08T05-53-44-987Z-iup2cp
  action: action-md-shared-contracts
  template: ts-structural-probe

patch-2026-07-08T05-53-44-987Z-st6a2t
  action: action-md-core-renderer
  template: renderer-probe

patch-2026-07-08T05-53-45-011Z-uwqr2m
  action: action-md-api-contracts
  template: api-contract-probe
```

Batch report:

```text
proposal-batch-report-2026-07-08T05-54-36-448Z-or2qyb
passed: yes
executed: 3
skipped: 0
excluded: 0
gate policy: fail-fast
```

Rollback:

```text
patch-2026-07-08T05-53-44-987Z-iup2cp: rollback passed
patch-2026-07-08T05-53-44-987Z-st6a2t: rollback passed
patch-2026-07-08T05-53-45-011Z-uwqr2m: rollback passed
```

## Readiness Result

Final command:

```bash
node dist/cli.js readiness --config configs/md-fast.migration-guard.json --run run-2026-07-08T04-10-31-670Z-btbcxw --strict
```

Final result:

```text
Status: go
Blockers: 0
Warnings: 1
Actions: 9
Proposals: 3
Batches: 1
Latest passing batch: proposal-batch-report-2026-07-08T05-54-36-448Z-or2qyb
Target clean: yes
```

The remaining warning is expected for this lane:

```text
confidence: medium
```

The readiness gate now accepts a passing batch as proposal-floor evidence after the applied proposals are rolled back:

```text
0 live candidate proposal(s); latest passing batch covers 3 proposal(s)
```

## Artifacts

- `reports/action-check-readiness-handoff.md`
- `reports/refactor-readiness.json`
- `reports/refactor-readiness.md`
- `reports/latest-report.md`
- `proposal-batches/proposal-batch-2026-07-08T05-54-11-156Z-zsnocg/proposal-batch-report-2026-07-08T05-54-36-448Z-or2qyb.json`
- proposal rollback reports under each proposal directory

## Verification

```text
npm test: 44 passed
git diff --check: passed with Windows LF/CRLF warnings only
target md repo: ## main...origin/main
```

## Exit Criteria

- Action plan generated: passed.
- Action check readiness all ready: passed.
- At least 3 proposals generated: passed.
- Required templates covered: passed.
- 3-proposal batch passed: passed.
- Applied proposals rolled back: passed.
- Target md repository clean: passed.
- `readiness --strict` returns `go`: passed.

## Next

The project is now ready for a scoped real refactor trial. Keep the first real trial small:

- choose one medium-risk dry-run-only lane or one tightly scoped high-risk lane;
- apply behavior diff on the proposal;
- require rollback or a clean commit boundary before expanding;
- keep `readiness --strict` as the preflight gate before any larger batch.
