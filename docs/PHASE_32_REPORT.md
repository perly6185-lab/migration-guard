# Phase 32: Real GitHub Read-Only Smoke Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 32 执行一次真实 GitHub read-only smoke，只验证 `--live-plan` 路径。

本阶段只允许：

- `GET /repos/{owner}/{repo}/issues?state=open&per_page=100`
- 写本地 Migration Guard artifacts

本阶段未执行：

- `--live`
- `POST /issues`
- `PATCH /issues/{number}`
- 任何真实 issue 创建或更新

## 2. 前置检查

命令：

```bash
node scripts/smoke/prepare-github-read-only-smoke.mjs --config configs/md-fast.migration-guard.json --run latest --repo perly6185-lab/migration-guard --require-token
```

结果：

- 初始 `GITHUB_TOKEN` 环境变量未设置。
- 预检没有调用 GitHub API。
- 随后使用本机已认证的 `gh auth token` 临时注入当前 PowerShell 进程。
- token 未打印、未写入 artifacts。

## 3. 真实 Read-Only Smoke

命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard
```

执行两次，CLI 均输出：

```text
GitHub live-plan read-only lookup wrote ...
Read-only: fetched open issues with GET only; no POST/PATCH mutations were sent.
```

## 4. 结果

Run：

```text
run-2026-07-06T04-20-16-122Z-8ktltz
```

Artifacts：

```text
.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T04-20-16-122Z-8ktltz/issue-sync/github-live-plan-issues.json
.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T04-20-16-122Z-8ktltz/issue-sync/github-live-plan.json
.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T04-20-16-122Z-8ktltz/issue-sync/github-live-plan-summary.json
```

Observed plan:

```text
planHash: 965e8beada94a0bc9af207b00960da74af9755c1a62143bd5836a930ed7986e9
stable across two read-only runs: yes
mutationCount: 9
willCreate: 9
willUpdate: 0
willSkip: 0
planIssueCount: 9
```

Rate limit summary:

```text
first remaining: 4996
second remaining: 4995
```

## 5. Sensitive Data Check

Scanned:

```text
github-live-plan*.json
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

## 6. Repository Cleanliness

Target repository:

```text
D:\learn\migration-guard-targets\md
## main...origin/main
```

Migration Guard repository was clean before writing this report.

## 7. Next Boundary

The next stage can plan a real mutation smoke, but must not execute it without a separate explicit authorization.

Required real mutation command shape:

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo perly6185-lab/migration-guard --live-confirm <run-id> --live-plan-confirm 965e8beada94a0bc9af207b00960da74af9755c1a62143bd5836a930ed7986e9 --max-live-mutations 1
```
