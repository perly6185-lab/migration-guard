# Phase 95 Report: One-Shot Session Next Action

生成日期：2026-07-10

## Goal

让 one-shot session ledger 从“记录窗口状态”推进到“直接告诉操作者下一步怎么继续”：读取 active session，同步最新 evidence，并输出当前唯一 runnable lifecycle command。

## Delivered

New CLI command:

```text
migration-guard one-shot session next
```

Key options:

```text
--session <path>
--skip-target-git
--strict
--json
```

New model and renderer:

```text
OneShotSessionNextAction
renderOneShotSessionNextAction
```

Output includes:

```text
session id
session state
runbook id
status
next step id
next title
next command
next reason
```

`one-shot session next` syncs the selected or latest session first, then uses the runbook lifecycle status to print one current command. Closed sessions return `none`.

## Verification

Build and test:

```text
npm test
```

Result:

```text
53 tests passed
```

Focused coverage:

- new session returns `baseline` as the next action
- rendered next-action output includes the runnable command

## Exit Criteria

- `one-shot session next` exposes the current runnable command: passed.
- JSON and Markdown-style text output are supported: passed.
- Unit test covers the baseline next-action path: passed.
- Full test suite passes: passed.

## Next

Phase 96 can start the next larger bounded `md` one-shot window using `one-shot session open` and `one-shot session next` as the operator path, with a slightly larger single-domain cleanup budget.
