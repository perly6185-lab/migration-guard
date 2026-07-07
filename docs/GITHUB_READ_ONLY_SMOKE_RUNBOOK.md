# GitHub Read-Only Smoke Runbook

This runbook is for a real GitHub `--live-plan` smoke. It performs read-only
GitHub API lookup only.

## Safety Contract

Allowed:

- `GET /repos/{owner}/{repo}/issues?state=open&per_page=100`
- Writing local Migration Guard artifacts

Not allowed:

- `--live`
- `POST /issues`
- `PATCH /issues/{number}`
- Real issue creation or update

## Prerequisites

- User explicitly authorizes a real read-only GitHub API smoke.
- `GITHUB_TOKEN` is set in the shell.
- Target repo is chosen with `--repo owner/name`.
- Current migration run exists.

## Command

Local preflight without network:

```bash
npm run build
node scripts/smoke/prepare-github-read-only-smoke.mjs --config configs/md-fast.migration-guard.json --run latest --repo owner/name
```

The preflight validates the local run and repo format, reports whether
`GITHUB_TOKEN` is present, and prints the exact read-only command. It does not
call GitHub.

Real read-only smoke after explicit authorization:

```bash
node dist/cli.js sync-issues --run latest --provider github --live-plan --repo owner/name
```

Expected CLI output includes:

```text
GitHub live-plan read-only lookup wrote ...
Read-only: fetched open issues with GET only; no POST/PATCH mutations were sent.
```

## Expected Artifacts

```text
issue-sync/github-live-plan-issues.json
issue-sync/github-live-plan-issues.md
issue-sync/github-live-plan-mapping.json
issue-sync/github-live-plan.json
issue-sync/github-live-plan-summary.json
```

Check:

- `github-live-plan.json` contains `planHash`.
- `github-live-plan-summary.json` contains the same `planHash`.
- Summary contains non-sensitive rate-limit data when GitHub returns it.
- Artifacts do not contain `GITHUB_TOKEN` or Authorization headers.

## Local No-Network Plan Hash Stability Check

This check uses a mocked GitHub lookup and does not require `GITHUB_TOKEN`.

```bash
npm run build
node scripts/smoke/check-live-plan-hash-stability.mjs
```

Expected:

- `passed: true`
- `requestCount: 2`
- `mutationRequests: 0`
- same `planHash` across both mocked read-only plans

## Next Step Boundary

Do not run a real `--live` mutation smoke from this runbook. Real mutation smoke
requires a separate explicit authorization and must include:

```bash
--live --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 1
```
