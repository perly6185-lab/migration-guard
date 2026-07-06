# Phase 26: GitHub Live Adapter Boundary + API Mock Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 26 将 GitHub provider 从 dry-run preview 推进到可测试的 live adapter 边界。当前阶段建立严格安全条件和 mock API 测试，不默认触碰真实 GitHub。

核心目标：

- live 模式必须显式 `--live`。
- GitHub live 模式必须提供 `--repo owner/name`。
- GitHub live 模式必须提供 `--live-confirm <run-id>`。
- GitHub live 模式必须有 `GITHUB_TOKEN`。
- `--dry-run` 和 `--live` 互斥。
- GitHub API 查询/创建/更新被封装到 mockable adapter。
- live summary artifact 不包含 token。

## 2. CLI

Dry-run 仍是推荐路径：

```bash
node dist/cli.js sync-issues --run latest --provider github --dry-run
```

Live 边界：

```bash
node dist/cli.js sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id>
```

安全校验：

- 缺 `--repo owner/name`：拒绝。
- repo 格式不是 `owner/name`：拒绝。
- 缺 `--live-confirm <run-id>`：拒绝。
- confirm 不匹配当前 run id：拒绝。
- 缺 `GITHUB_TOKEN`：拒绝。
- 同时传 `--dry-run` 和 `--live`：拒绝。
- GitLab/Jira/Linear live 仍未实现，继续拒绝并提示使用 dry-run。

## 3. GitHub Adapter

新增：

```text
src/core/githubIssueAdapter.ts
```

主要能力：

- `validateGitHubRepo(repo)`
- `createGitHubIssues(options)`

请求目标：

```text
GET https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100
POST https://api.github.com/repos/{owner}/{repo}/issues
PATCH https://api.github.com/repos/{owner}/{repo}/issues/{number}
```

策略：

- 先读取 open issues。
- 从 issue body front matter 提取 `mg_issue_id`。
- 命中相同 `mg_issue_id` 时 PATCH 更新。
- 未命中时 POST 创建。

create/update payload：

- title
- body
- labels

headers：

- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- `Content-Type: application/json`

## 4. Live Summary Artifact

GitHub live sync 会写：

```text
issue-sync/github-live-sync.json
```

包含：

- provider
- repo
- createdCount
- updatedCount
- failedCount
- issue titles
- issue URLs
- issue numbers
- errors

不包含：

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
- 共 19 个测试通过

新增/扩展覆盖：

- `--dry-run` 和 `--live` 互斥
- GitHub live 缺 live-confirm 被拒绝
- GitHub live confirm 不匹配 run id 被拒绝
- GitHub live 缺 repo 被拒绝
- GitHub live repo 格式错误被拒绝
- GitHub live 缺 token 被拒绝
- mock fetch 验证 GitHub lookup/create/update URL
- mock fetch 验证 Authorization header
- mock fetch 验证 title/body/labels payload
- live summary 写出 issue URL
- live summary 区分 created/updated
- live summary 不包含 token

## 6. 安全 Smoke

本阶段真实 smoke 只跑拒绝路径，不创建真实 GitHub issue。

建议命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --live-confirm run-unknown
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo bad-repo
```

预期：

- 第一条提示缺 `--live-confirm <run-id>`
- 第二条提示 confirm 不匹配当前 run id
- 第三条提示 repo 格式错误
- 目标仓库保持 clean

实际结果：

- `sync-issues --provider github --live` 返回 `GitHub live issue sync requires --live-confirm <run-id>.`
- `sync-issues --provider github --live --live-confirm run-unknown` 返回 `GitHub live confirmation mismatch. Expected --live-confirm run-2026-07-06T02-23-11-039Z-j5ue3e.`
- `sync-issues --provider github --live --live-confirm run-2026-07-06T02-23-11-039Z-j5ue3e --repo bad-repo` 返回 `Invalid GitHub repo "bad-repo". Expected owner/name.`
- target repository stayed clean:

```text
## main...origin/main
```

## 7. 后续建议

下一阶段可以进入 “GitHub Live Smoke Opt-In + Issue Update Strategy”：

1. 增加 `--live-confirm <run-id>` 或类似二次确认。
2. 支持根据 issue front matter 查找并更新已有 GitHub issue。
3. 支持 `--labels` 追加团队标签。
4. 增加 request rate-limit / retry 策略。
5. 在用户明确授权时跑一次真实 GitHub issue 创建 smoke。
