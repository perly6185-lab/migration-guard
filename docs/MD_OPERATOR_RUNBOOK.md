# MD Operator Runbook

生成日期：2026-07-08

## 1. Purpose

This runbook is the short path for operating Migration Guard against the real `md` target. Detailed phase evidence remains in `docs/PHASE_57_REPORT.md` through `docs/PHASE_68_REPORT.md`.

## 2. Preconditions

- Tool repo: `D:/learn/migration-guard`
- Target repo: `D:/learn/migration-guard-targets/md`
- Config: `configs/md-fast.migration-guard.json`
- Target repository should start clean:

```bash
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Expected:

```text
## main...origin/main
```

## 3. Create And Resume A Run

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD guarded migration" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run <run-id>
```

Check action readiness:

- ready checks should be counted in `actions` output.
- no-op-risk should be 0 before proposal generation unless intentionally accepted.

## 4. Generate Proposals

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run <run-id> --action action-md-shared-contracts
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run <run-id> --action action-md-core-renderer
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run <run-id> --action action-md-web-editor-shell
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run <run-id> --action action-md-api-contracts
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run <run-id> --action action-md-mcp-render
```

Expected template coverage:

- shared contracts: `ts-structural-probe`
- core renderer: `renderer-probe`
- web editor shell: `ui-smoke-probe`
- API contracts: `api-contract-probe`
- MCP render: `renderer-probe`

## 5. Plan And Apply A Batch

```bash
node dist/cli.js proposal batch plan --config configs/md-fast.migration-guard.json --run <run-id> --limit 5
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run <run-id> --limit 5 --gate-policy fail-fast
```

If the batch passes, rollback each applied proposal after recording the report:

```bash
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run <run-id> --proposal <proposal-id>
```

If the batch fails, use the next command from the batch report:

```bash
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal retry --config configs/md-fast.migration-guard.json --run <run-id> --proposal <failed-proposal-id>
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run <run-id> --proposal <retry-proposal-id> --checks
node dist/cli.js proposal accept --config configs/md-fast.migration-guard.json --run <run-id> --proposal <retry-proposal-id> --notes "verified repair"
```

`proposal accept` requires a checked passing retry verification.

## 6. Exclude Superseded Proposals

Use `ignore` for proposed-only proposals replaced by a newer proposal:

```bash
node dist/cli.js proposal ignore --config configs/md-fast.migration-guard.json --run <run-id> --proposal <old-proposal-id> --reason "superseded by regenerated proposal" --superseded-by <new-proposal-id>
node dist/cli.js proposal list --config configs/md-fast.migration-guard.json --run <run-id> --state ignored
```

Batch plans should show ignored/rejected/rolled-back proposals under excluded, not selected.

## 7. Refresh Report

```bash
node dist/cli.js report --config configs/md-fast.migration-guard.json --run <run-id>
```

Review:

- `Next Action`
- `Evidence Graph`
- `Recent Proposal Gates`
- `Recent Proposal Batches`
- `Recent Repair Acceptances`

## 8. Artifact Maintenance

Dry-run GC:

```bash
node dist/cli.js artifacts gc --config configs/md-fast.migration-guard.json --keep-runs 5 --json
```

Dry-run schema migration:

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --json
```

Only apply a migration after reviewing the dry-run plan hash:

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --apply --apply-confirm <plan-hash>
```

## 9. Final Clean Check

Always finish with:

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Expected current baseline:

- `npm test`: 38 tests passed
- `git diff --check`: passes with Windows LF/CRLF warnings only
- target md repo: `## main...origin/main`
