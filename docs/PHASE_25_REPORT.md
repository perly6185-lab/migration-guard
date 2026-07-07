# Phase 25: Provider Adapter + PR Comment Preview Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 25 在 Phase 24 的 provider-neutral issue context 基础上，增加更贴近真实团队协作平台的 dry-run artifact。当前阶段仍不调用外部 API，默认保持安全预览。

核心目标：

- GitHub dry-run 生成 PR comment preview。
- Provider export 写出字段映射。
- 非 local provider 的 live sync 明确阻断，避免误以为已经调用真实 API。
- CI handoff 同时生成 GitHub Actions step summary 风格 Markdown。

## 2. 已实现能力

### 2.1 Provider Mapping

`sync-issues --provider <provider> --dry-run` 会额外写出：

```text
issue-sync/<provider>-dry-run-mapping.json
```

内容包括：

- provider
- token env hint
- title/body/labels/status field mapping
- labels strategy
- body sections

GitHub 示例：

```json
{
  "provider": "github",
  "tokenEnv": "GITHUB_TOKEN",
  "dryRunDefault": true,
  "fields": {
    "title": "title",
    "body": "body",
    "labels": "labels",
    "status": "state/status"
  }
}
```

每条 issue JSON 也包含 `providerMapping` 摘要。

### 2.2 GitHub PR Comment Preview

GitHub dry-run 会额外写出：

```text
issue-sync/github-pr-comment.md
```

内容包含：

- run id
- migration goal
- latest failed gate
- verification report path
- replan issue/task
- first failed check
- failure category
- remediation hints
- latest failed batch
- stop reason
- next command
- skipped proposals

### 2.3 External Provider Safety

`local` provider 仍可正常写本地 export。

非 local provider 如果没有 `--dry-run`，当前会失败并提示：

```text
Live github issue sync is not implemented yet. Re-run with --dry-run to write provider-neutral artifacts.
```

这避免用户误以为已经创建了真实 GitHub/GitLab/Jira/Linear issue。

### 2.4 GitHub Step Summary

`writeCiHandoffReport` 现在除 `ci-handoff.md` 外，还会写：

```text
reports/github-step-summary.md
```

该文件可作为 GitHub Actions `$GITHUB_STEP_SUMMARY` 的内容来源。

## 3. 测试覆盖

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 19 个测试通过

新增/扩展覆盖：

- GitHub dry-run 写出 mapping artifact
- GitHub dry-run 写出 PR comment preview
- PR comment preview 包含 failed proposal 和 next command
- 非 local provider 不带 dry-run 会被阻断
- CI handoff 写出 `github-step-summary.md`

## 4. 真实 GitHub Dry-Run Smoke

复用 Phase 23 的失败 batch run：

```text
run-2026-07-06T02-23-11-039Z-j5ue3e
```

目标仓库：

```text
D:\learn\migration-guard-targets\md
```

命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run
```

结果：

- GitHub dry-run export: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/issue-sync/github-dry-run-issues.json`
- Provider mapping: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/issue-sync/github-dry-run-mapping.json`
- PR comment preview: `.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/issue-sync/github-pr-comment.md`
- mapping includes `tokenEnv: GITHUB_TOKEN`
- PR comment includes failed proposal `patch-phase23-fail`
- PR comment includes next command `migration-guard proposal replan --run latest --proposal patch-phase23-fail`
- issue JSON includes provider mapping summary
- issue JSON includes gate and batch context

CI summary smoke:

```text
.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-06T02-23-11-039Z-j5ue3e/reports/github-step-summary.md
```

The summary includes failed gate, failed batch, stop reason, next command and skipped proposals.

Target repository stayed clean:

```text
## main...origin/main
```

## 5. 实现边界

当前 Phase 25 仍保持 dry-run 预览层：

- 不调用 GitHub/GitLab/Jira/Linear API。
- 不读取或使用 token 发请求。
- GitHub PR comment 只是 Markdown artifact，不自动发布到 PR。
- Provider mapping 是字段映射草案，还不是完整 provider adapter。

## 6. 后续建议

下一阶段可以进入 “GitHub Issue Adapter Dry-Run to Live Boundary”：

1. 增加 `--live` 或类似显式开关，避免误触真实 API。
2. 在 live 模式读取 `GITHUB_TOKEN` 并调用 GitHub Issues API。
3. 支持 `--repo owner/name` 和 `--labels`。
4. PR comment 通过 GitHub API 发布前先支持 `--comment-dry-run`。
5. 增加 provider API mock 测试。
