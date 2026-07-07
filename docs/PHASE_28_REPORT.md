# Phase 28: GitHub Live Plan + Unchanged Skip Smoke Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 28 让 GitHub live sync 在执行 create/update 前先写出可审计计划，并通过 issue body hash 跳过未变化的 issue，减少外部平台噪音和重复更新。

核心目标：

- live sync 先生成 `github-live-plan.json`。
- plan 不包含 token。
- 根据 `mg_issue_id` 匹配 open issue。
- 根据正文 SHA-256 判断 unchanged issue。
- unchanged issue 记录为 skipped，不触发 PATCH。
- live summary 区分 created/updated/skipped/failed。
- 增加可复用 failing proposal batch smoke helper。

## 2. GitHub Live Plan

GitHub live sync 会写：

```text
issue-sync/github-live-plan.json
```

包含：

- provider
- repo
- matchingStrategy
- createdAt
- willCreate
- willUpdate
- willSkip
- issues[].issueId
- issues[].action
- issues[].bodyHash
- issues[].existingBodyHash
- issues[].existingNumber
- issues[].existingUrl

不包含：

- `GITHUB_TOKEN`
- Authorization header
- request secrets

## 3. Adapter 行为

同步策略：

1. GET open GitHub issues。
2. 从 body 提取 `mg_issue_id`。
3. 计算本地 issue body SHA-256。
4. 命中且 hash 相同：skip。
5. 命中但 hash 不同：PATCH。
6. 未命中：POST。

`github-live-sync.json` 新增：

- skippedCount
- planPath
- issues[].bodyHash
- issues[].action = created | updated | skipped | failed

## 4. Smoke Helper

新增：

```text
scripts/smoke/create-failing-proposal-batch.mjs
```

用途：

- 在 latest run 下创建两个 proposal artifact。
- 第一个 proposal 会新增一个退出码为 1 的 probe。
- 第二个 proposal 是应被 fail-fast batch 跳过的候选。
- 脚本只写 Migration Guard artifacts，不直接修改目标源码。

建议命令：

```bash
npm test
node scripts/smoke/create-failing-proposal-batch.mjs --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --gate-policy fail-fast
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run
```

## 5. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 19 个测试通过

新增/扩展覆盖：

- mock GitHub GET 返回一个 unchanged issue、一个 changed issue。
- unchanged issue 被标记为 skipped。
- skipped issue 不触发 PATCH/POST。
- changed issue 触发 PATCH。
- missing issue 触发 POST。
- live plan 写出 create/update/skip 计划。
- live summary 写出 createdCount/updatedCount/skippedCount/failedCount。
- live plan 和 live summary 都不包含 token。

## 6. 安全边界

本阶段没有放宽 live 安全条件：

- 仍必须显式 `--live`。
- 仍必须提供 `--repo owner/name`。
- 仍必须提供 `--live-confirm <run-id>`。
- 仍必须提供 `GITHUB_TOKEN`。
- `--dry-run` 和 `--live` 仍互斥。

没有用户明确授权时，只运行 dry-run 和 mock API 测试，不调用真实 GitHub API。

## 7. 后续建议

下一阶段建议进入 “GitHub Live Observability + Label Controls”：

1. 增加 `--label` / `--labels` 覆盖或追加团队标签。
2. 记录 GitHub rate-limit response headers 到非敏感 summary。
3. 增加 429/5xx retry backoff。
4. 支持 `--max-live-mutations <n>` 限制单次 live 变更量。
5. 在用户明确授权后执行一次真实 GitHub live smoke。
