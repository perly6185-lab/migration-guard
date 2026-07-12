# Phase 97 Report: MD2 Issue-Controlled Refactor Lane

生成日期：2026-07-11

## Goal

矫正真实重构需求边界：

```text
perly6185-lab/md.git  -> source repository
perly6185-lab/md2     -> target repository
perly6185-lab/md2     -> GitHub issue control plane
```

`md` 不再作为重构目标或 issue 统筹仓库；Migration Guard 自身仓库也不承担这条
业务迁移的 issue 控制面。

## Delivered

New md2 configs:

- `configs/md2-fast.migration-guard.json`
- `configs/md2-full.migration-guard.json`
- `configs/md2-one-shot.migration-guard.json`

Each config sets:

```json
{
  "variables": {
    "MG_SOURCE_ROOT": "../../migration-guard-targets/md",
    "MG_TARGET_ROOT": "../../migration-guard-targets/md2"
  },
  "issueSync": {
    "githubRepo": "perly6185-lab/md2"
  }
}
```

New config capability:

```json
{
  "issueSync": {
    "githubRepo": "owner/repo"
  }
}
```

`sync-issues` now uses `--repo` when provided, otherwise it falls back to
`config.issueSync.githubRepo` for GitHub issue sync. If neither exists, the
existing safety failure remains. Live sync still requires `--live-confirm`,
`--live-plan-confirm`, and `GITHUB_TOKEN`.

New/updated operator docs:

- `docs/MD_OPERATOR_RUNBOOK.md`
- `docs/MD2_REFACTOR_ORCHESTRATION.md`
- `docs/GITHUB_MUTATION_SMOKE_PLAN.md`
- historical notes in `docs/MD_REAL_WORLD_VALIDATION_PLAN.md`
- historical notes in `docs/MD_REAL_WORLD_VALIDATION_REPORT.md`

## Operator Path

Local target checkout status:

- `D:/learn/migration-guard-targets/md` exists.
- `D:/learn/migration-guard-targets/md2` was cloned from
  `https://github.com/perly6185-lab/md2.git`.
- Git reported `md2` as an empty repository, so the first execution stage must
  bootstrap/import target code before fast/full target checks can pass.

```bash
node dist/cli.js run --config configs/md2-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md2 --goal "Refactor md into md2 with guarded behavior parity" --dry-run --adapter md-monorepo --issue-provider github
node dist/cli.js resume --config configs/md2-fast.migration-guard.json --run <run-id> --auto
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --dry-run --labels team:migration,source:md,target:md2
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live-plan --labels team:migration,source:md,target:md2
```

Real GitHub mutation remains gated:

```bash
node dist/cli.js sync-issues --config configs/md2-fast.migration-guard.json --run <run-id> --provider github --live --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 5
```

## Self-Healing Control

The intended loop is:

```text
local failure/replan issue
  -> sync to perly6185-lab/md2
  -> repair proposal
  -> verify
  -> accept
  -> sync updated issue state back to perly6185-lab/md2
```

GitHub issue matching uses `mg_issue_id`, so repeated syncs update existing
`md2` issues instead of creating duplicates.

## Verification

Executed verification:

```bash
npm test
git diff --check
```

Results:

- `npm test`: 58 tests passed.
- `git diff --check`: passed, with Windows LF/CRLF warnings only.
