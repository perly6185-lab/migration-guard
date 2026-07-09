# Phase 90 Report: One-Shot Closure Metadata

生成日期：2026-07-09

## Goal

把 `one-shot report` 从验证摘要推进成一次性重构平台的 closure artifact：同一份报告不仅说明 checks/probes/compare 是否通过，也记录 one-shot window 的分支、PR、目标提交、merge commit、合并时间和预算说明。

## Delivered

`one-shot report` now accepts closure metadata:

```text
--name <text>
--branch <name>
--base-branch <name>
--pr-url <url>
--target-commit <sha>
--merge-commit <sha>
--merged-at <iso>
--budget <text>
--note <text>
--skip-git-metadata
```

It also auto-detects from the target repository when available:

```text
branch
targetCommit
```

New report model fields:

```text
metadata
summary.metadataComplete
closure-metadata criterion
```

The generated Markdown now includes:

```text
## Window
```

with name, branch, base branch, PR URL, target commit, merge commit, merged-at time, budget, and notes.

## Real md-one-shot Validation

Command:

```text
node dist/cli.js one-shot report --config configs/md-one-shot.migration-guard.json --max-source-file-delta 1 --name "Phase 88 bounded one-shot closure" --branch main --base-branch main --pr-url https://github.com/perly6185-lab/md/pull/6 --target-commit 3a82a8e --merge-commit 2c02450be494f2b45d3a3c748294a25e1bda0817 --merged-at 2026-07-09T09:21:28Z --budget "API/web/core/MCP/shared helper extraction and duplicate cleanup only" --note "post-merge md-one-shot evidence"
```

Result:

```text
Status: go
Checks: 5/5 passed
Probes: 4/4 passed
Compare passed: yes
Source file delta: 1 (budget 1)
Metadata complete: yes
Target clean: yes
Blockers: 0
Warnings: 0
```

Closure report:

```text
.migration-guard/external-targets/md-one-shot/one-shot/one-shot-report-2026-07-09T09-46-13-376Z.json
.migration-guard/external-targets/md-one-shot/one-shot/one-shot-report-2026-07-09T09-46-13-376Z.md
```

The `closure-metadata` criterion passed with:

```text
branch: main
PR URL: https://github.com/perly6185-lab/md/pull/6
target commit: 3a82a8e
merge commit: 2c02450be494f2b45d3a3c748294a25e1bda0817
merged at: 2026-07-09T09:21:28Z
```

## Verification

Build:

```text
npm run build
```

Result:

```text
passed
```

Test:

```text
npm test
```

Result:

```text
47 tests passed
```

Focused coverage:

- one-shot report captures PR URL, branch, target commit, merge commit, merged-at time, budget, and notes
- complete closure metadata makes the `closure-metadata` criterion pass
- metadata renders into the Markdown `Window` section

## Exit Criteria

- One-shot report records PR/branch/commit metadata: passed.
- Report warns when closure metadata is incomplete: passed.
- Target branch and HEAD commit can be auto-detected: passed.
- Real Phase 88 closure evidence produces a metadata-complete `go` report: passed.
- Full test suite passes: passed.

## Next

Phase 91 can make one-shot execution itself more platform-like by adding a command that writes a reusable one-shot runbook/checklist from the report: baseline command, verify command, compare artifact, PR metadata prompts, post-merge verify command, and final closure report command.
