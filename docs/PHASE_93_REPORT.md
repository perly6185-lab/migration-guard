# Phase 93 Report: One-Shot Session Ledger

生成日期：2026-07-10

## Goal

把一次性重构平台从“runbook + latest artifact 推断”推进到“显式 session ledger”：每个 one-shot window 有持久状态、runbook 链接、baseline/pre-PR/PR/merge/post-merge/closure evidence 链接和事件记录。

## Delivered

New CLI commands:

```text
migration-guard one-shot session open
migration-guard one-shot session status
migration-guard one-shot session sync
```

Key options:

```text
--session <path>
--max-source-file-delta <n>
--name <text>
--branch <name>
--base-branch <name>
--budget <text>
--command-prefix <command>
--skip-target-git
--strict
--json
```

New session model:

```text
OneShotSession
OneShotSessionEvidence
OneShotSessionEvent
OneShotSessionState
```

Session states:

```text
open
active
pre-pr
merged
closed
```

Session evidence tracks:

```text
runbookPath
baselinePath
prePrRunPath
prePrComparePath
prePrReportPath
prUrl
targetCommit
mergeCommit
mergedAt
postMergeRunPath
postMergeComparePath
closureReportPath
```

Output artifacts:

```text
<artifactsDir>/one-shot/one-shot-session-<timestamp>.json
<artifactsDir>/one-shot/one-shot-session-<timestamp>.md
```

`one-shot session open` creates a runbook and a linked session ledger. `one-shot session status` syncs the latest matching evidence into the ledger by default, while `--no-sync` reads the ledger as-is. `one-shot session sync` explicitly refreshes evidence and lifecycle state.

## Verification

Build and test:

```text
npm test
```

Result:

```text
52 tests passed
```

Focused coverage:

- session open writes a persistent ledger with runbook evidence
- session sync records metadata-complete closure evidence
- metadata-complete closure report moves the session to `closed`

## Exit Criteria

- `one-shot session open` creates runbook and session artifacts: passed.
- `one-shot session status` / `sync` refresh evidence links and lifecycle state: passed.
- Closure metadata is persisted into the session ledger: passed.
- Unit tests cover open and closure sync: passed.
- Full test suite passes: passed.

## Next

Phase 94 can use the session ledger as the default operator path for the next larger bounded one-shot window, then add optional resume commands that print the exact next baseline, verify, report or closure command from the active session.
