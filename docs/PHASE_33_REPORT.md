# Phase 33: Single-Issue GitHub Mutation Smoke Plan Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 33 为未来真实 GitHub mutation smoke 增加单 issue 限缩能力，并写出 mutation smoke plan。本阶段没有执行真实 mutation。

新增能力：

- `sync-issues --only-issue <issue-id>`
- dry-run/live-plan/live 均只处理指定 issue
- filtered plan hash 只覆盖指定 issue
- mocked live sync 可在 `--max-live-mutations 1` 下只执行一个 mutation
- future mutation smoke plan runbook

## 2. Safety Boundary

本阶段执行过：

- GitHub dry-run filtered export
- GitHub real read-only filtered `--live-plan`
- local tests with mocked live mutation

本阶段未执行：

- real `--live`
- real `POST /issues`
- real `PATCH /issues/{number}`

## 3. Commands

Filtered dry-run:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```

Filtered real read-only plan:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```

CLI confirmed:

```text
Read-only: fetched open issues with GET only; no POST/PATCH mutations were sent.
```

## 4. Results

Run:

```text
run-2026-07-06T04-20-16-122Z-8ktltz
```

Filtered issue:

```text
issue-2026-07-06T04-20-52-277Z-i860d5
```

Observed:

```text
dryRunCount: 1
dryRunIssueId: issue-2026-07-06T04-20-52-277Z-i860d5
mutationCount: 1
willCreate: 1
willUpdate: 0
willSkip: 0
planHash: b37385bebbb630988086be2747c6adacef25fd87dbbbe143c01c3ba047355e62
```

## 5. Sensitive Data Check

Scanned:

```text
github-live-plan*.json
github-dry-run-issues.json
```

Patterns:

```text
GITHUB_TOKEN
Authorization
Bearer
gho_
ghp_
github_pat_
```

Result:

```text
no sensitive markers found
```

## 6. Tests

Command:

```bash
npm test
```

Result:

```text
20 tests passed
```

Additional mocked coverage:

- missing `--only-issue` target rejects
- filtered dry-run exports one issue
- filtered live-plan creates one-issue plan
- filtered mocked live with `--max-live-mutations 1` performs one POST
- external URL is written only to the matching local issue

## 7. Next Boundary

Future real mutation smoke still requires separate explicit authorization.

Update, 2026-07-06: authorization was later granted and the single-issue
mutation smoke completed in Phase 35. See `docs/PHASE_35_REPORT.md`.

Command shape:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo perly6185-lab/migration-guard --live-confirm run-2026-07-06T04-20-16-122Z-8ktltz --live-plan-confirm b37385bebbb630988086be2747c6adacef25fd87dbbbe143c01c3ba047355e62 --max-live-mutations 1 --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```
