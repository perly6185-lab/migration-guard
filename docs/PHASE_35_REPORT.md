# Phase 35: Authorized Single-Issue GitHub Mutation Smoke Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 35 完成一次授权后的最小真实 GitHub mutation smoke，证明外部 handoff 可真实落到 GitHub issue，并立即停止 GitHub provider 深挖。

## 2. Authorization Boundary

用户已明确授权执行一次真实 mutation smoke。

本阶段允许：

- 一个 GitHub issue create/update mutation
- 本地 Migration Guard artifact 写入
- 本地 issue `externalUrl` 回写

本阶段未执行：

- 第二次 mutation
- issue close/reopen
- assignee/milestone/label reconciliation 扩展
- GitHub provider hardening

## 3. Commands

Filtered dry-run:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```

Filtered read-only plan:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```

Authorized live mutation:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo perly6185-lab/migration-guard --live-confirm run-2026-07-06T04-20-16-122Z-8ktltz --live-plan-confirm b37385bebbb630988086be2747c6adacef25fd87dbbbe143c01c3ba047355e62 --max-live-mutations 1 --only-issue issue-2026-07-06T04-20-52-277Z-i860d5
```

## 4. Results

Run:

```text
run-2026-07-06T04-20-16-122Z-8ktltz
```

Issue:

```text
issue-2026-07-06T04-20-52-277Z-i860d5
```

Read-only plan:

```text
mutationCount: 1
willCreate: 1
willUpdate: 0
willSkip: 0
planHash: b37385bebbb630988086be2747c6adacef25fd87dbbbe143c01c3ba047355e62
```

Live result:

```text
createdCount: 1
updatedCount: 0
skippedCount: 0
failedCount: 0
GitHub URL: https://github.com/perly6185-lab/migration-guard/issues/2
GitHub state: OPEN
```

Local write-back:

```text
externalUrl count: 1
externalUrl: https://github.com/perly6185-lab/migration-guard/issues/2
```

## 5. Sensitive Data Check

Credential marker scan:

```text
Authorization
Bearer
gho_
ghp_
github_pat_
```

Result:

```text
no credential markers found
```

Note:

```text
Provider mapping artifacts intentionally contain the literal environment variable name GITHUB_TOKEN.
No actual token value or Authorization header was written to artifacts.
```

## 6. Exit Decision

GitHub short closure is complete.

Next active development line:

```text
Migration Runner Loop
```

Do not continue with GitHub operational hardening until Runner Loop, behavior consistency, and AI collaboration closure advance.
