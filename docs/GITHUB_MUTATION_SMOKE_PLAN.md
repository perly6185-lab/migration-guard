# GitHub Mutation Smoke Plan

This is the safety plan and record pointer for real GitHub mutation smoke. It is
not authorization to run mutation.

Status update, 2026-07-06: one authorized single-issue mutation smoke was
completed. See `docs/PHASE_35_REPORT.md`. Do not run another mutation without a
new read-only plan and separate authorization.

## Safety Contract

Required before any real mutation:

- Separate explicit user authorization.
- A stable read-only `--live-plan` for the chosen issue.
- `--only-issue <mg_issue_id>` to limit the scope.
- `--max-live-mutations 1`.
- `--live-confirm <run-id>`.
- `--live-plan-confirm <planHash>`.

Allowed after authorization:

- One `POST /issues` or one `PATCH /issues/{number}`.
- Local Migration Guard artifact writes.

Not allowed without separate authorization:

- Multiple create/update mutations.
- Running `--live` without `--only-issue`.
- Running with `--max-live-mutations` greater than `1`.

## Select One Issue

Use the current local issues list:

```bash
node dist/cli.js issues --config configs/md-fast.migration-guard.json --run latest
```

Choose one low-risk issue id. Prefer a synthetic or clearly labeled migration
guard issue that can be safely closed or edited later.

## Dry-Run Filter Check

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run --only-issue <mg_issue_id>
```

Expected:

- `github-dry-run-issues.json` contains exactly one issue.
- The issue has `migrationGuard.issueId == <mg_issue_id>`.

## Read-Only Plan

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard --only-issue <mg_issue_id>
```

Expected:

- CLI prints read-only GET/no POST/PATCH message.
- `github-live-plan-summary.json` has `mutationCount: 1`.
- Record `planHash`.

## Future Mutation Command

Do not run this command without separate explicit authorization:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo perly6185-lab/migration-guard --live-confirm <run-id> --live-plan-confirm <planHash> --max-live-mutations 1 --only-issue <mg_issue_id>
```

## Post-Mutation Checks

After an authorized mutation smoke:

- Confirm `github-live-sync.json` has exactly one `created` or `updated` issue.
- Confirm the GitHub URL was written to the matching local issue only.
- Scan artifacts for `GITHUB_TOKEN`, `Authorization`, `Bearer`, `gho_`, `ghp_`, and `github_pat_`.
- Record the created/updated issue URL in a phase report.
- Do not run a second mutation without a new read-only plan and explicit authorization.
