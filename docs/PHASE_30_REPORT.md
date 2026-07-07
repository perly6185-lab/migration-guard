# Phase 30: GitHub Live Plan Hash Confirmation Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 30 将真实 GitHub live mutation 绑定到已审阅的 live plan。用户先运行 read-only `--live-plan` 生成计划和 `planHash`，再在真实 `--live` 时传入 `--live-plan-confirm <plan-hash>`。如果当前 lookup 生成的新计划和确认 hash 不一致，工具会拒绝 mutation。

核心目标：

- live plan 写出稳定 `planHash`。
- live plan summary 写出同一个 `planHash`。
- GitHub live 必须提供 `--live-plan-confirm <plan-hash>`。
- live mutation 前校验当前 plan hash。
- hash mismatch 时不触发 POST/PATCH。
- live summary 记录 plan hash 和用户确认 hash。

## 2. CLI

推荐流程：

```bash
node dist/cli.js sync-issues --run latest --provider github --live-plan --repo owner/name
node dist/cli.js sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 1
```

安全规则：

- `--live` 仍需要 `--live-confirm <run-id>`。
- `--live` 现在也需要 `--live-plan-confirm <plan-hash>`。
- `planHash` 不包含 `createdAt` 或 rate-limit 信息，避免稳定计划因非决策字段变化而失效。
- `planHash` 覆盖 repo、matching strategy、create/update/skip counts、mutationCount 和每个 issue 的 action/body hash/existing issue match。

## 3. Artifacts

`github-live-plan.json` 新增：

```text
planHash
```

`github-live-plan-summary.json` 新增：

```text
planHash
```

`github-live-sync.json` 新增：

```text
planHash
livePlanConfirm
```

这些 hash 不是 secret，可以安全写入 artifacts。

## 4. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 20 个测试通过

新增/扩展覆盖：

- read-only live plan 写出 64 位 hex `planHash`。
- live plan summary 的 `planHash` 和 plan artifact 一致。
- GitHub live 缺 `--live-plan-confirm` 被拒绝。
- GitHub live hash mismatch 被拒绝，且只执行 GET，不执行 POST/PATCH。
- GitHub live hash match 后继续执行 skip/update/create。
- live summary 写出 `planHash` 和 `livePlanConfirm`。

## 5. Safe Smoke

本阶段 safe smoke 不调用真实 GitHub API。

建议命令：

```bash
npm test
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live
```

预期：

- 缺 `--live-confirm <run-id>` 时拒绝。
- 没有真实 GitHub API 请求。
- 目标仓库保持 clean。

## 6. 后续建议

下一阶段建议进入 “Real GitHub Read-Only Plan Smoke”：

1. 在用户明确授权后，使用真实 `GITHUB_TOKEN` 跑一次 `--live-plan --repo perly6185-lab/migration-guard`。
2. 记录真实 rate-limit summary。
3. 检查 planHash 是否稳定。
4. 暂不执行 POST/PATCH，直到用户明确授权真实 mutation smoke。
