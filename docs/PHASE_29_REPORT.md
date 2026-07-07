# Phase 29: GitHub Live Guardrails + Observability Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 29 强化 GitHub live sync 的真实执行护栏。重点不是扩大 mutation 能力，而是让用户能先只读规划、限制变更数量、追加团队标签，并在 API 异常时看到可排障证据。

核心目标：

- 支持 read-only `--live-plan`。
- 支持 `--max-live-mutations <n>`。
- 支持 `--labels a,b,c`。
- 默认限制 GitHub live mutation 数量。
- 写出 GitHub rate-limit 非敏感信息。
- 对 429/5xx 做保守 retry。
- 超出 mutation limit 时写出 plan 后拒绝 POST/PATCH。

## 2. CLI

Read-only live plan：

```bash
node dist/cli.js sync-issues --run latest --provider github --live-plan --repo owner/name
```

Guarded live sync：

```bash
node dist/cli.js sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --max-live-mutations 3 --labels team:migration
```

安全规则：

- `--dry-run`、`--live-plan`、`--live` 互斥。
- `--live-plan` 需要 `--repo owner/name` 和 `GITHUB_TOKEN`。
- `--live` 仍需要 `--repo owner/name`、`--live-confirm <run-id>` 和 `GITHUB_TOKEN`。
- `--max-live-mutations` 必须是非负整数。
- 默认 GitHub live mutation 上限为 3。

## 3. Artifacts

Read-only plan 写：

```text
issue-sync/github-live-plan-issues.json
issue-sync/github-live-plan-issues.md
issue-sync/github-live-plan-mapping.json
issue-sync/github-live-plan.json
issue-sync/github-live-plan-summary.json
```

Live sync 写：

```text
issue-sync/github-issues.json
issue-sync/github-live-plan.json
issue-sync/github-live-sync.json
```

`github-live-plan.json` 包含：

- willCreate
- willUpdate
- willSkip
- mutationCount
- maxLiveMutations
- issue body hash
- existing issue number/url
- rateLimit

`github-live-sync.json` 包含：

- createdCount
- updatedCount
- skippedCount
- failedCount
- planPath
- rateLimit
- issue action and attemptCount

## 4. Retry 和 Observability

GitHub adapter 对以下情况做保守 retry：

- 429
- 5xx
- transient fetch error

默认最多 3 次，测试中通过 mock adapter 使用 2 次和 1ms delay 验证。

Rate-limit summary 只记录非敏感响应 header：

- x-ratelimit-limit
- x-ratelimit-remaining
- x-ratelimit-reset
- x-ratelimit-used
- x-ratelimit-resource

不会写入：

- `GITHUB_TOKEN`
- Authorization header
- request secrets

## 5. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 20 个测试通过

新增/扩展覆盖：

- `--live-plan` safety rejects。
- `--dry-run` / `--live-plan` / `--live` 互斥。
- `--labels` 追加团队标签并去重。
- live plan 写出 mutationCount 和 maxLiveMutations。
- mutation limit 超限时只执行 GET，不执行 POST/PATCH。
- read-only live plan 只执行 GET。
- live/live-plan summary 写出 rate-limit 信息。
- 502 mutation mock 会 retry 后成功，并记录 attemptCount。
- token 不写入 plan 或 summary。

## 6. Safe Smoke

本阶段 safe smoke 不调用真实 GitHub API。建议继续使用：

```bash
npm test
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run --labels team:migration
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan
```

预期：

- dry-run 写出 provider-neutral GitHub artifacts。
- live-plan 缺 repo/token 时拒绝，不触发真实 API。
- 目标仓库保持 clean。

## 7. 后续建议

下一阶段建议进入 “GitHub Real Live Smoke Opt-In”：

1. 增加 `--live-plan-confirm <plan-hash>`，把真实 live 绑定到已审阅 plan。
2. 在用户明确授权后执行一次真实 GitHub read-only plan smoke。
3. 再执行一次 `--max-live-mutations 1` 的真实 create/update smoke。
4. 将真实 issue URL 回写到 run package 并生成 PR/issue handoff report。
