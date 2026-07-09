# Phase 91 Report: One-Shot Runbook Generation

生成日期：2026-07-09

## Goal

把一次性重构平台从“能生成 closure report”推进到“能生成可执行 runbook”：在开窗前由工具写出 baseline、bounded edit、verify、pre-PR report、PR merge、post-merge verify、final closure report 的步骤和命令模板。

## Delivered

New CLI command:

```text
migration-guard one-shot runbook
```

Key options:

```text
--max-source-file-delta <n>
--name <text>
--branch <name>
--base-branch <name>
--budget <text>
--command-prefix <command>
--json
```

New runbook model:

```text
OneShotRunbook
OneShotRunbookStep
```

Runbook steps:

```text
target-prep
baseline
edit-window
post-edit-verify
pre-pr-report
pr-merge
post-merge-verify
closure-report
```

Output artifacts:

```text
<artifactsDir>/one-shot/one-shot-runbook-<timestamp>.json
<artifactsDir>/one-shot/one-shot-runbook-<timestamp>.md
```

## Real md-one-shot Validation

Command:

```text
node dist/cli.js one-shot runbook --config configs/md-one-shot.migration-guard.json --max-source-file-delta 1 --name "Next bounded one-shot window" --branch migration-guard/<phase>-one-shot --base-branch main --budget "bounded helper cleanup only"
```

Result:

```text
one-shot-runbook-2026-07-09T09-56-00-015Z
steps: 8
target: D:\learn\migration-guard-targets\md
config: D:\learn\migration-guard\configs\md-one-shot.migration-guard.json
source file delta budget: 1
```

Runbook artifacts:

```text
.migration-guard/external-targets/md-one-shot/one-shot/one-shot-runbook-2026-07-09T09-56-00-015Z.json
.migration-guard/external-targets/md-one-shot/one-shot/one-shot-runbook-2026-07-09T09-56-00-015Z.md
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
48 tests passed
```

Focused coverage:

- runbook renders reusable closure steps
- baseline command is included
- closure report command includes PR/merge metadata placeholders
- configured budget and window metadata render in Markdown

## Exit Criteria

- `one-shot runbook` writes JSON/Markdown artifacts: passed.
- Runbook includes the full one-shot lifecycle from target prep to closure report: passed.
- Runbook includes runnable command templates for baseline, verify, report, and closure report: passed.
- Real `md-one-shot` config produces a runbook artifact: passed.
- Full test suite passes: passed.

## Next

Phase 92 can make the platform more operator-friendly by adding a `one-shot status` view that reads the latest runbook and reports which lifecycle artifacts already exist, such as latest baseline, latest run, latest compare, pre-PR report, and closure report.
